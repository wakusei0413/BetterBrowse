/**
 * @file activity-tracker.js
 * @description 标签页活跃度跟踪器（记录标签页激活时间点与滑动时间窗口内的激活频次）
 * @encoding UTF-8
 */

export class TabActivityTracker {
  constructor() {
    /**
     * 内存中维护的标签页活跃度数据
     * 结构: { [tabId]: { lastActivated: number, activationTimestamps: number[] } }
     * @type {Record<number, { lastActivated: number, activationTimestamps: number[] }>}
     */
    this.stats = {};
    this.storageKey = 'bb_activity_stats';
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
   * 获取存储区域（优先使用 MV3 的 session 存储，无持久化磁盘损耗且能抵御 SW 休眠）
   */
  getStorage() {
    return chrome.storage && chrome.storage.session ? chrome.storage.session : chrome.storage.local;
  }

  /**
   * 从 Storage 恢复活跃度历史快照
   */
  async loadFromStorage() {
    return new Promise((resolve) => {
      try {
        const storage = this.getStorage();
        storage.get([this.storageKey], (result) => {
          if (!chrome.runtime.lastError && result && result[this.storageKey]) {
            this.stats = result[this.storageKey] || {};
          }
          resolve();
        });
      } catch (err) {
        console.warn('[TabActivityTracker] 恢复活跃度数据异常:', err);
        resolve();
      }
    });
  }

  /**
   * 将当前活跃度数据持久化至 Storage
   */
  saveToStorage() {
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      try {
        const storage = this.getStorage();
        storage.set({ [this.storageKey]: this.stats }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[TabActivityTracker] 持久化活跃度数据失败:', chrome.runtime.lastError);
          }
        });
      } catch (err) {
        console.warn('[TabActivityTracker] 写入存储异常:', err);
      }
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

    // 监听标签页关闭，自动清理对应内存与存储记录
    chrome.tabs.onRemoved.addListener((tabId) => {
      delete this.stats[tabId];
      this.saveToStorage();
    });

    // 插件启动时，预初始化当前所有已存在的标签页
    this.syncCurrentTabs();
  }

  /**
   * 同步当前浏览器已打开的所有标签页
   */
  async syncCurrentTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      const now = Date.now();
      let changed = false;
      tabs.forEach((tab) => {
        if (!this.stats[tab.id]) {
          this.stats[tab.id] = {
            lastActivated: tab.active ? now : 0,
            activationTimestamps: tab.active ? [now] : []
          };
          changed = true;
        }
      });
      if (changed) {
        this.saveToStorage();
      }
    } catch (err) {
      console.warn('[TabActivityTracker] 初始化同步标签页失败:', err);
    }
  }

  /**
   * 记录标签页激活事件
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

      // 清理超过 2 小时以上的陈旧时间戳以控制内存开销
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      this.stats[tabId].activationTimestamps = this.stats[tabId].activationTimestamps.filter(
        (ts) => ts >= twoHoursAgo
      );
    }

    this.saveToStorage();
  }

  /**
   * 获取当前全部活跃度统计数据
   * @returns {Record<number, { lastActivated: number, activationTimestamps: number[] }>}
   */
  getStats() {
    return this.stats;
  }
}

