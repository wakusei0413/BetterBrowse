/**
 * @file stash-service.js
 * @description 智能标签页收纳与恢复主服务（智能规则过滤、保存标签组并自动激活首位固定标签）
 * @encoding UTF-8
 */

import { StorageAdapter } from '../storage/storage-adapter.js';
import { RuleEngine } from '../rules/rule-engine.js';
import { LocalStashRepository } from './local-stash-repo.js';

export class StashService {
  /**
   * @param {RuleEngine} [ruleEngine]
   */
  constructor(ruleEngine) {
    this.ruleEngine = ruleEngine || new RuleEngine();
  }

  /**
   * 评估当前所有标签页的保留与收纳状态
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} activityStats
   * @returns {Promise<{ tabsToKeep: any[], tabsToStash: any[], total: number }>}
   */
  async evaluateAllTabs(activityStats = {}) {
    const config = await StorageAdapter.getUserConfig();
    const allTabs = await chrome.tabs.query({ currentWindow: true });

    return await this.ruleEngine.evaluateTabs({
      allTabs,
      activityStats,
      config
    });
  }

  /**
   * 确保指定窗口（或当前窗口）第 1 位常驻固定小标签页（Pinned Tab，无字图标常驻模式）死死占位存在
   * @param {boolean} [activate=true]
   * @param {number} [targetWindowId]
   */
  static async ensurePinnedStashTab(activate = true, targetWindowId = null) {
    try {
      const stashUrl = chrome.runtime.getURL('src/options/options.html');
      const queryOptions = targetWindowId ? { windowId: targetWindowId } : { currentWindow: true };
      const tabs = await chrome.tabs.query(queryOptions);
      if (!tabs || tabs.length === 0) return null;

      const windowId = targetWindowId || tabs[0].windowId;
      let existingStashTab = tabs.find((t) => t.url && t.url.includes('src/options/options.html'));

      if (existingStashTab) {
        // 若已存在，确保其被死死固定在 index 0
        if (!existingStashTab.pinned || existingStashTab.index !== 0) {
          if (!existingStashTab.pinned) {
            await chrome.tabs.update(existingStashTab.id, { pinned: true });
          }
          if (existingStashTab.index !== 0) {
            await chrome.tabs.move(existingStashTab.id, { index: 0 });
          }
        }
        if (activate && !existingStashTab.active) {
          await chrome.tabs.update(existingStashTab.id, { active: true });
        }
        return existingStashTab;
      }

      // 若不存在，在第 1 个位置（index: 0）创建一个固定标签页（Chrome 自动折叠为仅图标）
      const newPinnedTab = await chrome.tabs.create({
        windowId: windowId,
        url: `${stashUrl}#stash`,
        pinned: true,
        index: 0,
        active: activate
      });

      return newPinnedTab;
    } catch (err) {
      console.warn('[StashService] 确保固定常驻标签页异常:', err);
      return null;
    }
  }

  /**
   * 确保当前所有普通浏览器窗口均死死常驻固定收纳小标签页
   */
  static async ensureAllAllWindowsPinnedTab() {
    try {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      for (const win of windows) {
        if (typeof win.id === 'number') {
          await this.ensurePinnedStashTab(false, win.id);
        }
      }
    } catch (err) {
      console.warn('[StashService] 全窗口常驻守护异常:', err);
    }
  }

  /**
   * 统一收纳调度入口
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} [activityStats={}]
   * @param {{ forceAll?: boolean, windowId?: number }} [options={}]
   * @returns {Promise<{ success: boolean, stashedCount: number, keptCount?: number, error?: string }>}
   */
  async executeStash(activityStats = {}, options = {}) {
    const { forceAll = false, windowId = null } = options;
    if (forceAll) {
      return await this.executeAllTabsStash(windowId);
    }
    return await this.executeSmartStash(activityStats, windowId);
  }

  /**
   * 全量无条件收纳指定窗口（或当前窗口）的所有标签页（手动点击收纳按钮或关闭窗口时执行）
   * @param {number} [targetWindowId=null]
   * @returns {Promise<{ success: boolean, stashedCount: number, error?: string }>}
   */
  async executeAllTabsStash(targetWindowId = null) {
    try {
      const queryOptions = targetWindowId ? { windowId: targetWindowId } : { currentWindow: true };
      const tabs = await chrome.tabs.query(queryOptions);

      if (!tabs || tabs.length === 0) {
        await StashService.ensurePinnedStashTab(true, targetWindowId);
        return { success: true, stashedCount: 0 };
      }

      const windowId = targetWindowId || tabs[0].windowId;

      // 过滤出需要收纳的网页（排除插件自身的 options 页面及无意义空白页）
      const tabsToStash = tabs.filter((tab) => {
        if (!tab.url) return false;
        if (tab.url.includes('src/options/options.html')) return false;
        if (tab.url === 'chrome://newtab/' || tab.url === 'edge://newtab/' || tab.url === 'about:blank') return false;
        return true;
      });

      if (tabsToStash.length === 0) {
        await StashService.ensurePinnedStashTab(true, windowId);
        return { success: true, stashedCount: 0 };
      }

      const itemsToSave = tabsToStash.map((tab) => ({
        url: tab.url,
        title: tab.title || tab.url,
        favIconUrl: tab.favIconUrl || '',
        pinned: tab.pinned
      }));

      // 1. 全量写入本地收纳仓储
      const createRes = await LocalStashRepository.createGroup(itemsToSave);
      if (!createRes || !createRes.success) {
        return { success: false, stashedCount: 0, error: createRes?.error || '写入本地收纳仓储失败' };
      }

      // 2. 唤起并置顶第 1 个位置的常驻固定小标签页（Pinned Tab）
      await StashService.ensurePinnedStashTab(true, windowId);

      // 3. 关闭所有被收纳的标签页
      const tabIdsToClose = tabsToStash
        .map((tab) => tab.id)
        .filter((id) => typeof id === 'number');

      if (tabIdsToClose.length > 0) {
        await chrome.tabs.remove(tabIdsToClose);
      }

      return {
        success: true,
        stashedCount: tabIdsToClose.length
      };
    } catch (err) {
      console.error('[StashService] 全量收纳执行异常:', err);
      return { success: false, stashedCount: 0, error: err.message };
    }
  }

  /**
   * 智能规则过滤收纳（仅在达到标签阈值时后台自动提醒/触发使用）
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} [activityStats={}]
   * @param {number} [targetWindowId=null]
   * @returns {Promise<{ success: boolean, stashedCount: number, keptCount: number, error?: string }>}
   */
  async executeSmartStash(activityStats = {}, targetWindowId = null) {
    const config = await StorageAdapter.getUserConfig();
    const queryOptions = targetWindowId ? { windowId: targetWindowId } : { currentWindow: true };
    const allTabs = await chrome.tabs.query(queryOptions);

    // 记录用户当前正在前台浏览的页面
    const currentActiveTab = allTabs.find((t) => t.active);

    const evaluation = await this.ruleEngine.evaluateTabs({
      allTabs,
      activityStats,
      config
    });

    const { tabsToKeep, tabsToStash } = evaluation;
    const windowId = targetWindowId || (allTabs.length > 0 ? allTabs[0].windowId : null);

    if (!tabsToStash || tabsToStash.length === 0) {
      await StashService.ensurePinnedStashTab(false, windowId);
      return {
        success: true,
        stashedCount: 0,
        keptCount: tabsToKeep.length
      };
    }

    const itemsToSave = tabsToStash.map(({ tab }) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      pinned: tab.pinned
    }));

    // 1. 写入本地收纳仓储
    await LocalStashRepository.createGroup(itemsToSave);

    // 2. 确保首位常驻固定小标签存在（静默后台处理，activate: false 绝不抢占用户焦点）
    await StashService.ensurePinnedStashTab(false, windowId);

    // 3. 安全关闭所有被收纳的闲置标签页
    const tabIdsToClose = tabsToStash
      .map(({ tab }) => tab.id)
      .filter((id) => typeof id === 'number');

    if (tabIdsToClose.length > 0) {
      await chrome.tabs.remove(tabIdsToClose);
    }

    // 4. 确保用户当前浏览的前台页面稳固保持激活，实现 100% 无感浏览体验
    if (currentActiveTab && typeof currentActiveTab.id === 'number' && !tabIdsToClose.includes(currentActiveTab.id)) {
      try {
        await chrome.tabs.update(currentActiveTab.id, { active: true });
      } catch {}
    }

    return {
      success: true,
      stashedCount: tabIdsToClose.length,
      keptCount: tabsToKeep.length
    };
  }

  /**
   * 恢复指定收纳组的所有标签页
   * @param {string} groupId - 组 ID
   * @param {boolean} [removeAfterRestore=true] - 恢复后是否删除该组（若被锁定则自动跳过删除）
   * @returns {Promise<boolean>}
   */
  static async restoreGroup(groupId, removeAfterRestore = true) {
    const groups = await LocalStashRepository.getAllGroups();
    const targetGroup = groups.find((g) => g.id === groupId);
    if (!targetGroup || !targetGroup.tabs) return false;

    let restoredCount = 0;

    // 批量在当前窗口打开标签页（使用休眠挂起 discarded: true，避免海量标签并发下载网页拖垮内存）
    for (const item of targetGroup.tabs) {
      if (item.url) {
        try {
          // Chrome MV3 支持在创建非活跃标签时标记 discarded: true，挂起不加载，直到用户点击
          await chrome.tabs.create({
            url: item.url,
            pinned: Boolean(item.pinned),
            active: false,
            discarded: true
          });
          restoredCount++;
        } catch {
          // 若部分环境不支持 discarded 属性创建，则降级为常规后台标签
          try {
            await chrome.tabs.create({
              url: item.url,
              pinned: Boolean(item.pinned),
              active: false
            });
            restoredCount++;
          } catch (e) {
            console.warn('[StashService] 恢复标签页异常:', e);
          }
        }
      }
    }

    if (restoredCount === 0 && targetGroup.tabs.length > 0) {
      return false;
    }

    // 若非锁定组，恢复后默认删除该组
    if (removeAfterRestore && !targetGroup.locked) {
      await LocalStashRepository.deleteGroup(groupId);
    }

    return true;
  }

  /**
   * 恢复单个收纳标签项
   * @param {string} groupId - 组 ID
   * @param {string} itemId - 标签项 ID
   * @param {boolean} [removeAfterRestore=true]
   * @returns {Promise<boolean>}
   */
  static async restoreItem(groupId, itemId, removeAfterRestore = true) {
    const groups = await LocalStashRepository.getAllGroups();
    const targetGroup = groups.find((g) => g.id === groupId);
    if (!targetGroup) return false;

    const targetItem = targetGroup.tabs.find((t) => t.id === itemId);
    if (!targetItem || !targetItem.url) return false;

    await chrome.tabs.create({
      url: targetItem.url,
      pinned: Boolean(targetItem.pinned),
      active: true
    });

    if (removeAfterRestore && !targetGroup.locked) {
      await LocalStashRepository.deleteTabItem(groupId, itemId);
    }

    return true;
  }
}
