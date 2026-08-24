/**
 * @file pinned-rule.js
 * @description P3 规则：固定标签页保护（保护被固定在浏览器左侧的标签页）
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';

export class PinnedRule extends BaseRule {
  constructor() {
    super({
      id: 'pinned',
      name: '固定标签页',
      priority: RulePriorities.P3,
      description: '保护固定在浏览器左侧的常驻标签页（tab.pinned === true）'
    });
  }

  async evaluate({ tab, config }) {
    if (!config.rulesEnabled?.pinned) {
      return { retain: false };
    }

    if (tab.pinned === true) {
      return {
        retain: true,
        reason: '已被固定在浏览器左侧',
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

