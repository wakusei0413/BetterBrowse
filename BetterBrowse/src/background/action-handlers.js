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
import { LinkMatcher } from '../core/link/link-matcher.js';
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

/**
 * 构建统一 action 处理映射
 * @param {object} deps - 依赖注入（实例型服务与宿主环境回调）
 * @param {StashService} deps.stashService - 收纳服务实例
 * @param {TabActivityTracker} deps.activityTracker - 活跃度统计实例
 * @param {ThresholdMonitor} deps.thresholdMonitor - 阈值监控实例
 * @param {(action: string, data?: any) => Promise<void>} deps.broadcastToTabs - 向内容脚本广播
 * @param {{ getStatusSummary: () => any, onConfigUpdated: (config: any) => void } | null} [deps.aiBridge] - AI 桥接管理器
 * @returns {Record<string, (payload: any, sender?: any) => Promise<any>>}
 */
export function createActionHandlers(deps) {
  const { stashService, activityTracker, thresholdMonitor, broadcastToTabs, aiBridge } = deps;

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
      broadcastToTabs(ActionTypes.NOTIFY_RULE_UPDATED, { domain, mode });
      return res;
    },

    [ActionTypes.GET_GLOBAL_LINK_RULE]: async () => {
      return await LinkService.getGlobalRule();
    },

    [ActionTypes.SET_GLOBAL_LINK_RULE]: async (payload) => {
      const { enabled, mode } = payload || {};
      const res = await LinkService.setGlobalRule(enabled, mode);
      broadcastToTabs(ActionTypes.NOTIFY_RULE_UPDATED, { global: true, enabled, mode });
      return res;
    },

    [ActionTypes.GET_DOMAIN_RULES]: async () => {
      return await LinkService.getAllRules();
    },

    [ActionTypes.GET_PAGE_LINK_CONTEXT]: async (_payload, sender) => {
      const senderUrl = sender?.tab?.url || sender?.url || '';
      const domain = LinkMatcher.extractDomain(senderUrl);
      const [rules, globalRule] = await Promise.all([
        LinkService.getAllRules(),
        LinkService.getGlobalRule()
      ]);
      return {
        domain,
        domainRule: domain ? (rules[domain] || 'auto') : 'auto',
        linkRules: rules && typeof rules === 'object' ? rules : {},
        globalLinkRule: globalRule
      };
    },

    [ActionTypes.REMOVE_DOMAIN_RULE]: async (payload) => {
      const res = await LinkService.removeDomainRule(payload?.domain);
      broadcastToTabs(ActionTypes.NOTIFY_RULE_UPDATED, { domain: payload?.domain, mode: 'auto' });
      return res;
    },

    [ActionTypes.CLEAR_DOMAIN_RULES]: async () => {
      const res = await LinkService.clearAllDomainRules();
      broadcastToTabs(ActionTypes.NOTIFY_RULE_UPDATED, { clearAll: true });
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

      const tab = await chrome.tabs.create(createProperties);
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
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      DeviceEventLog.append('stash_executed', { via: 'manual', success: res?.success !== false }).catch(() => {});
      return res;
    },

    [ActionTypes.GET_TAB_ACTIVITY_STATS]: async () => {
      return activityTracker.getStats();
    },

    [ActionTypes.GET_COUNTDOWN_STATUS]: async () => {
      return thresholdMonitor.getCountdownStatus();
    },

    [ActionTypes.CANCEL_AUTO_STASH]: async () => {
      return thresholdMonitor.handleCancelAutoStash();
    },

    [ActionTypes.CONFIRM_AUTO_STASH]: async () => {
      const res = await thresholdMonitor.handleConfirmAutoStash();
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
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

    [ActionTypes.RESTORE_STASH_GROUP]: async (payload) => {
      const { groupId, removeAfterRestore } = payload || {};
      const res = await StashService.restoreGroup(groupId, removeAfterRestore);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.RESTORE_STASH_ITEM]: async (payload) => {
      const { groupId, itemId, removeAfterRestore } = payload || {};
      const res = await StashService.restoreItem(groupId, itemId, removeAfterRestore);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.DELETE_STASH_GROUP]: async (payload) => {
      const groupId = payload?.groupId;
      const res = await LocalStashRepository.deleteGroup(groupId, payload?.force === true);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.DELETE_STASH_ITEM]: async (payload) => {
      const { groupId, itemId } = payload || {};
      const res = await LocalStashRepository.deleteTabItem(groupId, itemId);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.CLEAR_ALL_STASH]: async () => {
      const res = await LocalStashRepository.clearAll();
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.DEDUPLICATE_STASH_DATA]: async () => {
      const res = await LocalStashRepository.deduplicateGroups();
      if (res.success) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.IMPORT_STASH_DATA]: async (payload) => {
      const jsonString = payload?.jsonString || '';
      const res = await LocalStashRepository.importDataJSON(jsonString);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
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
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      broadcastToTabs(ActionTypes.NOTIFY_RULE_UPDATED);
      broadcastToTabs(ActionTypes.NOTIFY_CONFIG_UPDATED);
      return res;
    },

    [ActionTypes.IMPORT_THIRD_PARTY_DATA]: async (payload) => {
      const textString = payload?.textString || '';
      const res = await LocalStashRepository.importThirdPartyData(textString);
      broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      return res;
    },

    [ActionTypes.EXPORT_ONETAB_TEXT]: async () => {
      return await LocalStashRepository.exportToOneTabText();
    },

    // === 收纳条目与检索（AI 增强，人类 UI 经同一动作亦可调用）===
    [ActionTypes.ADD_STASH_ITEM]: async (payload) => {
      const res = await LocalStashRepository.addTabItemToGroup(payload?.groupId, payload?.item);
      if (res?.success && res.added) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.UPDATE_STASH_ITEM]: async (payload) => {
      const res = await LocalStashRepository.updateTabItem(payload?.groupId, payload?.itemId, payload?.updates);
      if (res) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.SEARCH_STASH]: async (payload) => {
      const limit = Math.min(500, Math.max(1, Math.floor(Number(payload?.limit) || 100)));
      return await LocalStashRepository.searchStash(payload?.keyword, limit);
    },

    [ActionTypes.GET_STASH_GROUP_PAGE]: async (payload) => {
      return await LocalStashRepository.getGroupPage(payload?.groupId, {
        offset: payload?.offset,
        limit: payload?.limit
      });
    },

    // === 自动备份管理（AI 增强）===
    [ActionTypes.LIST_AUTO_BACKUPS]: async () => {
      return await LocalStashRepository.listAutoBackups();
    },

    [ActionTypes.RESTORE_AUTO_BACKUP]: async (payload) => {
      const res = await LocalStashRepository.restoreAutoBackup(payload?.createdAt);
      if (res?.success) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.DELETE_AUTO_BACKUP]: async (payload) => {
      return await LocalStashRepository.deleteAutoBackup(payload?.createdAt);
    },

    // === 配置管理相关 ===
    [ActionTypes.GET_CONFIG]: async () => {
      return await StorageAdapter.getUserConfig();
    },

    [ActionTypes.UPDATE_CONFIG]: async (payload) => {
      const res = await StorageAdapter.updateUserConfig(payload || {});
      broadcastToTabs(ActionTypes.NOTIFY_CONFIG_UPDATED, payload);
      // AI 桥接开关变化需即时生效（连接 / 断开本机通道）
      aiBridge?.onConfigUpdated(await StorageAdapter.getUserConfig());
      return res;
    },

    [ActionTypes.RESET_CONFIG]: async () => {
      const res = await StorageAdapter.replaceUserConfig(DefaultConfig);
      broadcastToTabs(ActionTypes.NOTIFY_CONFIG_UPDATED, DefaultConfig);
      aiBridge?.onConfigUpdated(await StorageAdapter.getUserConfig());
      return res;
    },

    [ActionTypes.UPDATE_STASH_GROUP]: async (payload) => {
      const { groupId, updates } = payload || {};
      const res = await LocalStashRepository.updateGroup(groupId, updates);
      // 广播收纳数据变更，保证其他上下文（如已打开的收纳箱页）即时刷新
      if (res) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.RESTORE_STASH_GROUP_DATA]: async (payload) => {
      const res = await LocalStashRepository.restoreGroupSnapshot(payload?.group);
      if (res?.success) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
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

    // === 30 天回收站 ===
    [ActionTypes.LIST_RECYCLE_BIN]: async () => {
      return await LocalStashRepository.listRecycleBin();
    },

    [ActionTypes.RESTORE_RECYCLE_BIN_ITEM]: async (payload) => {
      const res = await LocalStashRepository.restoreFromRecycleBin(payload?.tombstoneId);
      if (res?.success) {
        broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
      }
      return res;
    },

    [ActionTypes.PURGE_RECYCLE_BIN_ITEM]: async (payload) => {
      return await LocalStashRepository.purgeRecycleBinItem(payload?.tombstoneId);
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
    }
  };

  handlers[ActionTypes.SET_DOMAIN_RULE] = handlers[ActionTypes.SET_LINK_RULE];
  handlers[ActionTypes.OPEN_ONE_TAB] = handlers[ActionTypes.OPEN_PINNED_STASH_TAB];
  return handlers;
}
