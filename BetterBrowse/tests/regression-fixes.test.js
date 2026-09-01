/**
 * @file regression-fixes.test.js
 * @description 本轮缺陷修复的回归测试（entryId 双前缀恢复翻倍、单事务创建、孤儿条目去重污染、
 *              本地数据修订 6 修复迁移、阶梯窗口零值、全量跳过时不关标签、单组快照恢复、固定标签守护导入绑定）
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../src/constants/storage-keys.js";
import { DefaultConfig } from "../src/constants/config.js";
import { StorageAdapter } from "../src/core/storage/storage-adapter.js";
import { IndexedDBManager, IDBStores } from "../src/core/storage/indexed-db.js";
import { MigrationManager } from "../src/core/storage/migration.js";
import { LocalStashRepository } from "../src/core/stash/local-stash-repo.js";
import { IndexedStashRepository } from "../src/core/stash/indexed-stash-repo.js";
import { StashService } from "../src/core/stash/stash-service.js";
import { RecentActiveRule } from "../src/core/rules/recent-active-rule.js";
import { FormGuardRule } from "../src/core/rules/form-guard-rule.js";
import { countStoreRecords, installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

/**
 * 安装 chrome.storage.local 内存模拟（与 indexed-db-stash.test.js 保持同一模式）
 */
function installMockStorage(initialData = {}) {
  const store = { ...initialData };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get: (keys, callback) => {
          if (keys === null) return callback({ ...store });
          if (typeof keys === 'string') return callback({ [keys]: store[keys] });
          if (Array.isArray(keys)) {
            const res = {};
            keys.forEach((k) => { res[k] = store[k]; });
            return callback(res);
          }
          callback({});
        },
        set: (items, callback) => {
          Object.assign(store, items);
          callback?.();
        }
      }
    },
    tabs: {
      create: async (props) => ({ id: Math.floor(Math.random() * 1000), ...props }),
      query: async () => [],
      update: async () => ({}),
      move: async () => ({}),
      remove: async () => {}
    },
    windows: {
      getAll: async () => [{ id: 1 }],
      create: async () => ({ id: 2 })
    }
  };
  return store;
}

Deno.test("回归: 导出→全量恢复往返必须幂等（entryId 双前缀修复，标签不得翻倍）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 6 });
  try {
    await LocalStashRepository.createGroup([
      { url: "https://roundtrip.example/1", title: "页面一" },
      { url: "https://roundtrip.example/2", title: "页面二" }
    ], "往返组");

    const backup = await LocalStashRepository.exportFullBackupJSON();
    const res = await LocalStashRepository.restoreFullBackupJSON(backup);
    assertEquals(res.success, true);

    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].tabs.length, 2);
    assertEquals(await countStoreRecords(IndexedDBManager, IDBStores.STASH_ENTRIES), 2);

    // 再次恢复依旧幂等
    await LocalStashRepository.restoreFullBackupJSON(backup);
    const groupsAgain = await LocalStashRepository.getAllGroups();
    assertEquals(groupsAgain[0].tabs.length, 2);
    assertEquals(await countStoreRecords(IndexedDBManager, IDBStores.STASH_ENTRIES), 2);
  } finally {
    await idb.restore();
  }
});

Deno.test("回归: restoreGroupSnapshot 仅恢复单个组，不触碰现有数据", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 6 });
  try {
    const created = await LocalStashRepository.createGroup(
      [{ url: "https://snapshot.example/a", title: "快照页" }],
      "被删组"
    );
    await LocalStashRepository.createGroup([{ url: "https://snapshot.example/b" }], "保留组");
    await LocalStashRepository.deleteGroup(created.group.id);

    let groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);

    const res = await LocalStashRepository.restoreGroupSnapshot(created.group);
    assertEquals(res.success, true);
    groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 2);
    assertEquals(groups.some((g) => g.id === created.group.id), true);

    // 重复恢复同一快照幂等
    await LocalStashRepository.restoreGroupSnapshot(created.group);
    groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 2);
    const restored = groups.find((g) => g.id === created.group.id);
    assertEquals(restored.tabs.length, 1);
  } finally {
    await idb.restore();
  }
});

Deno.test("回归: 孤儿条目不得污染去重判定（联表校验组存在）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 6 });
  try {
    // 模拟历史中断产物：存在一条没有组记录的收纳条目
    const orphanUrl = "https://orphan.example/article";
    await IndexedDBManager.withWriteLock(async () => {
      await IndexedStashRepository._putChunked(IDBStores.STASH_ENTRIES, [{
        entryId: "orphan_grp::tab_item_x",
        groupId: "orphan_grp",
        pageId: IndexedStashRepository.computePageId(orphanUrl),
        createdAt: Date.now(),
        position: 0,
        pinned: false,
        archived: false
      }]);
    });

    await StorageAdapter.updateUserConfig({ stashSettings: { allowDuplicates: false } });
    const res = await LocalStashRepository.createGroup([{ url: orphanUrl, title: "重要文档" }], "新组");

    // 修复前此处返回 { success: true, group: null }，上层会关闭标签页造成数据丢失
    assertEquals(res.success, true);
    assertEquals(res.group !== null && res.group !== undefined, true);
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].tabs.length, 1);
  } finally {
    await idb.restore();
  }
});

Deno.test("回归: 本地数据修订 6 迁移清理双前缀重复条目与孤儿条目", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 5 });
  try {
    const created = await LocalStashRepository.createGroup(
      [{ url: "https://repair.example/1", title: "待修复页" }],
      "修复组"
    );
    const groupId = created.group.id;
    const canonicalEntryId = created.group.tabs[0].id;

    // 人为制造历史损坏：与规范条目完全同源的双前缀重复条目 + 孤儿条目
    const doubled = await IndexedDBManager.runTransaction(
      [IDBStores.STASH_ENTRIES],
      'readonly',
      async (tx) => await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_ENTRIES).get(canonicalEntryId))
    );
    await IndexedDBManager.withWriteLock(async () => {
      await IndexedStashRepository._putChunked(IDBStores.STASH_ENTRIES, [
        { ...doubled, entryId: `${groupId}::${canonicalEntryId}` },
        { entryId: "lost_grp::tab_item_y", groupId: "lost_grp", pageId: "page_x", createdAt: 1, position: 0, pinned: false, archived: false }
      ]);
    });
    assertEquals(await countStoreRecords(IndexedDBManager, IDBStores.STASH_ENTRIES), 3);

    await MigrationManager.runMigrations();

    assertEquals(store[StorageKeys.SCHEMA_VERSION], 8);
    const entries = await IndexedDBManager.runTransaction(
      [IDBStores.STASH_ENTRIES],
      'readonly',
      async (tx) => await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_ENTRIES).getAll())
    );
    // 双前缀条目被清理、孤儿被清理，仅剩规范条目
    assertEquals(entries.length, 1);
    assertEquals(entries[0].entryId, canonicalEntryId);

    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups[0].tabs.length, 1);
  } finally {
    await idb.restore();
  }
});

Deno.test("回归: 阶梯降级窗口为 0 时最近访问保护必须完全放开（|| 5 修复）", async () => {
  const rule = new RecentActiveRule();
  const tab = { id: 1, active: false, url: "https://idle.example" };
  const activityStats = { 1: { lastActivated: Date.now() - 60 * 1000, activationTimestamps: [Date.now() - 60 * 1000] } };
  const config = { ...DefaultConfig, rulesEnabled: { ...DefaultConfig.rulesEnabled, recentActive: true } };

  // 窗口 5 分钟：1 分钟前访问过 → 保留
  const kept = await rule.evaluate({ tab, activityStats, config, tierContext: { recentActiveMinutes: 5 } });
  assertEquals(kept.retain, true);

  // 窗口 0（阶梯最深层）：不再保护
  const stashed = await rule.evaluate({ tab, activityStats, config, tierContext: { recentActiveMinutes: 0 } });
  assertEquals(stashed.retain, false);
});

Deno.test("回归: FormGuardRule 提供 preload 预加载方法", () => {
  assertEquals(typeof FormGuardRule.prototype.preload, "function");
});

Deno.test("回归: 智能收纳全部命中重复跳过时不得关闭任何标签页", async () => {
  const idb = installFakeIndexedDB();
  let removed = false;
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 6 });
  globalThis.chrome.tabs = {
    ...globalThis.chrome.tabs,
    query: async () => [
      { id: 1, windowId: 1, url: "https://dup.example/page", title: "重复页", active: true },
      { id: 2, windowId: 1, url: "https://dup.example/page", title: "重复页", active: false },
      { id: 3, windowId: 1, url: "https://dup.example/page", title: "重复页", active: false }
    ],
    remove: async () => { removed = true; },
    update: async () => ({}),
    move: async () => ({}),
    onCreated: { addListener() {} },
    onActivated: { addListener() {} },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onMoved: { addListener() {} },
    // 表单探测应答"无活跃输入"，避免 fail-closed 策略将全部标签判为受保护
    sendMessage: (_tabId, _msg, callback) => callback?.({ success: true, data: { hasActiveInput: false } })
  };
  globalThis.chrome.windows = {
    ...globalThis.chrome.windows,
    getLastFocused: async () => ({ id: 1, tabs: [] }),
    onFocusChanged: { addListener() {} },
    onCreated: { addListener() {} },
    onRemoved: { addListener() {} }
  };
  globalThis.chrome.storage.session = undefined;
  globalThis.chrome.contextMenus = undefined;
  globalThis.chrome.notifications = undefined;
  globalThis.chrome.alarms = undefined;

  try {
    await StorageAdapter.updateUserConfig({
      tabThreshold: 3,
      stashSettings: { allowDuplicates: false, pinnedTabGuard: false, autoOpenStashTab: false }
    });
    // 预先把该 URL 收纳进历史组
    await LocalStashRepository.createGroup([{ url: "https://dup.example/page", title: "历史" }], "历史组");

    const service = new StashService();
    const res = await service.executeStash({}, { forceAll: false });

    assertEquals(res.success, true);
    assertEquals(res.stashedCount, 0);
    assertEquals(removed, false);
  } finally {
    await idb.restore();
  }
});

Deno.test("回归: closeTabsSafely 容忍批量关闭时部分标签已被关闭（No tab with id 竞态）", async () => {
  installMockStorage({});
  const alive = new Set([10, 30]);
  const removedIds = [];
  globalThis.chrome.tabs = {
    ...globalThis.chrome.tabs,
    remove: async (ids) => {
      const list = Array.isArray(ids) ? ids : [ids];
      const missing = list.filter((id) => !alive.has(id));
      // 与 Chrome 真实行为一致：批量 remove 中存在不存在的 ID 时整体抛错
      if (missing.length > 0) throw new Error(`No tab with id: ${missing[0]}`);
      for (const id of list) {
        alive.delete(id);
        removedIds.push(id);
      }
    }
  };

  // id=20 已被用户手动关闭：批量调用抛错后应逐个兜底，仅关闭存活的标签
  const closed = await StashService.closeTabsSafely([10, 20, 30]);
  assertEquals(closed, 2);
  assertEquals(removedIds.includes(10), true);
  assertEquals(removedIds.includes(30), true);
  assertEquals(removedIds.includes(20), false);

  // 全部标签均已不存在时返回 0 且不抛错
  const closedNone = await StashService.closeTabsSafely([10, 30]);
  assertEquals(closedNone, 0);

  // 空列表直接返回 0
  assertEquals(await StashService.closeTabsSafely([]), 0);
});

Deno.test("回归: MessageBus.sendToTab 必须吞掉 MV3 sendMessage 在 callback 模式下仍拒绝的 Promise", async () => {
  const { MessageBus } = await import("../src/core/bus/message-bus.js");
  installMockStorage({});
  globalThis.chrome.runtime = {
    ...(globalThis.chrome.runtime || {}),
    lastError: null
  };
  globalThis.chrome.tabs = {
    ...(globalThis.chrome.tabs || {}),
    sendMessage: (_tabId, _msg, callback) => {
      const rejected = Promise.reject(new Error("No tab with id: 1115423785"));
      rejected.catch(() => {});
      queueMicrotask(() => {
        globalThis.chrome.runtime.lastError = { message: "No tab with id: 1115423785" };
        callback?.();
        globalThis.chrome.runtime.lastError = null;
      });
      return rejected;
    }
  };

  const res = await MessageBus.sendToTab(1115423785, "CHECK_FORM_INPUT", null, 500);
  assertEquals(res.success, false);
  assertEquals(typeof res.error, "string");
});

Deno.test("回归: StorageAdapter.addChangeListener 在 chrome.storage 缺失时不得抛 TypeError", () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: null } };
  try {
    StorageAdapter.addChangeListener(() => {});
  } finally {
    globalThis.chrome = originalChrome;
  }
});

Deno.test("回归: PinnedTabGuard 更新选项页标签时不得因漏导入 isOwnOptionsUrl 抛 ReferenceError", async () => {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const updatedListeners = [];
  globalThis.setTimeout = (fn) => {
    if (typeof fn === 'function') queueMicrotask(fn);
    return 0;
  };
  globalThis.clearTimeout = () => {};
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`
    },
    tabs: {
      query: async () => [],
      onCreated: { addListener() {} },
      onUpdated: { addListener(fn) { updatedListeners.push(fn); } },
      onRemoved: { addListener() {} },
      onMoved: { addListener() {} }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onCreated: { addListener() {} },
      onFocusChanged: { addListener() {} },
      onRemoved: { addListener() {} },
      get: async () => null
    }
  };
  try {
    const { PinnedTabGuard } = await import("../src/background/pinned-tab-guard.js");
    new PinnedTabGuard();
    assertEquals(updatedListeners.length > 0, true);
    updatedListeners[0](1, { pinned: false }, {
      id: 1,
      windowId: 1,
      index: 2,
      url: 'chrome-extension://test/src/options/options.html#stash'
    });
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

Deno.test("回归: 用户拖拽标签页时后台打开新标签应重试并保留链接", async () => {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  let attempts = 0;
  const createCalls = [];
  globalThis.setTimeout = (fn) => {
    queueMicrotask(fn);
    return 0;
  };
  globalThis.chrome = {
    tabs: {
      create: async (properties) => {
        attempts += 1;
        createCalls.push({ ...properties });
        if (attempts < 3) {
          throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
        }
        return { id: 42, ...properties };
      }
    }
  };
  try {
    const { createTabWithRetry } = await import("../src/background/action-handlers.js");
    const tab = await createTabWithRetry({
      url: "https://retry-open.example/article",
      active: true,
      index: 4,
      openerTabId: 7,
      windowId: 1
    });
    assertEquals(tab.id, 42);
    assertEquals(attempts, 3);
    assertEquals(createCalls[0].index, 4);
    assertEquals(createCalls[2].index, 4);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.setTimeout = originalSetTimeout;
  }
});

Deno.test("回归: 拖拽持续时创建失败应去掉插入位置而不丢失标签页", async () => {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  const createCalls = [];
  globalThis.setTimeout = (fn) => {
    queueMicrotask(fn);
    return 0;
  };
  globalThis.chrome = {
    tabs: {
      create: async (properties) => {
        createCalls.push({ ...properties });
        if (Object.hasOwn(properties, "index")) {
          throw new Error("Tabs cannot be edited right now");
        }
        return { id: 43, ...properties };
      }
    }
  };
  try {
    const { createTabWithRetry } = await import("../src/background/action-handlers.js");
    const tab = await createTabWithRetry({
      url: "https://fallback-open.example/article",
      active: true,
      index: 2,
      openerTabId: 8,
      windowId: 1
    });
    assertEquals(tab.id, 43);
    assertEquals(createCalls.length, 5);
    assertEquals(Object.hasOwn(createCalls.at(-1), "index"), false);
    assertEquals(createCalls.at(-1).url, "https://fallback-open.example/article");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.setTimeout = originalSetTimeout;
  }
});
