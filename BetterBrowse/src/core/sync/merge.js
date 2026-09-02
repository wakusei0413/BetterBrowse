/**
 * @file merge.js
 * @description 操作日志字段级合并、墓碑与冲突记录（按 docs/02-webdav-sync.md 第 5 节）
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { DefaultConfig } from '../../constants/config.js';
import { SyncEntityTypes, SyncOps, TOMBSTONE_TTL_MS } from './sync-constants.js';
import { SyncOutbox } from './outbox.js';
import { AccountConfigSync } from './account-config-sync.js';
import { DeviceEventLog } from './device-events.js';

const PAGE_OWNED_FIELDS = new Set(['title', 'url', 'favIconUrl', 'domain']);

export class SyncMerge {
  /**
   * 比较两个字段版本：1 采纳 incoming，-1 保留 local，0 冲突
   * @param {{ lamport?: number, deviceId?: string } | null} localRev
   * @param {{ lamport?: number, deviceId?: string } | null} incomingRev
   * @returns {number}
   */
  static compareFieldRev(localRev, incomingRev) {
    const localLamport = Number(localRev?.lamport) || 0;
    const incomingLamport = Number(incomingRev?.lamport) || 0;
    if (incomingLamport > localLamport) return 1;
    if (incomingLamport < localLamport) return -1;
    const localDevice = String(localRev?.deviceId || '');
    const incomingDevice = String(incomingRev?.deviceId || '');
    if (localDevice && incomingDevice && localDevice !== incomingDevice) return 0;
    if (incomingDevice > localDevice) return 1;
    if (incomingDevice < localDevice) return -1;
    return -1;
  }

  /**
   * 暂定展示值：lamport 相同则按 deviceId 字典序较大者
   * @param {{ lamport?: number, deviceId?: string }} a
   * @param {{ lamport?: number, deviceId?: string }} b
   */
  static preferredRev(a, b) {
    const cmp = this.compareFieldRev(a, b);
    if (cmp > 0) return b;
    if (cmp < 0) return a;
    return String(b?.deviceId || '') > String(a?.deviceId || '') ? b : a;
  }

  /**
   * 读取墓碑
   * @param {IDBTransaction} tx
   * @param {string} entityType
   * @param {string} entityId
   */
  static async getTombstone(tx, entityType, entityId) {
    const key = `${entityType}::${entityId}`;
    return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.TOMBSTONES).get(key));
  }

  /**
   * 在事务内写入墓碑
   */
  static putTombstone(tx, entityType, entityId, now = Date.now()) {
    tx.objectStore(IDBStores.TOMBSTONES).put({
      tombstoneId: `${entityType}::${entityId}`,
      entityType,
      entityId,
      deletedAt: now,
      expiresAt: now + TOMBSTONE_TTL_MS
    });
  }

  /**
   * 应用一批远端操作（调用方须已持写锁）
   * @param {object[]} operations
   * @param {{ originIsCloudTentative?: boolean }} [options]
   * @returns {Promise<{ applied: number, conflicts: number, skipped: number }>}
   */
  static async applyOperations(operations, options = {}) {
    const ops = Array.isArray(operations) ? operations : [];
    let applied = 0;
    let conflicts = 0;
    let skipped = 0;

    const clock = await SyncOutbox.getClock();
    let seenLamport = Number(clock?.seenLamport) || 0;

    for (const op of ops) {
      if (!op?.operationId || !op.entityType || !op.entityId) {
        skipped += 1;
        continue;
      }
      seenLamport = Math.max(seenLamport, Number(op.lamport) || 0);
      const result = await this._applyOne(op, { originIsCloudTentative: options.originIsCloudTentative === true });
      if (result === 'conflict') conflicts += 1;
      else if (result === 'applied') applied += 1;
      else skipped += 1;
    }

    await IndexedDBManager.runTransaction(
      [IDBStores.SYNC_META, IDBStores.OPERATION_LOGS],
      'readwrite',
      async (tx) => {
        const meta = tx.objectStore(IDBStores.SYNC_META);
        const clockRecord = await IndexedDBManager.requestToPromise(meta.get('clock'));
        if (clockRecord?.value) {
          clockRecord.value.seenLamport = Math.max(Number(clockRecord.value.seenLamport) || 0, seenLamport);
          meta.put({ key: 'clock', value: clockRecord.value, updatedAt: Date.now() });
        }
        const logs = tx.objectStore(IDBStores.OPERATION_LOGS);
        for (const op of ops) {
          if (!op?.operationId) continue;
          const existing = await IndexedDBManager.requestToPromise(logs.get(op.operationId));
          if (!existing) logs.put({ ...op, logId: op.operationId, appliedAt: Date.now() });
        }
      }
    );

    return { applied, conflicts, skipped };
  }

  /**
   * @param {object} op
   * @param {{ originIsCloudTentative?: boolean }} options
   * @returns {Promise<'applied' | 'conflict' | 'skipped'>}
   */
  static async _applyOne(op, options) {
    const already = await IndexedDBManager.runTransaction([IDBStores.OPERATION_LOGS], 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.OPERATION_LOGS).get(op.operationId));
    });
    if (already) return 'skipped';

    if (op.entityType === SyncEntityTypes.PAGE) return await this._applyPage(op, options);
    if (op.entityType === SyncEntityTypes.STASH_GROUP) return await this._applyGroup(op, options);
    if (op.entityType === SyncEntityTypes.STASH_ENTRY) return await this._applyEntry(op, options);
    if (op.entityType === SyncEntityTypes.SETTINGS) return await this._applySettings(op, options);
    if (op.entityType === SyncEntityTypes.LINK_RULES) return await this._applyLinkRules(op, options);
    if (op.entityType === SyncEntityTypes.ACTIVITY) return await this._applyActivity(op);
    if (op.entityType === SyncEntityTypes.DEVICE_EVENT) return await this._applyDeviceEvent(op);
    return 'skipped';
  }

  static async _applyPage(op, options) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.PAGES, IDBStores.TOMBSTONES, IDBStores.CONFLICTS],
      'readwrite',
      async (tx) => {
        const tomb = await this.getTombstone(tx, SyncEntityTypes.PAGE, op.entityId);
        if (tomb && tomb.expiresAt > Date.now() && op.op !== SyncOps.DELETE) return 'skipped';
        if (op.op === SyncOps.DELETE) {
          tx.objectStore(IDBStores.PAGES).delete(op.entityId);
          this.putTombstone(tx, SyncEntityTypes.PAGE, op.entityId);
          return 'applied';
        }
        const store = tx.objectStore(IDBStores.PAGES);
        const existing = (await IndexedDBManager.requestToPromise(store.get(op.entityId))) || {
          pageId: op.entityId,
          url: '',
          domain: '',
          title: '',
          favIconUrl: '',
          createdAt: op.createdAt || Date.now(),
          fieldRevs: {}
        };
        const merged = this._mergeFields(existing, op, tx, SyncEntityTypes.PAGE, op.entityId, options);
        existing.updatedAt = Date.now();
        existing.originDeviceId = op.deviceId;
        existing.revision = op.lamport;
        store.put(existing);
        return merged;
      }
    );
  }

  static async _applyGroup(op, options) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.TOMBSTONES, IDBStores.CONFLICTS],
      'readwrite',
      async (tx) => {
        const tomb = await this.getTombstone(tx, SyncEntityTypes.STASH_GROUP, op.entityId);
        if (tomb && tomb.expiresAt > Date.now() && op.op !== SyncOps.DELETE) return 'skipped';
        if (op.op === SyncOps.DELETE) {
          tx.objectStore(IDBStores.STASH_GROUPS).delete(op.entityId);
          this.putTombstone(tx, SyncEntityTypes.STASH_GROUP, op.entityId);
          return 'applied';
        }
        const store = tx.objectStore(IDBStores.STASH_GROUPS);
        const existing = (await IndexedDBManager.requestToPromise(store.get(op.entityId))) || {
          groupId: op.entityId,
          createdAt: op.createdAt || Date.now(),
          title: '',
          locked: false,
          starred: false,
          archived: false,
          fieldRevs: {}
        };
        const merged = this._mergeFields(existing, op, tx, SyncEntityTypes.STASH_GROUP, op.entityId, options);
        existing.updatedAt = Date.now();
        existing.originDeviceId = op.deviceId;
        existing.revision = op.lamport;
        store.put(existing);
        return merged;
      }
    );
  }

  static async _applyEntry(op, options) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_ENTRIES, IDBStores.TOMBSTONES, IDBStores.CONFLICTS],
      'readwrite',
      async (tx) => {
        const tomb = await this.getTombstone(tx, SyncEntityTypes.STASH_ENTRY, op.entityId);
        if (tomb && tomb.expiresAt > Date.now() && op.op !== SyncOps.DELETE) return 'skipped';
        if (op.op === SyncOps.DELETE) {
          tx.objectStore(IDBStores.STASH_ENTRIES).delete(op.entityId);
          this.putTombstone(tx, SyncEntityTypes.STASH_ENTRY, op.entityId);
          return 'applied';
        }
        const store = tx.objectStore(IDBStores.STASH_ENTRIES);
        const existing = (await IndexedDBManager.requestToPromise(store.get(op.entityId))) || {
          entryId: op.entityId,
          groupId: op.fields?.groupId || '',
          pageId: op.fields?.pageId || '',
          createdAt: op.createdAt || Date.now(),
          position: 0,
          pinned: false,
          archived: false,
          fieldRevs: {}
        };
        const merged = this._mergeFields(existing, op, tx, SyncEntityTypes.STASH_ENTRY, op.entityId, options);
        existing.updatedAt = Date.now();
        existing.originDeviceId = op.deviceId;
        existing.revision = op.lamport;
        store.put(existing);
        return merged;
      }
    );
  }

  static async _applySettings(op, options) {
    const merged = await IndexedDBManager.runTransaction(
      [IDBStores.SETTINGS, IDBStores.CONFLICTS],
      'readwrite',
      async (tx) => {
        const store = tx.objectStore(IDBStores.SETTINGS);
        const record = await IndexedDBManager.requestToPromise(store.get(StorageKeys.USER_CONFIG));
        const current = StorageAdapter.mergeUserConfig(record?.value || {});
        current.fieldRevs = current.fieldRevs && typeof current.fieldRevs === 'object' ? current.fieldRevs : {};
        const wrapper = { fieldRevs: current.fieldRevs };
        for (const [path, value] of Object.entries(op.fields || {})) {
          wrapper[path] = this._getPath(current, path);
        }
        const result = this._mergeFields(wrapper, op, tx, SyncEntityTypes.SETTINGS, 'userConfig', {
          originIsCloudTentative: options.originIsCloudTentative === true
        });
        for (const [path, value] of Object.entries(wrapper)) {
          if (path === 'fieldRevs') continue;
          this._setPath(current, path, value);
        }
        current.fieldRevs = wrapper.fieldRevs;
        store.put({ key: StorageKeys.USER_CONFIG, value: current, updatedAt: Date.now() });
        return result;
      }
    );
    AccountConfigSync.scheduleMirror();
    return merged;
  }

  static async _applyLinkRules(op, options) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.SETTINGS, IDBStores.CONFLICTS],
      'readwrite',
      async (tx) => {
        const store = tx.objectStore(IDBStores.SETTINGS);
        const record = await IndexedDBManager.requestToPromise(store.get(StorageKeys.LINK_RULES));
        const current = record?.value && typeof record.value === 'object' ? { ...record.value } : {};
        current.fieldRevs = current.fieldRevs && typeof current.fieldRevs === 'object' ? current.fieldRevs : {};
        const wrapper = { fieldRevs: current.fieldRevs };
        for (const domain of Object.keys(op.fields || {})) {
          wrapper[domain] = current[domain];
        }
        const merged = this._mergeFields(wrapper, op, tx, SyncEntityTypes.LINK_RULES, 'root', {
          originIsCloudTentative: options.originIsCloudTentative === true
        });
        for (const [domain, value] of Object.entries(wrapper)) {
          if (domain === 'fieldRevs') continue;
          if (value === undefined || value === null || value === 'auto') delete current[domain];
          else current[domain] = value;
        }
        current.fieldRevs = wrapper.fieldRevs;
        store.put({ key: StorageKeys.LINK_RULES, value: current, updatedAt: Date.now() });
        return merged;
      }
    );
  }

  static _mergeActivityRecord(local, incoming) {
    const localRec = local && typeof local === 'object' ? local : {
      lastActivated: 0,
      activationTimestamps: [],
      url: ''
    };
    const incomingRec = incoming && typeof incoming === 'object' ? incoming : {};
    const lastActivated = Math.max(Number(localRec.lastActivated) || 0, Number(incomingRec.lastActivated) || 0);
    const mergedTs = [...new Set([
      ...(Array.isArray(localRec.activationTimestamps) ? localRec.activationTimestamps : []),
      ...(Array.isArray(incomingRec.activationTimestamps) ? incomingRec.activationTimestamps : [])
    ])].filter((ts) => Number.isFinite(ts)).sort((a, b) => a - b);
    const windowMs = (DefaultConfig.frequencyHistoryMinutes || 60) * 60 * 1000;
    const cutoff = Date.now() - windowMs * 2;
    return {
      url: incomingRec.url || localRec.url || '',
      lastActivated,
      activationTimestamps: mergedTs.filter((ts) => ts >= cutoff)
    };
  }

  static async _applyActivity(op) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.ACTIVITY_STATS],
      'readwrite',
      async (tx) => {
        const store = tx.objectStore(IDBStores.ACTIVITY_STATS);
        const writePage = async (pageId, incoming) => {
          if (!pageId || pageId === 'fieldRevs' || !/^page_/.test(pageId)) return;
          const existing = await IndexedDBManager.requestToPromise(store.get(pageId));
          const merged = this._mergeActivityRecord(existing?.value, incoming);
          store.put({ key: pageId, value: merged, updatedAt: Date.now() });
        };

        if (op.entityId === 'stats' && op.fields?.pages && typeof op.fields.pages === 'object') {
          for (const [pageId, incoming] of Object.entries(op.fields.pages)) {
            await writePage(pageId, incoming);
          }
        } else {
          await writePage(op.entityId, op.fields || {});
        }
        // 清理历史聚合键，避免双形态并存
        store.delete(StorageKeys.ACTIVITY_STATS);
        return 'applied';
      }
    );
  }

  static async _applyDeviceEvent(op) {
    const event = {
      eventId: op.entityId,
      deviceId: op.deviceId,
      originDeviceId: op.fields?.originDeviceId || op.deviceId,
      sequence: op.sequence,
      type: op.fields?.type || 'unknown',
      payload: op.fields?.payload || {},
      createdAt: op.createdAt || Date.now()
    };
    const result = await IndexedDBManager.runTransaction(
      [IDBStores.DEVICE_EVENTS],
      'readwrite',
      async (tx) => {
        const store = tx.objectStore(IDBStores.DEVICE_EVENTS);
        const existing = await IndexedDBManager.requestToPromise(store.get(op.entityId));
        if (existing) return 'skipped';
        store.put(event);
        return 'applied';
      }
    );
    if (result === 'applied') DeviceEventLog.appendRuntimeLog(event).catch(() => {});
    return result;
  }

  /**
   * 将 incoming.fields 合并进 existing，冲突写入 conflicts 仓储
   * @returns {'applied' | 'conflict'}
   */
  static _mergeFields(existing, op, tx, entityType, entityId, options = {}) {
    existing.fieldRevs = existing.fieldRevs && typeof existing.fieldRevs === 'object' ? existing.fieldRevs : {};
    const tentativeIncoming = options.originIsCloudTentative === true;
    let hasConflict = false;
    for (const [field, incomingValue] of Object.entries(op.fields || {})) {
      const incomingRev = op.fieldRevs?.[field] || { lamport: op.lamport, deviceId: op.deviceId, operationId: op.operationId };
      const localRev = existing.fieldRevs[field] || null;
      const cmp = this.compareFieldRev(localRev, incomingRev);
      if (cmp > 0) {
        existing[field] = incomingValue;
        existing.fieldRevs[field] = incomingRev;
        continue;
      }
      if (cmp < 0) continue;
      hasConflict = true;
      const localValue = existing[field];
      const preferred = tentativeIncoming
        ? incomingRev
        : this.preferredRev(localRev || incomingRev, incomingRev);
      const useIncoming = preferred === incomingRev || tentativeIncoming;
      if (useIncoming) existing[field] = incomingValue;
      existing.fieldRevs[field] = preferred;
      const conflictId = `${entityType}::${entityId}::${field}::${op.operationId}`;
      tx.objectStore(IDBStores.CONFLICTS).put({
        conflictId,
        entityType,
        entityId,
        field,
        localValue,
        incomingValue,
        localRev: localRev || null,
        incomingRev,
        tentativeValue: useIncoming ? incomingValue : localValue,
        resolved: false,
        createdAt: Date.now()
      });
    }
    return hasConflict ? 'conflict' : 'applied';
  }

  static _getPath(obj, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }

  static _setPath(obj, path, value) {
    const parts = path.split('.');
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  /**
   * 列出未裁决冲突
   */
  static async listConflicts() {
    return await IndexedDBManager.runTransaction([IDBStores.CONFLICTS], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.CONFLICTS).getAll());
      return (all || []).filter((item) => !item.resolved);
    });
  }

  /**
   * 将裁决值写入对应仓储（与 outbox PATCH 同事务；不走会再次入队的门面方法）
   * @param {IDBTransaction} tx
   * @param {object} conflict
   * @param {*} value
   * @param {object | null} operation
   */
  static async _writeResolvedValue(tx, conflict, value, operation) {
    const field = conflict.field;
    const rev = operation?.fieldRevs?.[field];
    const now = Date.now();
    const type = conflict.entityType;

    if (type === SyncEntityTypes.PAGE) {
      const store = tx.objectStore(IDBStores.PAGES);
      const page = await IndexedDBManager.requestToPromise(store.get(conflict.entityId));
      if (!page) return;
      page[field] = value;
      if (rev) page.fieldRevs = { ...(page.fieldRevs || {}), [field]: rev };
      page.updatedAt = now;
      if (operation) {
        page.revision = operation.lamport;
        page.originDeviceId = operation.deviceId;
      }
      store.put(page);
      return;
    }

    if (type === SyncEntityTypes.STASH_GROUP) {
      const store = tx.objectStore(IDBStores.STASH_GROUPS);
      const group = await IndexedDBManager.requestToPromise(store.get(conflict.entityId));
      if (!group) return;
      group[field] = value;
      if (rev) group.fieldRevs = { ...(group.fieldRevs || {}), [field]: rev };
      group.updatedAt = now;
      if (operation) {
        group.revision = operation.lamport;
        group.originDeviceId = operation.deviceId;
      }
      store.put(group);
      return;
    }

    if (type === SyncEntityTypes.STASH_ENTRY) {
      const store = tx.objectStore(IDBStores.STASH_ENTRIES);
      const entry = await IndexedDBManager.requestToPromise(store.get(conflict.entityId));
      if (!entry) return;
      if (PAGE_OWNED_FIELDS.has(field) && entry.pageId) {
        const pages = tx.objectStore(IDBStores.PAGES);
        const page = await IndexedDBManager.requestToPromise(pages.get(entry.pageId));
        if (page) {
          page[field] = value;
          if (rev) page.fieldRevs = { ...(page.fieldRevs || {}), [field]: rev };
          page.updatedAt = now;
          pages.put(page);
        }
      }
      entry[field] = value;
      if (rev) entry.fieldRevs = { ...(entry.fieldRevs || {}), [field]: rev };
      entry.updatedAt = now;
      if (operation) {
        entry.revision = operation.lamport;
        entry.originDeviceId = operation.deviceId;
      }
      store.put(entry);
      return;
    }

    if (type === SyncEntityTypes.SETTINGS) {
      const store = tx.objectStore(IDBStores.SETTINGS);
      const record = await IndexedDBManager.requestToPromise(store.get(StorageKeys.USER_CONFIG));
      const current = StorageAdapter.mergeUserConfig(record?.value || {});
      current.fieldRevs = current.fieldRevs && typeof current.fieldRevs === 'object' ? current.fieldRevs : {};
      this._setPath(current, field, value);
      if (rev) current.fieldRevs[field] = rev;
      store.put({ key: StorageKeys.USER_CONFIG, value: current, updatedAt: now });
      return;
    }

    if (type === SyncEntityTypes.LINK_RULES) {
      const store = tx.objectStore(IDBStores.SETTINGS);
      const record = await IndexedDBManager.requestToPromise(store.get(StorageKeys.LINK_RULES));
      const current = record?.value && typeof record.value === 'object' ? { ...record.value } : {};
      current.fieldRevs = current.fieldRevs && typeof current.fieldRevs === 'object' ? current.fieldRevs : {};
      if (value === undefined || value === null || value === 'auto') delete current[field];
      else current[field] = value;
      if (rev) current.fieldRevs[field] = rev;
      store.put({ key: StorageKeys.LINK_RULES, value: current, updatedAt: now });
    }
  }

  /**
   * 用户裁决冲突：写入本机实体并入队 PATCH（云端传播）
   * @param {string} conflictId
   * @param {'local' | 'incoming'} choice
   */
  static async resolveConflict(conflictId, choice) {
    return await IndexedDBManager.withWriteLock(async () => {
      const conflict = await IndexedDBManager.runTransaction([IDBStores.CONFLICTS], 'readonly', async (tx) => {
        return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.CONFLICTS).get(conflictId));
      });
      if (!conflict || conflict.resolved) return { success: false, error: '冲突不存在或已裁决' };
      const value = choice === 'incoming' ? conflict.incomingValue : conflict.localValue;
      await IndexedDBManager.runTransaction(
        [IDBStores.CONFLICTS, IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS, IDBStores.SETTINGS, IDBStores.PAGES, IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES],
        'readwrite',
        async (tx) => {
          const stored = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.CONFLICTS).get(conflictId));
          if (stored) {
            stored.resolved = true;
            stored.resolvedChoice = choice;
            stored.resolvedAt = Date.now();
            tx.objectStore(IDBStores.CONFLICTS).put(stored);
          }
          const operation = await SyncOutbox.enqueueInTx(tx, {
            entityType: conflict.entityType,
            entityId: conflict.entityId,
            op: SyncOps.PATCH,
            fields: { [conflict.field]: value },
            fieldNames: [conflict.field]
          });
          await this._writeResolvedValue(tx, conflict, value, operation);
        }
      );
      SyncOutbox.flushDirty();
      if (conflict.entityType === SyncEntityTypes.SETTINGS) {
        AccountConfigSync.scheduleMirror();
      }
      return { success: true };
    });
  }
}
