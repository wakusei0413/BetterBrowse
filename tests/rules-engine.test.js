/**
 * @file rules-engine.test.js
 * @description 智能规则引擎 P0~P3 多级优先级判定测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../BetterBrowse/src/core/rules/rule-engine.js';
import { FormGuardRule } from '../BetterBrowse/src/core/rules/form-guard-rule.js';
import { DefaultConfig } from '../BetterBrowse/src/constants/config.js';

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

function installFormProbeChrome(sendMessage, extra = {}) {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null, getURL: (path) => `chrome-extension://test/${path}` },
    webNavigation: {
      getAllFrames: async () => ([
        { frameId: 0, url: 'https://idle.example/' },
        { frameId: 3, url: 'https://ads.example/pixel' }
      ])
    },
    tabs: { sendMessage },
    ...extra
  };
  return () => {
    globalThis.chrome = originalChrome;
  };
}

/**
 * 构造"第一次探测无接收端、注入内容脚本后第二次成功"的发送桩
 * @param {Array<object>} injections - 记录注入调用
 * @param {{ hasActiveInput: boolean }} payload - 重探成功后的返回数据
 */
function createInjectionRecoverySender(injections, payload = { hasActiveInput: false }) {
  return (tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    // 注入前：该标签尚无内容脚本；注入后：可正常应答
    if (!injections.some((item) => item.target?.tabId === tabId)) {
      chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      cb?.();
      chrome.runtime.lastError = null;
      return;
    }
    chrome.runtime.lastError = null;
    cb?.({ success: true, data: payload });
  };
}

function createScriptingStub(injections) {
  return {
    scripting: {
      executeScript: async (options) => {
        injections.push(options);
        return [];
      }
    }
  };
}

test('FormGuardRule: 子框架探测失败不得把整页判为受保护', async () => {
  const restore = installFormProbeChrome((tabId, message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    const frameId = typeof optionsOrCb === 'object' && optionsOrCb ? optionsOrCb.frameId : 0;
    if (frameId === 0 || typeof optionsOrCb === 'function') {
      chrome.runtime.lastError = null;
      cb?.({ success: true, data: { hasActiveInput: false } });
      return;
    }
    chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    cb?.();
    chrome.runtime.lastError = null;
  });
  try {
    const res = await FormGuardRule.probeTabFrames(1);
    assert.equal(res.success, true);
    assert.equal(res.data.hasActiveInput, false);
  } finally {
    restore();
  }
});

test('FormGuardRule: 顶层探测失败仍按 fail-closed 保护', async () => {
  const restore = installFormProbeChrome((_tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    cb?.();
    chrome.runtime.lastError = null;
  });
  try {
    const res = await FormGuardRule.probeTabFrames(1);
    assert.equal(res.success, false);
  } finally {
    restore();
  }
});

test('FormGuardRule: 子框架确认有输入时仍保护该标签', async () => {
  const restore = installFormProbeChrome((_tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    const frameId = typeof optionsOrCb === 'object' && optionsOrCb ? optionsOrCb.frameId : 0;
    chrome.runtime.lastError = null;
    if (frameId === 3) {
      cb?.({ success: true, data: { hasActiveInput: true, reason: '框架内存在未提交输入' } });
      return;
    }
    cb?.({ success: true, data: { hasActiveInput: false } });
  });
  try {
    const res = await FormGuardRule.probeTabFrames(1);
    assert.equal(res.success, true);
    assert.equal(res.data.hasActiveInput, true);
  } finally {
    restore();
  }
});

test('FormGuardRule: 顶层无接收端时注入内容脚本后重探，不得再误判为受保护', async () => {
  const injections = [];
  const restore = installFormProbeChrome(
    createInjectionRecoverySender(injections),
    createScriptingStub(injections)
  );
  try {
    const res = await FormGuardRule.probeTabFrames(1);

    assert.equal(injections.length, 1);
    assert.equal(injections[0].target.tabId, 1);
    assert.deepEqual(injections[0].target.frameIds, [0]);
    assert.equal(injections[0].files[0], 'src/content/content-bundle.js');
    // 注入后确认页面无输入：不得再按 fail-closed 保留，否则批量标签会让整次收纳落空
    assert.equal(res.success, true);
    assert.equal(res.data.hasActiveInput, false);
  } finally {
    restore();
  }
});

test('FormGuardRule: 顶层探测超时时不得重复注入内容脚本', async () => {
  const injections = [];
  const restore = installFormProbeChrome((_tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    // 超时说明接收端存在，只是响应慢；重复注入会重复注册监听器
    chrome.runtime.lastError = { message: '内容脚本响应超时' };
    cb?.();
    chrome.runtime.lastError = null;
  }, createScriptingStub(injections));
  try {
    const res = await FormGuardRule.probeTabFrames(1);
    assert.equal(injections.length, 0);
    assert.equal(res.success, false);
  } finally {
    restore();
  }
});

test('FormGuardRule: 注入后仍探测不通时保持 fail-closed 保护', async () => {
  const injections = [];
  const restore = installFormProbeChrome((_tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    cb?.();
    chrome.runtime.lastError = null;
  }, createScriptingStub(injections));
  try {
    const res = await FormGuardRule.probeTabFrames(1);
    assert.equal(injections.length, 1);
    // 注入也救不回来（页面已丢弃/仍在中途导航）：宁可误保，不可误关
    assert.equal(res.success, false);
  } finally {
    restore();
  }
});

test('FormGuardRule: preload 覆盖仅有 pendingUrl 的待提交标签', async () => {
  const probed = [];
  const restore = installFormProbeChrome((tabId, _message, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    probed.push(tabId);
    chrome.runtime.lastError = null;
    cb?.({ success: true, data: { hasActiveInput: false } });
  });
  try {
    const results = new Map();
    await new FormGuardRule().preload({
      allTabs: [{ id: 7, url: '', pendingUrl: 'https://pending.example/' }],
      config: DefaultConfig,
      results
    });

    // URL 未提交的标签此前被整段跳过，导致在 evaluate 阶段才逐页探测并普遍 fail-closed
    assert.deepEqual([...new Set(probed)], [7]);
    assert.equal(results.get(7).success, true);
  } finally {
    restore();
  }
});
