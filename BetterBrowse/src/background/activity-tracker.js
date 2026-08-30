/**
 * @file activity-tracker.js
 * @description 标签页活跃度跟踪器（内存保留 tabId 投影供规则引擎评估；持久层自 v8 起按 pageId 存储，支撑跨设备合并）
 * @encoding UTF-8
 */

import { StorageKeys } from '../constants/storage-keys.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { IndexedStashRepository } from '../core/stash/indexed-stash-repo.js';

/** 活跃时间戳的内存保留窗口（超出后裁剪，控制体积） */
const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

export class TabActivityTracker {
  constructor() {
    /**
     * 内存中的 tabId 投影（GET_TAB_ACTIVITY_STATS / FrequencyRule 消费口径保持不变）
     * 结构: { [tabId]: { lastActivated: number, activationTimestamps: number[] } }
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
    this.saveDebounceTimer = null;

    this.init();
  }

  /**
   * 初始化存储恢复与生命周期监听
   */
  async init() {
    await this.loadFromStorage();
    this.initListeners();
  }

  /**
   * 从主库恢复按 pageId 存储的活跃度（v8 起走 IndexedDB，失败时 StorageAdapter 会回退旧存储）
   */
  async loadFromStorage() {
    try {
      const stored = await StorageAdapter.get(this.storageKey, {});
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        // 防御式过滤：仅保留 pageId 形态的键，旧版 tabId 键已在 v8 迁移清理
        for (const [key, value] of Object.entries(stored)) {
          if (key === 'fieldRevs') continue;
          if (/^page_/.test(key) && value && typeof value === 'object') {
            this.pageStats[key] = {
              url: typeof value.url === 'string' ? value.url : '',
              lastActivated: Number(value.lastActivated) || 0,
              activationTimestamps: Array.isArray(value.activationTimestamps)
                ? value.activationTimestamps.filter((ts) => Number.isFinite(ts))
                : []
            };
          }
        }
      }
    } catch (err) {
      console.warn('[TabActivityTracker] 恢复活跃度数据异常:', err);
    }
  }

  /**
   * 将按 pageId 的活跃度持久化至主库（StorageAdapter 自动生成 outbox 操作参与同步）
   */
  saveToStorage() {
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      StorageAdapter.set(this.storageKey, this.pageStats).then((ok) => {
        if (!ok) {
          console.warn('[TabActivityTracker] 持久化活跃度数据失败');
        }
      }).catch((err) => {
        console.warn('[TabActivityTracker] 写入存储异常:', err);
      });
    }, 500);
  }

  /**
   * 初始化 Chrome 标签页生命周期事件监听
   */
  initListeners() {
    // 监听标签页切换激活
    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.recordActivation(activeInfo.tabId);
    });

    // 监听标签页 URL 变化，维护 tabId → pageId 映射
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url) {
          this.tabMeta.set(tabId, { url: changeInfo.url, pageId: this.computePageId(changeInfo.url) });
        }
      });
    }

    // 监听标签页关闭，清理内存映射（pageId 维度的历史保留，供跨设备合并）
    chrome.tabs.onRemoved.addListener((tabId) => {
      delete this.stats[tabId];
      this.tabMeta.delete(tabId);
    });

    // 插件启动时，预初始化当前所有已存在的标签页
    this.syncCurrentTabs();
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
   * 同步当前浏览器已打开的所有标签页
   */
  async syncCurrentTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      const now = Date.now();
      let changed = false;
      for (const tab of tabs) {
        if (!tab.id) continue;
        if (tab.url) {
          this.tabMeta.set(tab.id, { url: tab.url, pageId: this.computePageId(tab.url) });
        }
        if (!this.stats[tab.id]) {
          this.stats[tab.id] = {
            lastActivated: tab.active ? now : 0,
            activationTimestamps: tab.active ? [now] : []
          };
          changed = true;
          if (tab.active) {
            await this._touchPage(tab.id, now);
          }
        }
      }
      if (changed) {
        this.saveToStorage();
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
   */
  async _touchPage(tabId, now) {
    const meta = await this._ensureTabMeta(tabId);
    if (!meta?.pageId) return;
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

      // 清理超过保留窗口的陈旧时间戳以控制内存开销
      this.stats[tabId].activationTimestamps = this.stats[tabId].activationTimestamps.filter(
        (ts) => ts >= now - ACTIVITY_WINDOW_MS
      );
    }

    this._touchPage(tabId, now)
      .then(() => this.saveToStorage())
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
