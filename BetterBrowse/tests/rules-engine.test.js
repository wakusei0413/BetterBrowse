/**
 * @file rules-engine.test.js
 * @description 智能规则引擎 P0~P3 多级优先级判定测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../src/core/rules/rule-engine.js';
import { DefaultConfig } from '../src/constants/config.js';

test('AudibleRule (P0): 正在播放媒体的标签页必须安全保留', async () => {
  const engine = new RuleEngine();
  const tabs = [
    { id: 1, url: 'https://bilibili.com/video/1', audible: true, active: false },
    { id: 2, url: 'https://example.com', audible: false, active: false }
  ];

  const res = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats: {},
    config: DefaultConfig
  });

  assert.equal(res.tabsToKeep.some((t) => t.tab.id === 1), true);
  assert.equal(res.tabsToStash.some((t) => t.tab.id === 2), true);
});

test('PinnedRule (P3): 固定在左侧的标签页必须保留', async () => {
  const engine = new RuleEngine();
  const tabs = [
    { id: 10, url: 'https://mail.google.com', pinned: true, active: false },
    { id: 20, url: 'https://news.ycombinator.com', pinned: false, active: false }
  ];

  const res = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats: {},
    config: DefaultConfig
  });

  assert.equal(res.tabsToKeep.some((t) => t.tab.id === 10), true);
  assert.equal(res.tabsToStash.some((t) => t.tab.id === 20), true);
});

test('RecentActiveRule (P1): 当前前台激活的标签页必须保留', async () => {
  const engine = new RuleEngine();
  const tabs = [
    { id: 100, url: 'https://github.com', active: true },
    { id: 200, url: 'https://idle.com', active: false }
  ];

  const res = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats: {},
    config: DefaultConfig
  });

  assert.equal(res.tabsToKeep.some((t) => t.tab.id === 100), true);
});
