/**
 * @file rule-engine.js
 * @description 智能收纳规则编排引擎（基于责任链与策略模式，支持动态插拔与扩展）
 * @encoding UTF-8
 */

import { AudibleRule } from './audible-rule.js';
import { FormGuardRule } from './form-guard-rule.js';
import { RecentActiveRule } from './recent-active-rule.js';
import { FrequencyRule } from './frequency-rule.js';
import { PinnedRule } from './pinned-rule.js';
import { isOwnOptionsUrl } from '../extension-url.js';

export class RuleEngine {
  /**
   * 初始化规则引擎，默认注册 P0-P3 标准规则
   */
  constructor() {
    /** @type {import('./base-rule.js').BaseRule[]} */
    this.rules = [];

    // 默认内置规则注册
    this.registerRule(new AudibleRule());
    this.registerRule(new FormGuardRule());
    this.registerRule(new RecentActiveRule());
    this.registerRule(new FrequencyRule());
    this.registerRule(new PinnedRule());
  }

  /**
   * 注册新规则（支持后续功能扩展与插件式接入）
   * @param {import('./base-rule.js').BaseRule} rule - 实现了 BaseRule 接口的规则实例
   */
  registerRule(rule) {
    if (!rule || typeof rule.evaluate !== 'function') {
      throw new Error('[RuleEngine] 注册规则失败：规则必须继承 BaseRule 并实现 evaluate 方法');
    }
    // 避免重复注册同名规则
    this.rules = this.rules.filter((r) => r.id !== rule.id);
    this.rules.push(rule);
    // 按优先级升序排序（数值越小优先级越高，P0 在 P1 之前先判定）
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 卸载指定规则
   * @param {string} ruleId
   */
  unregisterRule(ruleId) {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  /**
   * 获取当前已注册的所有规则实例列表
   */
  getRegisteredRules() {
    return [...this.rules];
  }

  /**
   * 评估全量标签页的收纳保留状态
   * @param {Object} params
   * @param {chrome.tabs.Tab[]} params.allTabs - 浏览器当前待评估的标签页数组
   * @param {Record<number, { lastActivated: number, activationTimestamps: number[] }>} params.activityStats - 活跃度统计数据
   * @param {typeof import('../../constants/config.js').DefaultConfig} params.config - 用户全局配置
   * @returns {Promise<{ tabsToKeep: Array<{ tab: chrome.tabs.Tab, reason: string, matchedRuleId: string }>, tabsToStash: Array<{ tab: chrome.tabs.Tab }>, total: number }>}
   */
  async evaluateTabs({ allTabs, activityStats, config }) {
    const tabsToKeep = [];
    const tabsToStash = [];

    const frequencyContext = this.rules.find((rule) => rule.id === 'highFrequency')?.createContext?.({ allTabs, activityStats, config });
    const formResults = new Map();
    const formRule = this.rules.find((rule) => rule.id === 'formGuard');
    if (formRule?.preload) await formRule.preload({ allTabs, config, results: formResults });

    for (const tab of allTabs) {
      // 插件自身 options 收纳页及系统特殊页面绝对保护保留（绝不收纳自身）
      if (tab.url && (isOwnOptionsUrl(tab.url) || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://'))) {
        tabsToKeep.push({
          tab,
          reason: '插件自身常驻小标签与系统页面保护',
          matchedRuleId: 'system_self'
        });
        continue;
      }

      let isRetained = false;
      let retainReason = '';
      let matchedRuleId = '';

      // 沿责任链依次执行各个规则进行判定
      for (const rule of this.rules) {
        try {
          const result = await rule.evaluate({
            tab,
            allTabs,
            activityStats,
            config,
            frequencyContext,
            formResults
          });

          if (result && result.retain) {
            isRetained = true;
            retainReason = result.reason || rule.name;
            matchedRuleId = result.matchedRuleId || rule.id;
            break; // 命中高优先级保留规则后，立即终止本标签页的后续判定
          }
        } catch (err) {
          console.error(`[RuleEngine] 规则 [${rule.id}] 评估异常:`, err);
        }
      }

      if (isRetained) {
        tabsToKeep.push({ tab, reason: retainReason, matchedRuleId });
      } else {
        tabsToStash.push({ tab });
      }
    }

    return {
      tabsToKeep,
      tabsToStash,
      total: allTabs.length
    };
  }
}

