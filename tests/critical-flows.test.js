/**
 * @file critical-flows.test.js
 * @description 核心业务关键路径与导入容错集成测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStashRepository } from '../BetterBrowse/src/core/stash/local-stash-repo.js';
import { StashService } from '../BetterBrowse/src/core/stash/stash-service.js';
import { MessageBus } from '../BetterBrowse/src/core/bus/message-bus.js';
import { OneTabConverter } from '../BetterBrowse/src/core/stash/onetab-converter.js';
import { ContextMenuManager } from '../BetterBrowse/src/background/context-menu-manager.js';
import { RuleEngine } from '../BetterBrowse/src/core/rules/rule-engine.js';
import { DefaultConfig } from '../BetterBrowse/src/constants/config.js';
import { LinkInterceptor } from '../BetterBrowse/src/content/link-interceptor.js';

function installChrome(overrides = {}) {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener() {} }
    },
    tabs: {
      query: async () => [],
      create: async () => ({}),
      remove: async () => {},
      update: async () => ({}),
      move: async () => ({})
    },
    storage: {
      local: {
        get: (_keys, callback) => callback({}),
        set: (_values, callback) => callback?.()
      }
    },
    ...overrides
  };
}

test('收纳持久化失败时不得关闭原标签页', async () => {
  let removed = false;
  installChrome({
    tabs: {
      query: async () => [{ id: 11, windowId: 1, url: 'https://example.com', title: '示例' }],
      remove: async () => { removed = true; },
      update: async () => ({}),
      move: async () => ({})
    }
  });

  const origCreateGroup = LocalStashRepository.createGroup;
  const origEnsure = StashService.ensurePinnedStashTab;

  try {
    LocalStashRepository.createGroup = async () => ({ success: false, error: '存储失败' });
    StashService.ensurePinnedStashTab = async () => ({});

    const result = await new StashService().executeAllTabsStash(1);
    assert.equal(result.success, false);
    assert.equal(removed, false);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
    StashService.ensurePinnedStashTab = origEnsure;
  }
});

test('智能收纳持久化失败时不得关闭原标签页', async () => {
  let removed = false;
  // 模拟达到标签阈值（默认 15）的场景，确保进入智能收纳流程
  const manyTabs = Array.from({ length: 15 }, (_, i) => ({
    id: 100 + i,
    windowId: 1,
    url: `https://idle${i}.example`,
    active: false
  }));
  installChrome({
    tabs: {
      query: async () => manyTabs,
      remove: async () => { removed = true; },
      update: async () => ({}),
      move: async () => ({})
    }
  });

  const origCreateGroup = LocalStashRepository.createGroup;
  const origEnsure = StashService.ensurePinnedStashTab;

  try {
    LocalStashRepository.createGroup = async () => ({ success: false, error: '存储失败' });
    StashService.ensurePinnedStashTab = async () => ({});

    const service = new StashService({
      evaluateTabs: async () => ({
        tabsToKeep: [],
        tabsToStash: [{ tab: { id: 12, url: 'https://idle.example', active: false } }]
      })
    });
    const result = await service.executeSmartStash({}, 1);
    assert.equal(result.success, false);
    assert.equal(removed, false);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
    StashService.ensurePinnedStashTab = origEnsure;
  }
});

test('右键定向收纳持久化失败时不得关闭原标签页', async () => {
  let removed = false;
  installChrome({
    tabs: {
      query: async () => [{ id: 13, index: 2, windowId: 1, url: 'https://right.example', active: false }],
      remove: async () => { removed = true; }
    }
  });

  const origCreateGroup = LocalStashRepository.createGroup;
  try {
    LocalStashRepository.createGroup = async () => ({ success: false, error: '存储失败' });
    await ContextMenuManager.stashTabsDirectional(1, 0, 'right');
    assert.equal(removed, false);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
  }
});

test('全部标签恢复失败时保留原收纳组', async () => {
  let deleted = false;
  installChrome({
    tabs: {
      create: async () => { throw new Error('创建失败'); }
    }
  });

  const origGetAll = LocalStashRepository.getAllGroups;
  const origDelete = LocalStashRepository.deleteGroup;

  try {
    LocalStashRepository.getAllGroups = async () => [{
      id: 'group-1',
      locked: false,
      tabs: [{ id: 'item-1', url: 'https://example.com', title: '示例' }]
    }];
    LocalStashRepository.deleteGroup = async () => { deleted = true; return true; };

    const result = await StashService.restoreGroup('group-1');
    assert.equal(result, false);
    assert.equal(deleted, false);
  } finally {
    LocalStashRepository.getAllGroups = origGetAll;
    LocalStashRepository.deleteGroup = origDelete;
  }
});

test('消息总线正常响应与派发', async () => {
  let listener;
  installChrome({
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(fn) { listener = fn; } }
    }
  });

  MessageBus.registerListener({
    PING: async (payload) => `pong:${payload}`
  });

  const response = await new Promise((resolve) => {
    // 扩展自身页面来源：sender.url 指向扩展页面，无 sender.tab
    const internalSender = { url: 'chrome-extension://test/src/options/options.html' };
    listener({ action: 'PING', payload: 'test' }, internalSender, resolve);
  });
  assert.deepEqual(response, { success: true, data: 'pong:test' });
});

test('消息总线对未注册动作返回失败而不是伪成功', async () => {
  installChrome({
    runtime: {
      lastError: null,
      sendMessage: (_message, callback) => callback(undefined)
    }
  });
  const response = await MessageBus.sendToBackground('UNKNOWN_ACTION');
  assert.equal(response.success, false);
});

test('空壳 JSON 不得被当作成功导入', async () => {
  installChrome();
  const result = await LocalStashRepository.importDataJSON('{"data":[{}]}');
  assert.equal(result.success, false);
  assert.equal(result.importedCount, 0);
});

test('OneTab 文本导出与解析往返一致性', () => {
  const groups = [{ tabs: [{ url: 'https://example.com', title: '示例标题' }] }];
  const text = OneTabConverter.exportToOneTabText(groups);
  const parsed = OneTabConverter.parseOneTabText(text);
  assert.equal(parsed[0].tabs[0].url, 'https://example.com');
  assert.equal(parsed[0].tabs[0].title, '示例标题');
});

test('导入包含无协议域名与特殊浏览器协议的标签页正常解析与补齐', () => {
  const text = [
    'github.com/someone/repo | GitHub Repo',
    'www.bilibili.com | 哔哩哔哩',
    'chrome://extensions/ | 扩展程序',
    'file:///C:/doc.pdf | 本地文档'
  ].join('\n');

  const parsed = OneTabConverter.parseOneTabText(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].tabs.length, 4);
  assert.equal(parsed[0].tabs[0].url, 'https://github.com/someone/repo');
  assert.equal(parsed[0].tabs[1].url, 'https://www.bilibili.com');
  assert.equal(parsed[0].tabs[2].url, 'chrome://extensions/');
  assert.equal(parsed[0].tabs[3].url, 'file:///C:/doc.pdf');
});

test('导入包含个别损坏项的列表能够容错跳过并成功导入其余标签', async () => {
  const text = [
    'https://a.com | A',
    'javascript:alert(1) | 有害伪协议',
    'https://b.com | B',
    '   | 空链接',
    'zhihu.com | 知乎'
  ].join('\n');

  installChrome();
  const result = await LocalStashRepository.importDataJSON(text);
  assert.equal(result.success, true);
  assert.equal(result.importedCount, 3);
});

test('普通网页伪装扩展选项页路径时不得被系统保护规则放行', async () => {
  installChrome({
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`
    }
  });
  const result = await new RuleEngine().evaluateTabs({
    allTabs: [{ id: 99, url: 'https://evil.example/src/options/options.html', active: false }],
    activityStats: {},
    config: DefaultConfig
  });
  assert.equal(result.tabsToStash.length, 1);
});

test('右键整组收纳 Chrome 原生标签分组（保留组名和颜色）', async () => {
  let createdGroup = null;
  let closedTabIds = [];

  installChrome({
    tabs: {
      query: async ({ groupId, windowId }) => {
        if (groupId === 10) {
          return [
            { id: 101, windowId: 1, groupId: 10, url: 'https://site1.com', title: 'Site 1', pinned: false },
            { id: 102, windowId: 1, groupId: 10, url: 'https://site2.com', title: 'Site 2', pinned: false }
          ];
        }
        return [];
      },
      remove: async (ids) => {
        closedTabIds.push(...ids);
      }
    },
    tabGroups: {
      get: async (groupId) => {
        if (groupId === 10) {
          return { id: 10, title: '工作项目', color: 'blue', collapsed: false };
        }
        return null;
      }
    }
  });

  const origCreateGroup = LocalStashRepository.createGroup;
  const origEnsure = StashService.ensurePinnedStashTab;

  try {
    LocalStashRepository.createGroup = async (items, title, options) => {
      createdGroup = {
        title,
        color: options?.color,
        tabs: items
      };
      return {
        success: true,
        group: { id: 'grp_test', ...createdGroup }
      };
    };
    StashService.ensurePinnedStashTab = async () => ({});

    await ContextMenuManager.stashCurrentTabGroup({ id: 101, windowId: 1, groupId: 10 });

    assert.ok(createdGroup);
    assert.equal(createdGroup.title, '工作项目');
    assert.equal(createdGroup.color, 'blue');
    assert.equal(createdGroup.tabs.length, 2);
    assert.deepEqual(closedTabIds, [101, 102]);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
    StashService.ensurePinnedStashTab = origEnsure;
  }
});

test('从收纳箱整组恢复时还原为展开的彩色 Chrome Tab Group', async () => {
  let groupedTabIds = [];
  let updatedGroupOptions = null;

  installChrome({
    tabs: {
      create: async (opts) => {
        const id = Math.floor(Math.random() * 1000) + 1;
        return { id, ...opts };
      },
      group: async ({ tabIds }) => {
        groupedTabIds = tabIds;
        return 999;
      }
    },
    tabGroups: {
      update: async (groupId, opts) => {
        if (groupId === 999) {
          updatedGroupOptions = opts;
        }
      }
    }
  });

  const origGetAll = LocalStashRepository.getAllGroups;
  const origDelete = LocalStashRepository.deleteGroup;

  try {
    LocalStashRepository.getAllGroups = async () => [{
      id: 'grp_native_test',
      title: '设计调研',
      color: 'purple',
      locked: false,
      tabs: [
        { id: 'item-1', url: 'https://design1.com', title: 'Design 1', pinned: false },
        { id: 'item-2', url: 'https://design2.com', title: 'Design 2', pinned: false }
      ]
    }];
    LocalStashRepository.deleteGroup = async () => true;

    const result = await StashService.restoreGroup('grp_native_test', false);
    assert.equal(result, true);
    assert.equal(groupedTabIds.length, 2);
    assert.ok(updatedGroupOptions);
    assert.equal(updatedGroupOptions.title, '设计调研');
    assert.equal(updatedGroupOptions.color, 'purple');
    assert.equal(updatedGroupOptions.collapsed, false);
  } finally {
    LocalStashRepository.getAllGroups = origGetAll;
    LocalStashRepository.deleteGroup = origDelete;
  }
});

test('LinkInterceptor: 每次手势最多允许开一个标签', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { hostname: 'example.com', href: 'https://example.com/' } };
  try {
    const interceptor = new LinkInterceptor();
    assert.equal(interceptor.shouldAllowOpenEvent(), false);
    interceptor.gestureOpenBudget = 1;
    assert.equal(interceptor.shouldAllowOpenEvent(), true);
    assert.equal(interceptor.shouldAllowOpenEvent(), false);
  } finally {
    globalThis.window = originalWindow;
  }
});
