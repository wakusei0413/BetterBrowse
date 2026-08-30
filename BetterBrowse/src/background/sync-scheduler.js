/**
 * @file sync-scheduler.js
 * @description 云端同步调度（变更防抖、启动、定时拉取、手动立即同步）
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

  static init() {
    SyncOutbox.onDirty = () => this.scheduleDebounced();
    if (chrome.alarms?.create) {
      try {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_ALARM_MINUTES });
      } catch {
        // 部分测试环境无 alarms
      }
    }
    if (chrome.alarms?.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === ALARM_NAME) this.runSafe({ reason: 'alarm' });
      });
    }
    if (typeof addEventListener === 'function') {
      this._onlineHandler = () => this.runSafe({ reason: 'online' });
      addEventListener('online', this._onlineHandler);
    }
    setTimeout(() => this.runSafe({ reason: 'startup' }), 1500);
  }

  static scheduleDebounced() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.runSafe({ reason: 'debounce' }), SYNC_DEBOUNCE_MS);
  }

  static async runNow() {
    return await SyncEngine.run({ manual: true });
  }

  static async runSafe(context = {}) {
    try {
      const config = await StorageAdapter.getUserConfig();
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
