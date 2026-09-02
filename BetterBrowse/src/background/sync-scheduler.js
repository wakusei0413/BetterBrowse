/**
 * @file sync-scheduler.js
 * @description 云端同步调度（变更防抖、浏览器启动、定时拉取、手动立即同步）
 * @encoding UTF-8
 */

import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { SyncEngine } from '../core/sync/sync-engine.js';
import { SyncOutbox } from '../core/sync/outbox.js';
import { SYNC_ALARM_MINUTES, SYNC_DEBOUNCE_MS } from '../core/sync/sync-constants.js';
import { ActionTypes } from '../constants/action-types.js';

const ALARM_NAME = 'better-browse-webdav-sync';

export class SyncScheduler {
  static _timer = null;
  static _onlineHandler = null;
  static _alarmHandler = null;
  static _initialized = false;
  static _autoSyncEnabled = null;

  /**
   * 同步注册长期事件监听，并按当前配置维护定时闹钟。
   * Service Worker 冷启动仅恢复调度状态，不冒充浏览器 startup 触发同步。
   */
  static init() {
    SyncOutbox.onDirty = () => this.scheduleDebounced();
    if (!this._initialized) {
      this._initialized = true;
      if (chrome.alarms?.onAlarm) {
        this._alarmHandler = (alarm) => {
          if (alarm?.name === ALARM_NAME) this.runSafe({ reason: 'alarm' });
        };
        chrome.alarms.onAlarm.addListener(this._alarmHandler);
      }
      if (typeof addEventListener === 'function') {
        this._onlineHandler = () => {
          if (this._autoSyncEnabled) this.runSafe({ reason: 'online' });
        };
        addEventListener('online', this._onlineHandler);
      }
    }
    this._refreshConfig().catch(() => {});
  }

  /**
   * 配置变更后即时创建或清理周期闹钟。
   * @param {any} config
   */
  static onConfigUpdated(config) {
    const enabled = config?.webdavSync?.enabled === true
      && config?.webdavSync?.autoSync !== false;
    this._autoSyncEnabled = enabled;
    if (!enabled) {
      clearTimeout(this._timer);
      this._timer = null;
      try {
        chrome.alarms?.clear?.(ALARM_NAME);
      } catch {
        // 测试环境或浏览器关闭过程中忽略清理异常
      }
      return;
    }
    try {
      chrome.alarms?.create?.(ALARM_NAME, { periodInMinutes: SYNC_ALARM_MINUTES });
    } catch {
      // 部分测试环境无 alarms
    }
  }

  /**
   * 仅供 chrome.runtime.onStartup 调用：浏览器真正启动时执行一次自动同步。
   */
  static async onStartup() {
    const config = await this._refreshConfig();
    if (!this._autoSyncEnabled) return { success: false, skipped: true };
    return await this.runSafe({ reason: 'startup', config });
  }

  static async _refreshConfig() {
    const config = await StorageAdapter.getUserConfig();
    this.onConfigUpdated(config);
    return config;
  }

  static scheduleDebounced() {
    if (this._autoSyncEnabled === false) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.runSafe({ reason: 'debounce' });
    }, SYNC_DEBOUNCE_MS);
  }

  static async runNow() {
    return await SyncEngine.run({ manual: true });
  }

  static async runSafe(context = {}) {
    try {
      const config = context.config || await this._refreshConfig();
      if (config.webdavSync?.enabled !== true) return { success: false, skipped: true };
      if (config.webdavSync?.autoSync === false && context.reason !== 'manual') {
        return { success: false, skipped: true };
      }
      const result = await SyncEngine.run({ manual: context.reason === 'manual' });
      this._broadcast(result);
      return result;
    } catch (err) {
      console.warn('[SyncScheduler] 同步异常:', err);
      return { success: false, error: err.message };
    }
  }

  static _broadcast(result) {
    try {
      chrome.runtime.sendMessage({
        action: ActionTypes.NOTIFY_SYNC_UPDATED,
        payload: result || {}
      }).catch(() => {});
    } catch {
      // 无接收方时忽略
    }
  }
}
