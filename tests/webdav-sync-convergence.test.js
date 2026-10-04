/**
 * @file webdav-sync-convergence.test.js
 * @description 多设备收敛性回归测试：并列冲突、快照合并、lamport 推进、快照命名唯一与远端/本地体积有界
 * @encoding UTF-8
 */

import { assert, assertEquals } from "@std/assert";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { MigrationManager } from "../BetterBrowse/src/core/storage/migration.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import { IndexedDBManager, IDBStores } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { WebdavCredentials } from "../BetterBrowse/src/core/sync/credentials.js";
import { SyncEngine } from "../BetterBrowse/src/core/sync/sync-engine.js";
import { SyncOutbox } from "../BetterBrowse/src/core/sync/outbox.js";
import { sha256Hex } from "../BetterBrowse/src/core/sync/crypto-util.js";
import { FakeIDBFactory } from "./helpers/fake-indexeddb.js";
import {
  FakeWebdavServer,
  countStore,
  installChromeStore,
  patchClock,
  useDevice
} from "./helpers/fake-webdav.js";

/** 初始化一台设备：迁移、配置 WebDAV、启用同步 */
async function bootDevice(name) {
  const factory = new FakeIDBFactory();
  const store = installChromeStore({ [StorageKeys.SCHEMA_VERSION]: 7 });
  await useDevice(factory, store);
  await MigrationManager.runMigrations();
  await WebdavCredentials.save({ serverUrl: 'https://dav.test/dav/', username: name, password: `p-${name}` });
  await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });
  return { factory, store };
}

async function sync(label) {
  const result = await SyncEngine.run({ manual: true });
  assertEquals(result.success, true, `${label} 同步应成功：${result.error || ''}`);
  return result;
}

async function groupTitle(groupId) {
  const groups = await LocalStashRepository.getAllGroups();
  return groups.find((g) => g.id === groupId)?.title;
}

/** 让远端认为上一份快照已过期，下次同步必定生成新快照 */
function expireSnapshot(server) {
  server.patchManifest({ snapshotCreatedAt: 1 });
}

async function withServer(fn) {
  const server = new FakeWebdavServer();
  SyncEngine.fetchImpl = (url, options) => server.fetch(url, options);
  try {
    await fn(server);
  } finally {
    SyncEngine.fetchImpl = null;
    await IndexedDBManager.close();
  }
}

Deno.test("收敛 1：lamport 相同的并发改名，两台设备最终显示同一个值", async () => {
  await withServer(async () => {
    const A = await bootDevice('a');
    const created = await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "原名");
    const groupId = created.group.id;
    await sync('A1');

    const B = await bootDevice('b');
    await sync('B1');

    // 两台设备在同一 lamport 基线上各改一次 → 产生同 lamport、不同 deviceId 的并列
    await patchClock({ lamport: 1000, seenLamport: 1000 });
    await LocalStashRepository.updateGroup(groupId, { title: "B 改名" });
    const deviceB = await SyncOutbox.getDeviceId();

    await useDevice(A.factory, A.store);
    await patchClock({ lamport: 1000, seenLamport: 1000 });
    await LocalStashRepository.updateGroup(groupId, { title: "A 改名" });
    const deviceA = await SyncOutbox.getDeviceId();

    await useDevice(B.factory, B.store);
    await sync('B2');
    await useDevice(A.factory, A.store);
    await sync('A2');
    const titleA = await groupTitle(groupId);
    await useDevice(B.factory, B.store);
    await sync('B3');
    const titleB = await groupTitle(groupId);

    assertEquals(titleA, titleB, "并列冲突后两台设备必须收敛到同一个值");
    assertEquals(titleA, deviceA > deviceB ? "A 改名" : "B 改名", "并列时按 deviceId 确定性取胜");
  });
});

Deno.test("收敛 2：应用其他设备的旧快照不得回退本机修改、不得复活本机已删除的组", async () => {
  await withServer(async (server) => {
    const A = await bootDevice('a');
    const g1 = (await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "一" }], "组一")).group.id;
    const g2 = (await LocalStashRepository.createGroup([{ url: "https://t.example/2", title: "二" }], "组二")).group.id;
    await sync('A1');

    const B = await bootDevice('b');
    await sync('B1');

    // A 离线改名 + 删除（尚未上传）
    await useDevice(A.factory, A.store);
    await LocalStashRepository.updateGroup(g1, { title: "A 新名" });
    await LocalStashRepository.deleteGroup(g2, true);

    // B 在看到 A 的修改之前生成新快照
    await useDevice(B.factory, B.store);
    expireSnapshot(server);
    const before = server.getManifest().snapshotId;
    await sync('B2');
    assert(server.getManifest().snapshotId !== before, "B 应生成新一代快照");

    // A 上传自己的修改后拉取并应用 B 的快照
    await useDevice(A.factory, A.store);
    await sync('A2');
    assertEquals(await groupTitle(g1), "A 新名", "A 的改名不得被 B 的旧快照回退");
    assertEquals(await groupTitle(g2), undefined, "A 已删除的组不得被 B 的旧快照复活");

    await useDevice(B.factory, B.store);
    await sync('B3');
    assertEquals(await groupTitle(g1), "A 新名");
    assertEquals(await groupTitle(g2), undefined);
  });
});

Deno.test("收敛 3：仅靠快照入网的新设备，其修改能传播回老设备", async () => {
  await withServer(async () => {
    const A = await bootDevice('a');
    const groupId = (await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "原名")).group.id;
    for (let i = 0; i < 5; i += 1) {
      await LocalStashRepository.updateGroup(groupId, { title: `A 第 ${i} 次改名` });
    }
    await sync('A1');

    // B 入网：A 的全部操作都在快照 watermark 之内，B 只能从快照获取状态
    const B = await bootDevice('b');
    await sync('B1');
    assertEquals(await groupTitle(groupId), "A 第 4 次改名");
    await LocalStashRepository.updateGroup(groupId, { title: "B 改名" });
    await sync('B2');

    await useDevice(A.factory, A.store);
    await sync('A2');
    assertEquals(await groupTitle(groupId), "B 改名", "新设备的修改不得因 lamport 过低被老设备丢弃");
  });
});

Deno.test("收敛 4：两台设备并发生成快照时文件不互相覆盖，清单摘要与文件一致", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    await LocalStashRepository.updateGroup((await LocalStashRepository.getAllGroups())[0].id, { title: "改" });

    // 模拟另一台设备：在 A 上传快照文件之后、更新清单之前，用同名文件写入自己的快照并推进清单
    const otherBody = JSON.stringify({ formatVersion: 1, createdAt: Date.now(), watermarks: {}, pages: [], stashGroups: [], stashEntries: [], settings: {}, activityStats: {}, deviceEvents: [], tombstones: [] });
    // 另一台设备基于同一份清单计算出的快照名，与 A 的命名规则一致（generation + 1）
    const m0 = server.getManifest();
    const otherId = `gen-${String((m0.generation || 0) + 1).padStart(4, '0')}`;
    let injected = false;
    server.onPut = async (path) => {
      if (injected || !path.startsWith('snapshots/')) return;
      injected = true;
      const m = server.getManifest();
      // 若 A 与对方撞名，对方的 PUT 会覆盖 A 刚写的文件
      server.files.set(`snapshots/${otherId}.json`, { body: otherBody, etag: server.etag() });
      server.patchManifest({
        generation: (m.generation || 0) + 1,
        previousSnapshotId: m.snapshotId,
        snapshotId: otherId,
        snapshotSha256: await sha256Hex(otherBody),
        snapshotCreatedAt: Date.now()
      });
    };
    expireSnapshot(server);
    await sync('A2');
    assert(injected, "应触发并发快照注入");

    const m = server.getManifest();
    assert(m.snapshotId !== m.previousSnapshotId, "当前快照与上一份快照不得是同一个文件");
    const file = server.files.get(`snapshots/${m.snapshotId}.json`);
    assert(file, "清单引用的快照文件必须存在");
    assertEquals(await sha256Hex(file.body), m.snapshotSha256, "清单记录的摘要必须与快照文件内容一致");
  });
});

Deno.test("体积有界：频繁同步不重复生成全量快照，远端与本地快照副本均有上限", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    const tabs = Array.from({ length: 120 }, (_, i) => ({ url: `https://bulk.example/${i}`, title: `页 ${i}` }));
    const created = await LocalStashRepository.createGroup(tabs, "大组");
    await LocalStashRepository.createGroup([{ url: "https://t.example/del", title: "删" }], "待删");
    await sync('初次');
    // 删除产生 30 天内有效的墓碑
    const toDelete = (await LocalStashRepository.getAllGroups()).find((g) => g.title === "待删");
    await LocalStashRepository.deleteGroup(toDelete.id, true);

    for (let i = 0; i < 6; i += 1) {
      await LocalStashRepository.updateGroup(created.group.id, { title: `大组 ${i}` });
      await sync(`第 ${i} 轮`);
    }

    const remoteSnapshots = server.snapshotFiles();
    assert(remoteSnapshots.length <= 2, `远端快照应只保留当前与上一份，实际 ${remoteSnapshots.length} 份`);
    const localSnapshots = await countStore(IDBStores.SNAPSHOTS);
    assert(localSnapshots <= 2, `本地快照缓存应只保留两份，实际 ${localSnapshots} 份`);
    const manifest = server.getManifest();
    assert(manifest.generation <= 3, `少量修改不应每轮都生成新快照，实际 generation=${manifest.generation}`);
  });
});

Deno.test("体积有界：历史遗留的大量旧快照在下次生成快照时被清理，只留当前与上一份", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    // 模拟旧版本遗留：每次同步都上传过一份全量快照
    const current = server.getManifest();
    for (let i = 1; i <= 8; i += 1) {
      server.files.set(`snapshots/gen-${String(i).padStart(4, '0')}.json`, { body: '{}', etag: server.etag() });
    }
    server.patchManifest({ generation: 9, snapshotCreatedAt: 1 });
    await LocalStashRepository.updateGroup((await LocalStashRepository.getAllGroups())[0].id, { title: "改" });
    await sync('A2');

    const m = server.getManifest();
    const left = server.snapshotFiles().sort();
    assertEquals(left, [`snapshots/${m.previousSnapshotId}.json`, `snapshots/${m.snapshotId}.json`].sort());
    assertEquals(m.previousSnapshotId, current.snapshotId);
  });
});

Deno.test("体积有界：已应用过的批次不再重复下载", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    const B = await bootDevice('b');
    await sync('B1');
    await LocalStashRepository.updateGroup((await LocalStashRepository.getAllGroups())[0].id, { title: "B 改" });
    await sync('B2');

    const realFetch = SyncEngine.fetchImpl;
    const gets = [];
    SyncEngine.fetchImpl = (url, options) => {
      if ((options?.method || 'GET') === 'GET' && url.includes('/operations/')) gets.push(url);
      return realFetch(url, options);
    };
    await useDevice(B.factory, B.store);
    await sync('B3');
    await sync('B4');
    assertEquals(gets.length, 0, `本机已应用的批次不应再下载，实际下载 ${gets.length} 次`);
  });
});

Deno.test("体积有界：活跃度高频写入在 outbox 中按页面合并且不单独触发同步", async () => {
  await withServer(async () => {
    await bootDevice('a');
    const { StorageKeys: Keys } = await import("../BetterBrowse/src/constants/storage-keys.js");
    let dirty = 0;
    SyncOutbox.onDirty = () => { dirty += 1; };
    try {
      for (let i = 0; i < 5; i += 1) {
        await StorageAdapter.set(Keys.ACTIVITY_STATS, {
          page_abc: { url: 'https://t.example/1', lastActivated: 1000 + i, activationTimestamps: [1000 + i] }
        });
      }
      const pending = (await SyncOutbox.listPending()).filter((op) => op.entityType === 'activity');
      assertEquals(pending.length, 1, "同一页面只保留最新一条待上传活跃度");
      assertEquals(pending[0].fields.lastActivated, 1004);
      assertEquals(dirty, 0, "活跃度写入不应单独触发防抖同步");
    } finally {
      SyncOutbox.onDirty = null;
    }
  });
});

Deno.test("体积有界：同步历史清理删除过期日志、已裁决冲突与过期墓碑，保留近期记录", async () => {
  await withServer(async () => {
    await bootDevice('a');
    const { SyncMerge } = await import("../BetterBrowse/src/core/sync/merge.js");
    const now = Date.now();
    const old = now - 31 * 86400000;
    await IndexedDBManager.runTransaction(
      [IDBStores.OPERATION_LOGS, IDBStores.CONFLICTS, IDBStores.TOMBSTONES],
      'readwrite',
      async (tx) => {
        tx.objectStore(IDBStores.OPERATION_LOGS).put({ logId: 'old', operationId: 'old', createdAt: old });
        tx.objectStore(IDBStores.OPERATION_LOGS).put({ logId: 'new', operationId: 'new', createdAt: now });
        tx.objectStore(IDBStores.CONFLICTS).put({ conflictId: 'c-old', resolved: true, resolvedAt: old });
        tx.objectStore(IDBStores.CONFLICTS).put({ conflictId: 'c-open', resolved: false, createdAt: old });
        tx.objectStore(IDBStores.TOMBSTONES).put({ tombstoneId: 't-old', expiresAt: now - 1 });
        tx.objectStore(IDBStores.TOMBSTONES).put({ tombstoneId: 't-live', expiresAt: now + 86400000 });
      }
    );
    const before = await countStore(IDBStores.OPERATION_LOGS);
    const result = await IndexedDBManager.withWriteLock(() => SyncMerge.pruneHistory(now));
    assertEquals(result.logs >= 1, true);
    assertEquals(await countStore(IDBStores.OPERATION_LOGS), before - result.logs);
    const read = (store, key) => IndexedDBManager.runTransaction([store], 'readonly', (tx) =>
      IndexedDBManager.requestToPromise(tx.objectStore(store).get(key)));
    assertEquals(await read(IDBStores.OPERATION_LOGS, 'old'), undefined);
    assert(await read(IDBStores.OPERATION_LOGS, 'new'));
    assertEquals(await read(IDBStores.CONFLICTS, 'c-old'), undefined);
    assert(await read(IDBStores.CONFLICTS, 'c-open'), "未裁决冲突必须保留");
    assertEquals(await read(IDBStores.TOMBSTONES, 't-old'), undefined);
    assert(await read(IDBStores.TOMBSTONES, 't-live'));
  });
});
