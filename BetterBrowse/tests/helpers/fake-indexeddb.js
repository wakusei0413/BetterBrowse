/**
 * @file fake-indexeddb.js
 * @description 测试专用的内存版 IndexedDB 模拟实现（覆盖本项目用到的 API 子集；请求事件以宏任务派发、读写事务支持中止回滚，贴近真实语义）
 * @encoding UTF-8
 */

/** 以宏任务调度回调，模拟真实 IndexedDB 的事件派发时机 */
const dispatchTask = (fn) => setTimeout(fn, 0);

/** 深克隆存储值，模拟 IndexedDB 的结构化克隆语义 */
const cloneValue = (value) => structuredClone(value);

/**
 * 模拟 IDBRequest：结果同步计算，事件在宏任务中派发
 */
class FakeRequest {
  constructor(transaction = null) {
    this.transaction = transaction;
    this.readyState = 'pending';
    this.result = undefined;
    this.error = null;
    this.source = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }

  _succeed(value) {
    this.result = value;
    this.readyState = 'done';
    const tx = this.transaction;
    dispatchTask(() => {
      try {
        if (typeof this.onsuccess === 'function') {
          this.onsuccess({ target: this, type: 'success' });
        }
      } finally {
        tx?._requestSettled();
      }
    });
  }

  _fail(error) {
    this.error = error;
    this.readyState = 'done';
    const tx = this.transaction;
    dispatchTask(() => {
      try {
        if (typeof this.onerror === 'function') {
          this.onerror({ target: this, type: 'error' });
        }
      } finally {
        tx?._requestSettled();
      }
    });
  }
}

/**
 * 模拟索引：按 keyPath 字段过滤仓储记录（查询时动态派生，无需维护增量）
 */
class FakeIndex {
  constructor(store, name, keyPath) {
    this._store = store;
    this.name = name;
    this.keyPath = keyPath;
  }

  _getValues(key) {
    const values = [];
    for (const value of this._store._records.values()) {
      const indexKey = value?.[this.keyPath];
      if (key === undefined || indexKey === key) values.push(cloneValue(value));
    }
    return values;
  }
}

/**
 * 模拟对象仓储（仅支持 keyPath 主键模式，覆盖项目实际用法）
 */
class FakeObjectStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this._records = new Map();
    this._indexes = new Map();
  }

  _extractKey(value) {
    const key = value?.[this.keyPath];
    if (key === undefined || key === null) {
      throw new Error(`记录缺少主键字段 ${this.keyPath}`);
    }
    return key;
  }

  _snapshot() {
    const snapshot = new Map();
    for (const [key, value] of this._records) snapshot.set(key, cloneValue(value));
    return snapshot;
  }

  _restore(snapshot) {
    this._records = snapshot;
  }

  addIndex(name, keyPath) {
    this._indexes.set(name, new FakeIndex(this, name, keyPath));
  }
}

/**
 * 事务视图：将对象仓储操作与事务生命周期关联（对应真实 API 中事务内的 store 实例）
 */
class FakeStoreView {
  constructor(store, tx) {
    this._store = store;
    this._tx = tx;
    this.name = store.name;
  }

  _wrap(request) {
    request.transaction = this._tx;
    this._tx._track(request);
    return request;
  }

  put(value) {
    const request = new FakeRequest(this._tx);
    try {
      const key = this._store._extractKey(value);
      this._store._records.set(key, cloneValue(value));
      request._succeed(key);
    } catch (err) {
      request._fail(err);
    }
    return this._wrap(request);
  }

  get(key) {
    const request = new FakeRequest(this._tx);
    const value = this._store._records.get(key);
    request._succeed(value === undefined ? undefined : cloneValue(value));
    return this._wrap(request);
  }

  getAll() {
    const request = new FakeRequest(this._tx);
    request._succeed([...this._store._records.values()].map(cloneValue));
    return this._wrap(request);
  }

  getAllKeys() {
    const request = new FakeRequest(this._tx);
    request._succeed([...this._store._records.keys()]);
    return this._wrap(request);
  }

  delete(key) {
    const request = new FakeRequest(this._tx);
    this._store._records.delete(key);
    request._succeed(undefined);
    return this._wrap(request);
  }

  clear() {
    const request = new FakeRequest(this._tx);
    this._store._records.clear();
    request._succeed(undefined);
    return this._wrap(request);
  }

  count() {
    const request = new FakeRequest(this._tx);
    request._succeed(this._store._records.size);
    return this._wrap(request);
  }

  index(name) {
    const index = this._store._indexes.get(name);
    if (!index) throw new Error(`索引不存在: ${name}`);
    return new FakeIndexView(index, this._tx);
  }
}

/**
 * 索引视图：将索引查询与事务生命周期关联
 */
class FakeIndexView {
  constructor(index, tx) {
    this._index = index;
    this._tx = tx;
    this.name = index.name;
  }

  _wrap(request) {
    request.transaction = this._tx;
    this._tx._track(request);
    return request;
  }

  getAll(key) {
    const request = new FakeRequest(this._tx);
    request._succeed(this._index._getValues(key));
    return this._wrap(request);
  }

  get(key) {
    const request = new FakeRequest(this._tx);
    const values = this._index._getValues(key);
    request._succeed(values.length > 0 ? values[0] : undefined);
    return this._wrap(request);
  }

  count() {
    const request = new FakeRequest(this._tx);
    request._succeed(this._index._getValues(undefined).length);
    return this._wrap(request);
  }
}

/**
 * 模拟事务：请求全部派发完毕且事件循环空闲后自动提交；读写事务中止时回滚快照
 */
class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this._storeNames = new Set(storeNames);
    // 与真实 IDBTransaction 对齐：允许调用方探测事务覆盖的对象仓储
    this.objectStoreNames = {
      contains: (storeName) => this._storeNames.has(storeName)
    };
    this._active = true;
    this._aborted = false;
    this._pendingRequests = 0;
    this._completionScheduled = false;
    // 读写事务开始前快照涉及仓储，abort 时整体回滚（贴近真实提交语义）
    this._snapshot = mode === 'readwrite' ? db._snapshotStores(storeNames) : null;
    dispatchTask(() => this._tryComplete());
  }

  objectStore(name) {
    if (!this._storeNames.has(name)) throw new Error(`事务未覆盖对象仓储: ${name}`);
    if (!this._active) throw new Error('事务已结束，无法继续操作');
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`对象仓储不存在: ${name}`);
    return new FakeStoreView(store, this);
  }

  abort() {
    if (this._aborted || !this._active) return;
    this._aborted = true;
    this._active = false;
    if (this._snapshot) this.db._restoreStores(this._snapshot);
    this.error = this.error || new Error('事务已被中止');
    dispatchTask(() => {
      if (typeof this.onabort === 'function') this.onabort({ target: this, type: 'abort' });
    });
  }

  _track(request) {
    this._pendingRequests++;
  }

  _requestSettled() {
    this._pendingRequests--;
    this._tryComplete();
  }

  _tryComplete() {
    if (this._aborted || !this._active) return;
    if (this._pendingRequests > 0) return;
    if (this._completionScheduled) return;
    this._completionScheduled = true;
    dispatchTask(() => {
      if (this._aborted) return;
      // 快照检查期间又有新请求入队（同一宏任务内继续操作事务），推迟提交
      if (this._pendingRequests > 0) {
        this._completionScheduled = false;
        return;
      }
      this._active = false;
      if (typeof this.oncomplete === 'function') {
        this.oncomplete({ target: this, type: 'complete' });
      }
    });
  }
}

/**
 * 模拟数据库连接
 */
class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this._closed = false;
    this.onclose = null;
    this.onversionchange = null;
    this.objectStoreNames = {
      contains: (storeName) => this._stores.has(storeName)
    };
  }

  createObjectStore(name, options = {}) {
    if (this._stores.has(name)) throw new Error(`对象仓储已存在: ${name}`);
    const store = new FakeObjectStore(name, options.keyPath);
    this._stores.set(name, store);
    return {
      createIndex: (indexName, keyPath) => {
        if (store._indexes.has(indexName)) throw new Error(`索引已存在: ${indexName}`);
        store.addIndex(indexName, keyPath);
        return { name: indexName, keyPath };
      }
    };
  }

  deleteObjectStore(name) {
    this._stores.delete(name);
  }

  transaction(storeNames, mode) {
    if (this._closed) throw new Error('数据库连接已关闭');
    const names = Array.isArray(storeNames) ? [...storeNames] : [storeNames];
    for (const name of names) {
      if (!this._stores.has(name)) throw new Error(`对象仓储不存在: ${name}`);
    }
    return new FakeTransaction(this, names, mode);
  }

  close() {
    this._closed = true;
  }

  /** 模拟浏览器强制断开连接（Service Worker 休眠终结 / 版本升级抢占） */
  _forceClose() {
    if (this._closed) return;
    this._closed = true;
    if (typeof this.onclose === 'function') {
      this.onclose({ target: this });
    }
  }

  _snapshotStores(storeNames) {
    const snapshot = new Map();
    for (const name of storeNames) {
      const store = this._stores.get(name);
      if (store) snapshot.set(name, store._snapshot());
    }
    return snapshot;
  }

  _restoreStores(snapshot) {
    for (const [name, records] of snapshot) {
      const store = this._stores.get(name);
      if (store) store._restore(records);
    }
  }
}

/**
 * 模拟 IDBFactory：管理数据库创建、版本升级与连接生命周期
 */
export class FakeIDBFactory {
  constructor() {
    this._databases = new Map();
    this._connections = new Set();
  }

  open(name, version) {
    const request = new FakeRequest(null);
    const targetVersion = typeof version === 'number' ? version : 1;
    dispatchTask(() => {
      let db = this._databases.get(name);
      const isNew = !db;
      const oldVersion = db ? db.version : 0;
      let upgradeNeeded = isNew;

      if (isNew) {
        db = new FakeDatabase(name, targetVersion);
        this._databases.set(name, db);
      } else if (oldVersion !== targetVersion) {
        if (targetVersion < oldVersion) {
          request._fail(new Error('VersionError: 不允许降级打开数据库'));
          return;
        }
        // 版本升级：强制关闭旧连接（触发 onclose，促使连接管理器重建连接）
        db.version = targetVersion;
        upgradeNeeded = true;
        db._forceClose();
        this._connections.delete(db);
      } else {
        // 同版本重新打开：允许同一数据库再次建立新连接（IndexedDBManager.close 后重连）
        db._closed = false;
      }

      this._connections.add(db);
      if (upgradeNeeded && typeof request.onupgradeneeded === 'function') {
        request.result = db;
        request.onupgradeneeded({ target: request, oldVersion, newVersion: targetVersion });
      }
      request._succeed(db);
    });
    return request;
  }

  deleteDatabase(name) {
    const db = this._databases.get(name);
    if (db) {
      db._forceClose();
      this._connections.delete(db);
      this._databases.delete(name);
    }
  }

  /** 关闭全部连接并触发 onclose（用于测试间的状态隔离） */
  closeAll() {
    for (const db of this._connections) {
      db._forceClose();
    }
    this._connections.clear();
  }
}

/**
 * 统计 IndexedDB 指定仓储的记录数
 * @param {{ runTransaction: Function, requestToPromise: Function }} IndexedDBManager
 * @param {string} storeName
 * @returns {Promise<number>}
 */
export async function countStoreRecords(IndexedDBManager, storeName) {
  return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
    return await IndexedDBManager.requestToPromise(tx.objectStore(storeName).count());
  });
}

/**
 * 安装内存版 IndexedDB 全局对象
 * @returns {{ factory: FakeIDBFactory, restore: () => void }}
 */
export function installFakeIndexedDB() {
  const factory = new FakeIDBFactory();
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = factory;
  return {
    factory,
    restore() {
      factory.closeAll();
      if (previous === undefined) {
        delete globalThis.indexedDB;
      } else {
        globalThis.indexedDB = previous;
      }
    }
  };
}
