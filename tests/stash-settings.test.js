/**
 * @file stash-settings.test.js
 * @description 收纳箱精细化设置与 OneTab 核心逻辑集成测试 (Deno 原生驱动)
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { DefaultConfig } from "../BetterBrowse/src/constants/config.js";
import { MigrationManager } from "../BetterBrowse/src/core/storage/migration.js";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { StashService } from "../BetterBrowse/src/core/stash/stash-service.js";

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

Deno.test("DefaultConfig: 默认配置包含完整的收纳箱设置", () => {
  const s = DefaultConfig.stashSettings;
  assertEquals(s.restoreBehavior, "remove");
  assertEquals(s.restorePosition, "currentWindow");
  assertEquals(s.allowDuplicates, true);
  assertEquals(s.existingTabTitleBehavior, "useOriginal");
  assertEquals(s.autoOpenStashTab, true);
  assertEquals(s.pinnedTabGuard, true);
  assertEquals(s.deleteConfirmation, true);
  assertEquals(s.autoBackupEnabled, true);
  assertEquals(s.backupRetentionDays, 30);
  assertEquals(s.displayDensity, "comfortable");
});

Deno.test("MigrationManager: 从历史 本地数据修订 1 迁移至当前修订平滑补齐 stashSettings 默认值", async () => {
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 1,
    [StorageKeys.USER_CONFIG]: { tabThreshold: 20 }
  });

  await MigrationManager.runMigrations();
  const config = store[StorageKeys.USER_CONFIG];
  assertEquals(config.stashSettings.restoreBehavior, "remove");
  assertEquals(config.stashSettings.allowDuplicates, true);
  assertEquals(config.stashSettings.autoOpenStashTab, true);
  // 本地数据修订 4 起补齐"阶梯式降级收纳"默认配置
  assertEquals(config.tieredStash.enabled, true);
  assertEquals(config.tieredStash.ultimateFallback, true);
  // 测试环境无 IndexedDB：本地数据修订 5 主库迁移待环境就绪后自动重试，本地数据修订停在 4
  assertEquals(store[StorageKeys.SCHEMA_VERSION], 4);
});

Deno.test("LocalStashRepository: createGroup 与 updateGroup 基础操作", async () => {
  const store = installMockStorage({
    [StorageKeys.STASH_GROUPS]: []
  });

  const res = await LocalStashRepository.createGroup(
    [{ url: "https://example.com", title: "示例网页" }],
    "测试组"
  );

  assertEquals(res.success, true);
  assertEquals(res.group.title, "测试组");
  assertEquals(res.group.tabs.length, 1);

  await LocalStashRepository.updateGroup(res.group.id, { starred: true, title: "重命名组" });
  const groups = store[StorageKeys.STASH_GROUPS];
  assertEquals(groups[0].starred, true);
  assertEquals(groups[0].title, "重命名组");
});

Deno.test("LocalStashRepository: deleteTabItem 删除单项及自动清理空组", async () => {
  const store = installMockStorage({
    [StorageKeys.STASH_GROUPS]: [
      {
        id: "g1",
        locked: false,
        tabs: [
          { id: "t1", url: "https://a.com", title: "A" },
          { id: "t2", url: "https://b.com", title: "B" }
        ]
      }
    ]
  });

  // 删除 t1，保留组（还剩 t2）
  await LocalStashRepository.deleteTabItem("g1", "t1");
  assertEquals(store[StorageKeys.STASH_GROUPS].length, 1);
  assertEquals(store[StorageKeys.STASH_GROUPS][0].tabs.length, 1);

  // 删除 t2，非锁定组自动清理
  await LocalStashRepository.deleteTabItem("g1", "t2");
  assertEquals(store[StorageKeys.STASH_GROUPS].length, 0);
});

Deno.test("StashService: restoreItem 恢复单项标签（非锁定组删除，锁定组保留）", async () => {
  const store = installMockStorage({
    [StorageKeys.STASH_GROUPS]: [
      {
        id: "g1",
        locked: false,
        tabs: [{ id: "t1", url: "https://example.com", title: "示例" }]
      },
      {
        id: "g2",
        locked: true,
        tabs: [{ id: "t2", url: "https://example2.com", title: "锁定示例" }]
      }
    ]
  });

  // 非锁定组：恢复后从收纳箱删除
  const res1 = await StashService.restoreItem("g1", "t1", true);
  assertEquals(res1, true);
  const groupsAfter1 = store[StorageKeys.STASH_GROUPS];
  assertEquals(groupsAfter1.some((g) => g.id === "g1"), false);

  // 锁定组：恢复后安全保留在收纳箱
  const res2 = await StashService.restoreItem("g2", "t2", true);
  assertEquals(res2, true);
  const groupsAfter2 = store[StorageKeys.STASH_GROUPS];
  const g2 = groupsAfter2.find((g) => g.id === "g2");
  assertEquals(g2.tabs.length, 1);
});

