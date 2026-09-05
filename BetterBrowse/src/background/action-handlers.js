/**
 * @file action-handlers.js
 * @description 统一 action 处理映射表（人类 UI 消息与 AI 桥接指令共用的同一条处理路径）
 *
 * 对等原则（docs/03-ai-skill-bridge.md）：MessageBus（人类）与 AIBridgeManager（AI Agent）
 * 复用同一份由本文件导出的处理映射，含 NOTIFY 广播收尾——
 * 新增任何人类功能时自动对 AI 可用，新增 AI 动作时同样挂载于此。
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { DefaultConfig } from '../constants/config.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { LinkService } from '../core/link/link-service.js';
import { StashService } from '../core/stash/stash-service.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { SyncScheduler } from './sync-scheduler.js';
import { IndexedDBManager } from '../core/storage/indexed-db.js';
import { SyncEngine } from '../core/sync/sync-engine.js';
import { SyncStatus } from '../core/sync/sync-constants.js';
import { SyncMerge } from '../core/sync/merge.js';
import { SyncSnapshot } from '../core/sync/snapshot.js';
import { WebdavCredentials } from '../core/sync/credentials.js';
import { DeviceEventLog } from '../core/sync/device-events.js';
import { filterCountableTabs, isOwnOptionsUrl } from '../core/extension-url.js';
import { buildCapabilitiesDescriptor } from '../core/ai/ai-capabilities.js';
import { RuntimeLogRepository } from '../core/logging/runtime-log-repository.js';
import { classifySender } from '../core/security/message-authorizer.js';
import { notifyExtensionPages, notifyLinkFrames } from './link-notifier.js';

const TAB_CREATE_RETRY_DELAYS_MS = [50, 150, 350];
const OPEN_TAB_RATE_LIMIT = 8;
const OPEN_TAB_RATE_WINDOW_MS = 10000;
const openTabTimestampsByTab = new Map();

// 站点图标解析的抓取超时与体积上限
const FAVICON_FETCH_TIMEOUT_MS = 5000;
const FAVICON_MAX_BYTES = 256 * 1024;
const FAVICON_ICON_EXT_RE = /\.(?:ico|png|gif|jpe?g|webp|svg|bmp|avif)$/i;

/**
 * 是否为可抓取的 http(s) 地址。
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/**
 * 从字节头嗅探常见图标格式（站点常把 .ico 标成 octet-stream）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sniffFaviconMime(bytes) {
  if (!bytes || bytes.length < 4) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)).trimStart();
  if (/^(<\?xml\b[\s\S]{0,200}<svg\b|<svg\b)/i.test(head)) return 'image/svg+xml';
  return '';
}

/**
 * 判定响应是否为可用图标：拒绝 HTML 登录页，接受 SVG 与未声明 MIME 的真实图片。
 * @param {string} contentType
 * @param {Uint8Array} bytes
 * @returns {string} 可用时返回 MIME，否则空串
 */
function resolveFaviconMime(contentType, bytes) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)).trimStart();
  if (/^(<!DOCTYPE html|<html\b)/i.test(head)) return '';
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (declared.startsWith('text/html')) return '';
  if (declared.startsWith('image/')) return declared;
  return sniffFaviconMime(bytes);
}

/**
 * 将 Chrome 内部图标地址还原为真实网页 URL。
 * 覆盖 chrome-extension://<id>/_favicon/?pageUrl=…、chrome://favicon2 与旧版 chrome://favicon。
 * @param {string} rawUrl
 * @returns {string|null}
 */
function unwrapChromeFaviconUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'chrome-extension:') {
      if (!/\/_favicon\/?$/.test(u.pathname)) return null;
      return u.searchParams.get('pageUrl') || u.searchParams.get('page_url') || null;
    }
    if (u.protocol !== 'chrome:') return null;
    const host = String(u.hostname || '').toLowerCase();
    if (host === 'favicon2') {
      return u.searchParams.get('pageUrl') || u.searchParams.get('page_url') || null;
    }
    if (host === 'favicon') {
      const fromQuery = u.searchParams.get('pageUrl') || u.searchParams.get('page_url');
      if (fromQuery) return fromQuery;
      const embedded = `${u.pathname || ''}${u.search || ''}`.match(/https?:\/\/\S+/i);
      return embedded ? embedded[0] : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 判断地址是否更像图标资源，而不是普通网页。
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isLikelyIconUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const path = u.pathname.toLowerCase();
    if (FAVICON_ICON_EXT_RE.test(path)) return true;
    if (path.includes('favicon') || path.includes('apple-touch-icon')) return true;
    const host = u.hostname.toLowerCase();
    if ((host === 'www.google.com' || host === 'google.com') && u.pathname.startsWith('/s2/favicons')) return true;
    if (host === 'icons.duckduckgo.com') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 读取 URL 的 origin 根图标。
 * @param {string} rawUrl
 * @returns {string}
 */
function originFaviconOf(rawUrl) {
  try {
    return `${new URL(rawUrl).origin}/favicon.ico`;
  } catch {
    return '';
  }
}

/**
 * 读取 URL 主机名。
 * @param {string} rawUrl
 * @returns {string}
 */
function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname || '';
  } catch {
    return '';
  }
}

/**
 * 组装图标抓取候选：真实 favIconUrl → 页面 origin/favicon.ico → DuckDuckGo → Google s2。
 * 绝不能把网页 HTML 地址本身当作图标抓取。
 * @param {string} rawUrl
 * @param {string} [explicitPageUrl]
 * @returns {string[]}
 */
function buildFaviconCandidates(rawUrl, explicitPageUrl) {
  const unwrapped = unwrapChromeFaviconUrl(rawUrl);
  const pageHint = isHttpUrl(explicitPageUrl) ? explicitPageUrl : '';
  let iconUrl = '';
  let pageUrl = pageHint;

  if (unwrapped) {
    if (isHttpUrl(unwrapped)) pageUrl = pageUrl || unwrapped;
  } else if (isHttpUrl(rawUrl)) {
    if (isLikelyIconUrl(rawUrl) || (pageUrl && rawUrl !== pageUrl)) {
      iconUrl = rawUrl;
    } else {
      pageUrl = pageUrl || rawUrl;
    }
  }

  const candidates = [];
  const seen = new Set();
  const add = (url) => {
    if (!url || seen.has(url) || !isHttpUrl(url)) return;
    seen.add(url);
    candidates.push(url);
  };

  add(iconUrl);
  add(originFaviconOf(pageUrl));
  const host = hostnameOf(pageUrl) || hostnameOf(iconUrl);
  if (host) {
    add(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    add(`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`);
  }
  return candidates;
}

// === 搜索引擎联想建议服务常量与有界缓存 ===
const SUGGEST_TIMEOUT_MS = 3000;
const SUGGEST_CACHE_MAX_ENTRIES = 100;
const SUGGEST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const suggestCache = new Map();

function getCachedSuggestions(key) {
  const entry = suggestCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SUGGEST_CACHE_TTL_MS) {
    suggestCache.delete(key);
    return null;
  }
  return entry.suggestions;
}

function setCachedSuggestions(key, suggestions) {
  if (suggestCache.size >= SUGGEST_CACHE_MAX_ENTRIES) {
    const oldestKey = suggestCache.keys().next().value;
    if (oldestKey) suggestCache.delete(oldestKey);
  }
  suggestCache.set(key, { timestamp: Date.now(), suggestions });
}

// 外部联想白名单 API 映射 (仅允许 Google 与 Bing)
const SUGGEST_URL_BUILDERS = {
  google: (q) => `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`
};

/**
 * 判定消息发送方是否处于隐身模式（保护历史记录安全）。
 * 覆盖 sender.tab 存在场景与 sender.tab 缺失（如隐身窗口下的 popup、无 tab 上下文）场景。
 * @param {chrome.runtime.MessageSender|undefined|null} sender
 * @returns {Promise<boolean>}
 */
async function isIncognitoSender(sender) {
  if (sender?.tab?.incognito) return true;
  if (typeof chrome !== 'undefined') {
    try {
      if (chrome.extension?.inIncognitoContext) return true;
      if (chrome.windows?.getLastFocused) {
        const win = await chrome.windows.getLastFocused().catch(() => null);
        if (win?.incognito) return true;
      }
      if (chrome.tabs?.query) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        if (activeTab?.incognito) return true;
      }
    } catch {
      // 忽略窗口查询异常
    }
  }
  return false;
}

/**
 * 内容脚本开标签的后台速率兜底（按 sender.tab 滑动窗口）。
 * AI / 扩展页面无 tab 来源时不限流。
 * @param {chrome.runtime.MessageSender|undefined|null} sender
 * @returns {boolean}
 */
function allowOpenTabFromSender(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return true;
  const now = Date.now();
  const recent = (openTabTimestampsByTab.get(tabId) || []).filter(
    (ts) => now - ts < OPEN_TAB_RATE_WINDOW_MS
  );
  if (recent.length >= OPEN_TAB_RATE_LIMIT) {
    openTabTimestampsByTab.set(tabId, recent);
    return false;
  }
  recent.push(now);
  openTabTimestampsByTab.set(tabId, recent);
  return true;
}

/**
 * 判断标签页是否处于 Chrome 暂时禁止编辑的状态（例如用户正在拖拽标签页）。
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientTabEditError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('tabs cannot be edited right now')
    || message.includes('user may be dragging a tab')
    || message.includes('tabs cannot be edited');
}

/**
 * 创建标签页并处理拖拽期间 Chrome 暂时拒绝编辑的竞态。
 * 优先保留原标签页右侧插入位置；若拖拽状态持续，则去掉 index 退化为普通创建，
 * 避免用户点击链接后因一次瞬时 API 错误完全丢失新标签页。
 * @param {chrome.tabs.CreateProperties} createProperties
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function createTabWithRetry(createProperties) {
  let lastError;
  for (let attempt = 0; attempt <= TAB_CREATE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, TAB_CREATE_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      return await chrome.tabs.create(createProperties);
    } catch (error) {
      lastError = error;
      if (!isTransientTabEditError(error)) throw error;
    }
  }

  // index 需要编辑现有标签页顺序，拖拽持续时普通创建仍可成功。
  if (Object.hasOwn(createProperties, 'index')) {
    const fallbackProperties = { ...createProperties };
    delete fallbackProperties.index;
    try {
      return await chrome.tabs.create(fallbackProperties);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * 构建统一 action 处理映射
 * @param {object} deps - 依赖注入（实例型服务与宿主环境回调）
 * @param {StashService} deps.stashService - 收纳服务实例
 * @param {TabActivityTracker} deps.activityTracker - 活跃度统计实例
 * @param {ThresholdMonitor} deps.thresholdMonitor - 阈值监控实例
 * @param {(action: string, data?: any) => Promise<void>} [deps.broadcastToTabs] - 兼容旧注入；链接刷新改走框架定向通知
 * @param {{ getStatusSummary: () => any, onConfigUpdated: (config: any) => void } | null} [deps.aiBridge] - AI 桥接管理器
 * @returns {Record<string, (payload: any, sender?: any) => Promise<any>>}
 */
export function createActionHandlers(deps) {
  const { stashService, activityTracker, thresholdMonitor, aiBridge } = deps;

  // 映射对象先落局部变量：GET_AI_CAPABILITIES 运行时据此自枚举可用动作（清单即事实）
  const handlers = {
    // === 链接跳转相关 ===
    [ActionTypes.GET_LINK_RULE]: async (payload) => {
      const domain = payload?.domain || '';
      return await LinkService.getModeForDomain(domain);
    },

    [ActionTypes.SET_LINK_RULE]: async (payload) => {
      const { domain, mode } = payload || {};
      const res = await LinkService.setDomainRule(domain, mode);
      await notifyLinkFrames({ domain });
      return res;
    },

    [ActionTypes.GET_GLOBAL_LINK_RULE]: async () => {
      return await LinkService.getGlobalRule();
    },

    [ActionTypes.SET_GLOBAL_LINK_RULE]: async (payload) => {
      const { enabled, mode } = payload || {};
      const res = await LinkService.setGlobalRule(enabled, mode);
      await notifyLinkFrames({ global: true });
      return res;
    },

    [ActionTypes.GET_DOMAIN_RULES]: async () => {
      return await LinkService.getAllRules();
    },

    [ActionTypes.GET_PAGE_LINK_CONTEXT]: async (_payload, sender) => {
      const senderUrl = sender?.url || sender?.tab?.url || '';
      return await LinkService.getPageLinkContext(senderUrl);
    },

    [ActionTypes.REMOVE_DOMAIN_RULE]: async (payload) => {
      const res = await LinkService.removeDomainRule(payload?.domain);
      await notifyLinkFrames({ domain: payload?.domain });
      return res;
    },

    [ActionTypes.CLEAR_DOMAIN_RULES]: async () => {
      const res = await LinkService.clearAllDomainRules();
      await notifyLinkFrames({ clearAll: true });
      return res;
    },

    [ActionTypes.OPEN_TAB_BACKGROUND]: async (payload, sender) => {
      const url = payload?.url;
      if (!url) return false;

      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return false;
        }
      } catch {
        return false;
      }

      if (!allowOpenTabFromSender(sender)) {
        return false;
      }

      const createProperties = {
        url,
        active: payload?.active !== false
      };

      // 如果是由网页内容脚本触发，将新标签页定位在原标签页紧邻右侧，并绑定父子关联
      if (sender && sender.tab) {
        if (typeof sender.tab.index === 'number') {
          createProperties.index = sender.tab.index + 1;
        }
        if (typeof sender.tab.id === 'number') {
          createProperties.openerTabId = sender.tab.id;
        }
        if (typeof sender.tab.windowId === 'number') {
          createProperties.windowId = sender.tab.windowId;
        }
      }

      const tab = await createTabWithRetry(createProperties);
      return { tabId: tab.id };
    },

    // === 智能收纳与规则相关 ===
    [ActionTypes.EVALUATE_TABS]: async () => {
      return await stashService.evaluateAllTabs(activityTracker.getStats());
    },

    [ActionTypes.EXECUTE_STASH]: async (payload) => {
      // 手动点击按钮默认为 forceAll: true 全量收纳
      const forceAll = payload?.forceAll !== false;
      const res = await stashService.executeStash(activityTracker.getStats(), { forceAll });
      DeviceEventLog.append('stash_executed', { via: 'manual', success: res?.success !== false }).catch(() => {});
      return res;
    },

    [ActionTypes.GET_TAB_ACTIVITY_STATS]: async () => {
      return activityTracker.getStats();
    },

    [ActionTypes.GET_COUNTDOWN_STATUS]: async () => {
      return thresholdMonitor.getCountdownStatus();
    },

    [ActionTypes.CANCEL_AUTO_STASH]: async (payload, sender) => {
      return thresholdMonitor.handleCancelAutoStash({
        nonce: payload?.nonce,
        requireNonce: classifySender(sender) === 'content'
      });
    },

    [ActionTypes.CONFIRM_AUTO_STASH]: async (payload, sender) => {
      return await thresholdMonitor.handleConfirmAutoStash({
        nonce: payload?.nonce,
        requireNonce: classifySender(sender) === 'content'
      });
    },

    [ActionTypes.GET_TAB_COUNT_INFO]: async () => {
      const [tabs, config] = await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        StorageAdapter.getUserConfig()
      ]);
      return {
        currentCount: filterCountableTabs(tabs).length,
        threshold: Number.isFinite(config.tabThreshold) ? Math.max(1, Math.floor(config.tabThreshold)) : 15
      };
    },

    // === 收纳箱数据管理相关 ===
    [ActionTypes.GET_STASH_GROUPS]: async () => {
      return await LocalStashRepository.getAllGroups();
    },

    [ActionTypes.GET_STASH_GROUP_SUMMARIES]: async (payload) => {
      return await LocalStashRepository.listGroupSummaries({
        previewLimit: payload?.previewLimit
      });
    },

    [ActionTypes.GET_STASH_STATS]: async () => {
      return await LocalStashRepository.getStashStats();
    },

    [ActionTypes.GET_STASH_TIMELINE_BUCKETS]: async () => {
      return await LocalStashRepository.listTimelineBuckets();
    },

    [ActionTypes.GET_STASH_GROUP_SUMMARIES_PAGE]: async (payload) => {
      return await LocalStashRepository.listGroupSummariesPage({
        cursor: payload?.cursor,
        limit: payload?.limit,
        previewLimit: payload?.previewLimit,
        createdAtFrom: payload?.createdAtFrom,
        createdAtTo: payload?.createdAtTo
      });
    },

    [ActionTypes.RESTORE_STASH_GROUP]: async (payload) => {
      const { groupId, removeAfterRestore } = payload || {};
      const res = await StashService.restoreGroup(groupId, removeAfterRestore);
      return res;
    },

    [ActionTypes.RESTORE_STASH_ITEM]: async (payload) => {
      const { groupId, itemId, removeAfterRestore } = payload || {};
      const res = await StashService.restoreItem(groupId, itemId, removeAfterRestore);
      return res;
    },

    [ActionTypes.DELETE_STASH_GROUP]: async (payload) => {
      const groupId = payload?.groupId;
      const res = await LocalStashRepository.deleteGroup(groupId, payload?.force === true);
      return res;
    },

    [ActionTypes.DELETE_STASH_ITEM]: async (payload) => {
      const { groupId, itemId } = payload || {};
      const res = await LocalStashRepository.deleteTabItem(groupId, itemId);
      return res;
    },

    [ActionTypes.CLEAR_ALL_STASH]: async () => {
      const res = await LocalStashRepository.clearAll();
      return res;
    },

    [ActionTypes.DEDUPLICATE_STASH_DATA]: async () => {
      return await LocalStashRepository.deduplicateGroups();
    },

    [ActionTypes.IMPORT_STASH_DATA]: async (payload) => {
      const jsonString = payload?.jsonString || '';
      const res = await LocalStashRepository.importDataJSON(jsonString);
      return res;
    },

    [ActionTypes.EXPORT_STASH_DATA]: async () => {
      return await LocalStashRepository.exportDataJSON();
    },

    [ActionTypes.EXPORT_FULL_BACKUP]: async () => {
      return await LocalStashRepository.exportFullBackupJSON();
    },

    [ActionTypes.RESTORE_FULL_BACKUP]: async (payload) => {
      const jsonString = payload?.jsonString || '';
      const res = await LocalStashRepository.restoreFullBackupJSON(jsonString);
      notifyExtensionPages(ActionTypes.NOTIFY_CONFIG_UPDATED, {});
      notifyExtensionPages(ActionTypes.NOTIFY_RULE_UPDATED, {});
      await notifyLinkFrames({ global: true });
      return res;
    },

    [ActionTypes.IMPORT_THIRD_PARTY_DATA]: async (payload) => {
      const textString = payload?.textString || '';
      const res = await LocalStashRepository.importThirdPartyData(textString);
      return res;
    },

    [ActionTypes.EXPORT_ONETAB_TEXT]: async () => {
      return await LocalStashRepository.exportToOneTabText();
    },

    // === 收纳条目与检索（AI 增强，人类 UI 经同一动作亦可调用）===
    [ActionTypes.ADD_STASH_ITEM]: async (payload) => {
      return await LocalStashRepository.addTabItemToGroup(payload?.groupId, payload?.item);
    },

    [ActionTypes.UPDATE_STASH_ITEM]: async (payload) => {
      return await LocalStashRepository.updateTabItem(payload?.groupId, payload?.itemId, payload?.updates);
    },

    [ActionTypes.SEARCH_STASH]: async (payload) => {
      const keyword = typeof payload === 'string' ? payload : (payload?.keyword ?? payload?.query ?? '');
      const limit = Math.min(500, Math.max(1, Math.floor(Number(payload?.limit) || 100)));
      const raw = await LocalStashRepository.searchStash(keyword, limit, {
        cursor: payload?.cursor,
        paginated: payload?.paginated === true
      });
      if (payload?.paginated === true) {
        const items = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []);
        return {
          success: true,
          data: items,
          items,
          nextCursor: raw?.nextCursor || null,
          hasMore: Boolean(raw?.hasMore && raw?.nextCursor)
        };
      }
      const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
      return items;
    },

    [ActionTypes.GET_STASH_GROUP_PAGE]: async (payload) => {
      return await LocalStashRepository.getGroupPage(payload?.groupId, {
        offset: payload?.offset,
        limit: payload?.limit,
        cursor: payload?.cursor
      });
    },

    [ActionTypes.READ_EXPORT_CHUNK]: async (payload) => {
      return await LocalStashRepository.readExportChunk({
        type: payload?.type,
        cursor: payload?.cursor,
        maxChars: payload?.maxChars,
        expectedStashRevision: payload?.expectedStashRevision
      });
    },

    // === 自动备份管理（AI 增强）===
    [ActionTypes.LIST_AUTO_BACKUPS]: async () => {
      return await LocalStashRepository.listAutoBackups();
    },

    [ActionTypes.RESTORE_AUTO_BACKUP]: async (payload) => {
      return await LocalStashRepository.restoreAutoBackup(payload?.createdAt);
    },

    [ActionTypes.DELETE_AUTO_BACKUP]: async (payload) => {
      return await LocalStashRepository.deleteAutoBackup(payload?.createdAt);
    },

    // === 配置管理相关 ===
    [ActionTypes.GET_CONFIG]: async () => {
      return await StorageAdapter.getUserConfig();
    },

    [ActionTypes.UPDATE_CONFIG]: async (payload) => {
      const partial = payload || {};
      const res = await StorageAdapter.updateUserConfig(partial);
      const config = await StorageAdapter.getUserConfig();
      aiBridge?.onConfigUpdated(config);
      SyncScheduler.onConfigUpdated(config);
      notifyExtensionPages(ActionTypes.NOTIFY_CONFIG_UPDATED, partial);
      if (partial.globalLinkRule) await notifyLinkFrames({ global: true });
      return res;
    },

    [ActionTypes.RESET_CONFIG]: async () => {
      const res = await StorageAdapter.replaceUserConfig(DefaultConfig);
      const config = await StorageAdapter.getUserConfig();
      aiBridge?.onConfigUpdated(config);
      SyncScheduler.onConfigUpdated(config);
      notifyExtensionPages(ActionTypes.NOTIFY_CONFIG_UPDATED, DefaultConfig);
      await notifyLinkFrames({ global: true });
      return res;
    },

    [ActionTypes.UPDATE_STASH_GROUP]: async (payload) => {
      const { groupId, updates } = payload || {};
      return await LocalStashRepository.updateGroup(groupId, updates);
    },

    [ActionTypes.RESTORE_STASH_GROUP_DATA]: async (payload) => {
      return await LocalStashRepository.restoreGroupSnapshot(payload?.group);
    },

    [ActionTypes.OPEN_OPTIONS_PAGE]: async (payload) => {
      const targetTab = payload?.tab || 'stash-settings';
      const targetUrl = chrome.runtime.getURL(`src/options/options.html#${targetTab}`);
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const existingOptionsTab = tabs.find((t) => isOwnOptionsUrl(t.url));

        if (existingOptionsTab) {
          await chrome.tabs.update(existingOptionsTab.id, {
            url: targetUrl,
            active: true
          });
          MessageBus.sendToTab(existingOptionsTab.id, 'SWITCH_OPTIONS_TAB', { tab: targetTab }, 800).catch(() => {});
        } else {
          await chrome.tabs.create({
            url: targetUrl,
            active: true
          });
        }
      } catch {
        chrome.runtime.openOptionsPage();
      }
      return true;
    },

    [ActionTypes.OPEN_PINNED_STASH_TAB]: async () => {
      await StashService.ensurePinnedStashTab(true);
      return true;
    },

    // === WebDAV 云端同步 ===
    [ActionTypes.GET_SYNC_STATUS]: async () => {
      return await SyncEngine.getStatus();
    },

    [ActionTypes.SAVE_WEBDAV_CREDENTIALS]: async (payload) => {
      try {
        await WebdavCredentials.save(payload || {});
        // 同步非机密的启用开关到用户配置
        const partial = {};
        if (payload && typeof payload.enabled === 'boolean') partial.enabled = payload.enabled;
        if (payload && typeof payload.autoSync === 'boolean') partial.autoSync = payload.autoSync;
        if (typeof payload?.serverUrl === 'string') partial.serverUrl = payload.serverUrl.trim();
        if (Object.keys(partial).length > 0) {
          await StorageAdapter.updateUserConfig({ webdavSync: partial });
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    [ActionTypes.TEST_WEBDAV_CONNECTION]: async () => {
      return await SyncEngine.testConnection();
    },

    [ActionTypes.RUN_SYNC_NOW]: async () => {
      return await SyncScheduler.runNow();
    },

    [ActionTypes.LIST_SYNC_CONFLICTS]: async () => {
      return await SyncMerge.listConflicts();
    },

    [ActionTypes.RESOLVE_SYNC_CONFLICT]: async (payload) => {
      return await SyncMerge.resolveConflict(payload?.conflictId, payload?.choice);
    },

    [ActionTypes.LIST_SYNC_DEVICES]: async () => {
      return await SyncEngine.listDevices();
    },

    [ActionTypes.RETIRE_SYNC_DEVICE]: async (payload) => {
      return await SyncEngine.retireDevice(payload?.deviceId);
    },

    [ActionTypes.GET_SYNC_RECOVERY_INFO]: async () => {
      return await SyncEngine.getRecoveryInfo();
    },

    [ActionTypes.FALLBACK_PREVIOUS_SNAPSHOT]: async () => {
      const info = await SyncEngine.getRecoveryInfo();
      const previousId = info?.previousSnapshotId || '';
      if (!previousId) {
        const local = await SyncEngine.rebuildFromScratch({ confirm: true });
        return local.success
          ? { success: true, source: local.source, message: '已从本机快照恢复' }
          : { success: false, error: local.error || '没有可回退的上一份快照' };
      }
      const creds = await WebdavCredentials.get();
      const client = creds.serverUrl ? SyncEngine._client(creds) : null;
      const payload = client
        ? await SyncEngine.fallbackToPreviousSnapshot(client, previousId)
        : (await SyncSnapshot.getLocal(previousId))?.payload || null;
      if (!payload) return { success: false, error: '上一份快照不可用' };
      await IndexedDBManager.withWriteLock(async () => {
        await SyncSnapshot.applyPayload(payload, { merge: false });
      });
      await SyncEngine._setStatus(SyncStatus.IDLE, '已回退上一份快照', { appliedSnapshotId: previousId });
      return { success: true, source: 'previous-snapshot', message: '已回退上一份快照' };
    },

    [ActionTypes.REBUILD_SYNC_FROM_SCRATCH]: async (payload) => {
      return await SyncEngine.rebuildFromScratch({ confirm: payload?.confirm === true });
    },

    // === AI 桥接自身（选项页与 Agent 共用）===
    [ActionTypes.GET_AI_CAPABILITIES]: async () => {
      const manifest = chrome.runtime.getManifest?.() || {};
      return buildCapabilitiesDescriptor({
        softwareVersion: manifest.version_name || manifest.version || '',
        availableActions: Object.keys(handlers)
      });
    },

    [ActionTypes.GET_AI_BRIDGE_STATUS]: async () => {
      return aiBridge
        ? aiBridge.getStatusSummary()
        : { armed: false, state: 'unavailable', extensionId: chrome.runtime.id || '' };
    },

    // === 统一运行日志 ===
    [ActionTypes.QUERY_RUNTIME_LOGS]: async (payload) => {
      return await RuntimeLogRepository.query(payload || {});
    },

    [ActionTypes.CLEAR_RUNTIME_LOGS]: async (payload) => {
      if (payload?.confirm !== true) return { success: false, error: '请先确认清空运行日志' };
      return await RuntimeLogRepository.clear();
    },

    // === 站点图标解析（避免扩展页直连第三方触发 PNA/CORS 与归档历史泄露）===
    [ActionTypes.RESOLVE_FAVICON_DATA_URL]: async (payload) => {
      const rawUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
      const pageUrl = typeof payload?.pageUrl === 'string' ? payload.pageUrl.trim() : '';
      if (!rawUrl && !pageUrl) return { success: false, dataUrl: '' };

      // Chrome 内部图标地址无法被扩展页直接加载；真实 favIconUrl 往往在 CDN 上，
      // 不能只按「图标主机」去撞 /favicon.ico，否则 GitHub/YouTube 等站点会永远停在默认图标。
      const candidates = buildFaviconCandidates(rawUrl || pageUrl, pageUrl);
      if (candidates.length === 0) return { success: false, dataUrl: '' };

      for (const url of candidates) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT_MS);
          let res;
          try {
            res = await fetch(url, {
              credentials: 'omit',
              redirect: 'follow',
              signal: controller.signal
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (buf.byteLength === 0 || buf.byteLength > FAVICON_MAX_BYTES) continue;
          const bytes = new Uint8Array(buf);
          const mime = resolveFaviconMime(res.headers.get('content-type'), bytes);
          if (!mime) continue;
          let bin = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          return { success: true, dataUrl: `data:${mime};base64,${btoa(bin)}` };
        } catch {
          continue;
        }
      }
      return { success: false, dataUrl: '' };
    },

    // === 主页与新标签页 ===
    [ActionTypes.GET_SEARCH_SUGGESTIONS]: async (payload) => {
      const config = await StorageAdapter.getUserConfig();
      if (!config.home?.enableExternalSuggest || !config.home?.externalSuggestAgreed) {
        return {
          success: false,
          agreed: false,
          error: '外部联想建议未开启或未取得用户明确同意',
          suggestions: []
        };
      }

      const engine = payload?.engine === 'bing' ? 'bing' : 'google';
      const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
      if (!query) {
        return { success: true, agreed: true, engine, query: '', suggestions: [] };
      }

      const cacheKey = `${engine}:${query}`;
      const cached = getCachedSuggestions(cacheKey);
      if (cached) {
        return { success: true, agreed: true, engine, query, suggestions: cached };
      }

      const builder = SUGGEST_URL_BUILDERS[engine];
      if (!builder) {
        return { success: false, agreed: true, engine, query, suggestions: [], error: '不支持的联想引擎' };
      }

      const url = builder(query);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(url, {
            credentials: 'omit',
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          return { success: false, agreed: true, engine, query, suggestions: [], error: `联想服务响应异常 (${res.status})` };
        }

        const data = await res.json();
        // 外部关闭在途返回保护：请求完成时再次复核配置，若用户在请求在途期间关闭则绝不返回
        const latestConfig = await StorageAdapter.getUserConfig();
        if (!latestConfig.home?.enableExternalSuggest || !latestConfig.home?.externalSuggestAgreed) {
          return {
            success: false,
            agreed: false,
            error: '外部联想建议已关闭或未取得用户明确同意',
            suggestions: []
          };
        }

        const rawList = Array.isArray(data?.[1]) ? data[1] : [];
        const suggestions = rawList
          .filter((item) => typeof item === 'string')
          .slice(0, 10);

        setCachedSuggestions(cacheKey, suggestions);
        return { success: true, agreed: true, engine, query, suggestions };
      } catch (err) {
        return {
          success: false,
          agreed: true,
          engine,
          query,
          suggestions: [],
          error: err?.name === 'AbortError' ? '联想请求超时' : (err?.message || '联想服务请求失败')
        };
      }
    },

    [ActionTypes.CHECK_HISTORY_PERMISSION]: async () => {
      try {
        const hasHistoryApi = typeof chrome !== 'undefined' && Boolean(chrome.history?.search);
        const hasPermission = typeof chrome !== 'undefined' && chrome.permissions?.contains
          ? await chrome.permissions.contains({ permissions: ['history'] })
          : false;
        return { success: true, granted: Boolean(hasHistoryApi && hasPermission) };
      } catch {
        return { success: true, granted: false };
      }
    },

    [ActionTypes.GET_BROWSER_HISTORY]: async (payload, sender) => {
      // 隐身模式保护：支持 sender.tab 存在及 sender.tab 缺失（popup/窗口上下文）场景
      if (await isIncognitoSender(sender)) {
        return { success: false, granted: false, error: '隐身模式下保护浏览历史', items: [] };
      }
      const hasPermission = typeof chrome !== 'undefined' && chrome.permissions?.contains
        ? await chrome.permissions.contains({ permissions: ['history'] })
        : false;
      if (!hasPermission || !chrome.history?.search) {
        return { success: false, granted: false, error: '未授予历史记录读取权限', items: [] };
      }

      const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
      const limit = Math.min(100, Math.max(1, Number(payload?.limit) || 20));
      const startTime = Number(payload?.startTime) || 0;

      try {
        const rawItems = await chrome.history.search({
          text: query,
          maxResults: limit,
          startTime
        });
        // 权限撤销在途泄漏防护：查询完成后复核权限，若在途期间已撤销则绝不返回
        const stillPermitted = typeof chrome !== 'undefined' && chrome.permissions?.contains
          ? await chrome.permissions.contains({ permissions: ['history'] })
          : true;
        if (!stillPermitted) {
          return { success: false, granted: false, error: '未授予历史记录读取权限', items: [] };
        }
        const items = (rawItems || []).map((item) => ({
          id: item.id,
          url: item.url || '',
          title: item.title || item.url || '无标题页面',
          lastVisitTime: item.lastVisitTime || 0,
          visitCount: Number(item.visitCount) || 1
        }));
        return { success: true, granted: true, items };
      } catch (err) {
        return { success: false, granted: true, items: [], error: err?.message || '读取历史记录失败' };
      }
    },

    [ActionTypes.GET_HISTORY_RECOMMENDATIONS]: async (payload, sender) => {
      // 隐身模式保护：支持 sender.tab 存在及 sender.tab 缺失（popup/窗口上下文）场景
      if (await isIncognitoSender(sender)) {
        return { success: true, granted: false, recent: [], topVisited: [], message: '隐身模式保护' };
      }
      const hasPermission = typeof chrome !== 'undefined' && chrome.permissions?.contains
        ? await chrome.permissions.contains({ permissions: ['history'] })
        : false;
      if (!hasPermission || !chrome.history?.search) {
        return { success: true, granted: false, recent: [], topVisited: [], message: '未授予历史记录读取权限' };
      }

      const limit = Math.min(20, Math.max(1, Number(payload?.limit) || 8));
      const now = Date.now();

      try {
        // 1. 最近访问推荐：候选范围近 7 天
        const recentRaw = await chrome.history.search({
          text: '',
          maxResults: limit * 3,
          startTime: now - 7 * 86400000
        });
        const recent = (recentRaw || [])
          .filter((item) => item.url && isHttpUrl(item.url))
          .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
          .slice(0, limit)
          .map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title || item.url,
            lastVisitTime: item.lastVisitTime || 0,
            candidateRange: '近 7 天'
          }));

        // 2. 常访网页推荐：候选范围近 30 天，按访问频次 visitCount 排序（标注访问次数，非时长）
        const topRaw = await chrome.history.search({
          text: '',
          maxResults: 150,
          startTime: now - 30 * 86400000
        });
        const topVisited = (topRaw || [])
          .filter((item) => item.url && isHttpUrl(item.url))
          .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0))
          .slice(0, limit)
          .map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title || item.url,
            visitCount: Number(item.visitCount) || 1,
            candidateRange: '近 30 天'
          }));

        // 权限撤销在途泄漏防护：查询完成后复核权限，若在途期间已撤销则绝不返回
        const stillPermitted = typeof chrome !== 'undefined' && chrome.permissions?.contains
          ? await chrome.permissions.contains({ permissions: ['history'] })
          : true;
        if (!stillPermitted) {
          return { success: true, granted: false, recent: [], topVisited: [], message: '未授予历史记录读取权限' };
        }

        return { success: true, granted: true, recent, topVisited };
      } catch (err) {
        return { success: false, granted: true, recent: [], topVisited: [], error: err?.message || '获取历史推荐失败' };
      }
    },

    [ActionTypes.GET_HOME_STATS]: async (payload, sender) => {
      try {
        let liveTabs = [];
        const targetWindowId = Number(payload?.windowId) || sender?.tab?.windowId;
        if (thresholdMonitor && typeof thresholdMonitor.getActiveWindowInfo === 'function') {
          const winInfo = await thresholdMonitor.getActiveWindowInfo(targetWindowId);
          liveTabs = winInfo?.tabs || [];
        } else if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
          if (targetWindowId) {
            liveTabs = await chrome.tabs.query({ windowId: targetWindowId }).catch(() => []);
          }
          if (liveTabs.length === 0 && chrome.windows?.getLastFocused) {
            const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] }).catch(() => null);
            if (win?.tabs?.length) liveTabs = win.tabs;
          }
          if (liveTabs.length === 0) {
            liveTabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
          }
        }
        const countableTabs = filterCountableTabs(liveTabs);
        const config = await StorageAdapter.getUserConfig();
        const stashStats = await LocalStashRepository.getStashStats();

        return {
          success: true,
          currentWindowCount: countableTabs.length,
          threshold: config.tabThreshold || 15,
          totalGroups: stashStats.totalGroups || 0,
          totalItems: stashStats.totalItems || 0
        };
      } catch (err) {
        return {
          success: false,
          currentWindowCount: 0,
          threshold: 15,
          totalGroups: 0,
          totalItems: 0,
          error: err?.message || '获取主页统计失败'
        };
      }
    }
  };

  handlers[ActionTypes.SET_DOMAIN_RULE] = handlers[ActionTypes.SET_LINK_RULE];
  handlers[ActionTypes.OPEN_ONE_TAB] = handlers[ActionTypes.OPEN_PINNED_STASH_TAB];
  return handlers;
}
