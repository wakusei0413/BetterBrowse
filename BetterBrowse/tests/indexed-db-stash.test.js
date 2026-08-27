/**
 * @file indexed-db-stash.test.js
 * @description IndexedDB 主库仓储、v5 数据迁移、幂等恢复、一键回退、30 天保留清理与并发写库集成测试
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../src/constants/storage-keys.js";
import { StorageAdapter } from "../src/core/storage/storage-adapter.js";
import { MigrationManager } from "../src/core/storage/migration.js";
import { IndexedDBManager, IDBStores } from "../src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../src/core/stash/local-stash-repo.js";
import { IndexedStashRepository } from "../src/core/stash/indexed-stash-repo.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

/**
 * 安装 chrome.storage 内存模拟（与 stash-settings.test.js 保持同一模式）
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
      move: async () => ({}),
      remove: async () => {},
      discard: async () => ({})
    },
    windows: {
      getAll: async () => [{ id: 1 }],
      create: async () => ({ id: 2 })
    }
  };
  return store;
}

/**
 * 统计 IndexedDB 指定仓储的记录数（直接验证三层模型数据布局）
 */
async function countStoreRecords(storeName) {
  return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
    return await IndexedDBManager.requestToPromise(tx.objectStore(storeName).count());
  });
}

Deno.test("IndexedStashRepository: createGroup 三层模型写入与 getAllGroups 完整还原（同一 URL 复用页面实体）", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 5 });
  try {
    const res1 = await LocalStashRepository.createGroup(
      [
        { url: "https://example.com/a", title: "页面甲", favIconUrl: "https://example.com/favicon.ico" },
        { url: "https://example.com/b", title: "页面乙" }
      ],
      "第一组"
    );
    assertEquals(res1.success, true);
    assertEquals(res1.group.title, "第一组");
    assertEquals(res1.group.tabs.length, 2);

    // 第二组复用同一 URL（默认允许重复），页面实体层应去重复用
    const res2 = await LocalStashRepository.createGroup(
      [{ url: "https://example.com/a", title: "页面甲（再次收纳）" }],
      "第二组"
    );
    assertEquals(res2.success, true);

    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 2);
    // 时间倒序：第二组在前
    assertEquals(groups[0].title, "第二组");
    assertEquals(groups[0].tabs[0].url, "https://example.com/a");
    // 组内顺序稳定还原
    assertEquals(groups[1].tabs.map((t) => t.url), ["https://example.com/a", "https://example.com/b"]);
    assertEquals(groups[1].tabs[0].title, "页面甲");
    assertEquals(groups[1].tabs[0].favIconUrl, "https://example.com/favicon.ico");

    // 三层模型数据布局：2 个不同 URL 仅产生 2 条页面实体（重复 URL 复用），3 条收纳记录、2 个组
    assertEquals(await countStoreRecords(IDBStores.PAGES), 2);
    assertEquals(await countStoreRecords(IDBStores.STASH_ENTRIES), 3);
    assertEquals(await countStoreRecords(IDBStores.STASH_GROUPS), 2);

    // IndexedDB 模式下通过修订号广播变更
    assertEquals(typeof store[StorageKeys.STASH_REV], "string");
  } finally {
    await idb.restore();
  }
});

Deno.test("IndexedStashRepository: updateGroup / deleteTabItem / deleteGroup / clearAll 全链路", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 5 });
  try {
    const g1 = await LocalStashRepository.createGroup(
      [
        { url: "https://a.com/1", title: "条目一" },
        { url: "https://a.com/2", title: "条目二" }
      ],
      "可操作组"
    );
    const g2 = await LocalStashRepository.createGroup([{ url: "https://b.com", title: "锁定内容" }], "锁定组");
    await LocalStashRepository.updateGroup(g2.group.id, { locked: true });

    // 更新标题与星标
    assertEquals(await LocalStashRepository.updateGroup(g1.group.id, { starred: true, title: "重命名组" }), true);
    const afterUpdate = await LocalStashRepository.getAllGroups();
    assertEquals(afterUpdate.find((g) => g.id === g1.group.id).title, "重命名组");
    assertEquals(afterUpdate.find((g) => g.id === g1.group.id).starred, true);

    // 删除单项：组内仍有条目时保留组
    const g1ItemId = g1.group.tabs[0].id;
    assertEquals(await LocalStashRepository.deleteTabItem(g1.group.id, g1ItemId), true);
    let groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.find((g) => g.id === g1.group.id).tabs.length, 1);

    // 删除最后一项：非锁定组自动清理
    assertEquals(await LocalStashRepository.deleteTabItem(g1.group.id, g1.group.tabs[1].id), true);
    groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.some((g) => g.id === g1.group.id), false);

    // 锁定组不可删除，force 可强制删除
    assertEquals(await LocalStashRepository.deleteGroup(g2.group.id), false);
    assertEquals(await LocalStashRepository.deleteGroup(g2.group.id, true), true);

    // clearAll 保留锁定组，includeLocked 全清
    const g3 = await LocalStashRepository.createGroup([{ url: "https://c.com", title: "普通" }], "普通组");
    const g4 = await LocalStashRepository.createGroup([{ url: "https://d.com", title: "锁定" }], "锁定组二");
    await LocalStashRepository.updateGroup(g4.group.id, { locked: true });
    assertEquals(await LocalStashRepository.clearAll(), true);
    groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].id, g4.group.id);
    assertEquals(await LocalStashRepository.clearAll(true), true);
    groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 0);
    assertEquals(g3.group.id.length > 0, true);
  } finally {
    await idb.restore();
  }
});

Deno.test("IndexedStashRepository: allowDuplicates=false 时索引去重且 useLatest 刷新已有标题", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 5,
    [StorageKeys.USER_CONFIG]: {
      stashSettings: { allowDuplicates: false, existingTabTitleBehavior: 'useLatest' }
    }
  });
  try {
    const res1 = await LocalStashRepository.createGroup(
      [{ url: "https://dup.com/page", title: "旧标题" }],
      "首个组"
    );
    assertEquals(res1.success, true);

    // 同一 URL 再次收纳：被索引去重跳过，且页面实体标题刷新为最新
    const res2 = await LocalStashRepository.createGroup(
      [{ url: "https://dup.com/page", title: "最新标题" }],
      "重复组"
    );
    assertEquals(res2.success, true);
    assertEquals(res2.group, null);
    assertEquals(res2.skipped, 1);

    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].tabs[0].title, "最新标题");
  } finally {
    await idb.restore();
  }
});

Deno.test("IndexedStashRepository: getGroupPage 分页与 searchEntries 关键字检索", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 5 });
  try {
    const res = await LocalStashRepository.createGroup(
      [
        { url: "https://search-alpha.example/1", title: "阿尔法页面" },
        { url: "https://search-beta.example/2", title: "贝塔页面" },
        { url: "https://search-gamma.example/3", title: "伽马页面" },
        { url: "https://search-delta.example/4", title: "德尔塔页面" },
        { url: "https://search-epsilon.example/5", title: "伊普西隆页面" }
      ],
      "分页测试组"
    );
    const groupId = res.group.id;

    // 分页：首页
    const page1 = await IndexedStashRepository.getGroupPage(groupId, { offset: 0, limit: 2 });
    assertEquals(page1.total, 5);
    assertEquals(page1.items.length, 2);
    assertEquals(page1.items[0].url, "https://search-alpha.example/1");
    assertEquals(page1.items[1].url, "https://search-beta.example/2");

    // 分页：尾页越界截断
    const page3 = await IndexedStashRepository.getGroupPage(groupId, { offset: 4, limit: 2 });
    assertEquals(page3.items.length, 1);
    assertEquals(page3.items[0].url, "https://search-epsilon.example/5");

    // 关键字检索：按标题
    const byTitle = await IndexedStashRepository.searchEntries("贝塔");
    assertEquals(byTitle.length, 1);
    assertEquals(byTitle[0].url, "https://search-beta.example/2");
    assertEquals(byTitle[0].groupId, groupId);

    // 关键字检索：按 URL 片段
    const byUrl = await IndexedStashRepository.searchEntries("search-delta");
    assertEquals(byUrl.length, 1);
    assertEquals(byUrl[0].itemId.length > 0, true);

    // 无命中
    assertEquals((await IndexedStashRepository.searchEntries("不存在的关键字xyz")).length, 0);
  } finally {
    await idb.restore();
  }
});

Deno.test("MigrationManager: v4 旧数组完整迁移至 IndexedDB 主库（v5），中断重跑幂等不重复", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 4,
    [StorageKeys.STASH_GROUPS]: [
      {
        id: "g1",
        createdAt: 1000,
        title: "旧组一",
        locked: false,
        starred: true,
        tabs: [
          { id: "t1", url: "https://a.com", title: "A 页面", favIconUrl: "https://a.com/fav.ico", pinned: false },
          { id: "t2", url: "https://b.com", title: "B 页面" }
        ]
      },
      {
        id: "g2",
        createdAt: 2000,
        title: "锁定组",
        locked: true,
        starred: false,
        tabs: [{ id: "t3", url: "https://c.com", title: "C 页面" }]
      }
    ]
  });
  try {
    await MigrationManager.runMigrations();

    // 版本推进至 v5 并记录迁移时间
    assertEquals(store[StorageKeys.SCHEMA_VERSION], 5);
    assertEquals(typeof store[StorageKeys.IDB_MIGRATED_AT], "number");

    // 数据经门面（IndexedDB 权威数据源）完整还原
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 2);
    // 星标组置顶
    assertEquals(groups[0].id, "g1");
    assertEquals(groups[0].starred, true);
    assertEquals(groups[0].tabs.map((t) => t.url), ["https://a.com", "https://b.com"]);
    assertEquals(groups[0].tabs[0].favIconUrl, "https://a.com/fav.ico");
    assertEquals(groups[1].id, "g2");
    assertEquals(groups[1].locked, true);

    // 旧数组在 30 天保留期内原样保留
    assertEquals(store[StorageKeys.STASH_GROUPS].length, 2);

    // 模拟迁移中断场景：版本号被回拨（未推进）但部分数据已写入，重跑不得重复
    store[StorageKeys.SCHEMA_VERSION] = 4;
    await MigrationManager.runMigrations();
    const afterRetry = await LocalStashRepository.getAllGroups();
    assertEquals(afterRetry.length, 2);
    assertEquals(afterRetry[0].tabs.length, 2);
    assertEquals(await countStoreRecords(IDBStores.STASH_ENTRIES), 3);
  } finally {
    await idb.restore();
  }
});

Deno.test("MigrationManager: 迁移执行失败时版本停在 v4 且旧数据完整保留，恢复后重试成功", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 4,
    [StorageKeys.STASH_GROUPS]: [
      { id: "g1", createdAt: 1000, title: "待迁移组", tabs: [{ id: "t1", url: "https://retry.com", title: "重试页面" }] }
    ]
  });
  const originalImport = IndexedStashRepository.importGroups;
  try {
    // 模拟迁移中途被 Service Worker 休眠打断
    IndexedStashRepository.importGroups = async () => {
      throw new Error("模拟迁移中断");
    };
    await MigrationManager.runMigrations();

    assertEquals(store[StorageKeys.SCHEMA_VERSION], 4);        // 版本未推进
    assertEquals(store[StorageKeys.STASH_GROUPS].length, 1);   // 旧数据完整保留
    assertEquals(store[StorageKeys.IDB_MIGRATED_AT], undefined);

    // 环境恢复后重试成功
    IndexedStashRepository.importGroups = originalImport;
    await MigrationManager.runMigrations();
    assertEquals(store[StorageKeys.SCHEMA_VERSION], 5);
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 1);
    assertEquals(groups[0].tabs[0].url, "https://retry.com");
  } finally {
    IndexedStashRepository.importGroups = originalImport;
    await idb.restore();
  }
});

Deno.test("MigrationManager: rollbackFromIndexedDB 一键回退至旧存储且 optout 持久生效", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 4,
    [StorageKeys.STASH_GROUPS]: [
      { id: "g1", createdAt: 1000, title: "迁移前数据", tabs: [{ id: "t1", url: "https://old.com", title: "旧页面" }] }
    ]
  });
  try {
    await MigrationManager.runMigrations();
    assertEquals(store[StorageKeys.SCHEMA_VERSION], 5);

    // 迁移后在 IndexedDB 模式下新增一组
    const created = await LocalStashRepository.createGroup([{ url: "https://new.com", title: "新页面" }], "主库新增组");
    assertEquals(created.success, true);

    // 一键回退：IndexedDB 全量数据导回旧数组并设置回退标记
    const rollback = await MigrationManager.rollbackFromIndexedDB();
    assertEquals(rollback.success, true);
    assertEquals(rollback.groupCount, 2);
    assertEquals(store[StorageKeys.IDB_OPTOUT], true);
    assertEquals(store[StorageKeys.STASH_GROUPS].length, 2);
    assertEquals(store[StorageKeys.STASH_GROUPS].some((g) => g.title === "主库新增组"), true);

    // 回退后新写入落在旧存储
    const afterRollback = await LocalStashRepository.createGroup(
      [{ url: "https://after-rollback.com", title: "回退后页面" }],
      "回退后新组"
    );
    assertEquals(afterRollback.success, true);
    assertEquals(store[StorageKeys.STASH_GROUPS].some((g) => g.title === "回退后新组"), true);

    // optout 生效：即使版本回拨到 v4，迁移也不会重新切回 IndexedDB
    store[StorageKeys.SCHEMA_VERSION] = 4;
    await MigrationManager.runMigrations();
    assertEquals(store[StorageKeys.SCHEMA_VERSION], 5);
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.some((g) => g.title === "回退后新组"), true);
  } finally {
    await idb.restore();
  }
});

Deno.test("MigrationManager: 迁移成功 30 天后自动清理旧数组，保留期内不动", async () => {
  const legacyGroups = [
    { id: "g1", createdAt: 1000, title: "旧数据", tabs: [{ id: "t1", url: "https://old.com", title: "旧页面" }] }
  ];

  // 超过 30 天：自动清理
  const storeExpired = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 5,
    [StorageKeys.IDB_MIGRATED_AT]: Date.now() - 31 * 86400000,
    [StorageKeys.STASH_GROUPS]: legacyGroups
  });
  await MigrationManager.runMigrations();
  assertEquals(storeExpired[StorageKeys.STASH_GROUPS].length, 0);

  // 30 天内：保留
  const storeFresh = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 5,
    [StorageKeys.IDB_MIGRATED_AT]: Date.now(),
    [StorageKeys.STASH_GROUPS]: legacyGroups
  });
  await MigrationManager.runMigrations();
  assertEquals(storeFresh[StorageKeys.STASH_GROUPS].length, 1);

  // 回退状态（migratedAt 为 0）：永不清理
  const storeOptout = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 5,
    [StorageKeys.IDB_MIGRATED_AT]: 0,
    [StorageKeys.STASH_GROUPS]: legacyGroups
  });
  await MigrationManager.runMigrations();
  assertEquals(storeOptout[StorageKeys.STASH_GROUPS].length, 1);
});

Deno.test("并发写库：多入口同时创建收纳组不丢数据、不覆盖（模拟 SW + 选项页并发）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 5 });
  try {
    const results = await Promise.all([
      LocalStashRepository.createGroup([{ url: "https://concurrent-1.com", title: "并发一" }], "并发组一"),
      LocalStashRepository.createGroup([{ url: "https://concurrent-2.com", title: "并发二" }], "并发组二"),
      LocalStashRepository.createGroup(
        [
          { url: "https://concurrent-3.com", title: "并发三" },
          { url: "https://concurrent-4.com", title: "并发四" }
        ],
        "并发组三"
      )
    ]);

    assertEquals(results.every((res) => res.success === true), true);

    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.length, 3);
    const urls = groups.flatMap((g) => g.tabs.map((t) => t.url)).sort();
    assertEquals(urls, [
      "https://concurrent-1.com",
      "https://concurrent-2.com",
      "https://concurrent-3.com",
      "https://concurrent-4.com"
    ]);
  } finally {
    await idb.restore();
  }
});

Deno.test("IndexedDB 故障降级：读取回退旧存储快照，写入显式失败不产生双数据源", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 5,
    [StorageKeys.STASH_GROUPS]: [
      { id: "legacy-snapshot", createdAt: 1000, title: "旧存储快照", tabs: [{ id: "t1", url: "https://snapshot.com", title: "快照页面" }] }
    ]
  });
  try {
    // 正常状态：IndexedDB 为权威数据源（为空），旧快照不影响展示
    assertEquals((await LocalStashRepository.getAllGroups()).length, 0);

    // 制造 IndexedDB 故障：断开缓存连接后令 open 抛错
    await IndexedDBManager.close();
    const originalOpen = idb.factory.open;
    idb.factory.open = () => {
      throw new Error("模拟 IndexedDB 不可用");
    };

    // 读路径降级：回退旧存储快照
    const degraded = await LocalStashRepository.getAllGroups();
    assertEquals(degraded.length, 1);
    assertEquals(degraded[0].title, "旧存储快照");

    // 写路径不降级：显式失败且不写旧存储（保障数据源唯一）
    const failed = await LocalStashRepository.createGroup([{ url: "https://broken.com", title: "失败写入" }], "失败组");
    assertEquals(failed.success, false);
    assertEquals(store[StorageKeys.STASH_GROUPS].length, 1);

    idb.factory.open = originalOpen;
  } finally {
    await idb.restore();
  }
});
