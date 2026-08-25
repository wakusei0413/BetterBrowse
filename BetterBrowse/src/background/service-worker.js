/**
 * @file service-worker.js
 * @description 后台服务主工作线程（事件调度、统一消息中枢与生命周期管理）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { DefaultConfig } from '../constants/config.js';
import { MigrationManager } from '../core/storage/migration.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { LinkService } from '../core/link/link-service.js';
import { StashService } from '../core/stash/stash-service.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { TabActivityTracker } from './activity-tracker.js';
import { ThresholdMonitor } from './threshold-monitor.js';
import { PinnedTabGuard } from './pinned-tab-guard.js';
import { ContextMenuManager } from './context-menu-manager.js';

// 初始化模块实例
const activityTracker = new TabActivityTracker();
const stashService = new StashService();
const pinnedTabGuard = new PinnedTabGuard();
ContextMenuManager.init();

const thresholdMonitor = new ThresholdMonitor({
  onStashRequested: async (targetWindowId = null) => {
    return await stashService.executeStash(activityTracker.getStats(), {
      forceAll: false,
      windowId: targetWindowId
    });
  },
  onOpenOptions: async () => {
    const targetUrl = chrome.runtime.getURL('src/options/options.html#stash-settings');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const existingOptionsTab = tabs.find((t) => t.url && t.url.includes('src/options/options.html'));
    if (existingOptionsTab) {
      await chrome.tabs.update(existingOptionsTab.id, { url: targetUrl, active: true });
      chrome.tabs.sendMessage(existingOptionsTab.id, {
        action: 'SWITCH_OPTIONS_TAB',
        payload: { tab: 'stash-settings' }
      }).catch(() => {});
    } else {
      await chrome.tabs.create({ url: targetUrl, active: true });
    }
  }
});

// 扩展安装/升级时运行迁移并强制死守首位固定小标签
chrome.runtime.onInstalled.addListener(async (details) => {
  console.info(`[ServiceWorker] 插件已安装/更新 (原因: ${details.reason})`);
  await MigrationManager.runMigrations();
  await StashService.ensureAllAllWindowsPinnedTab();
});

// 浏览器启动时自动守护
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(async () => {
    await StashService.ensureAllAllWindowsPinnedTab();
  });
}

/**
 * 向所有活跃标签页广播消息（双通道保障实时生效）
 * @param {string} action
 * @param {any} [data={}]
 */
async function broadcastToTabs(action, data = {}) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
        chrome.tabs.sendMessage(tab.id, { action, payload: data }).catch(() => {
          // 忽略未就绪或未注入内容脚本页面的通信错误
        });
      }
    }
  } catch (err) {
    console.warn('[ServiceWorker] 广播消息异常:', err);
  }
}

// 注册统一消息处理映射表
MessageBus.registerListener({
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

  [ActionTypes.OPEN_TAB_BACKGROUND]: async (payload, sender) => {
    const url = payload?.url;
    if (!url) return false;

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
    return res;
  },

  [ActionTypes.GET_TAB_ACTIVITY_STATS]: async () => {
    return activityTracker.getStats();
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
      currentCount: tabs.length,
      threshold: config.tabThreshold || 15
    };
  },

  // === 收纳箱数据管理相关 ===
  [ActionTypes.GET_STASH_GROUPS]: async () => {
    return await LocalStashRepository.getAllGroups();
  },

  [ActionTypes.RESTORE_STASH_GROUP]: async (payload) => {
    const { groupId, removeAfterRestore = true } = payload || {};
    const res = await StashService.restoreGroup(groupId, removeAfterRestore);
    broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
    return res;
  },

  [ActionTypes.RESTORE_STASH_ITEM]: async (payload) => {
    const { groupId, itemId, removeAfterRestore = true } = payload || {};
    const res = await StashService.restoreItem(groupId, itemId, removeAfterRestore);
    broadcastToTabs(ActionTypes.NOTIFY_STASH_UPDATED);
    return res;
  },

  [ActionTypes.DELETE_STASH_GROUP]: async (payload) => {
    const groupId = payload?.groupId;
    const res = await LocalStashRepository.deleteGroup(groupId);
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

  // === 配置管理相关 ===
  [ActionTypes.GET_CONFIG]: async () => {
    return await StorageAdapter.getUserConfig();
  },

  [ActionTypes.UPDATE_CONFIG]: async (payload) => {
    const res = await StorageAdapter.updateUserConfig(payload || {});
    broadcastToTabs(ActionTypes.NOTIFY_CONFIG_UPDATED, payload);
    return res;
  },

  [ActionTypes.RESET_CONFIG]: async () => {
    const res = await StorageAdapter.set(StorageKeys.USER_CONFIG, DefaultConfig);
    broadcastToTabs(ActionTypes.NOTIFY_CONFIG_UPDATED, DefaultConfig);
    return res;
  },

  [ActionTypes.UPDATE_STASH_GROUP]: async (payload) => {
    const { groupId, updates } = payload || {};
    return await LocalStashRepository.updateGroup(groupId, updates);
  },

  [ActionTypes.OPEN_OPTIONS_PAGE]: async (payload) => {
    const targetTab = payload?.tab || 'stash-settings';
    const targetUrl = chrome.runtime.getURL(`src/options/options.html#${targetTab}`);
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const existingOptionsTab = tabs.find((t) => t.url && t.url.includes('src/options/options.html'));

      if (existingOptionsTab) {
        await chrome.tabs.update(existingOptionsTab.id, {
          url: targetUrl,
          active: true
        });
        chrome.tabs.sendMessage(existingOptionsTab.id, {
          action: 'SWITCH_OPTIONS_TAB',
          payload: { tab: targetTab }
        }).catch(() => {});
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

  [ActionTypes.OPEN_ONE_TAB]: async () => {
    // 安全激活常驻首位的收纳箱页面
    await StashService.ensurePinnedStashTab(true);
    return true;
  }
});

