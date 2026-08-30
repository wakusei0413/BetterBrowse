/**
 * @file device-events.js
 * @description 跨设备可见、仅来源设备执行的倒计时 / 收纳事件
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { SyncOutbox } from './outbox.js';
import { SyncEntityTypes, SyncOps } from './sync-constants.js';

export const DeviceEventTypes = {
  COUNTDOWN_START: 'countdown_start',
  COUNTDOWN_CANCEL: 'countdown_cancel',
  COUNTDOWN_CONFIRM: 'countdown_confirm',
  STASH_EXECUTED: 'stash_executed'
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
      return record;
    });
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
