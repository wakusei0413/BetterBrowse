/**
 * @file base-rule.js
 * @description 智能标签页收纳规则基类（策略模式统一规范）
 * @encoding UTF-8
 */

export class BaseRule {
  /**
   * @param {Object} options
   * @param {string} options.id - 规则唯一标识
   * @param {string} options.name - 规则展示名称
   * @param {number} options.priority - 优先级数值（越小优先级越高，如 P0=0, P1=1）
   * @param {string} options.description - 规则中文详细说明
   */
  constructor({ id, name, priority, description }) {
    this.id = id;
    this.name = name;
    this.priority = priority;
    this.description = description;
  }

  /**
   * 评估单标签页或全量标签页上下文
   * @param {Object} context - 评估上下文对象
   * @param {chrome.tabs.Tab} context.tab - 待评估的当前标签页对象
   * @param {chrome.tabs.Tab[]} context.allTabs - 浏览器当前窗口/全量所有标签页列表
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} context.activityStats - 活跃度统计数据
   * @param {typeof import('../../constants/config.js').DefaultConfig} context.config - 用户全局配置
   * @returns {Promise<{ retain: boolean, reason?: string, matchedRuleId?: string }>} 返回是否保留及原因
   */
  async evaluate(context) {
    throw new Error(`[BaseRule] 规则 [${this.id}] 必须实现 evaluate 方法`);
  }
}

