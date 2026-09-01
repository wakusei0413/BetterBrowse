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

// ===================== 阶梯式降级收纳机制测试 =====================

test('TieredStash: buildTierContext 标准层级（level 0）返回基础参数', () => {
  const ctx = RuleEngine.buildTierContext(DefaultConfig, 0, { maxTiers: 5, tierStepSeconds: 60 });
  assert.equal(ctx.level, 0);
  assert.equal(ctx.recentActiveMinutes, DefaultConfig.recentActiveMinutes || 5);
  assert.equal(ctx.frequencyPercentile, DefaultConfig.frequencyPercentile || 0.2);
  assert.equal(ctx.minActivationCount, 2);
  assert.equal(ctx.softRulesEscalated, false);
});

test('TieredStash: buildTierContext 逐级缩短最近访问窗口与提高高频门槛', () => {
  const tierSettings = { maxTiers: 5, tierStepSeconds: 60 };
  const ctx1 = RuleEngine.buildTierContext(DefaultConfig, 1, tierSettings);
  assert.equal(ctx1.recentActiveMinutes, (DefaultConfig.recentActiveMinutes || 5) - 1);
  // 浮点误差范围内比较（0.2 - 0.05 等十进制减法存在二进制表示误差）
  assert.ok(Math.abs(ctx1.frequencyPercentile - ((DefaultConfig.frequencyPercentile || 0.2) - 0.05)) < 1e-9);
  assert.equal(ctx1.minActivationCount, 3);
  assert.equal(ctx1.softRulesEscalated, true);

  const ctx3 = RuleEngine.buildTierContext(DefaultConfig, 3, tierSettings);
  assert.equal(ctx3.recentActiveMinutes, (DefaultConfig.recentActiveMinutes || 5) - 3);
  assert.ok(Math.abs(ctx3.frequencyPercentile - ((DefaultConfig.frequencyPercentile || 0.2) - 0.15)) < 1e-9);
  assert.equal(ctx3.minActivationCount, 5);
});

test('TieredStash: buildTierContext 窗口缩短到 0 后不再为负值', () => {
  const ctxDeep = RuleEngine.buildTierContext(DefaultConfig, 99, { maxTiers: 99, tierStepSeconds: 60 });
  assert.equal(ctxDeep.recentActiveMinutes, 0);
  assert.equal(ctxDeep.frequencyPercentile, 0);
});

test('TieredStash: RecentActiveRule 随阶梯降级窗口逐级缩短，超出新窗口的标签转为可收纳', async () => {
  const engine = new RuleEngine();
  const now = Date.now();
  const tabs = [
    // 4 分 30 秒前被访问过的标签页
    { id: 1, url: 'https://recent.example', active: false, audible: false, pinned: false }
  ];
  const activityStats = {
    1: { lastActivated: now - 4.5 * 60 * 1000, activationTimestamps: [now - 4.5 * 60 * 1000] }
  };
  const tierSettings = { maxTiers: 5, tierStepSeconds: 60 };

  // 标准模式：窗口 5 分钟 → 4.5 分钟内，保留
  const resL0 = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats,
    config: DefaultConfig,
    tierContext: RuleEngine.buildTierContext(DefaultConfig, 0, tierSettings)
  });
  assert.equal(resL0.tabsToKeep.some((t) => t.tab.id === 1), true);

  // 阶梯第 1 级：窗口缩短至 4 分钟 → 4.5 分钟超窗，转为可收纳
  const resL1 = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats,
    config: DefaultConfig,
    tierContext: RuleEngine.buildTierContext(DefaultConfig, 1, tierSettings)
  });
  assert.equal(resL1.tabsToStash.some((t) => t.tab.id === 1), true);
});

test('TieredStash: FrequencyRule 随阶梯提高最低激活次数，低频标签转为可收纳', async () => {
  const engine = new RuleEngine();
  const now = Date.now();
  const tabs = [
    { id: 1, url: 'https://freq.example', active: false, audible: false, pinned: false },
    { id: 2, url: 'https://freq2.example', active: false, audible: false, pinned: false }
  ];
  // 最近访问时间置于 30 分钟前（避开"最近访问"软性保护干扰），仅保留 1 小时内的 2 次激活记录
  const activityStats = {
    1: { lastActivated: now - 30 * 60 * 1000, activationTimestamps: [now - 60 * 1000, now - 120 * 1000] },
    2: { lastActivated: now - 30 * 60 * 1000, activationTimestamps: [now - 300 * 1000, now - 600 * 1000] }
  };
  const tierSettings = { maxTiers: 5, tierStepSeconds: 60 };

  // 标准模式：最低激活 2 次 → 标签 1 满足高频保护
  const resL0 = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats,
    config: DefaultConfig,
    tierContext: RuleEngine.buildTierContext(DefaultConfig, 0, tierSettings)
  });
  assert.equal(resL0.tabsToKeep.some((t) => t.tab.id === 1), true);

  // 阶梯第 1 级：最低激活 3 次 → 标签 1 不再满足，转为可收纳
  const resL1 = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats,
    config: DefaultConfig,
    tierContext: RuleEngine.buildTierContext(DefaultConfig, 1, tierSettings)
  });
  assert.equal(resL1.tabsToStash.some((t) => t.tab.id === 1), true);
});

test('TieredStash: 终极兜底 hardCoreOnly 仅保留硬性保护，软性保护全部放弃', async () => {
  const engine = new RuleEngine();
  const now = Date.now();
  const tabs = [
    { id: 1, url: 'https://active.example', active: true },                                      // 前台激活 → 硬性保留
    { id: 2, url: 'https://music.example', active: false, audible: true },                       // 播放媒体 → 硬性保留
    { id: 3, url: 'https://pinned.example', active: false, pinned: true },                       // 固定标签 → 硬性保留
    { id: 4, url: 'https://recent.example', active: false },                                     // 仅最近访问（软性）→ 放弃
    { id: 5, url: 'https://freq.example', active: false }                                        // 仅高频访问（软性）→ 放弃
  ];
  const activityStats = {
    4: { lastActivated: now - 60 * 1000, activationTimestamps: [now - 60 * 1000] },
    5: { lastActivated: now - 60 * 1000, activationTimestamps: [now - 60 * 1000, now - 120 * 1000, now - 180 * 1000] }
  };
  const hardCoreContext = { hardCoreOnly: true, level: -1, softRulesEscalated: true };

  const res = await engine.evaluateTabs({
    allTabs: tabs,
    activityStats,
    config: DefaultConfig,
    tierContext: hardCoreContext
  });

  const keptIds = res.tabsToKeep.map((t) => t.tab.id);
  const stashedIds = res.tabsToStash.map((t) => t.tab.id);
  assert.deepEqual(keptIds.sort(), [1, 2, 3]);
  assert.deepEqual(stashedIds.sort(), [4, 5]);
});
