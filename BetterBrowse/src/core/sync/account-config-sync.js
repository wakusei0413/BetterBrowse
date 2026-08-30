/**
 * @file account-config-sync.js
 * @description 浏览器账号偏好镜像（chrome.storage.sync）。只同步阈值/规则/收纳箱设置/WebDAV 地址，
 *              不含收纳列表、域名跳转表、凭据与 fieldRevs。权威数据仍是 IndexedDB。
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { DefaultConfig } from '../../constants/config.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { ActionTypes } from '../../constants/action-types.js';
import {
  ACCOUNT_CONFIG_MAX_BYTES,
  ACCOUNT_CONFIG_PAYLOAD_VERSION,
  SYNC_CONFIG_NESTED_KEYS,
  SYNC_CONFIG_SCALAR_KEYS
} from './sync-constants.js';

export class AccountConfigSync {
  static _initialized = false;
  static _applying = false;
  static _lastSliceJson = '';
  static _pendingTimer = 0;
  static _pendingCount = 0;
  static _pendingChain = Promise.resolve();

  /**
   * 测试用：清空监听状态与切片缓存
   */
  static resetForTests() {
    this._initialized = false;
    this._applying = false;
    this._lastSliceJson = '';
    clearTimeout(this._pendingTimer);
    this._pendingTimer = 0;
    this._pendingCount = 0;
    this._pendingChain = Promise.resolve();
  }

  /**
   * 仅在 chrome.storage.sync 真实存在时返回该区域；缺失则返回 null，绝不回退 local。
   * @returns {chrome.storage.StorageArea | null}
   */
  static getSyncArea() {
    try {
      const area = (typeof chrome !== 'undefined') ? chrome.storage?.sync : null;
      if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') return null;
      return area;
    } catch {
      return null;
    }
  }

  /**
   * 从完整用户配置切出允许进入浏览器账号的偏好（剥离 fieldRevs、凭据与域名表）
   * @param {typeof DefaultConfig | Record<string, any>} config
   * @returns {Record<string, any>}
   */
  static slice(config) {
    const merged = StorageAdapter.mergeUserConfig(config || {});
    const sliced = {};
    for (const key of SYNC_CONFIG_SCALAR_KEYS) {
      sliced[key] = merged[key];
    }
    for (const key of SYNC_CONFIG_NESTED_KEYS) {
      const src = merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])
        ? merged[key]
        : {};
      const copy = { ...src };
      delete copy.fieldRevs;
      if (key === 'webdavSync') {
        sliced[key] = {
          enabled: copy.enabled === true,
          autoSync: copy.autoSync !== false,
          serverUrl: typeof copy.serverUrl === 'string' ? copy.serverUrl : ''
        };
        continue;
      }
      if (key === 'accountConfigSync') {
        sliced[key] = { enabled: copy.enabled !== false };
        continue;
      }
      sliced[key] = copy;
    }
    return sliced;
  }

  /**
   * 规范化远端载荷中的 config 切片（忽略未知字段）
   * @param {any} raw
   * @returns {Record<string, any> | null}
   */
  static sanitizeIncoming(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = raw.config && typeof raw.config === 'object' ? raw.config : raw;
    const sliced = this.slice(source);
    return sliced;
  }

  /**
   * 序列化账号偏好载荷；超限返回 null
   * @param {Record<string, any>} sliced
   * @param {number} [updatedAt=Date.now()]
   * @returns {{ json: string, payload: object, bytes: number } | null}
   */
  static buildPayload(sliced, updatedAt = Date.now()) {
    const payload = {
      v: ACCOUNT_CONFIG_PAYLOAD_VERSION,
      updatedAt: Number(updatedAt) || Date.now(),
      config: sliced
    };
    let json;
    try {
      json = JSON.stringify(payload);
    } catch (err) {
      console.warn('[AccountConfigSync] 序列化偏好失败:', err?.message || err);
      return null;
    }
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > ACCOUNT_CONFIG_MAX_BYTES) {
      console.warn(`[AccountConfigSync] 偏好体积 ${bytes} 字节超过 ${ACCOUNT_CONFIG_MAX_BYTES}，跳过写入 chrome.storage.sync`);
      return null;
    }
    return { json, payload, bytes };
  }

  /**
   * 本机配置写入成功后镜像到浏览器账号。失败不影响 IndexedDB。
   * @param {typeof DefaultConfig | Record<string, any>} config
   * @returns {Promise<boolean>}
   */
  static async mirror(config) {
    if (this._applying) return false;
    const area = this.getSyncArea();
    if (!area) return false;
    const merged = StorageAdapter.mergeUserConfig(config || {});
    const sliced = this.slice(merged);
    const sliceJson = JSON.stringify(sliced);
    if (sliceJson === this._lastSliceJson) return false;
    if (merged.accountConfigSync?.enabled === false) {
      // 关闭后只把开关本身推出去，后续偏好改动不再写入浏览器账号
      try {
        const last = this._lastSliceJson ? JSON.parse(this._lastSliceJson) : null;
        if (last?.accountConfigSync?.enabled === false) return false;
      } catch {
        // 忽略损坏的缓存切片，继续尝试写入关闭状态
      }
    }
    const built = this.buildPayload(sliced);
    if (!built) return false;
    // 先记下切片，避免本机 set 触发的 onChanged 再走 applyRemote 回写 IndexedDB
    this._lastSliceJson = sliceJson;
    const ok = await this._setSync(area, built.payload);
    return ok;
  }

  /**
   * 写锁释放后再镜像，避免嵌套写锁与 onChanged 回环
   * @param {typeof DefaultConfig | Record<string, any>} [config]
   */
  static scheduleMirror(config) {
    if (this._applying) return;
    const snapshot = config;
    this._schedule(async () => {
      if (snapshot && typeof snapshot === 'object') {
        await this.mirror(snapshot);
        return;
      }
      await this.remirrorFromLocal();
    });
  }

  /**
   * 从本机权威配置重新镜像（WebDAV 合并 / 快照应用后使用）
   * @returns {Promise<boolean>}
   */
  static async remirrorFromLocal() {
    if (this._applying) return false;
    try {
      const config = await StorageAdapter.getUserConfig();
      return await this.mirror(config);
    } catch (err) {
      console.warn('[AccountConfigSync] 从本机重镜像失败:', err?.message || err);
      return false;
    }
  }

  /**
   * Service Worker 启动：hydrate 一次并监听 chrome.storage.sync
   * @returns {Promise<void>}
   */
  static async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._bindListener();
    try {
      await this.hydrate();
    } catch (err) {
      console.warn('[AccountConfigSync] 启动 hydrate 异常:', err?.message || err);
    }
  }

  /**
   * 新设备用账号偏好覆盖默认值；本机已有偏好且账号为空则推上去。
   * @returns {Promise<'applied' | 'pushed' | 'skipped'>}
   */
  static async hydrate() {
    const area = this.getSyncArea();
    if (!area) return 'skipped';
    const remote = await this._getSync(area);
    const local = await StorageAdapter.getUserConfig();
    const localSlice = this.slice(local);
    const localJson = JSON.stringify(localSlice);

    if (this._isValidPayload(remote)) {
      const incoming = this.sanitizeIncoming(remote);
      if (!incoming) return 'skipped';
      const incomingJson = JSON.stringify(incoming);
      if (incomingJson === localJson) {
        this._lastSliceJson = localJson;
        return 'skipped';
      }
      if (this._isDefaultSlice(localSlice) && !this._isDefaultSlice(incoming)) {
        const applied = await this._applyIncoming(incoming);
        return applied ? 'applied' : 'skipped';
      }
      const localUpdatedAt = await this._localConfigUpdatedAt();
      if (Number(remote.updatedAt) > localUpdatedAt) {
        const applied = await this._applyIncoming(incoming);
        return applied ? 'applied' : 'skipped';
      }
    }

    this._lastSliceJson = '';
    await this.mirror(local);
    return 'pushed';
  }

  /**
   * 远端 onChanged：LWW 整份覆盖本机偏好，并进入 WebDAV outbox
   * @param {any} newValue
   * @returns {Promise<boolean>}
   */
  static async applyRemote(newValue) {
    if (!this._isValidPayload(newValue)) return false;
    const incoming = this.sanitizeIncoming(newValue);
    if (!incoming) return false;
    const incomingJson = JSON.stringify(incoming);
    if (incomingJson === this._lastSliceJson) return false;
    const local = await StorageAdapter.getUserConfig();
    const incomingEnabled = incoming.accountConfigSync?.enabled !== false;
    if (local.accountConfigSync?.enabled === false && !incomingEnabled) return false;
    return await this._applyIncoming(incoming);
  }

  static _bindListener() {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      const change = changes?.[StorageKeys.ACCOUNT_CONFIG];
      if (!change || change.newValue === undefined) return;
      this.applyRemote(change.newValue).catch((err) => {
        console.warn('[AccountConfigSync] 应用远端偏好失败:', err?.message || err);
      });
    });
  }

  static _isValidPayload(value) {
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Number(value.v) === ACCOUNT_CONFIG_PAYLOAD_VERSION
      && value.config
      && typeof value.config === 'object'
    );
  }

  static _isDefaultSlice(sliced) {
    const baseline = this.slice(DefaultConfig);
    return JSON.stringify(sliced) === JSON.stringify(baseline);
  }

  static async _localConfigUpdatedAt() {
    try {
      return await IndexedDBManager.runTransaction([IDBStores.SETTINGS], 'readonly', async (tx) => {
        const record = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.SETTINGS).get(StorageKeys.USER_CONFIG)
        );
        return Number(record?.updatedAt) || 0;
      });
    } catch {
      return 0;
    }
  }

  static async _applyIncoming(incoming) {
    this._applying = true;
    try {
      const ok = await StorageAdapter.updateUserConfig(incoming);
      if (!ok) return false;
      this._lastSliceJson = JSON.stringify(this.slice(incoming));
      this._notifyConfigUpdated(incoming);
      return true;
    } catch (err) {
      console.warn('[AccountConfigSync] 写入本机偏好失败:', err?.message || err);
      return false;
    } finally {
      this._applying = false;
    }
  }

  static _notifyConfigUpdated(payload) {
    try {
      chrome.runtime.sendMessage({
        action: ActionTypes.NOTIFY_CONFIG_UPDATED,
        payload: payload || {}
      }).catch(() => {});
    } catch {
      // 无接收方时忽略
    }
  }

  static _schedule(fn) {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingCount = Math.max(0, this._pendingCount - 1);
    }
    this._pendingCount += 1;
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = 0;
      this._pendingChain = this._pendingChain
        .catch(() => {})
        .then(fn)
        .catch((err) => {
          console.warn('[AccountConfigSync] 异步镜像异常:', err?.message || err);
        })
        .finally(() => {
          this._pendingCount = Math.max(0, this._pendingCount - 1);
        });
    }, 0);
  }

  /**
   * 测试用：等待已调度的镜像任务完成
   * @returns {Promise<void>}
   */
  static async flushPending() {
    let guard = 0;
    while (this._pendingCount > 0 && guard < 20) {
      guard += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this._pendingChain.catch(() => {});
    }
  }

  static _getSync(area) {
    return new Promise((resolve) => {
      try {
        area.get([StorageKeys.ACCOUNT_CONFIG], (result) => {
          if (chrome.runtime?.lastError) {
            console.warn(`[AccountConfigSync] 读取失败: ${chrome.runtime.lastError?.message || '未知错误'}`);
            resolve(null);
            return;
          }
          resolve(result ? result[StorageKeys.ACCOUNT_CONFIG] : null);
        });
      } catch (err) {
        console.warn('[AccountConfigSync] 读取异常:', err?.message || err);
        resolve(null);
      }
    });
  }

  static _setSync(area, payload) {
    return new Promise((resolve) => {
      try {
        area.set({ [StorageKeys.ACCOUNT_CONFIG]: payload }, () => {
          if (chrome.runtime?.lastError) {
            console.warn(`[AccountConfigSync] 写入失败: ${chrome.runtime.lastError?.message || '未知错误'}`);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (err) {
        console.warn('[AccountConfigSync] 写入异常:', err?.message || err);
        resolve(false);
      }
    });
  }
}
