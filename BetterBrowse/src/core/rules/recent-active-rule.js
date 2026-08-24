/**
 * @file recent-active-rule.js
 * @description P1 规则：保护最近访问与当前处于前台活跃状态的标签页
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';

export class RecentActiveRule extends BaseRule {
  constructor() {
    super({
      id: 'recentActive',
      name: '最近访问与当前活跃',
      priority: RulePriorities.P1,
      description: '保护当前激活中的标签页及在设定时间窗口（如5分钟）内访问过的标签页'
    });
  }

  async evaluate({ tab, activityStats, config }) {
    if (!config.rulesEnabled?.recentActive) {
      return { retain: false };
    }

    // 1. 当前正在前台激活的标签页直接保留
    if (tab.active === true) {
      return {
        retain: true,
        reason: '当前正在浏览的前台标签页',
        matchedRuleId: this.id
      };
    }

    // 2. 检查最近访问时间
    const windowMs = (config.recentActiveMinutes || 5) * 60 * 1000;
    const tabStat = activityStats?.[tab.id];
    const lastActivated = tabStat?.lastActivated || 0;
    const now = Date.now();

    if (lastActivated > 0 && (now - lastActivated) <= windowMs) {
      const elapsedMinutes = Math.max(1, Math.round((now - lastActivated) / 60000));
      return {
        retain: true,
        reason: `最近 ${elapsedMinutes} 分钟内被访问过`,
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

