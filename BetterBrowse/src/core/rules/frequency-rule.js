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

  createContext({ allTabs, activityStats, config }) {
    const windowMinutes = Number.isFinite(config.frequencyHistoryMinutes) && config.frequencyHistoryMinutes > 0 ? config.frequencyHistoryMinutes : 60;
    const now = Date.now();
    const countMap = new Map();
    for (const t of allTabs || []) {
      const timestamps = activityStats?.[t.id]?.activationTimestamps || [];
      countMap.set(t.id, timestamps.filter((ts) => now - ts <= windowMinutes * 60 * 1000).length);
    }
    const percentile = Number.isFinite(config.frequencyPercentile) && config.frequencyPercentile > 0 ? Math.min(config.frequencyPercentile, 1) : 0.2;
    const counts = Array.from(countMap.values()).sort((a, b) => b - a);
    const threshold = counts[Math.max(0, Math.max(1, Math.ceil((allTabs || []).length * percentile)) - 1)] || 2;
    return { countMap, threshold };
  }

  async evaluate({ tab, allTabs, activityStats, config, frequencyContext }) {
    if (!config.rulesEnabled?.highFrequency) {
      return { retain: false };
    }

    if (!allTabs || allTabs.length === 0 || !activityStats) {
      return { retain: false };
    }

    const context = frequencyContext || this.createContext({ allTabs, activityStats, config });
    const currentTabCount = context.countMap.get(tab.id) || 0;
    // 如果该标签页在 1 小时内几乎没有激活过（少于 2 次），则不属于高频标签
    if (currentTabCount < 2) {
      return { retain: false };
    }

    // 获取所有标签页的激活频次并降序排序
    const thresholdCount = context.threshold;

    if (currentTabCount >= thresholdCount) {
      return {
        retain: true,
        reason: `近 1 小时内激活 ${currentTabCount} 次（高频访问 Top 20%）`,
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

