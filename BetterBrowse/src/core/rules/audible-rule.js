/**
 * @file audible-rule.js
 * @description P0 规则：保护正在播放音频或视频媒体的标签页
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';

export class AudibleRule extends BaseRule {
  constructor() {
    super({
      id: 'audible',
      name: '正在播放媒体',
      priority: RulePriorities.P0,
      description: '当标签页正在播放音频或视频时保留（tab.audible === true）'
    });
  }

  async evaluate({ tab, config }) {
    if (!config.rulesEnabled?.audible) {
      return { retain: false };
    }

    if (tab.audible === true) {
      return {
        retain: true,
        reason: '标签页正在播放音视频媒体',
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

