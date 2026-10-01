/**
 * @file pinned-tab-guard.js
 * @description 常驻固定小标签页守护器与窗口/浏览器关闭全量自动收纳处理器
 * @encoding UTF-8
 */

import { StashService } from '../core/stash/stash-service.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';
import { isExcludedFromTabCounting, isOwnOptionsTab } from '../core/extension-url.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';

export class PinnedTabGuard {
  constructor() {
    this.isGuarding = false;
    this.checkDebounceTimer = null;
    /** @type {Set<number>} */
    this.pendingWindowIds = new Set();
    this.pendingAllWindows = false;
    /**
     * 维护各窗口当前已打开的所有标签页信息快照
     * Map<windowId, Map<tabId, { url: string, pendingUrl: string, title: string, favIconUrl: string, pinned: boolean, index: number }>>
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
      pendingUrl: tab.pendingUrl || '',
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
      if (isOwnOptionsTab(tab) && typeof tab.windowId === 'number') {
        this.scheduleCheck(100, tab.windowId);
      }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.recordTab(tab);

      // 固定小标签防脱落/防解绑/防重复守护
      if (tab && isOwnOptionsTab(tab)) {
        if (changeInfo.pinned === false || changeInfo.url || (typeof tab.index === 'number' && tab.index !== 0)) {
          this.scheduleCheck(100, tab.windowId);
        }
      }
    });

    // 3. 监听新窗口创建（新窗口打开时自动在第 1 位生成固定小标签）
    if (chrome.windows && chrome.windows.onCreated) {
      chrome.windows.onCreated.addListener((window) => {
        if (window.type === 'normal' && typeof window.id === 'number') {
          setTimeout(() => {
            this.scheduleCheck(0, window.id);
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
        const existing = windowId ? this.tabsByWindow.get(windowId)?.get(tabId) : null;
        const wasOptions = existing ? isOwnOptionsTab(existing) : false;
        if (windowId && this.tabsByWindow.has(windowId)) {
          this.tabsByWindow.get(windowId).delete(tabId);
        }
        if (removeInfo && !removeInfo.isWindowClosing && wasOptions) {
          this.scheduleCheck(150, windowId);
        }
      }
    });

    // 5. 监听标签页移动（如果 options.html 被拖动离开 index 0，自动移回首位）
    chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
      if (!moveInfo || typeof moveInfo.windowId !== 'number') return;
      const snapshot = this.tabsByWindow.get(moveInfo.windowId)?.get(tabId);
      if (snapshot && isOwnOptionsTab(snapshot)) {
        snapshot.index = moveInfo.toIndex;
        this.scheduleCheck(100, moveInfo.windowId);
        return;
      }
      if (moveInfo.toIndex === 0) {
        // 其它标签挤占了首位：快照里收纳箱的 index 已失效，标记为未知以免检查被"已在首位"捷径跳过
        for (const tab of this.tabsByWindow.get(moveInfo.windowId)?.values() || []) {
          if (isOwnOptionsTab(tab)) tab.index = -1;
        }
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
      // SW 冷启动瞬间快照可能尚未同步完成，先等待快照就绪。
      await this.ready?.catch?.(() => {});
      const config = await StorageAdapter.getUserConfig();
      if (config.stashSettings?.pinnedTabGuard === false) return;

      // 窗口关闭事件到达时，Chrome 往往已开始销毁标签。优先使用事件持续维护的快照并先过滤，
      // 只有快照完全缺失时才额外查询实时标签，避免每次关闭都做注定失败或空结果的全量查询。
      const windowTabsMap = this.tabsByWindow.get(windowId);
      let tabsToSave = windowTabsMap
        ? Array.from(windowTabsMap.values()).filter((tab) => !isExcludedFromTabCounting(tab))
        : [];
      if (!windowTabsMap) {
        try {
          const liveTabs = await chrome.tabs.query({ windowId });
          tabsToSave = liveTabs.filter((tab) => !isExcludedFromTabCounting(tab));
        } catch {}
      }

      if (tabsToSave.length > 0) {
        console.info(`[PinnedTabGuard] 正在执行窗口关闭全量收纳 (${tabsToSave.length} 个标签页)...`);
        // 快照与实时标签都按 pendingUrl 优先的统一口径入库，导航中的标签不会以空地址或旧地址保存
        await LocalStashRepository.createGroup(tabsToSave.map((tab) => StashService.tabToStashItem(tab)));
      }

      this.tabsByWindow.delete(windowId);
    } catch (err) {
      console.error('[PinnedTabGuard] 窗口关闭全量收纳异常:', err);
    }
  }

  /**
   * 防抖检查与常驻固定标签守护执行。检查进行中时只记录 pending，结束后再跑一轮，避免漏掉并发出现的第二份 options。
   * @param {number} [delay=150]
   * @param {number} [windowId]
   */
  scheduleCheck(delay = 150, windowId = null) {
    if (typeof windowId === 'number' && windowId !== chrome.windows.WINDOW_ID_NONE) {
      this.pendingWindowIds.add(windowId);
    } else {
      this.pendingAllWindows = true;
    }

    clearTimeout(this.checkDebounceTimer);
    this.checkDebounceTimer = setTimeout(() => {
      this.runScheduledCheck();
    }, delay);
  }

  /**
   * 执行已排队的常驻收纳箱检查
   */
  async runScheduledCheck() {
    if (this.isGuarding) return;
    this.isGuarding = true;
    try {
      while (this.pendingAllWindows || this.pendingWindowIds.size > 0) {
        const checkAll = this.pendingAllWindows;
        const windowIds = [...this.pendingWindowIds];
        this.pendingAllWindows = false;
        this.pendingWindowIds.clear();

        const config = await StorageAdapter.getUserConfig();
        if (config.stashSettings?.pinnedTabGuard === false) continue;

        if (checkAll) {
          await StashService.ensureAllAllWindowsPinnedTab();
          continue;
        }

        for (const pendingWindowId of windowIds) {
          const windowTabs = this.tabsByWindow.get(pendingWindowId);
          if (windowTabs) {
            const optionsTabs = [...windowTabs.values()].filter((tab) => isOwnOptionsTab(tab));
            if (optionsTabs.length === 1 && optionsTabs[0].pinned && optionsTabs[0].index === 0) {
              continue;
            }
          }
          const win = await chrome.windows.get(pendingWindowId).catch(() => null);
          if (win && win.type === 'normal') {
            await StashService.ensurePinnedStashTab(false, pendingWindowId);
          }
        }
      }
    } catch {
      // 忽略守护检查异常
    } finally {
      this.isGuarding = false;
      if (this.pendingAllWindows || this.pendingWindowIds.size > 0) {
        this.scheduleCheck(50);
      }
    }
  }
}
