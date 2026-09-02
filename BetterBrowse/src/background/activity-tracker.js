/**
 * @file activity-tracker.js
 * @description 标签页活跃度跟踪器（内存保留 tabId 投影；持久层按 pageId 单条写入，避免每次激活整对象重写）
 * @encoding UTF-8
 */

import { StorageKeys } from '../constants/storage-keys.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { IndexedDBManager, IDBStores } from '../core/storage/indexed-db.js';
import { IndexedStashRepository } from '../core/stash/indexed-stash-repo.js';
import { SyncOutbox } from '../core/sync/outbox.js';
import { SyncEntityTypes, SyncOps } from '../core/sync/sync-constants.js';

/** 活跃时间戳的内存保留窗口（超出后裁剪，控制体积） */
const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

export class TabActivityTracker {
  constructor() {
    /**
     * 内存中的 tabId 投影（GET_TAB_ACTIVITY_STATS / FrequencyRule 消费口径保持不变）
     * @type {Record<number, { lastActivated: number, activationTimestamps: number[] }>}
     */
    this.stats = {};
    /**
     * 跨设备同步的权威持久层：pageId → { url, lastActivated, activationTimestamps }
     * @type {Record<string, { url: string, lastActivated: number, activationTimestamps: number[] }>}
     */
    this.pageStats = {};
    /** tabId → { url, pageId } 映射缓存（仅本机运行时使用，绝不持久化 / 同步 tabId） */
    this.tabMeta = new Map();
    this.storageKey = StorageKeys.ACTIVITY_STATS;
    this.saveDebounceTimers = new Map();

    // MV3 生命周期事件必须同步注册；事件处理再安全等待持久化数据加载完成。
    this.initListeners();
    this.readyPromise = this.init();
  }

  /**
   * 恢复持久化数据并建立当前标签页的只读内存快照。
   */
  async init() {
    await this.loadFromStorage();
    await this.syncCurrentTabs();
  }

  /**
   * 从主库恢复按 pageId 存储的活跃度。
   * 兼容旧聚合键 `bb_activity_stats`：若仍存在，读取后按 pageId 拆开。
   */
  async loadFromStorage() {
    try {
      if (IndexedDBManager.isSupported() && (await StorageAdapter.get(StorageKeys.IDB_OPTOUT, false)) !== true) {
        const version = Number(await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0)) || 0;
        if (version >= 5) {
          const records = await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], 'readonly', async (tx) => {
            return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.ACTIVITY_STATS).getAll());
          });
          const now = Date.now();
          for (const record of records || []) {
            if (!record?.key) continue;
            if (record.key === StorageKeys.ACTIVITY_STATS) {
              const aggregate = record.value && typeof record.value === 'object' ? record.value : {};
              for (const [key, value] of Object.entries(aggregate)) {
                this._ingestPageStat(key, value, now);
              }
              continue;
            }
            if (/^page_/.test(record.key)) {
              this._ingestPageStat(record.key, record.value, now);
            }
          }
          return;
        }
      }

      const stored = await StorageAdapter.get(this.storageKey, {});
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const now = Date.now();
        for (const [key, value] of Object.entries(stored)) {
          if (key === 'fieldRevs') continue;
          this._ingestPageStat(key, value, now);
        }
      }
    } catch (err) {
      console.warn('[TabActivityTracker] 恢复活跃度数据异常:', err);
    }
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {number} now
   */
  _ingestPageStat(key, value, now) {
    if (!/^page_/.test(key) || !value || typeof value !== 'object') return;
    const lastActivated = Number(value.lastActivated) || 0;
    const timestamps = Array.isArray(value.activationTimestamps)
      ? value.activationTimestamps.filter((ts) => Number.isFinite(ts) && now - ts <= ACTIVITY_WINDOW_MS)
      : [];
    if (lastActivated && now - lastActivated > ACTIVITY_WINDOW_MS && timestamps.length === 0) return;
    this.pageStats[key] = {
      url: typeof value.url === 'string' ? value.url : '',
      lastActivated,
      activationTimestamps: timestamps
    };
  }

  /**
   * 仅持久化指定 pageId，避免整对象重写。
   * @param {string} pageId
   */
  savePageToStorage(pageId) {
    if (!pageId || !this.pageStats[pageId]) return;
    clearTimeout(this.saveDebounceTimers.get(pageId));
    const timer = setTimeout(() => {
      this.saveDebounceTimers.delete(pageId);
      this._persistPage(pageId).catch((err) => {
        console.warn('[TabActivityTracker] 写入 pageId 活跃度异常:', err);
      });
    }, 500);
    this.saveDebounceTimers.set(pageId, timer);
  }

  /**
   * @param {string} pageId
   */
  async _persistPage(pageId) {
    const record = this.pageStats[pageId];
    if (!record) return;
    const version = Number(await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0)) || 0;
    const optedOut = (await StorageAdapter.get(StorageKeys.IDB_OPTOUT, false)) === true;
    if (!IndexedDBManager.isSupported() || optedOut || version < 5) {
      // 旧存储路径仍整对象写，保持兼容回退行为
      await StorageAdapter.set(this.storageKey, this.pageStats);
      return;
    }

    await IndexedDBManager.withWriteLock(async () => {
      const enqueue = await SyncOutbox.isActive();
      const stores = [IDBStores.ACTIVITY_STATS];
      if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
      await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.ACTIVITY_STATS);
        store.put({
          key: pageId,
          value: {
            url: record.url || '',
            lastActivated: Number(record.lastActivated) || 0,
            activationTimestamps: Array.isArray(record.activationTimestamps) ? record.activationTimestamps : []
          },
          updatedAt: Date.now()
        });
        // 清理历史聚合键，避免双形态并存
        store.delete(StorageKeys.ACTIVITY_STATS);
        if (enqueue) {
          await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.ACTIVITY,
            entityId: pageId,
            op: SyncOps.UPSERT,
            fields: {
              url: record.url || '',
              lastActivated: Number(record.lastActivated) || 0,
              activationTimestamps: Array.isArray(record.activationTimestamps) ? record.activationTimestamps : []
            }
          });
        }
      });
      if (enqueue) SyncOutbox.flushDirty();
    });
  }

  /**
   * 初始化 Chrome 标签页生命周期事件监听
   */
  initListeners() {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.readyPromise
        .then(() => this.recordActivation(activeInfo.tabId))
        .catch(() => {});
    });

    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url) {
          this.tabMeta.set(tabId, { url: changeInfo.url, pageId: this.computePageId(changeInfo.url) });
        }
      });
    }

    chrome.tabs.onRemoved.addListener((tabId) => {
      delete this.stats[tabId];
      this.tabMeta.delete(tabId);
    });
  }

  /**
   * 计算页面实体 ID（与收纳仓储同一指纹算法）
   * @param {string} url
   * @returns {string}
   */
  computePageId(url) {
    try {
      return IndexedStashRepository.computePageId(url) || '';
    } catch {
      return '';
    }
  }

  /**
   * 建立当前标签页元数据与零值投影。冷启动不等同于用户激活，不写入持久层。
   */
  async syncCurrentTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        if (tab.url) {
          this.tabMeta.set(tab.id, { url: tab.url, pageId: this.computePageId(tab.url) });
        }
        if (!this.stats[tab.id]) {
          this.stats[tab.id] = {
            lastActivated: 0,
            activationTimestamps: []
          };
        }
      }
    } catch (err) {
      console.warn('[TabActivityTracker] 初始化同步标签页失败:', err);
    }
  }

  /**
   * 确保 tabId → pageId 映射就绪（异步兜底拉取 URL）
   * @param {number} tabId
   * @returns {Promise<{ url: string, pageId: string } | null>}
   */
  async _ensureTabMeta(tabId) {
    const cached = this.tabMeta.get(tabId);
    if (cached?.pageId) return cached;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) {
        const meta = { url: tab.url, pageId: this.computePageId(tab.url) };
        this.tabMeta.set(tabId, meta);
        return meta;
      }
    } catch {
      // 标签页可能已关闭
    }
    return null;
  }

  /**
   * 将一次激活合并进 pageId 维度数据（时间戳并集 + lastActivated 取最大）
   * @param {number} tabId
   * @param {number} now
   * @returns {Promise<string>}
   */
  async _touchPage(tabId, now) {
    const meta = await this._ensureTabMeta(tabId);
    if (!meta?.pageId) return '';
    const existing = this.pageStats[meta.pageId] || {
      url: meta.url || '',
      lastActivated: 0,
      activationTimestamps: []
    };
    const merged = new Set([...(existing.activationTimestamps || []), now]);
    this.pageStats[meta.pageId] = {
      url: meta.url || existing.url || '',
      lastActivated: Math.max(Number(existing.lastActivated) || 0, now),
      activationTimestamps: [...merged].filter((ts) => now - ts <= ACTIVITY_WINDOW_MS).sort((a, b) => a - b)
    };
    return meta.pageId;
  }

  /**
   * 记录标签页激活事件（同步更新 tabId 投影，异步合并 pageId 持久层）
   * @param {number} tabId
   */
  recordActivation(tabId) {
    const now = Date.now();
    if (!this.stats[tabId]) {
      this.stats[tabId] = {
        lastActivated: now,
        activationTimestamps: [now]
      };
    } else {
      this.stats[tabId].lastActivated = now;
      this.stats[tabId].activationTimestamps.push(now);
      this.stats[tabId].activationTimestamps = this.stats[tabId].activationTimestamps.filter(
        (ts) => ts >= now - ACTIVITY_WINDOW_MS
      );
    }

    this._touchPage(tabId, now)
      .then((pageId) => {
        if (pageId) this.savePageToStorage(pageId);
      })
      .catch(() => {});
  }

  /**
   * 获取当前全部活跃度统计数据（tabId 投影，仅供本机规则评估）
   * @returns {Record<number, { lastActivated: number, activationTimestamps: number[] }>}
   */
  getStats() {
    return this.stats;
  }
}
