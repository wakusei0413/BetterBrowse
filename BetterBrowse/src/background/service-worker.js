/**
 * @file service-worker.js
 * @description 后台服务主工作线程（事件调度、统一消息中枢与生命周期管理）
 * @encoding UTF-8
 */

import { API_VERSION } from '../constants/api-version.js';
import { ActionTypes } from '../constants/action-types.js';
import { MigrationManager } from '../core/storage/migration.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { StashService } from '../core/stash/stash-service.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { TabActivityTracker } from './activity-tracker.js';
import { ThresholdMonitor } from './threshold-monitor.js';
import { PinnedTabGuard } from './pinned-tab-guard.js';
import { ContextMenuManager } from './context-menu-manager.js';
import { SyncScheduler } from './sync-scheduler.js';
import { AccountConfigSync } from '../core/sync/account-config-sync.js';
import { isOwnOptionsUrl } from '../core/extension-url.js';
import { createActionHandlers } from './action-handlers.js';
import { AIBridgeManager } from './ai-bridge.js';
import { installRuntimeLogger } from '../core/logging/runtime-logger.js';
import { RuntimeLogRepository } from '../core/logging/runtime-log-repository.js';
import { DeviceEventLog } from '../core/sync/device-events.js';
import { isTrustedPopupLifecyclePort } from '../core/security/message-authorizer.js';

installRuntimeLogger({
  context: 'background',
  write: (entry) => RuntimeLogRepository.append(entry)
});

// 初始化模块实例
const softwareManifest = chrome.runtime.getManifest?.() || {};
const softwareVersion = softwareManifest.version_name || softwareManifest.version || '';
console.info(`[ServiceWorker] BetterBrowse 软件版本 ${softwareVersion}，API 版本 ${API_VERSION}`);
const activityTracker = new TabActivityTracker();
const stashService = new StashService();
const pinnedTabGuard = new PinnedTabGuard();
ContextMenuManager.init();

// 云端同步调度：变更防抖、启动拉取、定时器与网络恢复（未启用时自动跳过）
SyncScheduler.init();

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
    const existingOptionsTab = tabs.find((t) => isOwnOptionsUrl(t.url));
    if (existingOptionsTab) {
      await chrome.tabs.update(existingOptionsTab.id, { url: targetUrl, active: true });
      MessageBus.sendToTab(existingOptionsTab.id, 'SWITCH_OPTIONS_TAB', { tab: 'stash-settings' }, 800).catch(() => {});
    } else {
      await chrome.tabs.create({ url: targetUrl, active: true });
    }
  }
});

// 扩展安装/升级时运行迁移并强制死守首位固定小标签
chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[ServiceWorker] 插件已安装/更新 (原因: ${details.reason})`);
  (async () => {
    await MigrationManager.runMigrations();
    await AccountConfigSync.init();
    const config = await StorageAdapter.getUserConfig();
    if (config.stashSettings?.pinnedTabGuard !== false) await StashService.ensureAllAllWindowsPinnedTab();
  })().catch((err) => {
    console.warn('[ServiceWorker] 安装/更新初始化异常:', err?.message || err);
  });
});

// 浏览器启动时自动守护 + 迁移失败重试（迁移幂等，已完成时仅读取一次修订号）
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    (async () => {
      try {
        await MigrationManager.runMigrations();
      } catch (err) {
        console.warn('[ServiceWorker] 启动迁移重试异常:', err);
      }
      try {
        await AccountConfigSync.init();
      } catch (err) {
        console.warn('[ServiceWorker] 浏览器账号偏好同步初始化异常:', err);
      }
      const config = await StorageAdapter.getUserConfig();
      if (config.stashSettings?.pinnedTabGuard !== false) await StashService.ensureAllAllWindowsPinnedTab();
    })().catch((err) => {
      console.warn('[ServiceWorker] 浏览器启动初始化异常:', err?.message || err);
    });
  });
}

// Service Worker 冷启动兜底：确保未完成的存储迁移（如上次被休眠打断）尽快重试
// 迁移幂等可重入，已迁移完成时仅产生一次修订号读取，不影响事件响应
MigrationManager.runMigrations()
  .then(() => DeviceEventLog.migrateLegacyLogs())
  .catch((err) => {
    console.warn('[ServiceWorker] 存储迁移或历史事件日志归档异常:', err);
  })
  .then(() => AccountConfigSync.init())
  .catch((err) => {
    console.warn('[ServiceWorker] 浏览器账号偏好同步初始化异常:', err);
  });

/**
 * 向所有活跃标签页广播消息（双通道保障实时生效）
 * @param {string} action
 * @param {any} [data={}]
 */
async function broadcastToTabs(action, data = {}) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:') && !tab.url.startsWith('file://') && !tab.url.startsWith('chrome-extension://')) {
        MessageBus.sendToTab(tab.id, action, data, 400).catch(() => {
          // 忽略未就绪或未注入内容脚本页面的通信错误
        });
      }
    }
  } catch (err) {
    console.warn('[ServiceWorker] 广播消息异常:', err);
  }
}

try { chrome.action?.setBadgeText?.({ text: '' }); } catch {}

const aiBridge = new AIBridgeManager();

// 注册统一消息处理映射表（人类 UI 消息与 AI 桥接指令共用同一份，见 action-handlers.js）
const actionHandlers = createActionHandlers({
  stashService,
  activityTracker,
  thresholdMonitor,
  broadcastToTabs,
  aiBridge
});
const messageHandlers = {
  ...actionHandlers,
  // 来源授权由 MessageBus.registerListener 统一治理（内容脚本仅限白名单动作，
  // 未知来源拒绝），此处仅做日志写入
  [ActionTypes.APPEND_RUNTIME_LOG]: async (payload) => {
    await RuntimeLogRepository.append(payload || {});
    return { success: true };
  }
};
MessageBus.registerListener(messageHandlers);

// 弹窗打开后快速关闭视为扩展图标双击，直接执行当前窗口全量收纳
chrome.runtime.onConnect.addListener((port) => {
  if (!isTrustedPopupLifecyclePort(port)) return;
  const openedAt = Date.now();
  port.onDisconnect.addListener(() => {
    if (Date.now() - openedAt > 800) return;
    actionHandlers[ActionTypes.EXECUTE_STASH]({ forceAll: true }, null).catch((err) => {
      console.warn('[ServiceWorker] 双击快速收纳失败:', err?.message || err);
    });
  });
});

// AI 桥接初始化（开关默认关闭时仅挂载看门狗与状态，不建立本机通道；见 docs/03-ai-skill-bridge.md）
aiBridge.init(actionHandlers).catch((err) => {
  console.warn('[ServiceWorker] AI 桥接初始化异常:', err?.message || err);
});
