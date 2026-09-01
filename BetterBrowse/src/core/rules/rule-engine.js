/**
 * @file rule-engine.js
 * @description 智能收纳规则编排引擎（固定 P0-P3 内置规则按优先级顺序评估）
 * @encoding UTF-8
 */

import { AudibleRule } from './audible-rule.js';
import { FormGuardRule } from './form-guard-rule.js';
import { RecentActiveRule } from './recent-active-rule.js';
import { FrequencyRule } from './frequency-rule.js';
import { PinnedRule } from './pinned-rule.js';
import { isOwnOptionsUrl } from '../extension-url.js';

export class RuleEngine {
  /**
   * 初始化规则引擎，按优先级装载内置规则
   */
  constructor() {
    /** @type {import('./base-rule.js').BaseRule[]} */
    this.rules = [
      new AudibleRule(),
      new FormGuardRule(),
      new RecentActiveRule(),
      new FrequencyRule(),
      new PinnedRule()
    ];
  }

  /**
   * 构建阶梯式降级上下文（Tiered Escalation Context）
   *
   * 将"软性保护"（最近访问窗口、高频访问门槛）按层级逐级放宽：
   * - level 0：标准规则参数（不降级）
   * - level N：最近访问窗口逐级缩短 `tierStepSeconds` 秒/级；高频访问百分比逐级下调 5 个百分点；
   *            最低激活次数逐级上调 1 次
   * 硬性保护（正在播放媒体、正在输入表单、前台激活、固定标签、系统页面）不受阶梯影响。
   *
   * @param {typeof import('../../constants/config.js').DefaultConfig} config - 用户全局配置
   * @param {number} tierLevel - 当前降级层级（0 为标准模式）
   * @param {object} [tierSettings={}] - 阶梯机制参数（来自 config.tieredStash）
   * @returns {{ level: number, recentActiveMinutes: number, frequencyPercentile: number, minActivationCount: number, softRulesEscalated: boolean }}
   */
  static buildTierContext(config, tierLevel, tierSettings = {}) {
    const settings = tierSettings && typeof tierSettings === 'object' ? tierSettings : {};
    const maxTiers = Number.isFinite(settings.maxTiers) ? Math.max(0, Math.floor(settings.maxTiers)) : 5;
    const stepSeconds = Number.isFinite(settings.tierStepSeconds) ? Math.max(1, Math.floor(settings.tierStepSeconds)) : 60;
    const baseMinutes = Number.isFinite(config.recentActiveMinutes) && config.recentActiveMinutes > 0 ? config.recentActiveMinutes : 5;
    const basePercentile = Number.isFinite(config.frequencyPercentile) && config.frequencyPercentile > 0
      ? Math.min(config.frequencyPercentile, 1)
      : 0.2;

    const level = Math.min(Math.max(0, Math.floor(tierLevel || 0)), maxTiers);

    if (level === 0) {
      return {
        level: 0,
        recentActiveMinutes: baseMinutes,
        frequencyPercentile: basePercentile,
        minActivationCount: 2,
        softRulesEscalated: false
      };
    }

    // 逐级缩短"最近访问"保护窗口（如 5 分钟 → 4 分 59 秒 → 4 分 58 秒 …，直至 0）
    const baseWindowMs = baseMinutes * 60 * 1000;
    const reducedWindowMs = Math.max(0, baseWindowMs - level * stepSeconds * 1000);
    const reducedMinutes = reducedWindowMs / 60000;
    // 逐级下调"高频访问"保留比例（20% → 15% → 10% → 5% → 0%）
    const reducedPercentile = Math.max(0, basePercentile - level * 0.05);
    // 逐级上调"高频访问"最低激活次数（2 → 3 → 4 → …）
    const minActivationCount = 2 + level;

    return {
      level,
      recentActiveMinutes: reducedMinutes,
      frequencyPercentile: reducedPercentile,
      minActivationCount,
      softRulesEscalated: true
    };
  }

  /**
   * 评估全量标签页的收纳保留状态
   * @param {Object} params
   * @param {chrome.tabs.Tab[]} params.allTabs - 浏览器当前待评估的标签页数组
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} params.activityStats - 活跃度统计数据
   * @param {typeof import('../../constants/config.js').DefaultConfig} params.config - 用户全局配置
   * @param {object|null} [params.tierContext=null] - 阶梯式降级上下文（由 buildTierContext 构建；终极兜底阶段可传 { hardCoreOnly: true } 仅保留硬性保护）
   * @param {Map<number, boolean>|null} [params.formResultsCache=null] - 跨轮次复用的表单检测结果缓存（避免阶梯多轮评估时重复向页面发消息）
   * @returns {Promise<{ tabsToKeep: Array<{ tab: chrome.tabs.Tab, reason: string, matchedRuleId: string }>, tabsToStash: Array<{ tab: chrome.tabs.Tab }>, total: number }>}
   */
  async evaluateTabs({ allTabs, activityStats, config, tierContext = null, formResultsCache = null }) {
    const tabsToKeep = [];
    const tabsToStash = [];

    const frequencyContext = this.rules.find((rule) => rule.id === 'highFrequency')?.createContext?.({ allTabs, activityStats, config, tierContext });
    const formResults = formResultsCache || new Map();
    const formRule = this.rules.find((rule) => rule.id === 'formGuard');
    if (!formResultsCache && formRule?.preload) await formRule.preload({ allTabs, config, results: formResults });

    for (const tab of allTabs) {
      // 插件自身 options 收纳页及系统特殊页面绝对保护保留（绝不收纳自身）
      if (tab.url && (isOwnOptionsUrl(tab.url) || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://'))) {
        tabsToKeep.push({
          tab,
          reason: '插件自身常驻小标签与系统页面保护',
          matchedRuleId: 'system_self'
        });
        continue;
      }

      let isRetained = false;
      let retainReason = '';
      let matchedRuleId = '';

      // 沿责任链依次执行各个规则进行判定
      for (const rule of this.rules) {
        try {
          const result = await rule.evaluate({
            tab,
            allTabs,
            activityStats,
            config,
            frequencyContext,
            formResults,
            tierContext
          });

          if (result && result.retain) {
            isRetained = true;
            retainReason = result.reason || rule.name;
            matchedRuleId = result.matchedRuleId || rule.id;
            break; // 命中高优先级保留规则后，立即终止本标签页的后续判定
          }
        } catch (err) {
          console.error(`[RuleEngine] 规则 [${rule.id}] 评估异常:`, err);
        }
      }

      if (isRetained) {
        tabsToKeep.push({ tab, reason: retainReason, matchedRuleId });
      } else {
        tabsToStash.push({ tab });
      }
    }

    return {
      tabsToKeep,
      tabsToStash,
      total: allTabs.length
    };
  }
}

