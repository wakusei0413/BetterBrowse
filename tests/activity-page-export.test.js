/**
 * @file activity-page-export.test.js
 * @description 活跃度按 pageId 分记录写入，以及导出游标分块拼接回归
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { LOCAL_DATA_SCHEMA_REVISION } from "../BetterBrowse/src/constants/config.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import { IndexedDBManager, IDBStores } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { MigrationManager } from "../BetterBrowse/src/core/storage/migration.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

function installMockStorage(initialData = {}) {
  const store = { ...initialData };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      id: "testextensionidaaaaaaaaaaaaaaa",
      getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "1.0.0", version_name: "Milestone 3" })
    },
    storage: {
      local: {
        get: (keys, callback) => {
          if (keys === null) return callback({ ...store });
          if (typeof keys === "string") return callback({ [keys]: store[keys] });
          if (Array.isArray(keys)) {
            const res = {};
            keys.forEach((k) => { res[k] = store[k]; });
            return callback(res);
          }
          if (typeof keys === "object") {
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
    }
  };
  return store;
}

Deno.test("活跃度：StorageAdapter 整对象写入会拆成 pageId 分记录，读取仍返回聚合对象", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: LOCAL_DATA_SCHEMA_REVISION });
  try {
    await StorageAdapter.set(StorageKeys.ACTIVITY_STATS, {
      page_aaa: { url: "https://a.example", lastActivated: 10, activationTimestamps: [10] },
      page_bbb: { url: "https://b.example", lastActivated: 20, activationTimestamps: [20] }
    });

    const keys = await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], "readonly", async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.ACTIVITY_STATS).getAllKeys());
    });
    assertEquals(keys.includes(StorageKeys.ACTIVITY_STATS), false);
    assertEquals(keys.includes("page_aaa"), true);
    assertEquals(keys.includes("page_bbb"), true);

    const stats = await StorageAdapter.get(StorageKeys.ACTIVITY_STATS, {});
    assertEquals(stats.page_aaa.url, "https://a.example");
    assertEquals(stats.page_bbb.lastActivated, 20);
    assertEquals(store[StorageKeys.SCHEMA_VERSION], LOCAL_DATA_SCHEMA_REVISION);
  } finally {
    await idb.restore();
  }
});

Deno.test("迁移：本地数据修订 10 将活跃度聚合键拆成 pageId 分记录", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 9 });
  try {
    await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], "readwrite", async (tx) => {
      tx.objectStore(IDBStores.ACTIVITY_STATS).put({
        key: StorageKeys.ACTIVITY_STATS,
        value: {
          page_old: { url: "https://old.example", lastActivated: 7, activationTimestamps: [7] }
        },
        updatedAt: 1
      });
    });
    await MigrationManager.runMigrations();
    assertEquals(store[StorageKeys.SCHEMA_VERSION], LOCAL_DATA_SCHEMA_REVISION);

    const keys = await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], "readonly", async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.ACTIVITY_STATS).getAllKeys());
    });
    assertEquals(keys.includes(StorageKeys.ACTIVITY_STATS), false);
    assertEquals(keys.includes("page_old"), true);
  } finally {
    await idb.restore();
  }
});

Deno.test("导出：READ_EXPORT_CHUNK 游标分块拼接后可 JSON.parse，且与完整导出语义一致", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: LOCAL_DATA_SCHEMA_REVISION });
  try {
    await LocalStashRepository.createGroup(
      [
        { url: "https://export.example/a", title: "导出甲" },
        { url: "https://export.example/b", title: "导出乙" }
      ],
      "导出组"
    );
    await LocalStashRepository.createGroup(
      [{ url: "https://export.example/c", title: "导出丙" }],
      "另一组"
    );

    const full = JSON.parse(await LocalStashRepository.exportFullBackupJSON());
    let cursor = null;
    let expectedStashRevision;
    let body = "";
    for (let i = 0; i < 50; i++) {
      const part = await LocalStashRepository.readExportChunk({
        type: "full_backup",
        cursor,
        maxChars: 800,
        expectedStashRevision
      });
      assertEquals(Boolean(part.success === false), false, JSON.stringify(part));
      body += part.chunk || "";
      cursor = part.nextCursor;
      expectedStashRevision = part.stashRevision;
      if (part.done || !cursor) break;
      if (i === 49) throw new Error("导出分块次数过多");
    }

    const streamed = JSON.parse(body);
    assertEquals(streamed.plugin, "BetterBrowse");
    assertEquals(streamed.type, "full_backup");
    assertEquals(streamed.stashGroups.length, full.stashGroups.length);
    assertEquals(
      streamed.stashGroups.map((g) => g.title).sort(),
      full.stashGroups.map((g) => g.title).sort()
    );
    assertEquals(
      streamed.stashGroups.reduce((n, g) => n + (g.tabs?.length || 0), 0),
      full.stashGroups.reduce((n, g) => n + (g.tabs?.length || 0), 0)
    );
  } finally {
    await idb.restore();
  }
});
