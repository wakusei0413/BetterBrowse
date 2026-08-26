/**
 * @file context-menu-manager.js
 * @description 右键上下文菜单管理器（提供右键快速收纳当前窗口、收纳左侧/右侧标签页与打开收纳箱）
 * @encoding UTF-8
 */

import { StashService } from '../core/stash/stash-service.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';
import { isOwnOptionsUrl } from '../core/extension-url.js';

export class ContextMenuManager {
  /**
   * 初始化右键菜单
   */
  static init() {
    if (!chrome.contextMenus) return;

    if (chrome.runtime?.onInstalled) {
      chrome.runtime.onInstalled.addListener(() => {
        this.createMenus();
      });
    }

    if (chrome.contextMenus?.onClicked) {
      chrome.contextMenus.onClicked.addListener(async (info, tab) => {
        await this.handleMenuClick(info, tab);
      });
    }
  }

  /**
   * 创建上下文菜单项
   */
  static createMenus() {
    if (!chrome.contextMenus?.removeAll) return;

    chrome.contextMenus.removeAll(() => {
      // 1. 打开收纳箱
      chrome.contextMenus.create({
        id: 'better_browse_open_stash',
        title: '打开 BetterBrowse 收纳箱',
        contexts: ['action', 'page']
      });

      // 分隔线
      chrome.contextMenus.create({
        id: 'better_browse_separator_1',
        type: 'separator',
        contexts: ['action', 'page']
      });

      // 2. 收纳当前窗口所有标签页
      chrome.contextMenus.create({
        id: 'better_browse_stash_all',
        title: '收纳当前窗口的所有标签页',
        contexts: ['action', 'page']
      });

      // 3. 收纳右侧所有标签页
      chrome.contextMenus.create({
        id: 'better_browse_stash_right',
        title: '收纳当前标签页右侧的所有标签页',
        contexts: ['page']
      });

      // 4. 收纳左侧所有标签页
      chrome.contextMenus.create({
        id: 'better_browse_stash_left',
        title: '收纳当前标签页左侧的所有标签页',
        contexts: ['page']
      });
    });
  }

  /**
   * 处理右键菜单点击事件
   * @param {chrome.contextMenus.OnClickData} info
   * @param {chrome.tabs.Tab} [currentTab]
   */
  static async handleMenuClick(info, currentTab) {
    try {
      const stashService = new StashService();

      switch (info.menuItemId) {
        case 'better_browse_open_stash': {
          await StashService.ensurePinnedStashTab(true, currentTab?.windowId);
          break;
        }

        case 'better_browse_stash_all': {
          await stashService.executeAllTabsStash(currentTab?.windowId);
          break;
        }

        case 'better_browse_stash_right': {
          if (!currentTab || typeof currentTab.index !== 'number') break;
          await this.stashTabsDirectional(currentTab.windowId, currentTab.index, 'right');
          break;
        }

        case 'better_browse_stash_left': {
          if (!currentTab || typeof currentTab.index !== 'number') break;
          await this.stashTabsDirectional(currentTab.windowId, currentTab.index, 'left');
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.warn('[ContextMenuManager] 右键菜单处理异常:', err);
    }
  }

  /**
   * 定向收纳指定方向（左侧或右侧）的标签页
   * @param {number} windowId
   * @param {number} currentIndex
   * @param {'left'|'right'} direction
   */
  static async stashTabsDirectional(windowId, currentIndex, direction) {
    const tabs = await chrome.tabs.query({ windowId });
    if (!tabs || tabs.length === 0) return;

    const targetTabs = tabs.filter((tab) => {
      if (!tab.url) return false;
      if (isOwnOptionsUrl(tab.url)) return false;
      if (tab.url === 'chrome://newtab/' || tab.url === 'edge://newtab/' || tab.url === 'about:blank') return false;

      if (direction === 'right') {
        return tab.index > currentIndex;
      } else {
        return tab.index < currentIndex;
      }
    });

    if (targetTabs.length === 0) return;

    const itemsToSave = targetTabs.map((tab) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      pinned: tab.pinned
    }));

    const createRes = await LocalStashRepository.createGroup(itemsToSave);
    if (!createRes?.success) return;
    await StashService.ensurePinnedStashTab(false, windowId);

    const tabIdsToClose = targetTabs
      .map((tab) => tab.id)
      .filter((id) => typeof id === 'number');

    if (tabIdsToClose.length > 0) {
      await chrome.tabs.remove(tabIdsToClose);
    }
  }
}
