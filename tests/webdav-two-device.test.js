/**
 * @file webdav-two-device.test.js
 * @description 双设备端到端同步测试（两套独立 IndexedDB 共用同一 WebDAV 远端，走真实 SyncEngine 全流程）
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { MigrationManager } from "../BetterBrowse/src/core/storage/migration.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import { IndexedDBManager } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { WebdavCredentials } from "../BetterBrowse/src/core/sync/credentials.js";
import { SyncEngine } from "../BetterBrowse/src/core/sync/sync-engine.js";
import { FakeIDBFactory } from "./helpers/fake-indexeddb.js";
import { FakeWebdavServer, installChromeStore, useDevice } from "./helpers/fake-webdav.js";

Deno.test("双设备端到端：新设备配对不丢本机数据、双向传播、删除同步", async () => {
  const server = new FakeWebdavServer();
  SyncEngine.fetchImpl = (url, options) => server.fetch(url, options);
  const factoryA = new FakeIDBFactory();
  const factoryB = new FakeIDBFactory();

  try {
    // ===== 设备 A：创建数据并首次同步（生成快照基线） =====
    const storeA = installChromeStore({ [StorageKeys.SCHEMA_VERSION]: 7 });
    await useDevice(factoryA, storeA);
    await MigrationManager.runMigrations();
    await WebdavCredentials.save({ serverUrl: 'https://dav.test/dav/', username: 'a', password: 'p-a' });
    await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });

    const createdA = await LocalStashRepository.createGroup(
      [{ url: "https://a.example/x", title: "A 页面" }],
      "A 组"
    );
    const runA1 = await SyncEngine.run({ manual: true });
    assertEquals(runA1.success, true, "设备 A 首次同步应成功");

    // ===== 设备 B：离线期间先建了自己的组，再首次接入配对 =====
    const storeB = installChromeStore({ [StorageKeys.SCHEMA_VERSION]: 7 });
    await useDevice(factoryB, storeB);
    await MigrationManager.runMigrations();
    await WebdavCredentials.save({ serverUrl: 'https://dav.test/dav/', username: 'b', password: 'p-b' });
    await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });

    const createdB = await LocalStashRepository.createGroup(
      [{ url: "https://b.example/y", title: "B 页面" }],
      "B 组"
    );
    const runB1 = await SyncEngine.run({ manual: true });
    assertEquals(runB1.success, true, "设备 B 首次配对同步应成功");

    // B 应同时拥有 A 的组（快照配对）与自己的组（本地数据不被清掉）
    const groupsB1 = await LocalStashRepository.getAllGroups();
    assertEquals(groupsB1.length, 2, "设备 B 配对后应有两个组");
    assertEquals(groupsB1.some((g) => g.id === createdA.group.id), true, "A 的组应通过快照到达 B");
    assertEquals(groupsB1.some((g) => g.id === createdB.group.id), true, "B 本机离线创建的组不得丢失");

    // ===== B 修改 A 创建的组标题并同步 =====
    await LocalStashRepository.updateGroup(createdA.group.id, { title: "B 端改名" });
    const runB2 = await SyncEngine.run({ manual: true });
    assertEquals(runB2.success, true, "设备 B 二次同步应成功");

    // ===== 回到 A：拉取 B 的变更（改名 + B 的新组） =====
    await useDevice(factoryA, storeA);
    const runA2 = await SyncEngine.run({ manual: true });
    assertEquals(runA2.success, true, "设备 A 二次同步应成功");

    const groupsA2 = await LocalStashRepository.getAllGroups();
    assertEquals(groupsA2.length, 2, "设备 A 应看到两个组");
    const renamed = groupsA2.find((g) => g.id === createdA.group.id);
    assertEquals(renamed?.title, "B 端改名", "B 的改名应传播到 A");
    assertEquals(groupsA2.some((g) => g.id === createdB.group.id), true, "B 的新组应传播到 A");

    // ===== A 删除该组 → 同步 → B 侧同步后消失 =====
    await LocalStashRepository.deleteGroup(createdA.group.id);
    const runA3 = await SyncEngine.run({ manual: true });
    assertEquals(runA3.success, true);

    await useDevice(factoryB, storeB);
    const runB3 = await SyncEngine.run({ manual: true });
    assertEquals(runB3.success, true);

    const groupsB3 = await LocalStashRepository.getAllGroups();
    assertEquals(groupsB3.length, 1, "删除应传播到 B");
    assertEquals(groupsB3[0].id, createdB.group.id, "B 自己的组应保留");

    // ===== 远端设备清单 =====
    const manifest = server.getManifest();
    assertEquals(manifest.knownDevices.length, 2, "远端应登记两台设备");
    assertEquals(manifest.generation >= 1, true);
  } finally {
    SyncEngine.fetchImpl = null;
    await IndexedDBManager.close();
  }
});

Deno.test("双设备端到端：连错数据集目录时报数据损坏而非静默切换", async () => {
  const server = new FakeWebdavServer();
  SyncEngine.fetchImpl = (url, options) => server.fetch(url, options);
  const factoryA = new FakeIDBFactory();
  const factoryB = new FakeIDBFactory();

  try {
    // 设备 A 建立数据集
    const storeA = installChromeStore({ [StorageKeys.SCHEMA_VERSION]: 7 });
    await useDevice(factoryA, storeA);
    await MigrationManager.runMigrations();
    await WebdavCredentials.save({ serverUrl: 'https://dav.test/dav/', username: 'a', password: 'p-a' });
    await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });
    await LocalStashRepository.createGroup([{ url: "https://a.example/x", title: "A 页面" }], "A 组");
    const runA1 = await SyncEngine.run({ manual: true });
    assertEquals(runA1.success, true);

    // 设备 B 曾同步过（有 lastSyncAt 历史）
    const storeB = installChromeStore({ [StorageKeys.SCHEMA_VERSION]: 7 });
    await useDevice(factoryB, storeB);
    await MigrationManager.runMigrations();
    await WebdavCredentials.save({ serverUrl: 'https://dav.test/dav/', username: 'b', password: 'p-b' });
    await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });
    const runB1 = await SyncEngine.run({ manual: true });
    assertEquals(runB1.success, true);

    // 远端被替换为另一个全新数据集（模拟 A 清空重建 / B 连错目录）
    const staleSnapshotId = server.getManifest().snapshotId;
    server.files.delete('manifest.json');
    server.files.delete(`snapshots/${staleSnapshotId}.json`);
    const runB2 = await SyncEngine.run({ manual: true });
    assertEquals(runB2.success, false);
    assertEquals(runB2.status, 'corrupt', "有同步历史的设备遇到陌生数据集应报数据损坏");
  } finally {
    SyncEngine.fetchImpl = null;
    await IndexedDBManager.close();
  }
});
