/**
 * @file outbox.js
 * @description 本地不可变操作 outbox（与实体写入同事务追加；持锁由调用方保证）
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { SYNC_CLOCK_KEY, SyncOps } from './sync-constants.js';

export class SyncOutbox {
  /** 事务提交后通知调度器的回调（由 SyncScheduler 注册，避免循环依赖） */
  static onDirty = null;

  static _pendingDirty = false;

  /**
   * schema ≥ 8 且未回退时才记录 outbox
   * @returns {Promise<boolean>}
   */
  static async isActive() {
    try {
      if ((await StorageAdapter.getChrome(StorageKeys.IDB_OPTOUT, false)) === true) return false;
      const version = Number(await StorageAdapter.getChrome(StorageKeys.SCHEMA_VERSION, 0)) || 0;
      return version >= 8 && IndexedDBManager.isSupported();
    } catch {
      return false;
    }
  }

  /**
   * 生成随机标识
   * @param {string} prefix
   * @returns {string}
   */
  static randomId(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
  }

  /**
   * 读取或初始化本机时钟（须在写锁内）
   * @param {IDBTransaction} [tx]
   * @returns {Promise<{ deviceId: string, sequence: number, lamport: number, datasetId: string }>}
   */
  static async getClock(tx) {
    if (tx) {
      const store = tx.objectStore(IDBStores.SYNC_META);
      const record = await IndexedDBManager.requestToPromise(store.get(SYNC_CLOCK_KEY));
      if (record?.value) return record.value;
      const clock = this._newClock();
      store.put({ key: SYNC_CLOCK_KEY, value: clock, updatedAt: Date.now() });
      return clock;
    }
    return await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readonly', async (inner) => {
      const record = await IndexedDBManager.requestToPromise(inner.objectStore(IDBStores.SYNC_META).get(SYNC_CLOCK_KEY));
      return record?.value || null;
    });
  }

  static _newClock() {
    return {
      deviceId: this.randomId('dev'),
      sequence: 0,
      lamport: 0,
      datasetId: this.randomId('ds'),
      seenLamport: 0
    };
  }

  /**
   * 在当前写事务中追加一条操作（调用方事务必须包含 outbox 与 syncMeta）
   * @param {IDBTransaction} tx
   * @param {{ entityType: string, entityId: string, op?: string, fields?: Record<string, any>, fieldNames?: string[] }} spec
   * @returns {Promise<object | null>}
   */
  static async enqueueInTx(tx, spec) {
    if (!spec?.entityType || !spec?.entityId) return null;
    const metaStore = tx.objectStore(IDBStores.SYNC_META);
    const outboxStore = tx.objectStore(IDBStores.OUTBOX);
    // 契约：调用方事务必须已包含 OPERATION_LOGS（见各写路径的 stores 组装）
    const logStore = tx.objectStore(IDBStores.OPERATION_LOGS);

    let clockRecord = await IndexedDBManager.requestToPromise(metaStore.get(SYNC_CLOCK_KEY));
    const clock = clockRecord?.value || this._newClock();
    clock.sequence += 1;
    clock.lamport = Math.max(Number(clock.lamport) || 0, Number(clock.seenLamport) || 0) + 1;
    clock.seenLamport = clock.lamport;

    const fields = spec.fields && typeof spec.fields === 'object' ? spec.fields : {};
    const fieldNames = Array.isArray(spec.fieldNames) && spec.fieldNames.length > 0
      ? spec.fieldNames
      : Object.keys(fields);
    const fieldRevs = {};
    for (const name of fieldNames) {
      fieldRevs[name] = {
        lamport: clock.lamport,
        deviceId: clock.deviceId,
        operationId: ''
      };
    }
    const operationId = this.randomId('op');
    for (const name of Object.keys(fieldRevs)) {
      fieldRevs[name].operationId = operationId;
    }

    const operation = {
      operationId,
      deviceId: clock.deviceId,
      sequence: clock.sequence,
      lamport: clock.lamport,
      entityType: spec.entityType,
      entityId: String(spec.entityId),
      op: spec.op || SyncOps.PATCH,
      fields,
      fieldRevs,
      createdAt: Date.now()
    };

    outboxStore.put(operation);
    logStore.put({ ...operation, logId: operation.operationId });
    metaStore.put({ key: SYNC_CLOCK_KEY, value: clock, updatedAt: Date.now() });
    this._pendingDirty = true;
    return operation;
  }

  /**
   * 事务成功后通知调度器
   */
  static flushDirty() {
    if (!this._pendingDirty) return;
    this._pendingDirty = false;
    try {
      this.onDirty?.();
    } catch {
      // 调度失败不影响主写入
    }
  }

  /**
   * 读取尚未上传的操作（按 sequence 升序）
   * @returns {Promise<object[]>}
   */
  static async listPending() {
    return await IndexedDBManager.runTransaction([IDBStores.OUTBOX], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.OUTBOX).getAll());
      return (all || [])
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    });
  }

  /**
   * 标记批次已上传：远端批次与 operationLogs 已留档，本地 outbox 记录删除以防无限增长
   * @param {string[]} operationIds
   */
  static async markUploaded(operationIds) {
    const ids = new Set(operationIds || []);
    if (ids.size === 0) return;
    await IndexedDBManager.runTransaction([IDBStores.OUTBOX], 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.OUTBOX);
      for (const id of ids) store.delete(id);
    });
  }

  /**
   * 读取本机 deviceId（无时钟则返回空串）
   * @returns {Promise<string>}
   */
  static async getDeviceId() {
    const clock = await this.getClock();
    return clock?.deviceId || '';
  }
}
