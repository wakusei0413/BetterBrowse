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

test('智能收纳：硬性保护超限时仍收纳其余可安全回收的标签', async () => {
  // 20 个标签：16 个受硬性保护（固定/播放媒体/表单输入），4 个可回收。
  // 目标剩余数为 阈值-1 = 14，硬性保护 16 已超出 → 此前实现会整体放弃，一个都不收，
  // 在用户看来就是"自动收纳完全不工作"
  const protectedTabs = Array.from({ length: 16 }, (_, i) => ({
    id: 200 + i,
    windowId: 1,
    url: `https://protected${i}.example`,
    pinned: true
  }));
  const stashableTabs = Array.from({ length: 4 }, (_, i) => ({
    id: 300 + i,
    windowId: 1,
    url: `https://idle${i}.example`,
    active: false
  }));
  const removedIds = [];

  installChrome({
    tabs: {
      query: async () => [...protectedTabs, ...stashableTabs],
      remove: async (ids) => { removedIds.push(...(Array.isArray(ids) ? ids : [ids])); },
      update: async () => ({}),
      move: async () => ({})
    }
  });

  const origCreateGroup = LocalStashRepository.createGroup;
  const origEnsure = StashService.ensurePinnedStashTab;

  try {
    LocalStashRepository.createGroup = async (items) => ({ success: true, group: { id: 'g1', tabs: items } });
    StashService.ensurePinnedStashTab = async () => ({});

    const service = new StashService({
      evaluateTabs: async () => ({
        tabsToKeep: protectedTabs.map((tab) => ({ tab })),
        tabsToStash: stashableTabs.map((tab) => ({ tab })),
        total: 20
      })
    });

    const result = await service.executeSmartStash({}, 1);

    // 能收的就收：4 个可回收标签全部被收纳，并如实报告未达标
    assert.equal(result.success, true);
    assert.equal(result.stashedCount, 4);
    assert.equal(result.reachedTarget, false);
    assert.equal(result.tierLevel, 'hardLimit');
    assert.equal(result.hardProtectedCount, 16);
    assert.equal(result.remainingOverThreshold, 2);
    assert.equal(typeof result.note, 'string');

    assert.deepEqual(removedIds.sort((a, b) => a - b), stashableTabs.map((tab) => tab.id));
    // 红线不变：受硬性保护的标签页一个都不能被关闭
    assert.equal(protectedTabs.some((tab) => removedIds.includes(tab.id)), false);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
    StashService.ensurePinnedStashTab = origEnsure;
  }
});

test('智能收纳：确实没有可回收标签时明确报告需手动整理', async () => {
  const protectedTabs = Array.from({ length: 16 }, (_, i) => ({
    id: 400 + i,
    windowId: 1,
    url: `https://protected${i}.example`,
    pinned: true
  }));
  const removedIds = [];

  installChrome({
    tabs: {
      query: async () => protectedTabs,
      remove: async (ids) => { removedIds.push(...(Array.isArray(ids) ? ids : [ids])); },
      update: async () => ({}),
      move: async () => ({})
    }
  });

  const origEnsure = StashService.ensurePinnedStashTab;

  try {
    StashService.ensurePinnedStashTab = async () => ({});
    const service = new StashService({
      evaluateTabs: async () => ({
        tabsToKeep: protectedTabs.map((tab) => ({ tab })),
        tabsToStash: [],
        total: 16
      })
    });

    const result = await service.executeSmartStash({}, 1);

    assert.equal(result.success, false);
    assert.equal(result.stashedCount, 0);
    assert.equal(result.noStashableTabs, true);
    assert.equal(result.tierLevel, 'hardLimit');
    assert.equal(typeof result.error, 'string');
    assert.equal(removedIds.length, 0);
  } finally {
    StashService.ensurePinnedStashTab = origEnsure;
  }
});

test('全量收纳：导航中的标签按 pendingUrl 入库并关闭，重复跳过的标签保留', async () => {
  const closedTabIds = [];
  installChrome({
    tabs: {
      query: async () => [
        { id: 31, windowId: 1, url: 'https://old.example/', pendingUrl: 'https://new.example/', title: '' },
        { id: 32, windowId: 1, url: 'https://dup.example/', title: '重复' }
      ],
      remove: async (ids) => { closedTabIds.push(...[].concat(ids)); },
      update: async () => ({}),
      move: async () => ({})
    }
  });
  const origCreateGroup = LocalStashRepository.createGroup;
  const origEnsure = StashService.ensurePinnedStashTab;
  let savedItems = [];
  try {
    LocalStashRepository.createGroup = async (items) => {
      savedItems = items;
      // 模拟仓储按 allowDuplicates=false 跳过了重复项
      return { success: true, group: { id: 'grp_pending', tabs: items.filter((item) => item.url !== 'https://dup.example/') } };
    };
    StashService.ensurePinnedStashTab = async () => ({});

    const result = await new StashService().executeAllTabsStash(1);
    assert.equal(result.success, true);
    assert.equal(savedItems[0].url, 'https://new.example/');
    assert.equal(savedItems[0].title, 'https://new.example/');
    assert.deepEqual(closedTabIds, [31]);
  } finally {
    LocalStashRepository.createGroup = origCreateGroup;
    StashService.ensurePinnedStashTab = origEnsure;
  }
});
