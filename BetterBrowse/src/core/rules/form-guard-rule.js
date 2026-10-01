/**
 * @file form-guard-rule.js
 * @description P0 规则：表单输入保护（检测标签页是否包含正在输入的表单或未保存内容）
 * @encoding UTF-8
 */

import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';
import { MessageBus } from '../bus/message-bus.js';
import { ActionTypes } from '../../constants/action-types.js';
import { isInjectableWebTab } from '../extension-url.js';

/**
 * 内容脚本尚未注入时的失败特征。
 * 超时（接收端存在但响应慢）刻意不在此列：对已有监听器的页面重复注入内容脚本
 * 会重复注册 onMessage 监听器，反而制造"消息端口提前关闭"的伪故障。
 */
const NO_RECEIVER_PATTERN = /Receiving end does not exist|Could not establish connection/i;

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
      (tab) => tab?.id && isInjectableWebTab(tab) && !results.has(tab.id)
    );
    if (pendingTabs.length === 0) return;

    await Promise.all(
      pendingTabs.map(async (tab) => {
        results.set(tab.id, await FormGuardRule.probeTabFrames(tab.id));
      })
    );
  }

  /**
   * 探测顶层框架的表单状态，并在"内容脚本尚未注入"时动态注入后重探一次。
   *
   * 这是"有提示却不收纳"的关键修复：刚打开的页面、会话恢复的标签与扩展刚重载后的既有标签
   * 都没有内容脚本，此前一律因无法确认状态而 fail-closed 保留；数量一多就会命中硬性保护
   * 超限，导致整次自动收纳一个标签都收不掉。
   *
   * @param {number} tabId
   * @returns {Promise<{ success: boolean, data?: { hasActiveInput: boolean, reason?: string }, error?: string }>}
   */
  static async probeTopFrameWithRecovery(tabId) {
    // 顶层框架走不带 options 的普通发送，兼容更简单的测试桩与旧调用约定
    const first = await MessageBus.sendToTab(tabId, ActionTypes.CHECK_FORM_INPUT, null, 2000);
    if (first?.success) return first;
    if (!NO_RECEIVER_PATTERN.test(String(first?.error || ''))) return first;
    if (!globalThis.chrome?.scripting?.executeScript) return first;

    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['src/content/content-bundle.js']
      });
    } catch {
      // 标签页已被关闭、处于丢弃状态或仍在中途导航：保持 fail-closed
      return first;
    }
    return await MessageBus.sendToTab(tabId, ActionTypes.CHECK_FORM_INPUT, null, 2000);
  }

  /**
   * 聚合标签页全部 HTTP(S) 框架的表单状态：
   * - 任一框架确认有输入 → 保护该标签；
   * - 顶层框架探测失败 → fail-closed 保护（无法确认主页面表单）；
   * - 子框架无接收端/超时 → 跳过该框架（广告、沙箱 iframe 普遍无法注入，不得把整页判为受保护）。
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

    let sawTopSuccess = false;
    for (const frame of frames) {
      if (!Number.isInteger(frame.frameId) || frame.frameId < 0) continue;
      const url = frame.url || '';
      if (url && !url.startsWith('http://') && !url.startsWith('https://') && frame.frameId !== 0) continue;
      const isTop = frame.frameId === 0;
      try {
        const response = isTop
          ? await FormGuardRule.probeTopFrameWithRecovery(tabId)
          : await MessageBus.sendToFrame(tabId, frame.frameId, ActionTypes.CHECK_FORM_INPUT, null, 2000);
        if (!response?.success) {
          if (isTop) {
            return { success: false, error: response?.error || '顶层框架探测失败' };
          }
          continue;
        }
        if (isTop) sawTopSuccess = true;
        if (response.data?.hasActiveInput) {
          return {
            success: true,
            data: {
              hasActiveInput: true,
              reason: response.data.reason || (isTop ? '页面存在未提交输入' : '框架内存在未提交输入')
            }
          };
        }
      } catch {
        if (isTop) return { success: false, error: '顶层框架探测异常' };
      }
    }
    if (!sawTopSuccess) return { success: false, error: '顶层框架未确认' };
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

