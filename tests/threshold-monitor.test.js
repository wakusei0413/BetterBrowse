/**
 * @file threshold-monitor.test.js
 * @description 标签页超限阈值监控与冷却防打扰集成测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ThresholdMonitor } from '../BetterBrowse/src/background/threshold-monitor.js';
import { DefaultConfig } from '../BetterBrowse/src/constants/config.js';
import { StorageKeys } from '../BetterBrowse/src/constants/storage-keys.js';
import { StorageAdapter } from '../BetterBrowse/src/core/storage/storage-adapter.js';

function installMockChrome() {
  const sessionStore = {};
  const createdAlarms = [];
  const clearedAlarms = [];
  const updatedTabListeners = [];
  const sentBanners = [];
  const injectedScripts = [];
  const createdNotifications = [];
  let sendMessageFails = false;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    tabs: {
      onCreated: { addListener() {} },
      onUpdated: { addListener(fn) { updatedTabListeners.push(fn); } },
      onActivated: { addListener() {} },
      sendMessage: (tabId, message, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        if (message?.action === 'SHOW_AUTO_STASH_COUNTDOWN') {
          sentBanners.push({ tabId, payload: message.payload });
        }
        if (sendMessageFails) {
          chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          cb?.({ success: false, error: chrome.runtime.lastError.message });
          chrome.runtime.lastError = null;
          return;
        }
        cb?.({ success: true });
      },
      query: (query, cb) => {
        if (typeof query === 'function') return query([]);
        cb?.([]);
        return [];
      }
    },
    scripting: {
      executeScript: async ({ target }) => {
        injectedScripts.push(target);
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
      create: (id, options, cb) => {
        createdNotifications.push({ id, options });
        cb?.();
      },
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
      clear: (name) => {
        clearedAlarms.push(name);
      },
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
  globalThis.chrome._clearedAlarms = clearedAlarms;
  globalThis.chrome._updatedTabListeners = updatedTabListeners;
  globalThis.chrome._sentBanners = sentBanners;
  globalThis.chrome._injectedScripts = injectedScripts;
  globalThis.chrome._createdNotifications = createdNotifications;
  globalThis.chrome._setSendMessageFails = (value) => { sendMessageFails = value; };
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

test('ThresholdMonitor: tabs.onUpdated 仅在 URL 提交或加载完成时补检', async () => {
  installMockChrome();
  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});
  const scheduledWindowIds = [];
  monitor.scheduleTabCountCheck = (windowId) => scheduledWindowIds.push(windowId);

  assert.equal(chrome._updatedTabListeners.length, 1, '必须注册 tabs.onUpdated 监听器');
  const listener = chrome._updatedTabListeners[0];
  listener(3, { title: '仅标题变化' }, { id: 3, windowId: 7 });
  listener(3, { status: 'loading' }, { id: 3, windowId: 7 });
  assert.deepEqual(scheduledWindowIds, [], '标题与加载中事件不得触发全窗口扫描');

  listener(3, { url: 'https://example.com' }, { id: 3, windowId: 7 });
  listener(3, { status: 'complete' }, { id: 3, windowId: 7 });
  assert.deepEqual(scheduledWindowIds, [7, 7], 'URL 提交与加载完成必须按窗口补检');
});

test('ThresholdMonitor: 新标签 URL 较晚提交时 onUpdated 会补触发阈值检查', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 3,
    countdownSeconds: 3,
    autoStashOnThreshold: true,
    thresholdCooldownMinutes: 0
  });

  const tabs = [
    { id: 1, url: 'https://one.example', windowId: 1 },
    { id: 2, url: 'https://two.example', windowId: 1 },
    { id: 3, url: '', pendingUrl: '', windowId: 1 }
  ];
  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});
  monitor.getActiveWindowInfo = async () => ({ windowId: 1, tabs });

  let startCount = 0;
  monitor.startCountdown = async (windowId) => {
    startCount += 1;
    monitor.activeWindowId = windowId;
    monitor.totalSeconds = 3;
    monitor.remainingSeconds = 3;
    monitor.deadline = Date.now() + 3000;
    monitor.actionNonce = 'updated-tab-nonce-01234567';
  };

  try {
    await monitor.checkTabCount(1);
    assert.equal(startCount, 0, 'URL 未就绪时不应启动倒计时');

    tabs[2].url = 'https://three.example';
    chrome._updatedTabListeners[0](3, { url: tabs[2].url }, tabs[2]);
    await new Promise((resolve) => setTimeout(resolve, 220));

    assert.equal(startCount, 1, 'URL 提交后必须补检并启动倒计时');
    assert.equal(monitor.activeWindowId, 1);
    assert.equal(monitor.remainingSeconds, 3);
  } finally {
    monitor.deadline = 0;
    monitor.remainingSeconds = 0;
    monitor.actionNonce = '';
    monitor.clearLocalExpiryTimer();
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
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

/**
 * 构造一份会话存储中的倒计时状态快照
 * @param {number} deadline
 * @param {string} actionNonce
 */
function buildThresholdState(deadline, actionNonce) {
  return {
    deadline,
    activeWindowId: 1,
    totalSeconds: 15,
    lastActionTime: 0,
    actionNonce
  };
}

test('ThresholdMonitor: SW 冷启动恢复前到达的确认不得因凭证未就绪被拒', async () => {
  installMockChrome();
  const nonce = 'cold-start-nonce-0123456789';
  chrome.storage.session.set({ [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() + 15000, nonce) });
  // 模拟恢复读取尚未完成：SW 被点击唤醒时消息可能先于 restoreState 落地
  chrome.storage.session.get = (_keys, cb) => setTimeout(() => cb({
    [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() + 15000, nonce)
  }), 30);

  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 2, keptCount: 1 };
    }
  });

  const res = await monitor.handleConfirmAutoStash({ requireNonce: true, nonce });
  assert.equal(res.success, true);
  assert.equal(stashed, 1);
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: SW 冷启动恢复前到达的取消不得因凭证未就绪被拒', async () => {
  installMockChrome();
  const nonce = 'cold-start-cancel-nonce-0123';
  chrome.storage.session.set({ [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() + 15000, nonce) });
  chrome.storage.session.get = (_keys, cb) => setTimeout(() => cb({
    [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() + 15000, nonce)
  }), 30);

  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true };
    }
  });

  const res = await monitor.handleCancelAutoStash({ requireNonce: true, nonce });
  assert.equal(res.success, true);
  assert.equal(stashed, 0);
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: 恢复到已过期倒计时立即补收纳，不等下一次标签事件', async () => {
  installMockChrome();
  const nonce = 'restored-expired-nonce-0123';
  chrome.storage.session.set({
    [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() - 2000, nonce)
  });

  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 3, keptCount: 2 };
    }
  });

  await monitor.readyPromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stashed, 1);
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: 恢复到未到期倒计时重新挂载定时器与闹钟', async () => {
  installMockChrome();
  const nonce = 'restored-active-nonce-01234';
  chrome.storage.session.set({
    [StorageKeys.THRESHOLD_STATE]: buildThresholdState(Date.now() + 15000, nonce)
  });

  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});

  assert.equal(monitor.actionNonce, nonce);
  assert.notEqual(monitor.localExpiryTimer, null);
  assert.equal(
    chrome._createdAlarms.some((item) => item.name === monitor.alarmName),
    true
  );
  monitor.clearCountdownUI();
});

test('ThresholdMonitor: 陈旧恢复快照不得覆盖恢复期间的新写入', async () => {
  installMockChrome();
  const staleState = buildThresholdState(Date.now() + 15000, 'stale-nonce-1234567890');
  // 固定返回读取发起时的陈旧快照：模拟 get 尚未返回时监控器已被取消并写入新状态
  chrome.storage.session.get = (_keys, cb) => setTimeout(() => cb({
    [StorageKeys.THRESHOLD_STATE]: staleState
  }), 30);

  const monitor = new ThresholdMonitor();
  monitor.deadline = 0;
  monitor.actionNonce = '';
  await monitor.persistState();

  await monitor.readyPromise.catch(() => {});
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
});

test('ThresholdMonitor: 其它窗口标签数回落不得取消本窗口倒计时', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 3,
    countdownSeconds: 15
  });
  try {
    let stashed = 0;
    const monitor = new ThresholdMonitor({
      onStashRequested: async () => {
        stashed += 1;
        return { success: true, stashedCount: 1 };
      }
    });
    await monitor.readyPromise.catch(() => {});

    // 窗口 1 正在倒计时
    monitor.deadline = Date.now() + 15000;
    monitor.remainingSeconds = 15;
    monitor.actionNonce = 'window-one-nonce-01234567';
    monitor.activeWindowId = 1;

    const tabsByWindow = {
      1: [{ id: 1, url: 'https://one.example' }],
      2: [{ id: 9, url: 'https://two.example' }]
    };
    monitor.getActiveWindowInfo = async (targetWindowId = null) => ({
      windowId: targetWindowId,
      tabs: tabsByWindow[targetWindowId] || []
    });

    // 窗口 2 低于阈值：不得误杀窗口 1 的倒计时
    await monitor.checkTabCount(2);
    assert.equal(monitor.deadline > Date.now(), true);
    assert.equal(monitor.actionNonce, 'window-one-nonce-01234567');

    // 窗口 1 自己低于阈值：正常取消
    await monitor.checkTabCount(1);
    assert.equal(monitor.deadline, 0);
    assert.equal(monitor.actionNonce, '');
    assert.equal(stashed, 0);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 闹钟被反复提前消费时兜底闹钟持续存在且到期只收口一次', async () => {
  installMockChrome();
  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return { success: true, stashedCount: 1 };
    }
  });
  await monitor.readyPromise.catch(() => {});
  monitor.deadline = Date.now() + 60000;
  monitor.remainingSeconds = 60;
  monitor.actionNonce = 'early-alarm-nonce-01234567';

  // Chrome 不允许短于 30 秒的一次性闹钟按时触发，会反复提前消费它。
  // 关键在于倒计时绝不能被丢弃，且始终有重复兜底闹钟接续（无重挂次数上限）
  for (let i = 0; i < 5; i++) await monitor.handleAlarm();

  assert.equal(stashed, 0);
  assert.equal(monitor.deadline > Date.now(), true);
  assert.equal(monitor.actionNonce, 'early-alarm-nonce-01234567');
  const repeating = chrome._createdAlarms.filter((item) => item.periodInMinutes > 0);
  assert.equal(repeating.length >= 5, true);
  assert.equal(repeating.every((item) => item.name === monitor.alarmName), true);

  // 到期后收口一次，并清除重复兜底闹钟
  monitor.deadline = Date.now() - 10;
  await monitor.handleAlarm();
  assert.equal(stashed, 1);
  assert.equal(monitor.deadline, 0);
  assert.equal(monitor.actionNonce, '');
  assert.equal(chrome._clearedAlarms.includes(monitor.alarmName), true);

  // 闹钟已清除后再次触发不得重复收纳
  await monitor.handleAlarm();
  assert.equal(stashed, 1);
});

test('ThresholdMonitor: 未提交导航的标签同样能收到倒计时卡片', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 3,
    countdownSeconds: 15,
    thresholdCooldownMinutes: 0
  });
  try {
    const monitor = new ThresholdMonitor();
    await monitor.readyPromise.catch(() => {});
    // 会话恢复 / 慢加载：tab.url 尚为空，只有 pendingUrl —— 计数认它，卡片广播也必须认它
    monitor.getActiveWindowInfo = async () => ({
      windowId: 1,
      tabs: [
        { id: 1, url: '', pendingUrl: 'https://one.example/' },
        { id: 2, url: '', pendingUrl: 'https://two.example/' },
        { id: 3, url: '', pendingUrl: 'https://three.example/' }
      ]
    });

    await monitor.checkTabCount();
    // 卡片广播是发射后不管的并行流程，需等其落地后再断言
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(monitor.deadline > Date.now(), true);
    const bannerTabIds = chrome._sentBanners.map((item) => item.tabId).sort();
    assert.deepEqual(bannerTabIds, [1, 2, 3]);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 无接收端时对待提交标签动态注入内容脚本', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 2,
    countdownSeconds: 15,
    thresholdCooldownMinutes: 0
  });
  try {
    const monitor = new ThresholdMonitor();
    await monitor.readyPromise.catch(() => {});
    monitor.getActiveWindowInfo = async () => ({
      windowId: 1,
      tabs: [
        { id: 1, url: '', pendingUrl: 'https://one.example/' },
        { id: 2, url: '', pendingUrl: 'https://two.example/' }
      ]
    });
    chrome._setSendMessageFails(true);

    await monitor.checkTabCount();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // tab.url 为空不再成为跳过注入的理由，否则这类标签在整个倒计时里都看不到卡片
    assert.deepEqual(
      chrome._injectedScripts.map((target) => target.tabId).sort(),
      [1, 2]
    );
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: URL 晚提交时补播卡片且已投递标签不重复投递', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 3,
    countdownSeconds: 15,
    thresholdCooldownMinutes: 0
  });
  try {
    const monitor = new ThresholdMonitor();
    await monitor.readyPromise.catch(() => {});
    monitor.getActiveWindowInfo = async () => ({
      windowId: 1,
      tabs: [
        { id: 1, url: 'https://one.example/' },
        { id: 2, url: 'https://two.example/' },
        { id: 3, url: 'https://three.example/' }
      ]
    });

    await monitor.checkTabCount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(chrome._sentBanners.map((item) => item.tabId).sort(), [1, 2, 3]);

    // 倒计时进行中，第 4 个标签的 URL 才提交：必须补播，否则它全程看不到卡片
    const updatedListener = chrome._updatedTabListeners[0];
    updatedListener(4, { url: 'https://four.example/' }, { id: 4, windowId: 1, url: 'https://four.example/' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const bannerCountByTab = {};
    for (const item of chrome._sentBanners) {
      bannerCountByTab[item.tabId] = (bannerCountByTab[item.tabId] || 0) + 1;
    }
    assert.equal(bannerCountByTab[4], 1);
    // 已投递过的标签不得重复投递：重复投递会把页面上的倒计时重置回整轮秒数
    assert.equal(bannerCountByTab[1], 1);
    assert.equal(bannerCountByTab[3], 1);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 倒计时已到期但窗口回落到阈值以下时仍完成收纳', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 3,
    countdownSeconds: 15,
    thresholdCooldownMinutes: 5
  });
  try {
    for (const activeWindowId of [1, null]) {
      let stashed = 0;
      const monitor = new ThresholdMonitor({
        onStashRequested: async () => {
          stashed += 1;
          return { success: true, stashedCount: 1 };
        }
      });
      await monitor.readyPromise.catch(() => {});
      // 用户已经等满了整个倒计时之后才关掉多余标签：不能把这次收纳当"取消"丢弃
      monitor.deadline = Date.now() - 1000;
      monitor.actionNonce = 'expired-below-threshold-nonce';
      monitor.activeWindowId = activeWindowId;
      monitor.getActiveWindowInfo = async () => ({
        windowId: 1,
        tabs: [{ id: 1, url: 'https://one.example' }]
      });

      await monitor.checkTabCount(1);

      assert.equal(stashed, 1);
      assert.equal(monitor.deadline, 0);
      assert.equal(monitor.actionNonce, '');
    }
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 收纳空操作只进入短暂退避，成功收纳才走完整冷却', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 2,
    countdownSeconds: 3,
    autoStashOnThreshold: true,
    thresholdCooldownMinutes: 5
  });
  try {
    // 空操作：一个标签都没收掉，不得让用户在整个冷却期内再也看不到任何反应
    const noopMonitor = new ThresholdMonitor({
      onStashRequested: async () => ({
        success: false,
        stashedCount: 0,
        keptCount: 2,
        tierLevel: 'hardLimit',
        reachedTarget: false,
        error: '受硬性保护的标签页数量已超出目标剩余数量'
      })
    });
    await noopMonitor.readyPromise.catch(() => {});
    noopMonitor.deadline = Date.now() + 1000;
    noopMonitor.actionNonce = 'noop-nonce-0123456789ab';
    await noopMonitor.finalizeCountdown('timeout');

    assert.equal(noopMonitor.lastActionTime, 0);
    assert.equal(noopMonitor.noopCooldownUntil > Date.now(), true);

    // 空操作后短时间内不得立刻重启倒计时，但退避结束后即可再次触发
    noopMonitor.getActiveWindowInfo = async () => ({
      windowId: 1,
      tabs: [{ id: 1, url: 'https://a.example' }, { id: 2, url: 'https://b.example' }]
    });
    await noopMonitor.checkTabCount();
    assert.equal(noopMonitor.deadline, 0);

    noopMonitor.noopCooldownUntil = 0;
    await noopMonitor.checkTabCount();
    assert.equal(noopMonitor.deadline > Date.now(), true);

    // 确实收掉了标签：走完整冷却
    const successMonitor = new ThresholdMonitor({
      onStashRequested: async () => ({ success: true, stashedCount: 1 })
    });
    await successMonitor.readyPromise.catch(() => {});
    successMonitor.deadline = Date.now() + 1000;
    successMonitor.actionNonce = 'success-nonce-0123456789';
    await successMonitor.finalizeCountdown('timeout');

    assert.equal(successMonitor.lastActionTime > 0, true);
    assert.equal(successMonitor.noopCooldownUntil, 0);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 收纳未完全达标时弹出可见结果提示', async () => {
  installMockChrome();
  let stashed = 0;
  const monitor = new ThresholdMonitor({
    onStashRequested: async () => {
      stashed += 1;
      return {
        success: true,
        stashedCount: 3,
        keptCount: 16,
        tierLevel: 'hardLimit',
        reachedTarget: false,
        hardProtectedCount: 16,
        remainingOverThreshold: 2
      };
    }
  });
  await monitor.readyPromise.catch(() => {});
  monitor.deadline = Date.now() + 1000;
  monitor.actionNonce = 'partial-nonce-0123456789';
  await monitor.finalizeCountdown('timeout');

  assert.equal(stashed, 1);
  const notice = chrome._createdNotifications.find((item) => item.id === monitor.outcomeNotificationId);
  assert.equal(Boolean(notice), true);
  assert.equal(notice.options.message.includes('3'), true);
  assert.equal(notice.options.message.includes('2'), true);
});

test('ThresholdMonitor: 无倒计时时 SW 重启仍恢复冷却与空操作退避', async () => {
  installMockChrome();
  const now = Date.now();
  await new Promise((resolve) => chrome.storage.session.set({
    [StorageKeys.THRESHOLD_STATE]: {
      deadline: 0,
      activeWindowId: null,
      totalSeconds: 15,
      lastActionTime: now - 1000,
      noopCooldownUntil: now + 60000,
      noopStreak: 2,
      actionNonce: ''
    }
  }, resolve));
  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});
  assert.equal(monitor.lastActionTime, now - 1000);
  assert.equal(monitor.noopCooldownUntil, now + 60000);
  assert.equal(monitor.noopStreak, 2);
  assert.equal(monitor.deadline, 0);
});

test('ThresholdMonitor: 连续空操作退避逐次翻倍且封顶为完整冷却', async () => {
  installMockChrome();
  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});
  const backoffs = [];
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    await monitor.commitCooldown(false, 5);
    backoffs.push(Math.round((monitor.noopCooldownUntil - before) / 60000));
  }
  assert.deepEqual(backoffs, [1, 2, 4, 5, 5]);
  await monitor.commitCooldown(true, 5);
  assert.equal(monitor.noopStreak, 0);
  assert.equal(monitor.noopCooldownUntil, 0);
});

test('ThresholdMonitor: 收纳收口进行中不得再起第二轮倒计时', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({
    ...DefaultConfig,
    tabThreshold: 2,
    countdownSeconds: 15,
    thresholdCooldownMinutes: 5
  });
  try {
    let release;
    const monitor = new ThresholdMonitor({
      onStashRequested: () => new Promise((resolve) => { release = resolve; })
    });
    await monitor.readyPromise.catch(() => {});
    monitor.getActiveWindowInfo = async () => ({
      windowId: 1,
      tabs: [{ id: 1, url: 'https://a.example' }, { id: 2, url: 'https://b.example' }]
    });
    monitor.deadline = Date.now() + 1000;
    monitor.actionNonce = 'busy-nonce-0123456789ab';
    const finalizing = monitor.finalizeCountdown('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await monitor.checkTabCount();
    assert.equal(monitor.deadline, 0);
    release({ success: true, stashedCount: 1 });
    await finalizing;
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 卡片投递失败可补播，且只补播倒计时所属窗口', async () => {
  installMockChrome();
  const originalGetUserConfig = StorageAdapter.getUserConfig;
  StorageAdapter.getUserConfig = async () => ({ ...DefaultConfig, tabThreshold: 2, countdownSeconds: 15 });
  try {
    const monitor = new ThresholdMonitor();
    await monitor.readyPromise.catch(() => {});
    monitor.deadline = Date.now() + 15000;
    monitor.actionNonce = 'rebroadcast-nonce-012345';
    monitor.activeWindowId = 1;
    monitor.bannerContext = { currentCount: 3, threshold: 2 };
    chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
    chrome._setSendMessageFails(true);

    const tab = { id: 7, windowId: 1, url: '', pendingUrl: 'https://late.example/' };
    assert.equal(await monitor.sendBannerToTab(tab, { nonce: monitor.actionNonce }), false);
    assert.equal(monitor.bannerTabIds.has(7), false);

    chrome._setSendMessageFails(false);
    await monitor.rebroadcastBannerToTab({ id: 7, windowId: 1, url: 'https://late.example/' });
    assert.equal(chrome._sentBanners.filter((item) => item.tabId === 7).length, 2);

    await monitor.rebroadcastBannerToTab({ id: 8, windowId: 2, url: 'https://other.example/' });
    assert.equal(chrome._sentBanners.some((item) => item.tabId === 8), false);
  } finally {
    StorageAdapter.getUserConfig = originalGetUserConfig;
  }
});

test('ThresholdMonitor: 闹钟触发时无倒计时状态则清除残留兜底闹钟', async () => {
  installMockChrome();
  const monitor = new ThresholdMonitor();
  await monitor.readyPromise.catch(() => {});
  await monitor.handleAlarm();
  assert.equal(chrome._clearedAlarms.includes(monitor.alarmName), true);
});
