/**
 * @file stash-service.js
 * @description 智能标签页收纳与恢复主服务（智能规则过滤、保存标签组并自动激活首位固定标签）
 * @encoding UTF-8
 */

import { StorageAdapter } from '../storage/storage-adapter.js';
import { RuleEngine } from '../rules/rule-engine.js';
import { LocalStashRepository } from './local-stash-repo.js';
import { filterCountableTabs, isExcludedFromTabCounting, isOwnOptionsTab } from '../extension-url.js';

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
   * 安全批量关闭标签页（容忍收纳评估期间标签页已被用户手动关闭的竞态）
   * 批量 chrome.tabs.remove 中只要有一个 ID 已不存在就会整体抛出
   * "No tab with id" 并使整个收纳流程失败，此处降级为逐个关闭并跳过已消失的标签。
   * @param {number[]} tabIds - 待关闭的标签页 ID 列表
   * @returns {Promise<number>} 实际成功关闭的标签页数量
   */
  static async closeTabsSafely(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return 0;
    try {
      await chrome.tabs.remove(tabIds);
      return tabIds.length;
    } catch {
      let closedCount = 0;
      for (const tabId of tabIds) {
        try {
          await chrome.tabs.remove([tabId]);
          closedCount += 1;
        } catch {
          // 标签页已关闭或不存在的竞态，直接跳过
        }
      }
      return closedCount;
    }
  }

  /**
   * 按窗口串行化常驻收纳箱的创建与去重，避免并发查询都看见“没有”而各建一份。
   * @type {Map<number, Promise<unknown>>}
   */
  static _pinnedStashLocks = new Map();

  /**
   * @template T
   * @param {number} windowId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  static async _withPinnedStashLock(windowId, task) {
    const previous = this._pinnedStashLocks.get(windowId) || Promise.resolve();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    this._pinnedStashLocks.set(windowId, current);
    try {
      await previous.catch(() => {});
      return await task();
    } finally {
      release();
      if (this._pinnedStashLocks.get(windowId) === current) {
        this._pinnedStashLocks.delete(windowId);
      }
    }
  }

  /**
   * 在同一窗口的多个 options 标签中选出唯一保留项。
   * 优先级：已钉在 index 0 > 已钉住 > index 更小 > id 更小。不改 hash。
   * @param {chrome.tabs.Tab[]} optionsTabs
   * @returns {chrome.tabs.Tab|null}
   */
  static _pickPinnedStashKeeper(optionsTabs) {
    if (!Array.isArray(optionsTabs) || optionsTabs.length === 0) return null;
    return optionsTabs.slice().sort((left, right) => {
      const rank = (tab) => {
        if (tab.pinned && tab.index === 0) return 0;
        if (tab.pinned) return 1;
        return 2;
      };
      const rankDelta = rank(left) - rank(right);
      if (rankDelta !== 0) return rankDelta;
      const leftIndex = Number.isInteger(left.index) ? left.index : Number.MAX_SAFE_INTEGER;
      const rightIndex = Number.isInteger(right.index) ? right.index : Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return (Number(left.id) || 0) - (Number(right.id) || 0);
    })[0];
  }

  /**
   * 确保指定窗口（或当前窗口）恰好有一个常驻固定收纳箱（Pinned Tab，无字图标常驻模式）。
   * 多余的 options.html 会被关闭；newtab.html 绝不纳入去重。
   * @param {boolean} [activate=true]
   * @param {number} [targetWindowId]
   */
  static async ensurePinnedStashTab(activate = true, targetWindowId = null) {
    try {
      let windowId = typeof targetWindowId === 'number' ? targetWindowId : null;
      if (windowId === null) {
        const currentTabs = await chrome.tabs.query({ currentWindow: true });
        if (!currentTabs || currentTabs.length === 0) return null;
        windowId = currentTabs[0].windowId;
        if (typeof windowId !== 'number') return null;
      }
      return await this._withPinnedStashLock(windowId, () => this._ensurePinnedStashTabInWindow(activate, windowId));
    } catch (err) {
      console.warn('[StashService] 确保固定常驻标签页异常:', err);
      return null;
    }
  }

  /**
   * 在已持有窗口锁的情况下，创建或合并该窗口的唯一常驻收纳箱。
   * @param {boolean} activate
   * @param {number} windowId
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  static async _ensurePinnedStashTabInWindow(activate, windowId) {
    const stashUrl = chrome.runtime.getURL('src/options/options.html');
    let tabs = await chrome.tabs.query({ windowId });
    if (!tabs || tabs.length === 0) return null;

    let optionsTabs = tabs.filter((tab) => isOwnOptionsTab(tab));
    if (optionsTabs.length === 0) {
      await chrome.tabs.create({
        windowId,
        url: `${stashUrl}#stash`,
        pinned: true,
        index: 0,
        active: activate
      });
      tabs = await chrome.tabs.query({ windowId });
      if (!tabs || tabs.length === 0) return null;
      optionsTabs = tabs.filter((tab) => isOwnOptionsTab(tab));
    }
    if (optionsTabs.length === 0) return null;

    const keeper = this._pickPinnedStashKeeper(optionsTabs);
    if (!keeper || typeof keeper.id !== 'number') return null;
    const extras = optionsTabs.filter((tab) => tab.id !== keeper.id);
    const closedActiveExtra = extras.some((tab) => tab.active);

    if (!keeper.pinned) {
      await chrome.tabs.update(keeper.id, { pinned: true });
    }
    if (keeper.index !== 0) {
      await chrome.tabs.move(keeper.id, { index: 0 });
    }
    if (extras.length > 0) {
      await this.closeTabsSafely(extras.map((tab) => tab.id).filter((tabId) => typeof tabId === 'number'));
    }
    if ((activate || closedActiveExtra) && !keeper.active) {
      await chrome.tabs.update(keeper.id, { active: true });
    }

    const refreshed = await chrome.tabs.query({ windowId });
    return refreshed.find((tab) => tab.id === keeper.id) || keeper;
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
        const settings = (await StorageAdapter.getUserConfig()).stashSettings || {};
        await StashService.ensurePinnedStashTab(settings.pinnedTabGuard !== false && settings.autoOpenStashTab !== false, targetWindowId);
        return { success: true, stashedCount: 0 };
      }

      const windowId = targetWindowId || tabs[0].windowId;

      // 过滤出需要收纳的网页（排除插件自身的 options 页面及无意义空白页）
      const tabsToStash = tabs.filter((tab) => {
        if (!tab.url) return false;
        if (isExcludedFromTabCounting(tab)) return false;
        return true;
      });

      if (tabsToStash.length === 0) {
        const settings = (await StorageAdapter.getUserConfig()).stashSettings || {};
        await StashService.ensurePinnedStashTab(settings.pinnedTabGuard !== false && settings.autoOpenStashTab !== false, windowId);
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

      // 2. 仅关闭 URL 确实已持久化的标签页：
      //    allowDuplicates=false 时重复项会被仓储跳过（group 可能为 null），绝不关闭未保存的标签
      const savedUrls = new Set((createRes.group?.tabs || []).map((tab) => tab.url));
      const closableTabs = tabsToStash.filter((tab) => savedUrls.has(tab.url));

      if (closableTabs.length === 0) {
        return { success: true, stashedCount: 0 };
      }

      // 3. 唤起并置顶第 1 个位置的常驻固定小标签页（Pinned Tab）
      const settings = (await StorageAdapter.getUserConfig()).stashSettings || {};
      await StashService.ensurePinnedStashTab(settings.pinnedTabGuard !== false && settings.autoOpenStashTab !== false, windowId);

      // 4. 关闭所有被收纳的标签页（容忍收纳期间被用户手动关闭的竞态）
      const tabIdsToClose = closableTabs
        .map((tab) => tab.id)
        .filter((id) => typeof id === 'number');

      const closedCount = await StashService.closeTabsSafely(tabIdsToClose);

      return {
        success: true,
        stashedCount: closedCount,
        groupId: createRes.group?.id || null
      };
    } catch (err) {
      console.error('[StashService] 全量收纳执行异常:', err);
      return { success: false, stashedCount: 0, error: err.message };
    }
  }

  /**
   * 智能规则过滤收纳（仅在达到标签阈值时后台自动提醒/触发使用）
   *
   * 采用"阶梯式降级收纳"策略，确保收纳后必定降到阈值以下：
   * 1. 以标准规则（P0~P3）执行第一轮评估；
   * 2. 若收纳后可计数标签页数量仍不低于阈值，则逐级放宽软性保护
   *    （"最近访问"窗口逐级缩短、"高频访问"门槛逐级提高），直至降到阈值以下；
   * 3. 所有软性保护放宽到极限仍不达标时，若启用终极兜底，则按重要度从低到高
   *    强制回收最不重要的标签页（始终保护正在播放媒体、正在输入表单、
   *    前台激活、固定标签页及系统页面）；
   * 4. 若硬性保护标签数量本身超出目标剩余数量，则放弃本次自动收纳并明确提示。
   *
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} [activityStats={}]
   * @param {number} [targetWindowId=null]
   * @returns {Promise<{ success: boolean, stashedCount: number, keptCount: number, tierLevel: number|string, reachedTarget: boolean, note?: string, error?: string }>}
   */
  async executeSmartStash(activityStats = {}, targetWindowId = null) {
    const config = await StorageAdapter.getUserConfig();
    const tierSettings = config.tieredStash && typeof config.tieredStash === 'object' ? config.tieredStash : {};
    const queryOptions = targetWindowId ? { windowId: targetWindowId } : { currentWindow: true };
    const allTabs = await chrome.tabs.query(queryOptions);

    // 记录用户当前正在前台浏览的页面
    const currentActiveTab = allTabs.find((t) => t.active);
    const windowId = targetWindowId || (allTabs.length > 0 ? allTabs[0].windowId : null);

    // 与阈值监控保持同一计数口径（排除系统页/新标签页/插件自身页面）
    const countableTabs = filterCountableTabs(allTabs);
    const currentCount = countableTabs.length;
    const threshold = Number.isFinite(config.tabThreshold) ? Math.max(1, Math.floor(config.tabThreshold)) : 15;

    // 当前可计数标签页数量未达到阈值，无需任何回收
    if (currentCount < threshold) {
      return {
        success: true,
        stashedCount: 0,
        keptCount: allTabs.length,
        tierLevel: 0,
        reachedTarget: true,
        note: '标签页数量未超出阈值，无需智能收纳'
      };
    }

    const tierEnabled = tierSettings.enabled !== false;
    const maxTiers = tierEnabled ? Math.max(0, Number.isFinite(tierSettings.maxTiers) ? Math.floor(tierSettings.maxTiers) : 5) : 0;
    const safetyMargin = Math.max(0, Number.isFinite(tierSettings.targetSafetyMargin) ? Math.floor(tierSettings.targetSafetyMargin) : 0);
    // 达标标准：收纳后可计数数量 < 阈值（再额外减去安全余量），确保不再触发提醒
    const targetRemaining = Math.max(0, threshold - 1 - safetyMargin);

    // 跨阶梯复用表单检测结果，避免多轮评估时重复向页面发消息
    const formResultsCache = new Map();

    let evaluation = null;
    let finalTierLevel = 0;
    let reachedTarget = false;
    // 硬性保护标签数超出目标剩余数时的说明信息（此时仍会收纳其余可安全回收的标签）
    let hardLimitInfo = null;

    // === 阶梯循环：逐级放宽软性保护，直至收纳后降到阈值以下 ===
    for (let level = 0; level <= maxTiers; level++) {
      const tierContext = RuleEngine.buildTierContext(config, level, tierSettings);
      evaluation = await this.ruleEngine.evaluateTabs({
        allTabs,
        activityStats,
        config,
        tierContext,
        formResultsCache
      });

      const stashCountable = evaluation.tabsToStash.filter(({ tab }) => !isExcludedFromTabCounting(tab)).length;
      const remainingAfter = currentCount - stashCountable;
      finalTierLevel = level;
      if (remainingAfter <= targetRemaining) {
        reachedTarget = true;
        break;
      }
    }

    // === 终极兜底：软性保护已全部放开仍不达标时，按重要度强制回收 ===
    if (!reachedTarget && tierSettings.ultimateFallback !== false) {
      const hardCoreContext = { hardCoreOnly: true, level: -1, softRulesEscalated: true };
      const hardEvaluation = await this.ruleEngine.evaluateTabs({
        allTabs,
        activityStats,
        config,
        tierContext: hardCoreContext,
        formResultsCache
      });

      const hardCount = hardEvaluation.tabsToKeep.filter(({ tab }) => !isExcludedFromTabCounting(tab)).length;

      if (hardCount > targetRemaining) {
        // 硬性保护标签数量本身就超出目标剩余数：无法靠本次收纳降到阈值以下。
        // 但**仍要把其余所有可安全回收的标签全部收掉**——此前的"整体放弃"会让自动收纳
        // 在表单探测普遍失败等场景下一个标签都收不掉，用户看到的就是"自动收纳完全不工作"。
        // 红线不变：受硬性保护的标签页一个都不会被关闭。
        evaluation = {
          tabsToKeep: hardEvaluation.tabsToKeep,
          tabsToStash: hardEvaluation.tabsToStash,
          total: allTabs.length
        };
        finalTierLevel = 'hardLimit';
        reachedTarget = false;
        hardLimitInfo = {
          hardProtectedCount: hardCount,
          remainingOverThreshold: Math.max(0, hardCount - targetRemaining)
        };
      } else {
        // 从未被硬性保护的标签页中，按重要度从低到高依次强制回收，直到达标
        const candidates = hardEvaluation.tabsToStash
          .map(({ tab }) => ({ tab, score: this.computeImportanceScore(tab, activityStats) }))
          .sort((a, b) => a.score - b.score);

        const needCount = currentCount - targetRemaining; // 需要回收的可计数标签页数量
        let collectedCount = 0;
        const forcedStash = [];
        for (const item of candidates) {
          if (collectedCount >= needCount) break;
          if (isExcludedFromTabCounting(item.tab)) continue; // 跳过不计数的无意义页面
          collectedCount++;
          forcedStash.push(item.tab);
        }

        evaluation = {
          tabsToKeep: hardEvaluation.tabsToKeep,
          tabsToStash: forcedStash.map((tab) => ({ tab })),
          total: allTabs.length
        };
        finalTierLevel = 'ultimateFallback';
        reachedTarget = true;
      }
    }

    const { tabsToKeep, tabsToStash } = evaluation;

    if (!tabsToStash || tabsToStash.length === 0) {
      await StashService.ensurePinnedStashTab(false, windowId);
      if (hardLimitInfo) {
        // 受硬性保护的标签已超出目标剩余数，且没有其它可回收标签：明确说明原因与下一步动作
        return {
          success: false,
          stashedCount: 0,
          keptCount: tabsToKeep.length,
          tierLevel: finalTierLevel,
          reachedTarget: false,
          noStashableTabs: true,
          ...hardLimitInfo,
          error: `当前受硬性保护的标签页数量（${hardLimitInfo.hardProtectedCount}）已超出目标剩余数量（${targetRemaining}），无法自动降至阈值以下，请手动整理`,
          note: '硬性保护包括：正在播放媒体、正在输入表单、前台激活、固定标签页及系统页面'
        };
      }
      return {
        success: true,
        stashedCount: 0,
        keptCount: tabsToKeep.length,
        tierLevel: finalTierLevel,
        reachedTarget
      };
    }

    const itemsToSave = tabsToStash.map(({ tab }) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      pinned: tab.pinned
    }));

    // 1. 写入本地收纳仓储，持久化失败时绝不关闭原标签页
    const createRes = await LocalStashRepository.createGroup(itemsToSave);
    if (!createRes?.success) {
      return {
        success: false,
        stashedCount: 0,
        keptCount: tabsToKeep.length,
        tierLevel: finalTierLevel,
        reachedTarget,
        error: createRes?.error || '写入本地收纳仓储失败'
      };
    }

    // 2. 仅关闭 URL 确实已持久化的标签页：
    //    allowDuplicates=false 时重复项会被仓储跳过（group 可能为 null），
    //    此时若照常关闭，被跳过的 URL 将既不在任何可见收纳组中、标签也被关闭，造成数据静默丢失
    const savedUrls = new Set((createRes.group?.tabs || []).map((tab) => tab.url));
    const closableStash = tabsToStash.filter(({ tab }) => savedUrls.has(tab.url));

    if (closableStash.length === 0) {
      return {
        success: true,
        stashedCount: 0,
        keptCount: tabsToKeep.length,
        tierLevel: finalTierLevel,
        reachedTarget,
        note: '所选标签页均已存在于收纳箱中（跳过重复项），未关闭任何标签页'
      };
    }

    // 3. 确保首位常驻固定小标签存在（静默后台处理，activate: false 绝不抢占用户焦点）
    const settings = config.stashSettings || {};
    await StashService.ensurePinnedStashTab(settings.pinnedTabGuard !== false && settings.autoOpenStashTab !== false, windowId);

    // 4. 安全关闭所有被收纳的闲置标签页（容忍收纳期间被用户手动关闭的竞态）
    const tabIdsToClose = closableStash
      .map(({ tab }) => tab.id)
      .filter((id) => typeof id === 'number');

    const closedCount = await StashService.closeTabsSafely(tabIdsToClose);

    // 5. 确保用户当前浏览的前台页面稳固保持激活，实现 100% 无感浏览体验
    if (currentActiveTab && typeof currentActiveTab.id === 'number' && !tabIdsToClose.includes(currentActiveTab.id)) {
      try {
        await chrome.tabs.update(currentActiveTab.id, { active: true });
      } catch {}
    }

    return {
      success: true,
      stashedCount: closedCount,
      keptCount: tabsToKeep.length,
      tierLevel: finalTierLevel,
      reachedTarget,
      // 受硬性保护的标签仍超出目标数：如实报告部分达标，便于提醒用户手动整理剩余标签
      ...(hardLimitInfo
        ? {
            ...hardLimitInfo,
            note: `已收纳 ${closedCount} 个闲置标签，但仍有 ${hardLimitInfo.remainingOverThreshold} 个受保护标签超出目标剩余数量，建议手动整理`
          }
        : {}),
      groupId: createRes.group?.id || null
    };
  }

  /**
   * 计算标签页重要度评分（分数越低越不重要，越先被强制回收）
   *
   * 评分维度：
   * - 最近 1 小时内的激活次数（每次 +10 分）
   * - 最近访问时间（60 分钟内线性衰减，越近越重要，最高 +60 分）
   * - 从未产生激活记录的标签页视为最低优先级（-100 分，最先回收）
   *
   * @param {chrome.tabs.Tab} tab
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} [activityStats={}]
   * @returns {number}
   */
  computeImportanceScore(tab, activityStats = {}) {
    const stat = activityStats?.[tab.id];
    const activationCount = stat?.activationTimestamps?.length || 0;
    const lastActivated = stat?.lastActivated || 0;
    const now = Date.now();

    let score = 0;
    // 激活次数越多越重要（每次 +10 分）
    score += activationCount * 10;
    // 最近访问越近越重要（最近 60 分钟内线性衰减，超出 60 分钟记为 0）
    if (lastActivated > 0) {
      score += Math.max(0, 60 - (now - lastActivated) / 60000);
    }
    // 从未产生过激活记录的标签页优先级最低，最先被回收
    if (activationCount === 0 && lastActivated <= 0) {
      score -= 100;
    }
    return score;
  }

  /**
   * 恢复指定收纳组的所有标签页
   * @param {string} groupId - 组 ID
   * @param {boolean} [removeAfterRestore=true] - 恢复后是否删除该组（若被锁定则自动跳过删除）
   * @returns {Promise<boolean>}
   */
  static async restoreGroup(groupId, removeAfterRestore = undefined) {
    const config = await StorageAdapter.getUserConfig();
    const settings = config.stashSettings || {};
    const groups = await LocalStashRepository.getAllGroups();
    const targetGroup = groups.find((g) => g.id === groupId);
    if (!targetGroup || !targetGroup.tabs) return false;

    const shouldRemove = removeAfterRestore === undefined ? settings.restoreBehavior === 'remove' : removeAfterRestore;
    let restoredCount = 0;
    const restoredTabIds = [];
    let targetWindowId = null;
    if (settings.restorePosition === 'newWindow' && chrome.windows?.create) {
      try { targetWindowId = (await chrome.windows.create({ focused: true, type: 'normal' }))?.id || null; } catch {}
    }

    // 批量在当前窗口打开标签页（使用休眠挂起 discarded: true，避免海量标签并发下载网页拖垮内存）
    for (const item of targetGroup.tabs) {
      if (item.url) {
        try {
          // Chrome MV3 支持在创建非活跃标签时标记 discarded: true，挂起不加载，直到用户点击
          const tab = await chrome.tabs.create({
            url: item.url,
            ...(targetWindowId ? { windowId: targetWindowId } : {}),
            pinned: Boolean(item.pinned),
            active: false,
            discarded: true
          });
          if (typeof tab?.id === 'number' && !item.pinned) {
            restoredTabIds.push(tab.id);
          }
          restoredCount++;
        } catch {
          // 若部分环境不支持 discarded 属性创建，则降级为常规后台标签
          try {
            const tab = await chrome.tabs.create({
              url: item.url,
              ...(targetWindowId ? { windowId: targetWindowId } : {}),
              pinned: Boolean(item.pinned),
              active: false
            });
            if (typeof tab?.id === 'number' && !item.pinned) {
              restoredTabIds.push(tab.id);
            }
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

    // 深度联动 Chrome 原生 Tab Groups：还原为自动展开的彩色标签分组
    if (restoredTabIds.length > 0 && chrome.tabs?.group) {
      try {
        const groupCreationOpts = { tabIds: restoredTabIds };
        if (targetWindowId) {
          groupCreationOpts.createProperties = { windowId: targetWindowId };
        }
        const newGroupId = await chrome.tabs.group(groupCreationOpts);
        if (chrome.tabGroups?.update && typeof newGroupId === 'number') {
          const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
          const randomColor = colors[Math.floor(Math.random() * colors.length)];
          const updateOpts = {
            collapsed: false,
            color: targetGroup.color || randomColor
          };
          if (targetGroup.title) updateOpts.title = targetGroup.title;
          await chrome.tabGroups.update(newGroupId, updateOpts);
        }
      } catch (groupErr) {
        console.warn('[StashService] 还原为原生标签分组异常:', groupErr);
      }
    }

    // 若非锁定组，恢复后默认删除该组
    if (shouldRemove && !targetGroup.locked) {
      await LocalStashRepository.deleteGroup(groupId);
    } else if (settings.restoreBehavior === 'archive' && !targetGroup.locked) {
      await LocalStashRepository.markGroupArchived?.(groupId);
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
  static async restoreItem(groupId, itemId, removeAfterRestore = undefined) {
    const config = await StorageAdapter.getUserConfig();
    const settings = config.stashSettings || {};
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

    const shouldRemove = removeAfterRestore === undefined ? settings.restoreBehavior === 'remove' : removeAfterRestore;
    if (shouldRemove && !targetGroup.locked) {
      await LocalStashRepository.deleteTabItem(groupId, itemId);
    } else if (settings.restoreBehavior === 'archive' && !targetGroup.locked) {
      await LocalStashRepository.markGroupArchived?.(groupId);
    }

    return true;
  }
}
