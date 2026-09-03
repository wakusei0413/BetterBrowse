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

/**
 * 判定响应内容是否为可用的图片类型（防止站点把登录页 HTML 当成图标返回）。
 * @param {string} contentType
 * @returns {boolean}
 */
function isImageContentType(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/**
 * 将 Chrome 内部图标地址（chrome-extension://<id>/_favicon/?pageUrl=...&size=32）
 * 还原为真实网页 URL。这类地址由 tab.favIconUrl 直接产生，扩展页无法自行加载，
 * 必须在后台还原后再按域名取图标。
 * @param {string} rawUrl
 * @returns {string|null}
 */
function unwrapChromeFaviconUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'chrome-extension:') return null;
    if (!/\/_favicon\/?$/.test(u.pathname)) return null;
    return u.searchParams.get('pageUrl') || null;
  } catch {
    return null;
  }
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
      const limit = Math.min(500, Math.max(1, Math.floor(Number(payload?.limit) || 100)));
      return await LocalStashRepository.searchStash(payload?.keyword, limit, {
        cursor: payload?.cursor,
        paginated: payload?.paginated === true
      });
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
      if (!rawUrl) return { success: false, dataUrl: '' };

      // Chrome 内部图标地址（chrome-extension://<id>/_favicon/?pageUrl=…）无法被扩展页
      // 直接加载，先还原出真实网页 URL 再走域名推导，否则这些条目永远显示默认图标
      const target = unwrapChromeFaviconUrl(rawUrl) || rawUrl;

      // 拒绝危险伪协议，杜绝后台被当作任意内容抓取代理
      if (!/^https?:\/\//i.test(target)) return { success: false, dataUrl: '' };

      // 候选顺序：域名根 /favicon.ico → 原始 favicon URL（若是图标路径）→ Google s2 兜底。
      // ⚠️ 绝不能把原始 URL 放在首位：调用方传入的可能是"网页 URL"而非图标 URL，
      // 直接抓取会拿到 HTML 页面（Content-Type: text/html），旧实现不校验类型就
      // 当成图标返回，前端 <img> 加载失败后只能静默回退成默认图标。
      const candidates = [];
      try {
        const u = new URL(target);
        candidates.push(`${u.origin}/favicon.ico`);
        if (/(?:^|\/)favicon\.ico$/i.test(u.pathname)) candidates.push(target);
        candidates.push(`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(u.hostname)}`);
      } catch {
        return { success: false, dataUrl: '' };
      }

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
          // 只接受图片响应：站点常把 404/登录页以 200 + text/html 返回
          if (!isImageContentType(res.headers.get('content-type'))) continue;
          const buf = await res.arrayBuffer();
          if (buf.byteLength === 0 || buf.byteLength > FAVICON_MAX_BYTES) continue;
          const mime = String(res.headers.get('content-type') || '').split(';')[0].trim() || 'image/x-icon';
          const bytes = new Uint8Array(buf);
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
    }
  };

  handlers[ActionTypes.SET_DOMAIN_RULE] = handlers[ActionTypes.SET_LINK_RULE];
  handlers[ActionTypes.OPEN_ONE_TAB] = handlers[ActionTypes.OPEN_PINNED_STASH_TAB];
  return handlers;
}
