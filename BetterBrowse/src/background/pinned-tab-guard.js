/**
 * @file pinned-tab-guard.js
 * @description 常驻固定小标签页守护器与窗口/浏览器关闭全量自动收纳处理器
 * @encoding UTF-8
 */

import { StashService } from '../core/stash/stash-service.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';
import { isExcludedFromTabCounting, isOwnOptionsUrl } from '../core/extension-url.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';

export class PinnedTabGuard {
  constructor() {
    this.isGuarding = false;
    this.checkDebounceTimer = null;
    /**
     * 维护各窗口当前已打开的所有标签页信息快照
     * Map<windowId, Map<tabId, { url: string, title: string, favIconUrl: string, pinned: boolean, index: number }>>
     */
    this.tabsByWindow = new Map();
    this.closingWindows = new Set();

    this.initListeners();
    this.ready = this.syncAllTabs();
  }

  /**
   * 同步当前所有已打开的普通窗口与标签页
   */
  async syncAllTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      this.tabsByWindow.clear();
      for (const tab of tabs) {
        if (typeof tab.windowId === 'number' && typeof tab.id === 'number') {
          this.recordTab(tab);
        }
      }
    } catch (err) {
      console.warn('[PinnedTabGuard] 同步标签快照异常:', err);
    }
  }

  /**
   * 记录标签页快照信息
   * @param {chrome.tabs.Tab} tab
   */
  recordTab(tab) {
    if (!tab || typeof tab.windowId !== 'number' || typeof tab.id !== 'number') return;
    if (!this.tabsByWindow.has(tab.windowId)) {
      this.tabsByWindow.set(tab.windowId, new Map());
    }
    this.tabsByWindow.get(tab.windowId).set(tab.id, {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || tab.url || '无标题页面',
      favIconUrl: tab.favIconUrl || '',
      pinned: Boolean(tab.pinned),
      index: tab.index
    });
  }

  /**
   * 初始化常驻固定标签守护监听与窗口关闭全量收纳
   */
  initListeners() {
    // 1. Service Worker 启动时延迟预检
    this.scheduleCheck(200);

    // 2. 标签页创建与更新时同步快照
    chrome.tabs.onCreated.addListener((tab) => {
      this.recordTab(tab);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.recordTab(tab);

      // 固定小标签防脱落/防解绑守护
      if (tab && isOwnOptionsUrl(tab.url)) {
        if (changeInfo.pinned === false || (typeof tab.index === 'number' && tab.index !== 0)) {
          this.scheduleCheck(100, tab.windowId);
        }
      }
    });

    // 3. 监听新窗口创建（新窗口打开时自动在第 1 位生成固定小标签）
    if (chrome.windows && chrome.windows.onCreated) {
      chrome.windows.onCreated.addListener((window) => {
        if (window.type === 'normal') {
          setTimeout(() => {
            StorageAdapter.getUserConfig().then((config) => {
              if (config.stashSettings?.pinnedTabGuard !== false) {
                return StashService.ensurePinnedStashTab(false, window.id);
              }
            }).catch(() => {});
          }, 350);
        }
      });
    }

    // 4. 监听标签页关闭与窗口关闭全量自动收纳（核心：关闭浏览器/窗口时，全量无条件收纳所有页面）
    chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
      const windowId = removeInfo?.windowId;

      if (removeInfo && removeInfo.isWindowClosing && windowId) {
        // 该窗口正在关闭：立即全量收纳该窗口中除 options.html 和空白页之外的全部标签页
        if (!this.closingWindows.has(windowId)) {
          this.closingWindows.add(windowId);
          await this.stashClosingWindowTabs(windowId);
          setTimeout(() => {
            this.closingWindows.delete(windowId);
          }, 3000);
        }
      } else {
        // 单个标签页常规关闭
        if (windowId && this.tabsByWindow.has(windowId)) {
          this.tabsByWindow.get(windowId).delete(tabId);
        }
        if (removeInfo && !removeInfo.isWindowClosing) {
          this.scheduleCheck(150, windowId);
        }
      }
    });

    // 5. 监听标签页移动（如果 options.html 被拖动离开 index 0，自动移回首位）
    chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
      if (moveInfo && typeof moveInfo.windowId === 'number') {
        this.scheduleCheck(100, moveInfo.windowId);
      }
    });

    // 6. 监听浏览器窗口聚焦
    if (chrome.windows && chrome.windows.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener((windowId) => {
        if (windowId !== chrome.windows.WINDOW_ID_NONE) {
          this.scheduleCheck(150, windowId);
        }
      });
    }

    // 7. 窗口被完全销毁清理
    if (chrome.windows && chrome.windows.onRemoved) {
      chrome.windows.onRemoved.addListener((windowId) => {
        this.tabsByWindow.delete(windowId);
        this.closingWindows.delete(windowId);
      });
    }
  }

  /**
   * 窗口/浏览器关闭时，将当前窗口所有标签页全量收纳
   * @param {number} windowId
   */
  async stashClosingWindowTabs(windowId) {
    try {
      // SW 冷启动瞬间快照可能尚未同步完成，等待其就绪再走兜底路径
      // （实时 tabs.query 优先，快照仅作为查询失败时的兜底）
      await this.ready?.catch?.(() => {});
      const config = await StorageAdapter.getUserConfig();
      if (config.stashSettings?.pinnedTabGuard === false) return;
      let tabsList = [];
      try {
        const liveTabs = await chrome.tabs.query({ windowId });
        tabsList = liveTabs.map((tab) => ({
          id: tab.id,
          url: tab.url || '',
          title: tab.title || tab.url || '无标题页面',
          favIconUrl: tab.favIconUrl || '',
          pinned: Boolean(tab.pinned),
          index: tab.index
        }));
      } catch {}
      if (tabsList.length === 0) {
        const windowTabsMap = this.tabsByWindow.get(windowId);
        tabsList = windowTabsMap ? Array.from(windowTabsMap.values()) : [];
      }
      if (tabsList.length === 0) return;
      const tabsToSave = tabsList.filter((tab) => !isExcludedFromTabCounting(tab));

      if (tabsToSave.length > 0) {
        console.info(`[PinnedTabGuard] 正在执行窗口关闭全量收纳 (${tabsToSave.length} 个标签页)...`);
        await LocalStashRepository.createGroup(tabsToSave);
      }

      this.tabsByWindow.delete(windowId);
    } catch (err) {
      console.error('[PinnedTabGuard] 窗口关闭全量收纳异常:', err);
    }
  }

  /**
   * 防抖检查与常驻固定标签守护执行
   * @param {number} [delay=150]
   * @param {number} [windowId]
   */
  scheduleCheck(delay = 150, windowId = null) {
    if (this.isGuarding) return;

    clearTimeout(this.checkDebounceTimer);
    this.checkDebounceTimer = setTimeout(async () => {
      this.isGuarding = true;
      try {
        const config = await StorageAdapter.getUserConfig();
        if (config.stashSettings?.pinnedTabGuard === false) return;
        if (windowId && windowId !== chrome.windows.WINDOW_ID_NONE) {
          const win = await chrome.windows.get(windowId).catch(() => null);
          if (win && win.type === 'normal') {
            await StashService.ensurePinnedStashTab(false, windowId);
          }
        } else {
          await StashService.ensureAllAllWindowsPinnedTab();
        }
      } catch {
        // 忽略守护检查异常
      } finally {
        this.isGuarding = false;
      }
    }, delay);
  }
}
