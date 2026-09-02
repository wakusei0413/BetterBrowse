/**
 * @file stash-item-ops.test.js
 * @description 收纳条目增强读写测试（AI 桥接阶段三）：组内追加条目、条目编辑、检索分页与自动备份管理
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import { IndexedDBManager, IDBStores } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

/**
 * 安装 chrome.storage 内存模拟（与 indexed-db-stash.test.js 保持同一模式）
 */
function installMockStorage(initialData = {}) {
  const store = { ...initialData };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
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
          if (typeof keys === 'object') {
            const res = { ...keys };
            Object.keys(keys).forEach((k) => {
              if (store[k] !== undefined) res[k] = store[k];
            });
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
      remove: async () => {},
      discard: async () => ({})
    },
    windows: { getAll: async () => [{ id: 1 }], create: async () => ({ id: 2 }) }
  };
  return store;
}

Deno.test("AI 增强：addTabItemToGroup 追加条目（页面实体复用 + 修订号广播 + allowDuplicates 去重）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const created = await LocalStashRepository.createGroup(
      [{ url: "https://docs.example.com/intro", title: "入门文档" }],
      "工作资料"
    );
    assertEquals(created.success, true);
    const groupId = created.group.id;
    const pagesBefore = await IndexedDBManager.runTransaction([IDBStores.PAGES], 'readonly', async (tx) =>
      await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).count()));

    // 追加一个全新 URL 的条目
    const added = await LocalStashRepository.addTabItemToGroup(groupId, {
      url: "docs.example.com/api",   // 缺省协议应自动补齐
      title: "API 参考"
    });
    assertEquals(added.success, true);
    assertEquals(added.added, true);
    assertEquals(added.item.url, "https://docs.example.com/api");
    assertEquals(added.item.title, "API 参考");

    // 组内顺序：新条目追加在尾部，且修订号已广播
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].tabs.map((t) => t.title), ["入门文档", "API 参考"]);
    const rev = await StorageAdapter.get(StorageKeys.STASH_REV, null);
    assertEquals(typeof rev, "string");

    // 页面实体按 URL 指纹入库：新增 1 条
    const pagesAfter = await IndexedDBManager.runTransaction([IDBStores.PAGES], 'readonly', async (tx) =>
      await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).count()));
    assertEquals(pagesAfter, pagesBefore + 1);

    // 再次追加同一 URL（默认允许重复）应成功产生第二条收纳记录
    const dup = await LocalStashRepository.addTabItemToGroup(groupId, { url: "https://docs.example.com/api" });
    assertEquals(dup.success, true);
    assertEquals(dup.added, true);
    const pageDup = await LocalStashRepository.getGroupPage(groupId, {});
    assertEquals(pageDup.total, 3);

    // allowDuplicates=false 时同 URL 已被收录 → 跳过
    await StorageAdapter.updateUserConfig({ stashSettings: { allowDuplicates: false } });
    const skipped = await LocalStashRepository.addTabItemToGroup(groupId, { url: "https://docs.example.com/api" });
    assertEquals(skipped.success, true);
    assertEquals(skipped.added, false);
    assertEquals(skipped.skipped, 1);

    // 不存在的组：明确失败
    const missing = await LocalStashRepository.addTabItemToGroup("stash_grp_none", { url: "https://a.com" });
    assertEquals(missing.success, false);
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 增强：updateTabItem 编辑条目（标题走页面实体共享层，URL 重指向页面实体）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const created = await LocalStashRepository.createGroup(
      [{ url: "https://example.com/old-path", title: "旧标题" }],
      "编辑测试"
    );
    const groupId = created.group.id;
    const itemId = created.group.tabs[0].id;

    // 1. 改标题：两层模型下 title 属于页面实体
    assertEquals(await LocalStashRepository.updateTabItem(groupId, itemId, { title: "新标题" }), true);
    let page = await LocalStashRepository.getGroupPage(groupId, { limit: 10 });
    assertEquals(page.items[0].title, "新标题");

    // 2. 改 URL：条目重新指向新 URL 的页面实体
    assertEquals(
      await LocalStashRepository.updateTabItem(groupId, itemId, { url: "https://example.com/new-path" }),
      true
    );
    page = await LocalStashRepository.getGroupPage(groupId, { limit: 10 });
    assertEquals(page.items[0].url, "https://example.com/new-path");
    assertEquals(page.items[0].title, "新标题");

    // 3. 改置顶 / 归档
    assertEquals(
      await LocalStashRepository.updateTabItem(groupId, itemId, { pinned: true, archived: true }),
      true
    );
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups[0].tabs[0].pinned, true);
    assertEquals(groups[0].tabs[0].archived, true);

    // 4. 无效 URL 拒绝；无字段更新拒绝；不存在的条目返回 false
    assertEquals(await LocalStashRepository.updateTabItem(groupId, itemId, { url: "javascript:alert(1)" }), false);
    assertEquals(await LocalStashRepository.updateTabItem(groupId, itemId, {}), false);
    assertEquals(await LocalStashRepository.updateTabItem(groupId, "tab_item_none", { title: "x" }), false);
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 增强：SEARCH_STASH 检索与 GET_STASH_GROUP_PAGE 分页", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const created = await LocalStashRepository.createGroup(
      [
        { url: "https://news.ycombinator.com", title: "极客新闻" },
        { url: "https://github.com/features", title: "代码托管" }
      ],
      "日常阅读"
    );
    await LocalStashRepository.addTabItemToGroup(created.group.id, {
      url: "https://developer.mozilla.org/zh-CN/docs/Web",
      title: "Web 开发文档"
    });

    // 关键词命中标题与 URL
    const byTitle = await LocalStashRepository.searchStash("极客");
    assertEquals(byTitle.length, 1);
    assertEquals(byTitle[0].groupId, created.group.id);
    const byUrl = await LocalStashRepository.searchStash("mozilla");
    assertEquals(byUrl.length, 1);
    assertEquals(byUrl[0].url, "https://developer.mozilla.org/zh-CN/docs/Web");
    assertEquals(await LocalStashRepository.searchStash(""), []);

    // 分页：limit=2 时第一页 2 条、total=3
    const firstPage = await LocalStashRepository.getGroupPage(created.group.id, { offset: 0, limit: 2 });
    assertEquals(firstPage.total, 3);
    assertEquals(firstPage.items.length, 2);
    assertEquals(firstPage.hasMore, true);
    const secondPage = await LocalStashRepository.getGroupPage(created.group.id, { offset: 2, limit: 2 });
    assertEquals(secondPage.items.length, 1);
    const cursorPage = await LocalStashRepository.getGroupPage(created.group.id, {
      cursor: firstPage.nextCursor,
      limit: 2
    });
    assertEquals(cursorPage.items.length, 1);
    const stats = await LocalStashRepository.getStashStats();
    assertEquals(stats.groupCount, 1);
    assertEquals(stats.itemCount, 3);
    const pagedSearch = await LocalStashRepository.searchStash("https://", 2, { paginated: true });
    assertEquals(pagedSearch.items.length, 2);
    assertEquals(pagedSearch.hasMore, true);
  } finally {
    await idb.restore();
  }
});

Deno.test("listGroupSummaries：返回 itemCount 且不含 tabs / favicon，计数与 getAllGroups 一致", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const created = await LocalStashRepository.createGroup(
      [
        { url: "https://summary.example/a", title: "摘要甲", favIconUrl: "https://summary.example/a.ico" },
        { url: "https://summary.example/b", title: "摘要乙", favIconUrl: "https://summary.example/b.ico" }
      ],
      "摘要组"
    );
    await LocalStashRepository.createGroup(
      [{ url: "https://summary.example/c", title: "摘要丙" }],
      "另一组"
    );

    const summaries = await LocalStashRepository.listGroupSummaries();
    const full = await LocalStashRepository.getAllGroups();
    assertEquals(summaries.length, full.length);
    assertEquals(summaries.every((group) => !Object.hasOwn(group, "tabs")), true);
    assertEquals(summaries.every((group) => !Object.hasOwn(group, "favIconUrl")), true);

    const summaryMap = new Map(summaries.map((group) => [group.id, group]));
    for (const group of full) {
      const summary = summaryMap.get(group.id);
      assertEquals(Boolean(summary), true);
      assertEquals(summary.itemCount, group.tabs.length);
      assertEquals(summary.title, group.title);
      assertEquals(summary.starred, Boolean(group.starred));
    }

    const createdSummary = summaryMap.get(created.group.id);
    assertEquals(createdSummary.itemCount, 2);

    const withPreview = await LocalStashRepository.listGroupSummaries({ previewLimit: 25 });
    const previewed = withPreview.find((group) => group.id === created.group.id);
    assertEquals(previewed.tabs.length, 2);
    assertEquals(previewed.tabs[0].url, "https://summary.example/a");
    assertEquals(previewed.tabs[0].title, "摘要甲");
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 增强：自动备份管理（list / restore 幂等 / delete）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    // 构造两份备份快照（绕过自动备份触发条件，直接写入仓储键）
    const now = Date.now();
    const groupsA = [
      {
        id: "stash_grp_backup_a", createdAt: now - 1000, title: "备份组甲", locked: false, starred: false,
        tabs: [{ id: "tab_a1", url: "https://backup.example.com/a", title: "备份页甲" }]
      }
    ];
    const groupsB = [
      {
        id: "stash_grp_backup_b", createdAt: now - 500, title: "备份组乙", locked: false, starred: false,
        tabs: [{ id: "tab_b1", url: "https://backup.example.com/b", title: "备份页乙" }]
      }
    ];
    await StorageAdapter.set(StorageKeys.AUTO_BACKUPS, [
      { createdAt: now - 60000, groups: groupsA },
      { createdAt: now - 30000, groups: groupsB }
    ]);

    // 1. 摘要列表
    const list = await LocalStashRepository.listAutoBackups();
    assertEquals(list.length, 2);
    assertEquals(list[0].groupCount, 1);
    assertEquals(list[0].entryCount, 1);
    assertEquals(typeof list[0].sizeBytes, "number");

    // 2. 恢复：组数据入库且可重复执行（幂等 upsert）
    const restored = await LocalStashRepository.restoreAutoBackup(now - 60000);
    assertEquals(restored.success, true);
    assertEquals(restored.groupCount, 1);
    const restoredAgain = await LocalStashRepository.restoreAutoBackup(now - 60000);
    assertEquals(restoredAgain.success, true);
    const all = await LocalStashRepository.getAllGroups();
    assertEquals(all.length, 1);
    assertEquals(all[0].title, "备份组甲");

    // 3. 删除指定备份；不存在的备份明确失败
    const removed = await LocalStashRepository.deleteAutoBackup(now - 30000);
    assertEquals(removed.success, true);
    assertEquals(removed.remaining, 1);
    const missing = await LocalStashRepository.deleteAutoBackup(now - 30000);
    assertEquals(missing.success, false);

    // 4. 恢复不存在的备份明确失败
    const missingRestore = await LocalStashRepository.restoreAutoBackup(12345);
    assertEquals(missingRestore.success, false);
  } finally {
    await idb.restore();
  }
});

Deno.test("恢复组快照：危险协议被清洗，合法 URL 写入", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const snapshot = {
      id: "stash_grp_restore_sanitize",
      createdAt: Date.now(),
      title: "脏快照",
      tabs: [
        { id: "t1", url: "javascript:alert(1)", title: "xss" },
        { id: "t2", url: "https://safe.example/", title: "安全页" },
        { id: "t3", url: "data:text/html,hi", title: "data" }
      ]
    };
    const res = await LocalStashRepository.restoreGroupSnapshot(snapshot);
    assertEquals(res.success, true);
    const groups = await LocalStashRepository.getAllGroups();
    const restored = groups.find((g) => g.id === snapshot.id);
    assertEquals(Boolean(restored), true);
    assertEquals(restored.tabs.length, 1);
    assertEquals(restored.tabs[0].url, "https://safe.example/");

    const empty = await LocalStashRepository.restoreGroupSnapshot({
      id: "stash_grp_evil_only",
      tabs: [{ url: "javascript:alert(1)" }]
    });
    assertEquals(empty.success, false);
  } finally {
    await idb.restore();
  }
});
