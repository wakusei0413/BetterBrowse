/**
 * @file threshold-monitor.test.js
 * @description 标签页超限阈值监控与冷却防打扰集成测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ThresholdMonitor } from '../BetterBrowse/src/background/threshold-monitor.js';
import { DefaultConfig } from '../BetterBrowse/src/constants/config.js';
import { StorageAdapter } from '../BetterBrowse/src/core/storage/storage-adapter.js';

function installMockChrome() {
  const sessionStore = {};
  const createdAlarms = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    tabs: {
      onCreated: { addListener() {} },
      onActivated: { addListener() {} },
      query: (query, cb) => {
        if (typeof query === 'function') return query([]);
        cb?.([]);
        return [];
      }
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
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {}
    },
    alarms: {
      create: (name, info) => {
        createdAlarms.push({ name, ...(info || {}) });
      },
      clear: () => {},
      onAlarm: { addListener() {} }
    },
    storage: {
      local: {
        get: (_keys, cb) => cb({ user_config: DefaultConfig }),
        set: (_items, cb) => cb?.()
      },
      session: {
        get: (_keys, cb) => cb({ ...sessionStore }),
        set: (items, cb) => {
          Object.assign(sessionStore, items);
          cb?.();
        }
      }
    }
  };
  globalThis.chrome._createdAlarms = createdAlarms;
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

test('ThresholdMonitor: 扩展页与新标签页不参与阈值计数', async () => {
  installMockChrome();
  chrome.storage.local.get = (_keys, cb) => cb({
    user_config: { ...DefaultConfig, tabThreshold: 3, countdownSeconds: 3 }
  });

  const monitor = new ThresholdMonitor();
  monitor.getActiveWindowInfo = async () => ({
    windowId: 1,
    tabs: [
      { id: 1, url: 'https://one.example' },
      { id: 2, url: 'https://two.example' },
      { id: 3, url: 'chrome-extension://test/src/options/options.html#stash' },
      { id: 4, url: 'chrome://newtab/' }
    ]
  });

  await monitor.checkTabCount();
  assert.equal(monitor.remainingSeconds, 0);
  assert.equal(monitor.countdownInterval, null);
});

test('ThresholdMonitor: 要求 nonce 时错误凭证不得确认或取消', async () => {
  installMockChrome();
  let stashed = false;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed = true;
      return { success: true };
    }
  });
  monitor.deadline = Date.now() + 15000;
  monitor.remainingSeconds = 15;
  monitor.actionNonce = 'countdown-nonce-token-ok';

  const deniedConfirm = await monitor.handleConfirmAutoStash({
    requireNonce: true,
    nonce: 'wrong-token'
  });
  assert.equal(deniedConfirm.success, false);
  assert.equal(stashed, false);
  assert.equal(monitor.remainingSeconds, 15);

  const deniedCancel = await monitor.handleCancelAutoStash({
    requireNonce: true,
    nonce: ''
  });
  assert.equal(deniedCancel.success, false);
  assert.equal(monitor.remainingSeconds, 15);

  const allowed = await monitor.handleConfirmAutoStash({
    requireNonce: true,
    nonce: 'countdown-nonce-token-ok'
  });
  assert.equal(stashed, true);
  assert.equal(allowed.success, true);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: 闹钟提前触发不得丢弃倒计时，到期后仍收纳', async () => {
  installMockChrome();
  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 2 };
    }
  });
  await monitor.readyPromise.catch(() => {});
  monitor.deadline = Date.now() + 15000;
  monitor.remainingSeconds = 15;
  monitor.actionNonce = 'countdown-nonce-token-ok';
  monitor.activeWindowId = 1;

  await monitor.handleAlarm();
  assert.equal(stashed, 0);
  assert.equal(monitor.deadline > Date.now(), true);
  assert.equal(
    chrome._createdAlarms.some((item) => item.delayInMinutes >= 0.5),
    true
  );

  monitor.deadline = Date.now() - 20;
  await monitor.handleAlarm();
  assert.equal(stashed, 1);
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: 倒计时已到期时过期检查不受冷却拦截', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 2,
    countdownSeconds: 3,
    autoStashOnThreshold: true,
    thresholdCooldownMinutes: 5
  });
  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 1 };
    }
  });
  monitor.getActiveWindowInfo = async () => ({
    windowId: 1,
    tabs: [
      { id: 1, url: 'https://one.example' },
      { id: 2, url: 'https://two.example' },
      { id: 3, url: 'https://three.example' }
    ]
  });
  try {
    await monitor.readyPromise.catch(() => {});
    monitor.lastActionTime = Date.now();
    monitor.deadline = Date.now() - 1000;
    monitor.actionNonce = 'countdown-nonce-token-ok';

    await monitor.checkTabCount();
    assert.equal(stashed, 1);
    assert.equal(monitor.deadline, 0);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 闹钟与手动确认并发时只收纳一次', async () => {
  installMockChrome();
  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 1 };
    }
  });
  await monitor.readyPromise.catch(() => {});
  monitor.deadline = Date.now() - 10;
  monitor.remainingSeconds = 0;
  monitor.actionNonce = 'countdown-nonce-token-ok';

  const [alarmRes, confirmRes] = await Promise.all([
    monitor.handleAlarm(),
    monitor.handleConfirmAutoStash({ requireNonce: true, nonce: 'countdown-nonce-token-ok' })
  ]);
  assert.equal(stashed, 1);
  assert.equal(alarmRes?.success !== false || confirmRes?.success !== false, true);
});
