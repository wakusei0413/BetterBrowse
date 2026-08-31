/**
 * @file snapshot.js
 * @description generation 快照的生成与应用（watermark 之后才重放操作）
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { SYNC_CLOCK_KEY, WEBDAV_FORMAT_REVISION, SyncEntityTypes } from './sync-constants.js';
import { sha256Hex } from './crypto-util.js';
import { AccountConfigSync } from './account-config-sync.js';
import { DeviceEventLog } from './device-events.js';

export class SyncSnapshot {
  /**
   * 导出当前可同步实体为快照对象（不含凭据与本地自动备份）
   * @returns {Promise<object>}
   */
  static async buildPayload() {
    return await IndexedDBManager.runTransaction(
      [
        IDBStores.PAGES,
        IDBStores.STASH_GROUPS,
        IDBStores.STASH_ENTRIES,
        IDBStores.SETTINGS,
        IDBStores.ACTIVITY_STATS,
        IDBStores.DEVICE_EVENTS,
        IDBStores.TOMBSTONES,
        IDBStores.SYNC_META
      ],
      'readonly',
      async (tx) => {
        const pages = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).getAll());
        const groups = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).getAll());
        const entries = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_ENTRIES).getAll());
        const settingsAll = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SETTINGS).getAll());
        const activity = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.ACTIVITY_STATS).get(StorageKeys.ACTIVITY_STATS)
        );
        const events = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.DEVICE_EVENTS).getAll());
        const tombs = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.TOMBSTONES).getAll());
        const clock = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SYNC_META).get(SYNC_CLOCK_KEY));

        const settings = {};
        for (const record of settingsAll || []) {
          if (record.key === StorageKeys.WEBDAV_CREDENTIALS) continue;
          if (record.key === StorageKeys.AUTO_BACKUPS) continue;
          settings[record.key] = record.value;
        }

        const liveTombs = (tombs || []).filter((item) => Number(item.expiresAt) > Date.now());
        const watermarks = {};
        if (clock?.value?.deviceId) {
          watermarks[clock.value.deviceId] = Number(clock.value.sequence) || 0;
        }

        return {
          formatVersion: WEBDAV_FORMAT_REVISION,
          createdAt: Date.now(),
          watermarks,
          pages: pages || [],
          stashGroups: groups || [],
          stashEntries: entries || [],
          settings,
          activityStats: activity?.value && typeof activity.value === 'object' ? activity.value : {},
          deviceEvents: events || [],
          tombstones: liveTombs
        };
      }
    );
  }

  /**
   * 序列化并计算 sha256
   * @param {object} payload
   */
  static async serialize(payload) {
    const body = JSON.stringify(payload);
    const sha256 = await sha256Hex(body);
    return { body, sha256 };
  }

  /**
   * 用快照覆盖本地可同步实体（调用方须持写锁）。凭据与自动备份保留。
   * @param {object} payload
   * @param {{ merge?: boolean }} [options] - merge=true 时不清空本地仓储，
   *   仅按快照墓碑执行删除，保护尚未同步的本地实体（新设备配对 / 离线期间创建的数据）
   */
  static async applyPayload(payload, { merge = false } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('快照载荷无效');
    await IndexedDBManager.runTransaction(
      [
        IDBStores.PAGES,
        IDBStores.STASH_GROUPS,
        IDBStores.STASH_ENTRIES,
        IDBStores.SETTINGS,
        IDBStores.ACTIVITY_STATS,
        IDBStores.DEVICE_EVENTS,
        IDBStores.TOMBSTONES
      ],
      'readwrite',
      async (tx) => {
        if (!merge) {
          tx.objectStore(IDBStores.PAGES).clear();
          tx.objectStore(IDBStores.STASH_GROUPS).clear();
          tx.objectStore(IDBStores.STASH_ENTRIES).clear();
          tx.objectStore(IDBStores.DEVICE_EVENTS).clear();
          tx.objectStore(IDBStores.TOMBSTONES).clear();
        }

        for (const page of payload.pages || []) {
          if (page?.pageId) tx.objectStore(IDBStores.PAGES).put(page);
        }
        for (const group of payload.stashGroups || []) {
          if (group?.groupId) tx.objectStore(IDBStores.STASH_GROUPS).put(group);
        }
        for (const entry of payload.stashEntries || []) {
          if (entry?.entryId) tx.objectStore(IDBStores.STASH_ENTRIES).put(entry);
        }
        for (const event of payload.deviceEvents || []) {
          if (event?.eventId) tx.objectStore(IDBStores.DEVICE_EVENTS).put(event);
        }
        for (const tomb of payload.tombstones || []) {
          if (!tomb?.tombstoneId) continue;
          tx.objectStore(IDBStores.TOMBSTONES).put(tomb);
          if (merge && Number(tomb.expiresAt) > Date.now()) {
            // 合并模式下按墓碑执行删除（替代清库语义），30 天内的删除不得被本地旧副本复活
            if (tomb.entityType === SyncEntityTypes.PAGE) {
              tx.objectStore(IDBStores.PAGES).delete(tomb.entityId);
            } else if (tomb.entityType === SyncEntityTypes.STASH_GROUP) {
              tx.objectStore(IDBStores.STASH_GROUPS).delete(tomb.entityId);
            } else if (tomb.entityType === SyncEntityTypes.STASH_ENTRY) {
              tx.objectStore(IDBStores.STASH_ENTRIES).delete(tomb.entityId);
            }
          }
        }

        const settingsStore = tx.objectStore(IDBStores.SETTINGS);
        const incomingSettings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
        for (const [key, value] of Object.entries(incomingSettings)) {
          if (key === StorageKeys.WEBDAV_CREDENTIALS || key === StorageKeys.AUTO_BACKUPS) continue;
          settingsStore.put({ key, value, updatedAt: Date.now() });
        }

        tx.objectStore(IDBStores.ACTIVITY_STATS).put({
          key: StorageKeys.ACTIVITY_STATS,
          value: payload.activityStats && typeof payload.activityStats === 'object' ? payload.activityStats : {},
          updatedAt: Date.now()
        });
      }
    );
    for (const event of payload.deviceEvents || []) {
      DeviceEventLog.appendRuntimeLog(event).catch(() => {});
    }
    AccountConfigSync.scheduleMirror();
  }

  /**
   * 缓存一份已校验的快照到本地 SNAPSHOTS 仓储（供损坏回退）
   * @param {string} snapshotId
   * @param {object} payload
   * @param {string} [sha256]
   */
  static async cacheLocal(snapshotId, payload, sha256 = '') {
    if (!snapshotId || !payload || typeof payload !== 'object') return;
    const match = String(snapshotId).match(/(\d+)/);
    const generation = match ? Number(match[1]) : 0;
    await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readwrite', async (tx) => {
      tx.objectStore(IDBStores.SNAPSHOTS).put({
        snapshotId,
        generation,
        createdAt: Number(payload.createdAt) || Date.now(),
        sha256: sha256 || '',
        payload
      });
    });
  }

  /**
   * 读取本地缓存的快照
   * @param {string} snapshotId
   * @returns {Promise<{ snapshotId: string, sha256?: string, payload?: object, createdAt?: number } | null>}
   */
  static async getLocal(snapshotId) {
    if (!snapshotId) return null;
    return await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SNAPSHOTS).get(snapshotId)) || null;
    });
  }

  /**
   * 列出本地缓存快照（按 createdAt 降序）
   * @returns {Promise<object[]>}
   */
  static async listLocal() {
    return await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SNAPSHOTS).getAll());
      return (all || []).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    });
  }

  /**
   * 过滤出快照 watermark 之后的操作
   * @param {object[]} operations
   * @param {Record<string, number>} watermarks
   */
  static filterAfterWatermark(operations, watermarks) {
    const marks = watermarks && typeof watermarks === 'object' ? watermarks : {};
    return (operations || []).filter((op) => {
      const seen = Number(marks[op.deviceId]) || 0;
      return Number(op.sequence) > seen;
    });
  }
}
