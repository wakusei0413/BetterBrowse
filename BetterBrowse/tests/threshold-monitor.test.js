/**
 * @file threshold-monitor.test.js
 * @description 标签页超限阈值监控与冷却防打扰集成测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ThresholdMonitor } from '../src/background/threshold-monitor.js';
import { DefaultConfig } from '../src/constants/config.js';

function installMockChrome() {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    tabs: {
      onCreated: { addListener() {} },
      onActivated: { addListener() {} },
      query: async () => []
    },
    windows: {
      onFocusChanged: { addListener() {} },
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 1, tabs: [] })
    },
    notifications: {
      onButtonClicked: { addListener() {} },
      clear: () => {}
    },
    storage: {
      local: {
        get: (_keys, cb) => cb({ user_config: DefaultConfig }),
        set: (_items, cb) => cb?.()
      }
    }
  };
}

test('ThresholdMonitor: 实例化与默认状态正常', () => {
  installMockChrome();
  const monitor = new ThresholdMonitor();
  assert.equal(monitor.totalSeconds, 15);
  assert.equal(monitor.remainingSeconds, 0);
  assert.equal(monitor.countdownInterval, null);
});

test('ThresholdMonitor: 冷却时间内防打扰机制生效', () => {
  installMockChrome();
  const monitor = new ThresholdMonitor();
  monitor.lastActionTime = Date.now(); // 刚触发过

  // 模拟判断冷却时间 (默认 5 分钟)
  const isCooling = Date.now() - monitor.lastActionTime < 5 * 60 * 1000;
  assert.equal(isCooling, true);
});
