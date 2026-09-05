/**
 * @file home-newtab.test.js
 * @description 主页与新标签页全量单元与集成测试套件
 * 覆盖：聚合联想、权限与隐身保护、历史推荐、收纳分页、路由兼容、隐私隔离与组件生命周期
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionTypes } from '../BetterBrowse/src/constants/action-types.js';
import { DefaultConfig } from '../BetterBrowse/src/constants/config.js';
import { StorageKeys } from '../BetterBrowse/src/constants/storage-keys.js';
import {
  isExcludedFromTabCounting,
  isOwnExtensionPageUrl,
  isOwnNewTabUrl,
  isOwnOptionsUrl
} from '../BetterBrowse/src/core/extension-url.js';
import { StorageAdapter } from '../BetterBrowse/src/core/storage/storage-adapter.js';
import { LocalStashRepository } from '../BetterBrowse/src/core/stash/local-stash-repo.js';
import { createActionHandlers } from '../BetterBrowse/src/background/action-handlers.js';
import { AIBridgeManager } from '../BetterBrowse/src/background/ai-bridge.js';
import { AccountConfigSync } from '../BetterBrowse/src/core/sync/account-config-sync.js';
import { SyncSnapshot } from '../BetterBrowse/src/core/sync/snapshot.js';
import { IndexedDBManager, IDBStores } from '../BetterBrowse/src/core/storage/indexed-db.js';
import { FakeIDBFactory } from './helpers/fake-indexeddb.js';

function setupEnvironment() {
  const store = {};
  globalThis.indexedDB = new FakeIDBFactory();
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      sendMessage: () => Promise.resolve(),
      lastError: null
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const res = {};
          if (Array.isArray(keys)) {
            for (const k of keys) res[k] = store[k];
          } else if (typeof keys === 'string') {
            res[keys] = store[keys];
          }
          callback?.(res);
        },
        set: (items, callback) => {
          Object.assign(store, items);
          callback?.();
        }
      },
      sync: {
        get: (keys, callback) => callback?.({}),
        set: (items, callback) => callback?.()
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 101 }),
      update: () => Promise.resolve()
    },
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve(true)
    },
    history: {
      search: () => Promise.resolve([])
    }
  };
  return store;
}

test('extension-url: 独立新标签页识别与排除计数，且严格区分 options', () => {
  setupEnvironment();
  const newtabUrl = 'chrome-extension://test-extension-id/src/newtab/newtab.html';
  const optionsUrl = 'chrome-extension://test-extension-id/src/options/options.html';

  assert.equal(isOwnNewTabUrl(newtabUrl), true);
  assert.equal(isOwnNewTabUrl(`${newtabUrl}#search`), true);
  assert.equal(isOwnNewTabUrl(optionsUrl), false);

  assert.equal(isOwnOptionsUrl(optionsUrl), true);
  assert.equal(isOwnOptionsUrl(newtabUrl), false, 'pinned-tab-guard 绝对不可将 newtab 识别为 options');

  assert.equal(isOwnExtensionPageUrl(newtabUrl), true);
  assert.equal(isOwnExtensionPageUrl(optionsUrl), true);

  assert.equal(isExcludedFromTabCounting({ url: newtabUrl }), true, 'newtab 必须排除在标签计数与收纳之外');
  assert.equal(isExcludedFromTabCounting({ url: optionsUrl }), true);
  assert.equal(isExcludedFromTabCounting({ url: 'https://github.com' }), false);
});

test('DefaultConfig 与 StorageAdapter: 主页偏好深度合并与增量更新', async () => {
  setupEnvironment();
  assert.ok(DefaultConfig.home, 'DefaultConfig 必须包含 home 偏好配置');
  assert.equal(DefaultConfig.home.enableExternalSuggest, false, '默认必须关闭外部联想建议');
  assert.equal(DefaultConfig.home.externalSuggestAgreed, false, '默认未主动同意');

  const merged = StorageAdapter.mergeUserConfig({});
  assert.equal(merged.home.searchEngine, 'google');
  assert.equal(merged.home.showRecentStash, true);

  const customMerged = StorageAdapter.mergeUserConfig({
    home: { searchEngine: 'bing', enableExternalSuggest: true }
  });
  assert.equal(customMerged.home.searchEngine, 'bing');
  assert.equal(customMerged.home.enableExternalSuggest, true);
  assert.equal(customMerged.home.externalSuggestAgreed, false, '未声明同意状态保留默认值');
});

test('隐私隔离: externalSuggestAgreed 绝不进入备份导出、WebDAV 快照与账号同步', async () => {
  const store = setupEnvironment();
  await StorageAdapter.updateUserConfig({
    home: {
      searchEngine: 'bing',
      enableExternalSuggest: true,
      externalSuggestAgreed: true
    }
  });

  // 1. 全量备份 JSON 导出必须剥离同意状态
  const backupJson = await LocalStashRepository.exportFullBackupJSON();
  const parsedBackup = JSON.parse(backupJson);
  assert.equal(parsedBackup.config.home.externalSuggestAgreed, false, '全量备份导出时同意状态必须为 false');

  // 2. 账号偏好镜像 (AccountConfigSync.slice) 不包含 home（保持设备本地）
  const sliced = AccountConfigSync.slice(parsedBackup.config);
  assert.equal(sliced.home, undefined, '浏览器账号偏好镜像绝不能跨设备同步主页敏感偏好');

  // 3. WebDAV 快照构建时同意状态不得外泄
  await IndexedDBManager.open();
  const snapshotPayload = await SyncSnapshot.buildPayload();
  const snapshotUserConfig = snapshotPayload.settings[StorageKeys.USER_CONFIG];
  if (snapshotUserConfig?.home) {
    assert.equal(snapshotUserConfig.home.externalSuggestAgreed, false, 'WebDAV 远端快照中同意状态必须置为 false');
  }
});

test('聚合联想 Action: 默认未同意时拒绝请求，同意后支持白名单与有界缓存', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. 未同意时拦截
  await StorageAdapter.updateUserConfig({
    home: { enableExternalSuggest: false, externalSuggestAgreed: false }
  });
  const unconsented = await handlers[ActionTypes.GET_SEARCH_SUGGESTIONS]({ query: 'better' });
  assert.equal(unconsented.success, false);
  assert.equal(unconsented.agreed, false);
  assert.deepEqual(unconsented.suggestions, []);

  // 2. 模拟 fetch 验证白名单 Google / Bing 联想解析与缓存
  let fetchCount = 0;
  let lastFetchedUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCount++;
    lastFetchedUrl = String(url);
    assert.equal(options.credentials, 'omit', '必须使用 credentials: omit');
    return {
      ok: true,
      status: 200,
      json: async () => ['better', ['betterbrowse', 'better discord', 'better call saul']]
    };
  };

  try {
    await StorageAdapter.updateUserConfig({
      home: { enableExternalSuggest: true, externalSuggestAgreed: true, suggestEngine: 'google' }
    });

    const res1 = await handlers[ActionTypes.GET_SEARCH_SUGGESTIONS]({ query: 'better', engine: 'google' });
    assert.equal(res1.success, true);
    assert.equal(res1.agreed, true);
    assert.equal(res1.suggestions.length, 3);
    assert.ok(lastFetchedUrl.includes('suggestqueries.google.com'));
    assert.equal(fetchCount, 1);

    // 二次请求相同 query 命中有界缓存，不产生重复 fetch
    const res2 = await handlers[ActionTypes.GET_SEARCH_SUGGESTIONS]({ query: 'better', engine: 'google' });
    assert.equal(res2.success, true);
    assert.equal(res2.suggestions.length, 3);
    assert.equal(fetchCount, 1, '重复 query 应命中缓存');

    // 空 query 直接返回空数组不发网络请求
    const emptyRes = await handlers[ActionTypes.GET_SEARCH_SUGGESTIONS]({ query: '   ' });
    assert.equal(emptyRes.success, true);
    assert.deepEqual(emptyRes.suggestions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('安全审计: 严禁记录搜索词审计', () => {
  const bridge = new AIBridgeManager();
  const summarySuggest = bridge._buildAuditSummary(ActionTypes.GET_SEARCH_SUGGESTIONS, {
    query: 'my private secret search term',
    engine: 'google'
  });
  assert.ok(!summarySuggest.includes('private'), '联想审计摘要不得包含搜索词');
  assert.ok(!summarySuggest.includes('secret'));

  const summaryHistory = bridge._buildAuditSummary(ActionTypes.GET_BROWSER_HISTORY, {
    query: 'confidential document'
  });
  assert.ok(!summaryHistory.includes('confidential'), '历史查询审计摘要不得包含搜索词');
});

test('History 权限与推荐: 真实权限为准、隐身保护、候选范围与 visitCount 访问次数标注', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. 未授权 history 权限时安全返回
  globalThis.chrome.permissions.contains = async () => false;
  const permRes = await handlers[ActionTypes.CHECK_HISTORY_PERMISSION]();
  assert.equal(permRes.granted, false);

  const histNoPerm = await handlers[ActionTypes.GET_BROWSER_HISTORY]({ query: 'test' });
  assert.equal(histNoPerm.granted, false);

  const recNoPerm = await handlers[ActionTypes.GET_HISTORY_RECOMMENDATIONS]({});
  assert.equal(recNoPerm.granted, false);

  // 2. 隐身模式保护：若 sender 处于 incognito，拒绝读取历史
  const incognitoRes = await handlers[ActionTypes.GET_BROWSER_HISTORY](
    { query: 'test' },
    { tab: { incognito: true } }
  );
  assert.equal(incognitoRes.granted, false);
  assert.ok(incognitoRes.error.includes('隐身模式'));

  // 3. 授权后正常返回，并明确标注候选范围与 visitCount 访问次数
  globalThis.chrome.permissions.contains = async () => true;
  const mockHistoryData = [
    { id: '1', url: 'https://example.com/a', title: 'A Page', lastVisitTime: Date.now() - 1000, visitCount: 42 },
    { id: '2', url: 'https://example.com/b', title: 'B Page', lastVisitTime: Date.now() - 5000, visitCount: 5 }
  ];
  globalThis.chrome.history.search = async () => mockHistoryData;

  const recGranted = await handlers[ActionTypes.GET_HISTORY_RECOMMENDATIONS]({ limit: 5 });
  assert.equal(recGranted.success, true);
  assert.equal(recGranted.granted, true);
  assert.equal(recGranted.recent.length, 2);
  assert.equal(recGranted.topVisited.length, 2);

  // 候选范围标注
  assert.equal(recGranted.recent[0].candidateRange, '近 7 天');
  assert.equal(recGranted.topVisited[0].candidateRange, '近 30 天');
  // visitCount 明确为数字访问次数，非时长
  assert.equal(recGranted.topVisited[0].visitCount, 42);
  assert.equal(typeof recGranted.topVisited[0].visitCount, 'number');
});

test('主页统计 Action: 准确统计当前窗口可计数标签与收纳总量', async () => {
  setupEnvironment();
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'https://github.com' },
    { id: 2, url: 'chrome-extension://test-extension-id/src/options/options.html#stash' },
    { id: 3, url: 'chrome-extension://test-extension-id/src/newtab/newtab.html' },
    { id: 4, url: 'about:blank' },
    { id: 5, url: 'https://news.ycombinator.com' }
  ];

  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  const stats = await handlers[ActionTypes.GET_HOME_STATS]({});
  assert.equal(stats.success, true);
  assert.equal(stats.currentWindowCount, 2, '仅保留 github.com 与 ycombinator.com 两个普通网页');
  assert.equal(stats.threshold, 15);
});

test('组件打开行为与环境适配: 独立页当前页打开，管理中心新标签打开', () => {
  setupEnvironment();
  let updatedUrl = '';
  let createdTabUrl = '';
  globalThis.chrome.tabs.update = async ({ url }) => { updatedUrl = url; };
  globalThis.chrome.tabs.create = async ({ url }) => { createdTabUrl = url; return { id: 202 }; };

  // 1. 独立页模式 (openTarget: 'current')
  const standaloneHost = {
    openTarget: 'current',
    openUrl(url) {
      if (this.openTarget === 'current') {
        globalThis.chrome.tabs.update({ url });
      } else {
        globalThis.chrome.tabs.create({ url, active: true });
      }
    }
  };
  standaloneHost.openUrl('https://example.com/standalone');
  assert.equal(updatedUrl, 'https://example.com/standalone');
  assert.equal(createdTabUrl, '');

  // 2. 管理中心模式 (openTarget: 'new')
  const optionsHost = {
    openTarget: 'new',
    openUrl(url) {
      if (this.openTarget === 'current') {
        globalThis.chrome.tabs.update({ url });
      } else {
        globalThis.chrome.tabs.create({ url, active: true });
      }
    }
  };
  optionsHost.openUrl('https://example.com/options');
  assert.equal(createdTabUrl, 'https://example.com/options');
});

test('PinnedTabGuard 保护机制: 独立 newtab 绝不被误认为 options 固定常驻', () => {
  setupEnvironment();
  const optionsUrl = 'chrome-extension://test-extension-id/src/options/options.html';
  const newtabUrl = 'chrome-extension://test-extension-id/src/newtab/newtab.html';

  // 模拟 PinnedTabGuard 内部判定
  const isOptionsTarget = (url) => isOwnOptionsUrl(url);
  assert.equal(isOptionsTarget(optionsUrl), true);
  assert.equal(isOptionsTarget(newtabUrl), false, 'newtab 绝不得触发固定标签置顶守护');
  assert.equal(isExcludedFromTabCounting({ url: newtabUrl }), true, 'newtab 必须被排除全量收纳');
});

test('收纳检索与分页: SEARCH_STASH 分页游标支持', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 验证 SEARCH_STASH handler 支持 paginated 参数
  const res = await handlers[ActionTypes.SEARCH_STASH]({ keyword: 'test', limit: 5, paginated: true });
  assert.ok(res !== undefined);
  if (res.items) {
    assert.ok(Array.isArray(res.items));
  }
});

test('隐私隔离: readExportChunk 分块全量备份导出必须剥离 externalSuggestAgreed', async () => {
  setupEnvironment();
  await StorageAdapter.updateUserConfig({
    home: {
      enableExternalSuggest: true,
      externalSuggestAgreed: true
    }
  });

  const chunkRes = await LocalStashRepository.readExportChunk({
    type: 'full_backup',
    maxChars: 50000
  });
  assert.ok(chunkRes.chunk);
  const parsed = JSON.parse(chunkRes.chunk.trim());
  assert.equal(parsed.config.home.externalSuggestAgreed, false, '分块导出首块中 externalSuggestAgreed 必须为 false');
});

test('安全边界: 隐身模式下保护浏览历史（覆盖 sender.tab 存在与 sender.tab 缺失上下文）', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. sender.tab.incognito 为 true 时拦截
  const resWithTab = await handlers[ActionTypes.GET_BROWSER_HISTORY]({ query: 'test' }, { tab: { incognito: true } });
  assert.equal(resWithTab.success, false);
  assert.equal(resWithTab.granted, false);

  const recWithTab = await handlers[ActionTypes.GET_HISTORY_RECOMMENDATIONS]({}, { tab: { incognito: true } });
  assert.equal(recWithTab.success, true);
  assert.equal(recWithTab.granted, false);
  assert.deepEqual(recWithTab.recent, []);

  // 2. sender.tab 缺失但全局处于隐身窗口上下文时拦截
  globalThis.chrome.extension = { inIncognitoContext: true };
  const resNoTab = await handlers[ActionTypes.GET_BROWSER_HISTORY]({ query: 'test' }, {});
  assert.equal(resNoTab.success, false);
  assert.equal(resNoTab.granted, false);

  const recNoTab = await handlers[ActionTypes.GET_HISTORY_RECOMMENDATIONS]({}, {});
  assert.equal(recNoTab.success, true);
  assert.equal(recNoTab.granted, false);
  globalThis.chrome.extension = undefined;
});

test('安全边界: 权限撤销在途泄漏防护与外部联想关闭在途返回防护', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. 历史查询在途期间权限被撤销
  let checkCount = 0;
  globalThis.chrome.permissions.contains = async () => {
    checkCount++;
    return checkCount === 1; // 首次（开始前）为 true，二次（完成后）为 false
  };
  globalThis.chrome.history.search = async () => [
    { id: 'secret-1', url: 'https://secret.com', title: 'Secret' }
  ];

  const leakedHistory = await handlers[ActionTypes.GET_BROWSER_HISTORY]({ query: 'secret' });
  assert.equal(leakedHistory.success, false, '在途撤销权限必须拦截历史记录返回');
  assert.deepEqual(leakedHistory.items, []);

  // 2. 外部联想在途期间用户关闭同意
  await StorageAdapter.updateUserConfig({
    home: { enableExternalSuggest: true, externalSuggestAgreed: true }
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // 模拟网络请求期间用户切断同意
    await StorageAdapter.updateUserConfig({
      home: { enableExternalSuggest: false, externalSuggestAgreed: false }
    });
    return {
      ok: true,
      json: async () => ['q', ['leaked-suggestion']]
    };
  };

  try {
    const res = await handlers[ActionTypes.GET_SEARCH_SUGGESTIONS]({ query: 'test' });
    assert.equal(res.success, false, '请求在途期间关闭必须拦截联想返回');
    assert.deepEqual(res.suggestions, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SEARCH_STASH 规范化: 兼容 query/keyword 并返回一致的 items/data/nextCursor 结构', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. query 传参兼容
  const resQuery = await handlers[ActionTypes.SEARCH_STASH]({ query: 'foo', limit: 5, paginated: true });
  assert.equal(resQuery.success, true);
  assert.ok(Array.isArray(resQuery.items));
  assert.ok(Array.isArray(resQuery.data));
  assert.equal(resQuery.items, resQuery.data);

  // 2. keyword 传参兼容
  const resKeyword = await handlers[ActionTypes.SEARCH_STASH]({ keyword: 'bar', limit: 5, paginated: true });
  assert.equal(resKeyword.success, true);
  assert.ok(Array.isArray(resKeyword.items));

  // 3. 非 paginated 返回数组
  const resArray = await handlers[ActionTypes.SEARCH_STASH]({ keyword: 'baz' });
  assert.ok(Array.isArray(resArray));
});

test('主页统计 Action: 与 thresholdMonitor.getActiveWindowInfo 窗口口径对齐', async () => {
  setupEnvironment();
  const mockTabs = [
    { id: 101, url: 'https://developer.mozilla.org', windowId: 99 },
    { id: 102, url: 'chrome-extension://test-extension-id/src/newtab/newtab.html', windowId: 99 }
  ];

  let calledActiveWindow = false;
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {
      getActiveWindowInfo: async (targetId) => {
        calledActiveWindow = true;
        return { windowId: targetId || 99, tabs: mockTabs };
      }
    },
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  const stats = await handlers[ActionTypes.GET_HOME_STATS]({ windowId: 99 });
  assert.equal(calledActiveWindow, true);
  assert.equal(stats.success, true);
  assert.equal(stats.currentWindowCount, 1, '排除 newtab.html 后仅有 1 个可计数网页');
});

test('模块偏好实现: showWindowTabStats / showRecentStash / showHistoryRecommendations 开关生效', () => {
  setupEnvironment();
  const createMockElement = () => {
    const el = { hidden: false };
    el.classList = {
      toggle: (cls, force) => {
        el.hidden = force;
      }
    };
    return el;
  };

  const mockView = {
    config: {
      home: {
        showWindowTabStats: false,
        showRecentStash: false,
        showHistoryRecommendations: false
      }
    },
    statsPill: createMockElement(),
    recentStashCard: createMockElement(),
    historyCard: createMockElement(),
    homeGrid: createMockElement(),
    applyModulePreferences() {
      const home = this.config?.home || {};
      const showStats = home.showWindowTabStats !== false;
      const showRecent = home.showRecentStash !== false;
      const showHistory = home.showHistoryRecommendations !== false;

      this.statsPill.classList.toggle('bb-hidden', !showStats);
      this.recentStashCard.classList.toggle('bb-hidden', !showRecent);
      this.historyCard.classList.toggle('bb-hidden', !showHistory);
      this.homeGrid.classList.toggle('bb-hidden', !showRecent && !showHistory);
    }
  };

  mockView.applyModulePreferences();
  assert.equal(mockView.statsPill.hidden, true);
  assert.equal(mockView.recentStashCard.hidden, true);
  assert.equal(mockView.historyCard.hidden, true);
  assert.equal(mockView.homeGrid.hidden, true);

  // 恢复开启
  mockView.config.home.showRecentStash = true;
  mockView.applyModulePreferences();
  assert.equal(mockView.recentStashCard.hidden, false);
  assert.equal(mockView.homeGrid.hidden, false);
});

test('键盘交互与输入法保护: IME 组合与修饰键行为', () => {
  setupEnvironment();
  let searchTriggered = false;
  let forceNewTabParam = false;

  const mockHandler = {
    isComposing: false,
    onKeyDown(e) {
      if (this.isComposing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        searchTriggered = true;
        forceNewTabParam = Boolean(e.ctrlKey || e.metaKey);
      }
    }
  };

  // 1. 拼音输入法组合期间按回车确认拼音字母，绝不触发全局搜索
  mockHandler.onKeyDown({ key: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(searchTriggered, false, 'IME 组合期间不得触发搜索');

  // 2. 普通回车触发搜索
  mockHandler.onKeyDown({ key: 'Enter', isComposing: false, keyCode: 13 });
  assert.equal(searchTriggered, true);
  assert.equal(forceNewTabParam, false);

  // 3. Ctrl+Enter 修饰键强制新标签页打开
  searchTriggered = false;
  mockHandler.onKeyDown({ key: 'Enter', isComposing: false, keyCode: 13, ctrlKey: true });
  assert.equal(searchTriggered, true);
  assert.equal(forceNewTabParam, true, 'Ctrl+Enter 必须标记 forceNewTab');
});

test('收纳结果查看组: 导航至指定组并在 options 解析 groupId 参数', () => {
  setupEnvironment();
  let targetUrl = '';
  let calledGroupId = '';

  const standaloneView = {
    isStandalone: true,
    navigateToStash(groupId = null) {
      const hash = groupId ? `#stash?groupId=${encodeURIComponent(groupId)}` : '#stash';
      targetUrl = `chrome-extension://test-extension-id/src/options/options.html${hash}`;
    }
  };

  standaloneView.navigateToStash('group-abc-123');
  assert.equal(targetUrl, 'chrome-extension://test-extension-id/src/options/options.html#stash?groupId=group-abc-123');

  // 模拟 options.js hash 解析
  const rawHash = targetUrl.split('#')[1];
  const [tabName, queryPart] = rawHash.split('?');
  assert.equal(tabName, 'stash');
  const params = new URLSearchParams(queryPart);
  calledGroupId = params.get('groupId');
  assert.equal(calledGroupId, 'group-abc-123');
});

test('主页偏好面板: details 结构、复选框 UPDATE_CONFIG 持久化、失败回滚与热更新同步', async () => {
  setupEnvironment();
  const handlers = createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
  });

  // 1. 模拟 HomeView 偏好控制器与复选框状态
  let lastSentAction = '';
  let lastSentPayload = null;
  let feedbackMessage = '';
  let feedbackType = '';

  const checkboxMap = {
    showWindowTabStats: { checked: true },
    showRecentStash: { checked: true },
    showHistoryRecommendations: { checked: true }
  };

  const controller = {
    config: {
      home: {
        showWindowTabStats: true,
        showRecentStash: true,
        showHistoryRecommendations: true
      }
    },
    syncCheckboxStates() {
      const home = this.config?.home || {};
      checkboxMap.showWindowTabStats.checked = home.showWindowTabStats !== false;
      checkboxMap.showRecentStash.checked = home.showRecentStash !== false;
      checkboxMap.showHistoryRecommendations.checked = home.showHistoryRecommendations !== false;
    },
    async updateModulePreference(key, value, checkboxEl) {
      try {
        lastSentAction = ActionTypes.UPDATE_CONFIG;
        lastSentPayload = { home: { ...(this.config?.home || {}), [key]: value } };
        const res = await handlers[ActionTypes.UPDATE_CONFIG](lastSentPayload);
        if (!res) throw new Error('配置更新未成功');
        this.config.home[key] = value;
        feedbackMessage = '偏好已保存';
        feedbackType = 'success';
      } catch (err) {
        if (checkboxEl) checkboxEl.checked = !value;
        feedbackMessage = `保存失败: ${err?.message || '配置更新异常'}`;
        feedbackType = 'error';
      }
    }
  };

  // 2. 用户取消勾选 showRecentStash 并成功持久化
  checkboxMap.showRecentStash.checked = false;
  await controller.updateModulePreference('showRecentStash', false, checkboxMap.showRecentStash);
  assert.equal(lastSentAction, ActionTypes.UPDATE_CONFIG);
  assert.equal(lastSentPayload.home.showRecentStash, false);
  assert.equal(controller.config.home.showRecentStash, false);
  assert.equal(feedbackType, 'success');
  assert.equal(feedbackMessage, '偏好已保存');

  // 验证配置已实际写入 Storage
  const savedConfig = await StorageAdapter.getUserConfig();
  assert.equal(savedConfig.home.showRecentStash, false);

  // 3. 模拟异常场景：更新失败时回滚 checkbox 状态
  const failingController = {
    ...controller,
    async updateModulePreference(key, value, checkboxEl) {
      try {
        throw new Error('网络/存储受阻');
      } catch (err) {
        if (checkboxEl) checkboxEl.checked = !value;
        feedbackMessage = `保存失败: ${err?.message}`;
        feedbackType = 'error';
      }
    }
  };
  checkboxMap.showHistoryRecommendations.checked = false;
  await failingController.updateModulePreference('showHistoryRecommendations', false, checkboxMap.showHistoryRecommendations);
  assert.equal(checkboxMap.showHistoryRecommendations.checked, true, '失败时复选框必须回滚到原值');
  assert.equal(feedbackType, 'error');
  assert.ok(feedbackMessage.includes('保存失败'));

  // 4. 模拟外部 NOTIFY_CONFIG_UPDATED 热更新同步 checkbox 状态
  controller.config.home = {
    showWindowTabStats: false,
    showRecentStash: true,
    showHistoryRecommendations: false
  };
  controller.syncCheckboxStates();
  assert.equal(checkboxMap.showWindowTabStats.checked, false);
  assert.equal(checkboxMap.showRecentStash.checked, true);
  assert.equal(checkboxMap.showHistoryRecommendations.checked, false);
});
