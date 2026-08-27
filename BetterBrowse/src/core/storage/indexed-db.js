/**
 * @file indexed-db.js
 * @description IndexedDB 本地主库连接管理器（惰性连接重建、跨上下文写锁与分批事务，适配 MV3 Service Worker 生命周期）
 * @encoding UTF-8
 */

/** 本地主库数据库名称 */
export const DB_NAME = 'betterbrowse';

/** 本地主库结构版本（新增对象仓储或索引时递增） */
export const DB_VERSION = 1;

/**
 * 对象仓储名称与结构契约（详见 docs/01-local-indexeddb.md 第 2.1 节）
 * - pages:        页面实体层，同一 URL 唯一（pageId 为 URL 指纹）
 * - stashGroups:  收纳组层
 * - stashEntries: 收纳记录层，组内条目通过 pageId 指向页面实体
 * - settings / activityStats: 阶段一仅建表占位，读写仍以 chrome.storage.local 为准以兼容现有逻辑
 * - deviceEvents: 本地操作事件（阶段二跨设备同步复用）
 */
export const IDBStores = {
  PAGES: 'pages',
  STASH_GROUPS: 'stashGroups',
  STASH_ENTRIES: 'stashEntries',
  SETTINGS: 'settings',
  ACTIVITY_STATS: 'activityStats',
  DEVICE_EVENTS: 'deviceEvents'
};

export class IndexedDBManager {
  /**
   * 缓存的连接 Promise
   * 注意：连接被关闭（Service Worker 休眠终结、数据库版本升级、数据库被删除）后自动置空，
   * 下一次操作会惰性重建连接，这是应对 MV3 Service Worker 休眠的核心手段。
   */
  static _dbPromise = null;

  /** 进程内串行写入队列（Web Locks API 不可用时的降级方案） */
  static _localWriteQueue = Promise.resolve();

  /**
   * 当前环境是否支持 IndexedDB
   * @returns {boolean}
   */
  static isSupported() {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  }

  /**
   * 打开数据库连接（缓存复用；连接失效后自动重建；启动就绪语义：所有读写路径必须先等待本方法完成）
   * @returns {Promise<IDBDatabase>}
   */
  static open() {
    if (!this._dbPromise) {
      this._dbPromise = this._openDatabase();
      // 打开失败时清空缓存，允许下一次操作重试而不是永久持有失败的连接
      this._dbPromise.catch(() => {
        this._dbPromise = null;
      });
    }
    return this._dbPromise;
  }

  /**
   * 实际打开数据库并装配结构
   * @returns {Promise<IDBDatabase>}
   */
  static _openDatabase() {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        // 首次创建或版本升级时建立对象仓储与索引
        this._ensureSchema(event.target.result);
      };

      request.onsuccess = () => {
        const db = request.result;
        // 连接被浏览器强制关闭（数据库被删除 / 私密模式回收）时清空缓存，下次操作重新打开
        db.onclose = () => {
          this._dbPromise = null;
        };
        // 其他上下文请求升级数据库版本时主动让出连接，避免升级请求被阻塞
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // 忽略重复关闭
          }
          this._dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => reject(request.error || new Error('IndexedDB 数据库打开失败'));
      request.onblocked = () => {
        // 等待其他上下文释放旧版本连接（不主动失败，由浏览器自行调度）
      };
    });
  }

  /**
   * 建立对象仓储与索引结构（幂等：已存在的仓储与索引直接跳过）
   * @param {IDBDatabase} db
   */
  static _ensureSchema(db) {
    if (!db.objectStoreNames.contains(IDBStores.PAGES)) {
      const pages = db.createObjectStore(IDBStores.PAGES, { keyPath: 'pageId' });
      pages.createIndex('url', 'url', { unique: false });
      pages.createIndex('domain', 'domain', { unique: false });
      pages.createIndex('updatedAt', 'updatedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(IDBStores.STASH_GROUPS)) {
      const groups = db.createObjectStore(IDBStores.STASH_GROUPS, { keyPath: 'groupId' });
      groups.createIndex('createdAt', 'createdAt', { unique: false });
      groups.createIndex('name', 'title', { unique: false });
    }

    if (!db.objectStoreNames.contains(IDBStores.STASH_ENTRIES)) {
      const entries = db.createObjectStore(IDBStores.STASH_ENTRIES, { keyPath: 'entryId' });
      entries.createIndex('groupId', 'groupId', { unique: false });
      entries.createIndex('pageId', 'pageId', { unique: false });
      entries.createIndex('createdAt', 'createdAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(IDBStores.SETTINGS)) {
      db.createObjectStore(IDBStores.SETTINGS, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(IDBStores.ACTIVITY_STATS)) {
      db.createObjectStore(IDBStores.ACTIVITY_STATS, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(IDBStores.DEVICE_EVENTS)) {
      const events = db.createObjectStore(IDBStores.DEVICE_EVENTS, { keyPath: 'eventId' });
      events.createIndex('deviceId', 'deviceId', { unique: false });
      events.createIndex('sequence', 'sequence', { unique: false });
    }
  }

  /**
   * 主动关闭当前连接（主要用于回退与测试场景）
   */
  static async close() {
    if (!this._dbPromise) return;
    try {
      const db = await this._dbPromise;
      db.close();
    } catch {
      // 连接可能已失效
    }
    this._dbPromise = null;
  }

  /**
   * 将 IDBRequest 包装为 Promise
   * @param {IDBRequest} request
   * @returns {Promise<any>}
   */
  static requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 请求执行失败'));
    });
  }

  /**
   * 在单个事务中执行回调
   * 启动就绪：内部先等待数据库打开完成后才创建事务，确保迁移期间的数据读写有序
   * @param {string | string[]} storeNames - 涉及的对象仓储
   * @param {'readonly' | 'readwrite'} mode - 事务模式
   * @param {(tx: IDBTransaction) => any} callback - 业务回调，可返回值或 Promise
   * @returns {Promise<any>} 事务提交成功后返回回调结果
   */
  static async runTransaction(storeNames, mode, callback) {
    const db = await this.open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const outcome = { done: false, value: undefined, error: undefined };

      tx.oncomplete = () => {
        if (outcome.done) resolve(outcome.value);
        else reject(outcome.error || new Error('IndexedDB 事务已完成但业务回调未结束'));
      };
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务已中止'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务执行失败'));

      (async () => {
        try {
          outcome.value = await callback(tx);
          outcome.done = true;
        } catch (err) {
          outcome.error = err;
          try {
            tx.abort();
          } catch {
            // 事务可能已经结束，忽略重复中止
          }
        }
      })();
    });
  }

  /**
   * 跨上下文写入锁
   * Service Worker 与选项页等多个入口可能同时写库，通过 Web Locks API 跨上下文串行化
   * "读-改-写"序列，避免相互覆盖；Web Locks 不可用（如测试环境）时降级为进程内串行队列。
   * ⚠️ 注意：严禁嵌套获取（同上下文重复获取同一把锁会死锁）
   * @param {() => any} operation - 需要串行化的写入操作
   * @returns {Promise<any>}
   */
  static async withWriteLock(operation) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      return await locks.request('bb-idb-write', { mode: 'exclusive' }, async () => await operation());
    }
    // 降级方案：进程内 Promise 链串行（单上下文场景下语义等价）
    const run = this._localWriteQueue.then(operation, operation);
    this._localWriteQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * 将大数组切分为固定大小的批次
   * 避免单次超大事务被 Service Worker 休眠打断后整体回滚，也降低单事务内存峰值
   * @param {any[]} list - 待切分列表
   * @param {number} [size=500] - 每批数量
   * @returns {any[][]}
   */
  static chunk(list, size = 500) {
    const chunks = [];
    const source = Array.isArray(list) ? list : [];
    for (let i = 0; i < source.length; i += size) {
      chunks.push(source.slice(i, i + size));
    }
    return chunks;
  }
}
