/**
 * @file storage-adapter.js
 * @description 统一存储适配器（IndexedDB 主库优先承载配置/规则/备份/活跃度；chrome.storage 保留版本门控、修订号与运行时状态）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { DefaultConfig } from '../../constants/config.js';
import { IndexedDBManager, IDBStores } from './indexed-db.js';
import { SyncOutbox } from '../sync/outbox.js';
import { AccountConfigSync } from '../sync/account-config-sync.js';
import { SYNC_CONFIG_NESTED_KEYS, SYNC_CONFIG_SCALAR_KEYS, SyncEntityTypes, SyncOps } from '../sync/sync-constants.js';

/** 本地数据修订 7 起迁入 IndexedDB settings / activityStats 仓储的业务键 */
const IDB_SETTINGS_KEYS = new Set([
  StorageKeys.USER_CONFIG,
  StorageKeys.LINK_RULES,
  StorageKeys.AUTO_BACKUPS
]);

const IDB_ACTIVITY_KEYS = new Set([
  StorageKeys.ACTIVITY_STATS
]);

/**
 * chrome.storage 单次操作超时保护（毫秒）。
 * 极端情况下（如 SW 休眠唤醒竞态）storage 回调可能永不返回，
 * 超时按失败降级，杜绝调用方无限等待。
 */
const CHROME_STORAGE_TIMEOUT_MS = 8000;

/**
 * 为 chrome.storage 回 style API 包装超时保护
 * @template T
 * @param {Promise<T>} operation
 * @param {T} fallbackValue - 超时时的降级返回值
 * @param {string} label - 日志标签
 * @returns {Promise<T>}
 */
function withStorageTimeout(operation, fallbackValue, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[StorageAdapter] ${label} 超时（${CHROME_STORAGE_TIMEOUT_MS} 毫秒），按降级值继续`);
      resolve(fallbackValue);
    }, CHROME_STORAGE_TIMEOUT_MS);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      }
    );
  });
}

export class StorageAdapter {
  /**
   * 获取指定 Storage 区域（默认为 local，容量大且读写速度快）
   * @param {'local' | 'sync' | 'session'} [area='local']
   */
  static getStorageArea(area = 'local') {
    const storageApi = (typeof chrome !== 'undefined') ? chrome.storage : null;
    if (!storageApi) {
      throw new Error('chrome.storage 不可用');
    }
    if (area === 'session' && storageApi.session) return storageApi.session;
    if (area === 'sync' && storageApi.sync) return storageApi.sync;
    if (!storageApi.local) {
      throw new Error('chrome.storage.local 不可用');
    }
    return storageApi.local;
  }

  /**
   * 当前键是否应由 IndexedDB 主库承载
   * 版本门控：schema ≥ 7 且未回退、环境支持 IndexedDB、且请求落在 local 区域
   * @param {string} key
   * @param {'local' | 'sync' | 'session'} [area='local']
   * @returns {Promise<{ store: string | null, useIdb: boolean }>}
   */
  static async _resolveIdbStore(key, area = 'local') {
    if (area !== 'local') return { store: null, useIdb: false };
    if (!IDB_SETTINGS_KEYS.has(key) && !IDB_ACTIVITY_KEYS.has(key)) {
      return { store: null, useIdb: false };
    }
    if (!IndexedDBManager.isSupported()) return { store: null, useIdb: false };
    try {
      if ((await this.getChrome(StorageKeys.IDB_OPTOUT, false)) === true) {
        return { store: null, useIdb: false };
      }
      const version = Number(await this.getChrome(StorageKeys.SCHEMA_VERSION, 0)) || 0;
      if (version < 7) return { store: null, useIdb: false };
      return {
        store: IDB_ACTIVITY_KEYS.has(key) ? IDBStores.ACTIVITY_STATS : IDBStores.SETTINGS,
        useIdb: true
      };
    } catch {
      return { store: null, useIdb: false };
    }
  }

  /**
   * 直接读写 chrome.storage（绕过 IndexedDB 路由，供版本门控与迁移内部使用）
   * @param {string} key
   * @param {any} [defaultValue=null]
   * @param {'local' | 'sync' | 'session'} [area='local']
   * @returns {Promise<any>}
   */
  static async getChrome(key, defaultValue = null, area = 'local') {
    return withStorageTimeout(
      new Promise((resolve) => {
        try {
          const storage = this.getStorageArea(area);
          storage.get([key], (result) => {
            if (chrome.runtime.lastError) {
              // 仅记录可读的错误消息（直接输出 lastError 对象在扩展错误页会显示为 [object Object]）
              // 配额/瞬时失败属运行时预期，用 warn 避免扩展错误页收录为未处理错误
              console.warn(`[StorageAdapter] 读取 key=${key} 失败: ${chrome.runtime.lastError?.message || '未知错误'}`);
              resolve(defaultValue);
              return;
            }
            const val = result ? result[key] : undefined;
            resolve(val !== undefined ? val : defaultValue);
          });
        } catch (err) {
          console.warn(`[StorageAdapter] 读取异常 key=${key}:`, err?.message || err);
          resolve(defaultValue);
        }
      }),
      defaultValue,
      `读取 key=${key}`
    );
  }

  /**
   * 直接写入 chrome.storage（绕过 IndexedDB 路由）
   * @param {string} key
   * @param {any} value
   * @param {'local' | 'sync' | 'session'} [area='local']
   * @returns {Promise<boolean>}
   */
  static async setChrome(key, value, area = 'local') {
    return withStorageTimeout(
      new Promise((resolve) => {
        try {
          const storage = this.getStorageArea(area);
          storage.set({ [key]: value }, () => {
            if (chrome.runtime.lastError) {
              // 配额/瞬时失败属运行时预期（如旧版 chrome.storage 写入备份超限），
              // 用 warn 避免扩展错误页收录为未处理错误；消息已展开，不再输出 [object Object]
              console.warn(`[StorageAdapter] 写入 key=${key} 失败: ${chrome.runtime.lastError?.message || '未知错误'}`);
              resolve(false);
              return;
            }
            resolve(true);
          });
        } catch (err) {
          console.warn(`[StorageAdapter] 写入异常 key=${key}:`, err?.message || err);
          resolve(false);
        }
      }),
      false,
      `写入 key=${key}`
    );
  }

  /**
   * 从 IndexedDB 指定仓储读取单条记录
   * @param {string} storeName
   * @param {string} key
   * @returns {Promise<any | undefined>}
   */
  static async _getIdbValue(storeName, key) {
    return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
      // 活跃度自本地数据修订 10 起按 pageId 分记录；对外仍返回聚合对象以兼容旧调用方。
      if (storeName === IDBStores.ACTIVITY_STATS && key === StorageKeys.ACTIVITY_STATS) {
        const all = await IndexedDBManager.requestToPromise(tx.objectStore(storeName).getAll());
        const aggregate = {};
        for (const record of all || []) {
          if (!record?.key) continue;
          if (record.key === StorageKeys.ACTIVITY_STATS && record.value && typeof record.value === 'object') {
            Object.assign(aggregate, record.value);
            continue;
          }
          if (/^page_/.test(record.key) && record.value && typeof record.value === 'object') {
            aggregate[record.key] = record.value;
          }
        }
        // 已走 IndexedDB 主库时，即使结果为空也返回 {}，避免回退到旧 chrome.storage 脏快照。
        return aggregate;
      }
      const record = await IndexedDBManager.requestToPromise(tx.objectStore(storeName).get(key));
      return record ? record.value : undefined;
    });
  }

  /**
   * 向 IndexedDB 指定仓储写入单条记录
   * @param {string} storeName
   * @param {string} key
   * @param {any} value
   * @returns {Promise<boolean>}
   */
  static async _setIdbValue(storeName, key, value) {
    const shouldEnqueue = await this._shouldEnqueue(key);
    const stores = [storeName];
    if (shouldEnqueue) {
      stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
    }
    await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
      // 活跃度整对象写入拆成 pageId 记录，并删除历史聚合键。
      if (storeName === IDBStores.ACTIVITY_STATS && key === StorageKeys.ACTIVITY_STATS) {
        const store = tx.objectStore(storeName);
        const pages = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const existing = await IndexedDBManager.requestToPromise(store.getAllKeys());
        for (const existingKey of existing || []) {
          if (existingKey === StorageKeys.ACTIVITY_STATS || /^page_/.test(String(existingKey))) {
            store.delete(existingKey);
          }
        }
        for (const [pageId, pageValue] of Object.entries(pages)) {
          if (!/^page_/.test(pageId) || !pageValue || typeof pageValue !== 'object') continue;
          store.put({
            key: pageId,
            value: {
              url: typeof pageValue.url === 'string' ? pageValue.url : '',
              lastActivated: Number(pageValue.lastActivated) || 0,
              activationTimestamps: Array.isArray(pageValue.activationTimestamps)
                ? pageValue.activationTimestamps.filter((ts) => Number.isFinite(ts))
                : []
            },
            updatedAt: Date.now()
          });
          if (shouldEnqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.ACTIVITY,
              entityId: pageId,
              op: SyncOps.UPSERT,
              fields: {
                url: typeof pageValue.url === 'string' ? pageValue.url : '',
                lastActivated: Number(pageValue.lastActivated) || 0,
                activationTimestamps: Array.isArray(pageValue.activationTimestamps)
                  ? pageValue.activationTimestamps.filter((ts) => Number.isFinite(ts))
                  : []
              }
            });
          }
        }
        return;
      }

      let enqueueSpec = null;
      if (shouldEnqueue) {
        enqueueSpec = await this._buildEnqueueSpec(tx, storeName, key, value);
      }
      tx.objectStore(storeName).put({ key, value, updatedAt: Date.now() });
      if (enqueueSpec) await SyncOutbox.enqueueInTx(tx, enqueueSpec);
    });
    if (shouldEnqueue) SyncOutbox.flushDirty();
    return true;
  }

  /**
   * 是否把本次 settings / activity 写入记入同步 outbox
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  static async _shouldEnqueue(key) {
    if (key === StorageKeys.AUTO_BACKUPS || key === StorageKeys.WEBDAV_CREDENTIALS) return false;
    if (key !== StorageKeys.USER_CONFIG && key !== StorageKeys.LINK_RULES && key !== StorageKeys.ACTIVITY_STATS) {
      return false;
    }
    return await SyncOutbox.isActive();
  }

  /**
   * 根据键生成 outbox 操作描述
   * @param {IDBTransaction} tx
   * @param {string} storeName
   * @param {string} key
   * @param {any} value
   */
  static async _buildEnqueueSpec(tx, storeName, key, value) {
    if (key === StorageKeys.USER_CONFIG) {
      const prevRecord = await IndexedDBManager.requestToPromise(tx.objectStore(storeName).get(key));
      const prev = this.mergeUserConfig(prevRecord?.value || {});
      const next = this.mergeUserConfig(value);
      const fields = this._diffSyncConfig(prev, next);
      if (Object.keys(fields).length === 0) return null;
      return {
        entityType: SyncEntityTypes.SETTINGS,
        entityId: 'userConfig',
        op: SyncOps.PATCH,
        fields
      };
    }
    if (key === StorageKeys.LINK_RULES) {
      const rules = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const fields = { ...rules };
      delete fields.fieldRevs;
      return {
        entityType: SyncEntityTypes.LINK_RULES,
        entityId: 'root',
        op: SyncOps.UPSERT,
        fields
      };
    }
    if (key === StorageKeys.ACTIVITY_STATS) {
      return {
        entityType: SyncEntityTypes.ACTIVITY,
        entityId: 'stats',
        op: SyncOps.UPSERT,
        fields: { pages: value && typeof value === 'object' ? value : {} }
      };
    }
    return null;
  }

  /**
   * 计算可同步配置字段的增量补丁（点分路径）
   * @param {typeof DefaultConfig} prev
   * @param {typeof DefaultConfig} next
   * @returns {Record<string, any>}
   */
  static _diffSyncConfig(prev, next) {
    const fields = {};
    for (const key of SYNC_CONFIG_SCALAR_KEYS) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        fields[key] = next[key];
      }
    }
    for (const key of SYNC_CONFIG_NESTED_KEYS) {
      const prevObj = prev[key] && typeof prev[key] === 'object' ? prev[key] : {};
      const nextObj = next[key] && typeof next[key] === 'object' ? next[key] : {};
      const names = new Set([...Object.keys(prevObj), ...Object.keys(nextObj)]);
      for (const sub of names) {
        if (sub === 'fieldRevs') continue;
        if (JSON.stringify(prevObj[sub]) !== JSON.stringify(nextObj[sub])) {
          fields[`${key}.${sub}`] = nextObj[sub];
        }
      }
    }
    return fields;
  }

  /**
   * 读取存储值
   * 本地数据修订 7 起配置/规则/备份/活跃度优先走 IndexedDB；读失败时回退旧 chrome.storage 快照（30 天保留期内仍可读）
   * @param {string} key - 存储键名
   * @param {any} [defaultValue=null] - 默认回退值
   * @param {'local' | 'sync' | 'session'} [area='local'] - 存储区域
   * @returns {Promise<any>}
   */
  static async get(key, defaultValue = null, area = 'local') {
    const route = await this._resolveIdbStore(key, area);
    if (route.useIdb) {
      try {
        const value = await this._getIdbValue(route.store, key);
        if (value !== undefined) return value;
      } catch (err) {
        console.warn(`[StorageAdapter] IndexedDB 读取 key=${key} 失败，降级至 chrome.storage.local:`, err);
      }
      // IndexedDB 无记录或读失败：回退旧存储快照
    }
    return await this.getChrome(key, defaultValue, area);
  }

  /**
   * 写入存储值
   * 本地数据修订 7 起配置/规则/备份/活跃度写入 IndexedDB 主库；写失败显式返回 false，绝不降级写旧存储
   * @param {string} key - 存储键名
   * @param {any} value - 待存入的值
   * @param {'local' | 'sync' | 'session'} [area='local'] - 存储区域
   * @returns {Promise<boolean>}
   */
  static async set(key, value, area = 'local') {
    const route = await this._resolveIdbStore(key, area);
    let ok = false;
    if (route.useIdb) {
      try {
        ok = await this._setIdbValue(route.store, key, value);
      } catch (err) {
        console.warn(`[StorageAdapter] IndexedDB 写入 key=${key} 失败:`, err?.message || err);
        return false;
      }
    } else {
      ok = await this.setChrome(key, value, area);
    }
    if (ok && key === StorageKeys.USER_CONFIG && area === 'local') {
      AccountConfigSync.scheduleMirror(value);
    }
    return ok;
  }

  /**
   * 深度合并用户配置与默认值（补齐新增字段，保留用户已有值）
   * @param {any} rawConfig
   * @returns {typeof DefaultConfig}
   */
  static mergeUserConfig(rawConfig) {
    const storedConfig = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? rawConfig
      : {};
    return {
      ...DefaultConfig,
      ...storedConfig,
      rulesEnabled: {
        ...DefaultConfig.rulesEnabled,
        ...(storedConfig.rulesEnabled || {})
      },
      globalLinkRule: {
        ...DefaultConfig.globalLinkRule,
        ...(storedConfig.globalLinkRule || {})
      },
      stashSettings: {
        ...DefaultConfig.stashSettings,
        ...(storedConfig.stashSettings || {})
      },
      tieredStash: {
        ...DefaultConfig.tieredStash,
        ...(storedConfig.tieredStash || {})
      },
      autoBackupLimits: {
        ...DefaultConfig.autoBackupLimits,
        ...(storedConfig.autoBackupLimits || {})
      },
      webdavSync: {
        ...DefaultConfig.webdavSync,
        ...(storedConfig.webdavSync || {})
      },
      accountConfigSync: {
        ...DefaultConfig.accountConfigSync,
        ...(storedConfig.accountConfigSync || {})
      },
      aiBridge: {
        ...DefaultConfig.aiBridge,
        ...(storedConfig.aiBridge || {})
      }
    };
  }

  /**
   * 获取用户全局配置（自动与默认配置深度合并）
   * @returns {Promise<typeof DefaultConfig>}
   */
  static async getUserConfig() {
    const rawConfig = await this.get(StorageKeys.USER_CONFIG, {});
    return this.mergeUserConfig(rawConfig);
  }

  /**
   * 更新用户全局配置
   * 读-改-写序列持跨上下文写锁（与 IndexedDB 写入共用同一把互斥锁），
   * 防止 popup 与选项页并发更新配置时相互覆盖丢失字段。
   * ⚠️ 本方法不可在已持有写锁的临界区内调用（会死锁）
   * @param {Partial<typeof DefaultConfig>} partialConfig - 增量配置
   * @returns {Promise<boolean>}
   */
  static async updateUserConfig(partialConfig) {
    partialConfig = partialConfig && typeof partialConfig === 'object' && !Array.isArray(partialConfig)
      ? partialConfig
      : {};
    return await IndexedDBManager.withWriteLock(async () => {
      return await this.updateUserConfigUnlocked(partialConfig);
    });
  }

  /**
   * 无锁版配置更新（调用方必须已持有跨上下文写锁）
   * @param {Partial<typeof DefaultConfig>} partialConfig
   * @returns {Promise<boolean>}
   */
  static async updateUserConfigUnlocked(partialConfig) {
    partialConfig = partialConfig && typeof partialConfig === 'object' && !Array.isArray(partialConfig)
      ? partialConfig
      : {};
    const current = await this.getUserConfig();
    const updated = {
      ...current,
      ...partialConfig,
      rulesEnabled: {
        ...current.rulesEnabled,
        ...(partialConfig.rulesEnabled || {})
      },
      globalLinkRule: {
        ...current.globalLinkRule,
        ...(partialConfig.globalLinkRule || {})
      },
      stashSettings: {
        ...current.stashSettings,
        ...(partialConfig.stashSettings || {})
      },
      tieredStash: {
        ...current.tieredStash,
        ...(partialConfig.tieredStash || {})
      },
      autoBackupLimits: {
        ...current.autoBackupLimits,
        ...(partialConfig.autoBackupLimits || {})
      },
      webdavSync: {
        ...current.webdavSync,
        ...(partialConfig.webdavSync || {})
      },
      accountConfigSync: {
        ...current.accountConfigSync,
        ...(partialConfig.accountConfigSync || {})
      },
      aiBridge: {
        ...current.aiBridge,
        ...(partialConfig.aiBridge || {})
      }
    };
    return await this.set(StorageKeys.USER_CONFIG, updated);
  }

  /**
   * 覆盖写入完整用户配置（重置默认 / 全量备份恢复）
   * ⚠️ 本方法不可在已持有写锁的临界区内调用
   * @param {typeof DefaultConfig} config
   * @returns {Promise<boolean>}
   */
  static async replaceUserConfig(config) {
    return await IndexedDBManager.withWriteLock(async () => {
      return await this.set(StorageKeys.USER_CONFIG, this.mergeUserConfig(config));
    });
  }

  /**
   * 监听存储变化事件
   * @param {(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void} callback
   */
  static addChangeListener(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener(callback);
  }
}
