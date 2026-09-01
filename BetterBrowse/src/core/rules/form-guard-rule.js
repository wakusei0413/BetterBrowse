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

  /**
   * 预加载阶段：批量向所有可注入页面发送表单检测消息并填充缓存
   * （规则引擎在标准评估前调用一次，避免阶梯多轮评估时逐 tab 串行重查）
   * @param {Object} params
   * @param {chrome.tabs.Tab[]} params.allTabs
   * @param {Object} params.config
   * @param {Map<number, {success: boolean}>} params.results - 跨轮次复用的检测结果缓存
   */
  async preload({ allTabs, config, results }) {
    if (!config?.rulesEnabled?.formGuard || config.stashSettings?.excludeFormDirtyTabs === false) {
      return;
    }
    if (!globalThis.chrome?.tabs?.sendMessage || !results) return;

    const pendingTabs = (allTabs || []).filter(
      (tab) => tab?.id && tab.url
        && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
        && !results.has(tab.id)
    );
    if (pendingTabs.length === 0) return;

    // 并行探测所有候选页面（单页超时由 MessageBus.sendToTab 内部 2 秒兜底）
    await Promise.all(
      pendingTabs.map(async (tab) => {
        try {
          const response = await MessageBus.sendToTab(tab.id, ActionTypes.CHECK_FORM_INPUT);
          results.set(tab.id, response);
        } catch {
          // 单页通信异常不影响其余页面的预加载，评估阶段会按 fail-closed 策略兜底
          results.set(tab.id, { success: false, error: '探测异常' });
        }
      })
    );
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
      // 通信异常与"无法确认表单状态"保持同一安全策略：宁可误保，不可误关
      return {
        retain: true,
        reason: '表单状态检测异常，按安全策略暂不收纳',
        matchedRuleId: this.id
      };
    }

    return { retain: false };
  }
}

