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

    await Promise.all(
      pendingTabs.map(async (tab) => {
        results.set(tab.id, await FormGuardRule.probeTabFrames(tab.id));
      })
    );
  }

  /**
   * 聚合标签页全部 HTTP(S) 框架的表单状态：任一框架有输入或探测失败即视为需保护。
   * @param {number} tabId
   * @returns {Promise<{ success: boolean, data?: { hasActiveInput: boolean, reason?: string }, error?: string }>}
   */
  static async probeTabFrames(tabId) {
    let frames = [{ frameId: 0 }];
    try {
      if (chrome.webNavigation?.getAllFrames) {
        const listed = await chrome.webNavigation.getAllFrames({ tabId });
        if (Array.isArray(listed) && listed.length > 0) frames = listed;
      }
    } catch {
      // 无 webNavigation 时只探测顶层
    }

    let sawSuccess = false;
    let activeReason = '';
    for (const frame of frames) {
      if (!Number.isInteger(frame.frameId) || frame.frameId < 0) continue;
      const url = frame.url || '';
      if (url && !url.startsWith('http://') && !url.startsWith('https://') && frame.frameId !== 0) continue;
      try {
        // 顶层框架走不带 options 的普通发送，兼容更简单的测试桩与旧调用约定
        const response = frame.frameId === 0
          ? await MessageBus.sendToTab(tabId, ActionTypes.CHECK_FORM_INPUT, null, 2000)
          : await MessageBus.sendToFrame(tabId, frame.frameId, ActionTypes.CHECK_FORM_INPUT, null, 2000);
        if (!response?.success) {
          return { success: false, error: response?.error || '框架探测失败' };
        }
        sawSuccess = true;
        if (response.data?.hasActiveInput) {
          activeReason = response.data.reason || '框架内存在未提交输入';
          return { success: true, data: { hasActiveInput: true, reason: activeReason } };
        }
      } catch {
        return { success: false, error: '探测异常' };
      }
    }
    if (!sawSuccess) return { success: false, error: '无可探测框架' };
    return { success: true, data: { hasActiveInput: false } };
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
      const response = cached || await FormGuardRule.probeTabFrames(tab.id);
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

