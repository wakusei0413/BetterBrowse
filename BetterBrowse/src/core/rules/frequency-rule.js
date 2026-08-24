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

  async evaluate({ tab, allTabs, activityStats, config }) {
    if (!config.rulesEnabled?.highFrequency) {
      return { retain: false };
    }

    if (!allTabs || allTabs.length === 0 || !activityStats) {
      return { retain: false };
    }

    const windowMs = (config.frequencyHistoryMinutes || 60) * 60 * 1000;
    const now = Date.now();

    // 计算每个标签在时间窗口内的有效激活次数
    const countMap = new Map();
    for (const t of allTabs) {
      const timestamps = activityStats[t.id]?.activationTimestamps || [];
      const validCount = timestamps.filter((ts) => (now - ts) <= windowMs).length;
      countMap.set(t.id, validCount);
    }

    const currentTabCount = countMap.get(tab.id) || 0;
    // 如果该标签页在 1 小时内几乎没有激活过（少于 2 次），则不属于高频标签
    if (currentTabCount < 2) {
      return { retain: false };
    }

    // 获取所有标签页的激活频次并降序排序
    const allCounts = Array.from(countMap.values()).sort((a, b) => b - a);
    const topCountIndex = Math.max(1, Math.ceil(allTabs.length * (config.frequencyPercentile || 0.2)));
    const thresholdCount = allCounts[topCountIndex - 1] || 2;

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

