/**
 * @file fake-indexeddb.js
 * @description 测试专用的内存版 IndexedDB 模拟实现（覆盖本项目用到的 API 子集；支持复合索引、KeyRange 与游标分页）
 * @encoding UTF-8
 */

/** 以宏任务调度回调，模拟真实 IndexedDB 的事件派发时机 */
const dispatchTask = (fn) => setTimeout(fn, 0);

/** 深克隆存储值，模拟 IndexedDB 的结构化克隆语义 */
const cloneValue = (value) => structuredClone(value);

/** 按 IndexedDB 键语义比较基础值与数组复合键 */
function compareKeys(left, right) {
  const a = Array.isArray(left) ? left : [left];
  const b = Array.isArray(right) ? right : [right];
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** 从记录中提取字符串或数组 keyPath 对应的键 */
function extractKeyPath(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((path) => value?.[path]);
  return value?.[keyPath];
}

/** 判断查询条件是否命中键 */
function matchesQuery(key, query) {
  if (query === undefined || query === null) return true;
  if (typeof query.includes === 'function') return query.includes(key);
  return compareKeys(key, query) === 0;
}

/** 最小 IDBKeyRange 实现 */
class FakeIDBKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(key) {
    if (this.lower !== undefined) {
      const lowerCmp = compareKeys(key, this.lower);
      if (lowerCmp < 0 || (lowerCmp === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const upperCmp = compareKeys(key, this.upper);
      if (upperCmp > 0 || (upperCmp === 0 && this.upperOpen)) return false;
    }
    return true;
  }

  static only(value) {
    return new FakeIDBKeyRange(value, value, false, false);
  }

  static lowerBound(value, open = false) {
    return new FakeIDBKeyRange(value, undefined, open, false);
  }

  static upperBound(value, open = false) {
    return new FakeIDBKeyRange(undefined, value, false, open);
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

/** 模拟 DOMStringList 的 contains 能力 */
function createNameList(source) {
  return {
    contains: (name) => source.has(name),
    item: (index) => [...source.keys()][index] || null,
    get length() {
      return source.size;
    },
    [Symbol.iterator]: function* () {
      yield* source.keys();
    }
  };
}

/** 模拟 IDBRequest */
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
        if (typeof this.onsuccess === 'function') this.onsuccess({ target: this, type: 'success' });
      } finally {
        if (typeof tx?._requestSettled === 'function') tx._requestSettled();
      }
    });
  }

  _fail(error) {
    this.error = error;
    this.readyState = 'done';
    const tx = this.transaction;
    dispatchTask(() => {
      try {
        if (typeof this.onerror === 'function') this.onerror({ target: this, type: 'error' });
      } finally {
        if (typeof tx?._requestSettled === 'function') tx._requestSettled();
      }
    });
  }
}

/** 模拟 IDBCursorWithValue */
class FakeCursor {
  constructor(request, rows, index, store) {
    this._request = request;
    this._rows = rows;
    this._index = index;
    this._store = store;
    this._continued = false;
    this._sync();
  }

  delete() {
    this._request._pendingDelete = true;
    const request = new FakeRequest(this._request.transaction);
    this._request.transaction?._track?.(request);
    if (this._store && this.primaryKey !== undefined) {
      this._store._records.delete(this.primaryKey);
    }
    request._succeed(undefined);
    return request;
  }

  _sync() {
    const row = this._rows[this._index];
    this.key = cloneValue(row.key);
    this.primaryKey = cloneValue(row.primaryKey);
    this.value = cloneValue(row.value);
  }

  continue(key) {
    this._continued = true;
    this._request._pendingDelete = false;
    let next = this._index + 1;
    if (key !== undefined) {
      while (next < this._rows.length && compareKeys(this._rows[next].key, key) < 0) next++;
    }
    this._request._emit(next);
  }

  advance(count) {
    const step = Math.max(1, Math.floor(Number(count) || 1));
    this._continued = true;
    this._request._emit(this._index + step);
  }
}

/** 游标请求在回调停止 continue 时才结算事务中的待处理请求 */
class FakeCursorRequest extends FakeRequest {
  constructor(transaction, rows, store = null) {
    super(transaction);
    this._rows = rows;
    this._store = store;
    this._settled = false;
  }

  _start() {
    this.transaction?._track(this);
    this._emit(0);
    return this;
  }

  _emit(index) {
    dispatchTask(() => {
      if (this._settled) return;
      if (index >= this._rows.length) {
        this.result = null;
        this.readyState = 'done';
        try {
          if (typeof this.onsuccess === 'function') this.onsuccess({ target: this, type: 'success' });
        } finally {
          this._settle();
        }
        return;
      }
      const cursor = new FakeCursor(this, this._rows, index, this._store);
      this.result = cursor;
      this.readyState = 'done';
      try {
        if (typeof this.onsuccess === 'function') this.onsuccess({ target: this, type: 'success' });
      } finally {
        if (!cursor._continued && !this._pendingDelete) this._settle();
      }
    });
  }

  _settle() {
    if (this._settled) return;
    this._settled = true;
    if (typeof this.transaction?._requestSettled === 'function') this.transaction._requestSettled();
  }
}

/** 模拟索引：查询时从仓储记录动态派生 */
class FakeIndex {
  constructor(store, name, keyPath) {
    this._store = store;
    this.name = name;
    this.keyPath = keyPath;
  }

  _rows(query, direction = 'next') {
    const rows = [];
    for (const [primaryKey, value] of this._store._records) {
      const key = extractKeyPath(value, this.keyPath);
      if (matchesQuery(key, query)) rows.push({ key, primaryKey, value });
    }
    rows.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.primaryKey, b.primaryKey));
    if (String(direction).startsWith('prev')) rows.reverse();
    return rows.map((row) => ({
      key: cloneValue(row.key),
      primaryKey: cloneValue(row.primaryKey),
      value: cloneValue(row.value)
    }));
  }
}

/** 模拟对象仓储 */
class FakeObjectStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this._records = new Map();
    this._indexes = new Map();
  }

  _extractKey(value) {
    const key = extractKeyPath(value, this.keyPath);
    if (key === undefined || key === null || (Array.isArray(key) && key.some((part) => part === undefined || part === null))) {
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

/** 事务中的对象仓储视图 */
class FakeStoreView {
  constructor(store, tx) {
    this._store = store;
    this._tx = tx;
    this.name = store.name;
    this.keyPath = store.keyPath;
    this.indexNames = createNameList(store._indexes);
  }

  _wrap(request) {
    request.transaction = this._tx;
    this._tx?._track(request);
    return request;
  }

  createIndex(name, keyPath) {
    if (this._store._indexes.has(name)) throw new Error(`索引已存在: ${name}`);
    this._store.addIndex(name, keyPath);
    return new FakeIndexView(this._store._indexes.get(name), this._tx);
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

  getAll(query, count) {
    const request = new FakeRequest(this._tx);
    let values = [...this._store._records.entries()]
      .filter(([key]) => matchesQuery(key, query))
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([, value]) => cloneValue(value));
    if (Number.isFinite(count)) values = values.slice(0, count);
    request._succeed(values);
    return this._wrap(request);
  }

  getAllKeys(query, count) {
    const request = new FakeRequest(this._tx);
    let keys = [...this._store._records.keys()]
      .filter((key) => matchesQuery(key, query))
      .sort(compareKeys)
      .map(cloneValue);
    if (Number.isFinite(count)) keys = keys.slice(0, count);
    request._succeed(keys);
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

  count(query) {
    const request = new FakeRequest(this._tx);
    const count = [...this._store._records.keys()].filter((key) => matchesQuery(key, query)).length;
    request._succeed(count);
    return this._wrap(request);
  }

  index(name) {
    const index = this._store._indexes.get(name);
    if (!index) throw new Error(`索引不存在: ${name}`);
    return new FakeIndexView(index, this._tx);
  }

  openCursor(query, direction = 'next') {
    const rows = [...this._store._records.entries()]
      .filter(([key]) => matchesQuery(key, query))
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, value]) => ({ key, primaryKey: key, value }));
    if (String(direction).startsWith('prev')) rows.reverse();
    return new FakeCursorRequest(this._tx, rows, this._store)._start();
  }
}

/** 事务中的索引视图 */
class FakeIndexView {
  constructor(index, tx) {
    this._index = index;
    this._tx = tx;
    this.name = index.name;
    this.keyPath = index.keyPath;
  }

  _wrap(request) {
    request.transaction = this._tx;
    this._tx?._track(request);
    return request;
  }

  getAll(query, count) {
    const request = new FakeRequest(this._tx);
    let values = this._index._rows(query).map((row) => row.value);
    if (Number.isFinite(count)) values = values.slice(0, count);
    request._succeed(values);
    return this._wrap(request);
  }

  get(query) {
    const request = new FakeRequest(this._tx);
    const rows = this._index._rows(query);
    request._succeed(rows.length > 0 ? rows[0].value : undefined);
    return this._wrap(request);
  }

  count(query) {
    const request = new FakeRequest(this._tx);
    request._succeed(this._index._rows(query).length);
    return this._wrap(request);
  }

  openCursor(query, direction = 'next') {
    return new FakeCursorRequest(this._tx, this._index._rows(query, direction), this._index._store)._start();
  }
}

/** 模拟事务 */
class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this._storeNames = new Set(storeNames);
    this.objectStoreNames = createNameList(new Map([...this._storeNames].map((name) => [name, true])));
    this._active = true;
    this._aborted = false;
    this._pendingRequests = 0;
    this._completionScheduled = false;
    this._idlePasses = 0;
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

  _track() {
    this._pendingRequests++;
    this._idlePasses = 0;
    this._completionScheduled = false;
  }

  _requestSettled() {
    this._pendingRequests--;
    this._tryComplete();
  }

  _tryComplete() {
    if (this._aborted || !this._active || this._pendingRequests > 0) return;
    if (this._idlePasses < 3) {
      this._idlePasses += 1;
      queueMicrotask(() => dispatchTask(() => this._tryComplete()));
      return;
    }
    if (this._completionScheduled) return;
    this._completionScheduled = true;
    this._active = false;
    if (typeof this.oncomplete === 'function') this.oncomplete({ target: this, type: 'complete' });
  }
}

/** 模拟数据库连接 */
class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this._closed = false;
    this.onclose = null;
    this.onversionchange = null;
    this.objectStoreNames = createNameList(this._stores);
  }

  createObjectStore(name, options = {}) {
    if (this._stores.has(name)) throw new Error(`对象仓储已存在: ${name}`);
    const store = new FakeObjectStore(name, options.keyPath);
    this._stores.set(name, store);
    return new FakeStoreView(store, null);
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

  _forceClose() {
    if (this._closed) return;
    this._closed = true;
    if (typeof this.onclose === 'function') this.onclose({ target: this });
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

/** 模拟 IDBFactory */
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
        db.version = targetVersion;
        upgradeNeeded = true;
        db._forceClose();
        this._connections.delete(db);
        db._closed = false;
      } else {
        db._closed = false;
      }

      this._connections.add(db);
      if (upgradeNeeded && typeof request.onupgradeneeded === 'function') {
        request.result = db;
        request.transaction = {
          objectStore: (storeName) => {
            const store = db._stores.get(storeName);
            if (!store) throw new Error(`对象仓储不存在: ${storeName}`);
            return new FakeStoreView(store, null);
          }
        };
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

  closeAll() {
    for (const db of this._connections) db._forceClose();
    this._connections.clear();
  }
}

/** 统计 IndexedDB 指定仓储的记录数 */
export async function countStoreRecords(IndexedDBManager, storeName) {
  return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
    return await IndexedDBManager.requestToPromise(tx.objectStore(storeName).count());
  });
}

/** 安装内存版 IndexedDB 全局对象 */
export function installFakeIndexedDB() {
  const factory = new FakeIDBFactory();
  const previousIndexedDB = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
  return {
    factory,
    restore() {
      factory.closeAll();
      if (previousIndexedDB === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = previousIndexedDB;
      if (previousKeyRange === undefined) delete globalThis.IDBKeyRange;
      else globalThis.IDBKeyRange = previousKeyRange;
    }
  };
}
