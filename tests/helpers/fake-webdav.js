/**
 * @file fake-webdav.js
 * @description 双设备同步测试共用的内存 WebDAV 服务器、chrome.storage 模拟与设备切换工具
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from "../../BetterBrowse/src/core/storage/indexed-db.js";
import { SYNC_CLOCK_KEY } from "../../BetterBrowse/src/core/sync/sync-constants.js";

/**
 * 安装 chrome.storage 内存模拟（每台设备独立一份，可复用已有数据对象）
 * @param {Record<string, any>} [data]
 */
export function installChromeStore(data = {}) {
  const store = data;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: () => {}
    },
    storage: {
      local: {
        get: (keys, callback) => {
          if (keys === null) return callback({ ...store });
          if (typeof keys === 'string') return callback({ [keys]: store[keys] });
          if (Array.isArray(keys)) {
            const res = {};
            keys.forEach((k) => { res[k] = store[k]; });
            return callback(res);
          }
          callback({ ...store });
        },
        set: (items, callback) => {
          Object.assign(store, items);
          callback?.();
        }
      }
    },
    alarms: {
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} }
    }
  };
  return store;
}

/**
 * 内存版 WebDAV 服务器（支持 If-Match / If-None-Match，可挂 PUT 钩子模拟并发写入）
 */
export class FakeWebdavServer {
  constructor() {
    this.files = new Map();
    this.counter = 0;
    /** @type {((path: string, body: string) => void | Promise<void>) | null} PUT 成功后的钩子（响应前等待） */
    this.onPut = null;
  }

  etag() {
    return `etag-${++this.counter}`;
  }

  _response(status, body = '', etag = undefined) {
    const headers = {};
    if (etag !== undefined) headers['ETag'] = etag;
    return new Response(body, { status, headers });
  }

  async fetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const path = decodeURIComponent(new URL(url).pathname).replace(/^.*\/BetterBrowse\/?/, '');
    const headers = options.headers || {};
    const file = this.files.get(path);

    if (method === 'MKCOL') {
      if (this.files.has(path)) return this._response(405);
      this.files.set(path, { body: '', etag: this.etag(), dir: true });
      return this._response(201);
    }
    if (method === 'GET' || method === 'HEAD') {
      if (!file) return this._response(404);
      return this._response(200, method === 'HEAD' ? '' : file.body, file.etag);
    }
    if (method === 'DELETE') {
      if (!file) return this._response(404);
      this.files.delete(path);
      return this._response(204);
    }
    if (method === 'PROPFIND') {
      const prefix = path ? `${path.replace(/\/+$/, '')}/` : '';
      const hrefs = [...this.files.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/') && key !== prefix)
        .map((key) => `<d:response><d:href>/dav/BetterBrowse/${encodeURI(key)}</d:href></d:response>`);
      const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`
        + `<d:response><d:href>/dav/BetterBrowse/${encodeURI(prefix)}</d:href></d:response>`
        + `${hrefs.join('')}</d:multistatus>`;
      return this._response(207, body);
    }
    if (method === 'PUT') {
      if (headers['If-Match'] && (!file || file.etag !== headers['If-Match'])) return this._response(412);
      if (headers['If-None-Match'] === '*' && file) return this._response(412);
      const etag = this.etag();
      const body = options.body ?? '';
      this.files.set(path, { body, etag });
      await this.onPut?.(path, body);
      return this._response(201, '', etag);
    }
    return this._response(405);
  }

  getManifest() {
    const raw = this.files.get('manifest.json');
    return raw ? JSON.parse(raw.body) : null;
  }

  /** 直接改写远端清单（模拟其他设备写入，刷新 ETag） */
  patchManifest(patch) {
    const next = { ...this.getManifest(), ...patch };
    this.files.set('manifest.json', { body: JSON.stringify(next, null, 2), etag: this.etag() });
    return next;
  }

  /** 列出远端快照文件路径 */
  snapshotFiles() {
    return [...this.files.keys()].filter((key) => /^snapshots\/.+\.json$/.test(key));
  }
}

/** 切换到指定设备的本地环境（IndexedDB 工厂 + chrome.storage） */
export async function useDevice(factory, store) {
  await IndexedDBManager.close();
  globalThis.indexedDB = factory;
  installChromeStore(store);
}

/** 直接改写本机同步时钟（测试构造 lamport 相同的并发编辑） */
export async function patchClock(patch) {
  await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readwrite', async (tx) => {
    const store = tx.objectStore(IDBStores.SYNC_META);
    const record = await IndexedDBManager.requestToPromise(store.get(SYNC_CLOCK_KEY));
    store.put({ key: SYNC_CLOCK_KEY, value: { ...record.value, ...patch }, updatedAt: Date.now() });
  });
}

/** 统计某个本地仓储的记录数 */
export async function countStore(storeName) {
  return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
    return Number(await IndexedDBManager.requestToPromise(tx.objectStore(storeName).count())) || 0;
  });
}
