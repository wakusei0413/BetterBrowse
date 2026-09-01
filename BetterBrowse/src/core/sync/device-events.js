/**
 * @file device-events.js
 * @description 跨设备可见、仅来源设备执行的倒计时 / 收纳事件
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { SyncOutbox } from './outbox.js';
import { SyncEntityTypes, SyncOps } from './sync-constants.js';
import { RuntimeLogRepository } from '../logging/runtime-log-repository.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { StorageKeys } from '../../constants/storage-keys.js';

export const DeviceEventTypes = {
  COUNTDOWN_START: 'countdown_start',
  COUNTDOWN_CANCEL: 'countdown_cancel',
  COUNTDOWN_CONFIRM: 'countdown_confirm',
  STASH_EXECUTED: 'stash_executed'
};

const DEVICE_EVENT_LABELS = {
  [DeviceEventTypes.COUNTDOWN_START]: '开始收纳倒计时',
  [DeviceEventTypes.COUNTDOWN_CANCEL]: '取消收纳倒计时',
  [DeviceEventTypes.COUNTDOWN_CONFIRM]: '确认智能收纳',
  [DeviceEventTypes.STASH_EXECUTED]: '执行智能收纳'
};

export class DeviceEventLog {
  /**
   * 追加一条本机事件（自行持写锁，避免与倒计时调用方嵌套）
   * @param {string} type
   * @param {object} [payload]
   */
  static async append(type, payload = {}) {
    if (!(await SyncOutbox.isActive())) return null;
    return await IndexedDBManager.withWriteLock(async () => {
      const eventId = SyncOutbox.randomId('evt');
      const deviceId = await SyncOutbox.getDeviceId();
      const record = {
        eventId,
        deviceId,
        originDeviceId: deviceId,
        type,
        payload: payload && typeof payload === 'object' ? payload : {},
        createdAt: Date.now(),
        sequence: 0
      };
      await IndexedDBManager.runTransaction(
        [IDBStores.DEVICE_EVENTS, IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS],
        'readwrite',
        async (tx) => {
          const op = await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.DEVICE_EVENT,
            entityId: eventId,
            op: SyncOps.UPSERT,
            fields: {
              type,
              payload: record.payload,
              originDeviceId: deviceId
            }
          });
          record.sequence = op?.sequence || 0;
          tx.objectStore(IDBStores.DEVICE_EVENTS).put(record);
        }
      );
      SyncOutbox.flushDirty();
      this.appendRuntimeLog(record).catch(() => {});
      return record;
    });
  }

  static async appendRuntimeLog(event) {
    if (!event?.eventId) return null;
    const localDeviceId = await SyncOutbox.getDeviceId();
    const eventDeviceId = event.originDeviceId || event.deviceId || '';
    const deviceLabel = localDeviceId && eventDeviceId === localDeviceId ? '本机' : '其他设备';
    return await RuntimeLogRepository.append({
      id: `device-event-${event.eventId}`,
      ts: Number(event.createdAt) || Date.now(),
      level: event.payload?.success === false ? 'error' : 'info',
      source: '跨设备事件',
      context: 'sync',
      category: 'runtime',
      message: `${deviceLabel} ${DEVICE_EVENT_LABELS[event.type] || event.type || '未知事件'}`
    });
  }

  static async migrateLegacyLogs() {
    if ((await StorageAdapter.getChrome(StorageKeys.DEVICE_EVENTS_LOG_MIGRATED, false)) === true) return;
    const events = await this.listRecent(50);
    for (const event of [...events].reverse()) {
      await this.appendRuntimeLog(event);
    }
    await StorageAdapter.setChrome(StorageKeys.DEVICE_EVENTS_LOG_MIGRATED, true);
  }

  /**
   * 列出最近事件（新→旧）
   * @param {number} [limit=50]
   */
  static async listRecent(limit = 50) {
    return await IndexedDBManager.runTransaction([IDBStores.DEVICE_EVENTS], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.DEVICE_EVENTS).getAll());
      return (all || [])
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, Math.max(1, limit));
    });
  }
}
