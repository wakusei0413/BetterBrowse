/**
 * @file form-guard-rule.js
 * @description P0 规则：表单输入保护（检测标签页是否包含正在输入的表单或未保存内容）
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';
import { MessageBus } from '../bus/message-bus.js';
import { ActionTypes } from '../../constants/action-types.js';

export class FormGuardRule extends BaseRule {
  constructor() {
    super({
      id: 'formGuard',
      name: '表单输入保护',
      priority: RulePriorities.P0,
      description: '检测网页内 input、textarea 或可编辑区域是否有焦点或已输入内容'
    });
  }

  async evaluate({ tab, config, formResults }) {
    if (!config.rulesEnabled?.formGuard || config.stashSettings?.excludeFormDirtyTabs === false) {
      return { retain: false };
    }

    if (!tab.id || !tab.url) {
      return { retain: false };
    }

    // 无法注入脚本的特殊协议页面直接跳过本规则
    if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
      return { retain: false };
    }
    if (!globalThis.chrome?.tabs?.sendMessage) {
      return { retain: false };
    }

    try {
      const cached = formResults?.get(tab.id);
      const response = cached || await MessageBus.sendToTab(tab.id, ActionTypes.CHECK_FORM_INPUT);
      formResults?.set(tab.id, response);
      if (response && response.success && response.data && response.data.hasActiveInput) {
        return {
          retain: true,
          reason: response.data.reason || '标签页包含未提交或正在编辑的表单内容',
          matchedRuleId: this.id
        };
      }
      if (!response?.success) {
        return {
          retain: true,
          reason: '无法确认表单状态，按安全策略暂不收纳',
          matchedRuleId: this.id
        };
      }
    } catch {
      // 忽略通信异常
    }

    return { retain: false };
  }
}

