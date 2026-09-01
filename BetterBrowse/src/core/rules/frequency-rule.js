/**
 * @file frequency-rule.js
 * @description P2 规则：高使用频率保护（统计最近 1 小时内被激活频次，保留前 20%）
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';

export class FrequencyRule extends BaseRule {
  constructor() {
    super({
      id: 'highFrequency',
      name: '高频访问标签页',
      priority: RulePriorities.P2,
      description: '统计最近 1 小时内被切换激活的次数，保护排名前 20% 的常用标签页'
    });
  }

  /**
   * 构建高频访问统计上下文
   * @param {Object} params
   * @param {chrome.tabs.Tab[]} params.allTabs - 全量标签页
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} params.activityStats - 活跃度统计
   * @param {typeof import('../../constants/config.js').DefaultConfig} params.config - 用户全局配置
   * @param {object|null} [params.tierContext] - 阶梯式降级上下文（逐级下调保留百分比）
   * @returns {{ countMap: Map<number, number>, threshold: number }}
   */
  createContext({ allTabs, activityStats, config, tierContext }) {
    const windowMinutes = Number.isFinite(config.frequencyHistoryMinutes) && config.frequencyHistoryMinutes > 0 ? config.frequencyHistoryMinutes : 60;
    const now = Date.now();
    const countMap = new Map();
    for (const t of allTabs || []) {
      const timestamps = activityStats?.[t.id]?.activationTimestamps || [];
      countMap.set(t.id, timestamps.filter((ts) => now - ts <= windowMinutes * 60 * 1000).length);
    }
    const percentile = Number.isFinite(tierContext?.frequencyPercentile)
      ? Math.min(Math.max(tierContext.frequencyPercentile, 0), 1)
      : (Number.isFinite(config.frequencyPercentile) && config.frequencyPercentile > 0 ? Math.min(config.frequencyPercentile, 1) : 0.2);
    const counts = Array.from(countMap.values()).sort((a, b) => b - a);
    const threshold = counts[Math.max(0, Math.max(1, Math.ceil((allTabs || []).length * percentile)) - 1)] || 2;
    return { countMap, threshold, percentile };
  }

  /**
   * 评估标签页是否属于高频访问而应被保留
   * @param {Object} params
   * @param {chrome.tabs.Tab} params.tab - 待评估标签页
   * @param {chrome.tabs.Tab[]} params.allTabs - 全量标签页
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} params.activityStats - 活跃度统计
   * @param {typeof import('../../constants/config.js').DefaultConfig} params.config - 用户全局配置
   * @param {object|null} [params.frequencyContext] - 高频统计上下文（预构建，避免重复统计）
   * @param {object|null} [params.tierContext] - 阶梯式降级上下文（逐级上调最低激活次数；终极兜底 hardCoreOnly 时放弃本软性保护）
   */
  async evaluate({ tab, allTabs, activityStats, config, frequencyContext, tierContext }) {
    if (!config.rulesEnabled?.highFrequency) {
      return { retain: false };
    }

    // 终极兜底阶段：放弃"高频访问"软性保护
    if (tierContext?.hardCoreOnly) {
      return { retain: false };
    }

    if (!allTabs || allTabs.length === 0 || !activityStats) {
      return { retain: false };
    }

    const context = frequencyContext || this.createContext({ allTabs, activityStats, config, tierContext });
    const currentTabCount = context.countMap.get(tab.id) || 0;
    // 阶梯降级时逐级上调最低激活次数（标准 2 次 → 3 次 → 4 次 …）
    const minActivationCount = Number.isFinite(tierContext?.minActivationCount) ? Math.max(1, Math.floor(tierContext.minActivationCount)) : 2;
    // 如果该标签页在 1 小时内几乎没有激活过（少于最低激活次数），则不属于高频标签
    if (currentTabCount < minActivationCount) {
      return { retain: false };
    }

    // 获取所有标签页的激活频次并降序排序
    const thresholdCount = context.threshold;

    if (currentTabCount >= thresholdCount) {
      const pct = Math.round((context.percentile || 0) * 100);
      return {
        retain: true,
        reason: pct > 0
          ? `近 1 小时内激活 ${currentTabCount} 次（高频访问 Top ${pct}%）`
          : `近 1 小时内激活 ${currentTabCount} 次（高频访问保护）`,
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

