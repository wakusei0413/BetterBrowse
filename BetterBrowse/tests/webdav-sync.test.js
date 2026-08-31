/**
 * @file webdav-sync.test.js
 * @description WebDAV 云端同步集成测试（v8 迁移、outbox 上传、清单条件写入、快照基线、字段冲突、墓碑与凭据隔离）
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../src/constants/storage-keys.js";
import { MigrationManager } from "../src/core/storage/migration.js";
import { StorageAdapter } from "../src/core/storage/storage-adapter.js";
import { IndexedDBManager, IDBStores } from "../src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../src/core/stash/local-stash-repo.js";
import { WebdavCredentials } from "../src/core/sync/credentials.js";
import { SyncEngine } from "../src/core/sync/sync-engine.js";
import { SyncOutbox } from "../src/core/sync/outbox.js";
import { SyncMerge } from "../src/core/sync/merge.js";
import { SyncSnapshot } from "../src/core/sync/snapshot.js";
import { DeviceEventLog } from "../src/core/sync/device-events.js";
import { sha256Hex } from "../src/core/sync/crypto-util.js";
import { SyncEntityTypes, SyncStatus } from "../src/core/sync/sync-constants.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

/**
 * 安装 chrome.storage 内存模拟（与 indexed-db-stash.test.js 保持同一模式）
 */
function installMockStorage(initialData = {}) {
  const store = { ...initialData };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: () => {}
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
    alarms: {
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} }
    }
  };
  return store;
}

/**
 * 内存版 WebDAV 服务器：path → { body, etag }，支持 If-Match / If-None-Match 条件写
 */
class FakeWebdavServer {
  constructor() {
    this.files = new Map();
    this.counter = 0;
    this.noEtag = false;          // 模拟不返回 ETag 的服务器
    this.ignoreIfMatch = false;   // 模拟不支持条件写入的服务器
    this.conflictPaths = new Set(); // 对这些路径的 PUT 恒定返回 412
  }

  etag() {
    return this.noEtag ? '' : `etag-${++this.counter}`;
  }

  _response(status, body = '', etag = undefined) {
    const headers = {};
    if (!this.noEtag) headers['ETag'] = etag !== undefined ? etag : this.etag();
    if (status === 204 || status === 304) return new Response(null, { status, headers });
    return new Response(body, { status, headers });
  }

  async fetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const path = decodeURIComponent(new URL(url).pathname).replace(/^.*\/BetterBrowse\/?/, '');
    const headers = options.headers || {};
    const ifMatch = headers['If-Match'];
    const ifNoneMatch = headers['If-None-Match'];
    const file = this.files.get(path);

    if (method === 'MKCOL') {
      if (this.files.has(path)) return this._response(405);
      this.files.set(path, { body: '', etag: this.etag() });
      return this._response(201);
    }
    if (method === 'GET') {
      if (!file) return this._response(404);
      return this._response(200, file.body, file.etag);
    }
    if (method === 'HEAD') {
      if (!file) return this._response(404);
      return this._response(200, '', file.etag);
    }
    if (method === 'DELETE') {
      if (!file) return this._response(404);
      this.files.delete(path);
      return this._response(204);
    }
    if (method === 'PUT') {
      if (this.conflictPaths.has(path)) return this._response(412);
      if (ifMatch && !this.ignoreIfMatch) {
        if (!file || file.etag !== ifMatch) return this._response(412);
      }
      if (ifNoneMatch === '*' && file) return this._response(412);
      const etag = this.etag();
      this.files.set(path, { body: options.body ?? '', etag });
      return this._response(201, '', etag);
    }
    return this._response(405);
  }

  getManifest() {
    const raw = this.files.get('manifest.json');
    return raw ? JSON.parse(raw.body) : null;
  }

  async putManifest(manifest) {
    const body = JSON.stringify(manifest, null, 2);
    this.files.set('manifest.json', { body, etag: this.etag() });
  }
}

/** 读取 IndexedDB 单条记录（测试辅助） */
async function readRecord(storeName, key) {
  return await IndexedDBManager.runTransaction([storeName], 'readonly', async (tx) => {
    return await IndexedDBManager.requestToPromise(tx.objectStore(storeName).get(key));
  });
}

/** 初始化一个完成 v8 迁移、已配置 WebDAV 的设备环境 */
async function setupDevice(server, { seedSchema = 7 } = {}) {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: seedSchema });
  await MigrationManager.runMigrations();
  await WebdavCredentials.save({
    serverUrl: 'https://dav.test/dav/',
    username: 'alice',
    password: 'test-password-do-not-leak'
  });
  await StorageAdapter.updateUserConfig({ webdavSync: { enabled: true, autoSync: true } });
  SyncEngine.fetchImpl = (url, options) => server.fetch(url, options);
  return { idb, store };
}

Deno.test("WebdavClient: 缺失条件写入能力时进入兼容模式，正常服务器返回 full", async () => {
  const server = new FakeWebdavServer();
  server.noEtag = true;
  let client = new (await import("../src/core/sync/webdav-client.js")).WebdavClient({
    serverUrl: 'https://dav.test/dav/',
    username: 'u',
    password: 'p',
    fetchImpl: (url, options) => server.fetch(url, options)
  });
  const missing = await client.probeCapability();
  assertEquals(missing.ok, true);
  assertEquals(missing.etagSupport, 'partial');
  assertEquals(missing.reason, '服务器未返回 ETag');

  const server2 = new FakeWebdavServer();
  server2.ignoreIfMatch = true;
  client = new (await import("../src/core/sync/webdav-client.js")).WebdavClient({
    serverUrl: 'https://dav.test/dav/',
    username: 'u',
    password: 'p',
    fetchImpl: (url, options) => server2.fetch(url, options)
  });
  const weak = await client.probeCapability();
  assertEquals(weak.ok, true);
  assertEquals(weak.etagSupport, 'partial');
  assertEquals(weak.reason.includes('412'), true);

  const server3 = new FakeWebdavServer();
  client = new (await import("../src/core/sync/webdav-client.js")).WebdavClient({
    serverUrl: 'https://dav.test/dav/',
    username: 'u',
    password: 'p',
    fetchImpl: (url, options) => server3.fetch(url, options)
  });
  const ok = await client.probeCapability();
  assertEquals(ok.ok, true);
  assertEquals(ok.etagSupport, 'full');
});

Deno.test("MigrationManager: v8 初始化同步时钟并按 pageId 转换活跃度", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({
    [StorageKeys.SCHEMA_VERSION]: 7,
    [StorageKeys.USER_CONFIG]: { tabThreshold: 30 }
  });
  try {
    // 预置 v7 形态的活跃度（tabId 键 + pageId 键混合）
    await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], 'readwrite', async (tx) => {
      tx.objectStore(IDBStores.ACTIVITY_STATS).put({
        key: StorageKeys.ACTIVITY_STATS,
        value: {
          "7": { lastActivated: 123, activationTimestamps: [123] },
          "page_deadbeef": { url: 'https://x.com', lastActivated: 456, activationTimestamps: [456] }
        },
        updatedAt: 1
      });
    });

    await MigrationManager.runMigrations();
    assertEquals(store[StorageKeys.SCHEMA_VERSION], 8);

    const clock = await readRecord(IDBStores.SYNC_META, 'clock');
    assertEquals(typeof clock?.value?.deviceId, 'string');
    assertEquals(clock.value.deviceId.length > 0, true);
    assertEquals(typeof clock.value.datasetId, 'string');

    const stats = await StorageAdapter.get(StorageKeys.ACTIVITY_STATS, {});
    assertEquals(stats["7"], undefined);
    assertEquals(stats["page_deadbeef"].lastActivated, 456);

    // 幂等重跑：deviceId 不变
    const deviceId = clock.value.deviceId;
    store[StorageKeys.SCHEMA_VERSION] = 7;
    await MigrationManager.runMigrations();
    const clockAgain = await readRecord(IDBStores.SYNC_META, 'clock');
    assertEquals(clockAgain.value.deviceId, deviceId);
  } finally {
    await idb.restore();
  }
});

Deno.test("SyncEngine: 首次同步上传批次并生成快照基线，凭据与自动备份不进入快照", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup(
      [
        { url: "https://sync.com/a", title: "页面甲" },
        { url: "https://sync.com/b", title: "页面乙" }
      ],
      "同步组一"
    );
    assertEquals((await SyncOutbox.listPending()).length > 0, true);

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);
    assertEquals(result.status, SyncStatus.SYNCED);

    const manifest = server.getManifest();
    assertEquals(manifest.generation, 1);
    assertEquals(manifest.operationFiles.length, 1);
    assertEquals(manifest.snapshotId, 'gen-0001');
    assertEquals(manifest.knownDevices.length, 1);
    assertEquals(server.files.has('snapshots/gen-0001.json'), true);
    assertEquals(server.files.has(`devices/${manifest.knownDevices[0].deviceId}.json`), true);

    // 上传完成后 outbox 清空
    assertEquals((await SyncOutbox.listPending()).length, 0);

    // 快照包含页面与设置，但绝不包含凭据与本地自动备份
    const snapshot = JSON.parse(server.files.get('snapshots/gen-0001.json').body);
    assertEquals(snapshot.pages.length, 2);
    assertEquals(snapshot.stashGroups.length, 1);
    assertEquals(snapshot.settings[StorageKeys.WEBDAV_CREDENTIALS], undefined);
    assertEquals(snapshot.settings[StorageKeys.AUTO_BACKUPS], undefined);
    assertEquals(JSON.stringify(snapshot).includes('test-password-do-not-leak'), false);
    const exported = await LocalStashRepository.exportFullBackupJSON();
    assertEquals(exported.includes('test-password-do-not-leak'), false);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 拉取其他设备操作，同字段并发修改写入冲突记录且双方候选保留", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://conflict.com", title: "初始标题" }], "冲突组");
    await SyncEngine.run({ manual: true });

    const groups = await LocalStashRepository.getAllGroups();
    const groupId = groups[0].id;
    const groupRecord = await readRecord(IDBStores.STASH_GROUPS, groupId);
    const localLamport = groupRecord.fieldRevs.title.lamport;
    const localDevice = groupRecord.fieldRevs.title.deviceId;

    // 模拟设备 B 离线期间对同字段做了修改（lamport 相同、deviceId 不同 → 冲突）
    const opB = {
      operationId: 'op_b_1',
      deviceId: 'devB-offline',
      sequence: 1,
      lamport: localLamport,
      entityType: SyncEntityTypes.STASH_GROUP,
      entityId: groupId,
      op: 'patch',
      fields: { title: 'B 端改名' },
      fieldRevs: { title: { lamport: localLamport, deviceId: 'devB-offline', operationId: 'op_b_1' } },
      createdAt: Date.now()
    };
    const batchBody = JSON.stringify(opB) + '\n';
    const batchPath = 'operations/devB-offline/1-1-batchB.ndjson';
    server.files.set(batchPath, { body: batchBody, etag: server.etag() });
    const manifest = server.getManifest();
    manifest.operationFiles.push({
      deviceId: 'devB-offline', start: 1, end: 1, batchId: 'batchB', path: batchPath, sha256: await sha256Hex(batchBody)
    });
    manifest.knownDevices.push({ deviceId: 'devB-offline', lastSeenAt: Date.now(), retired: false });
    await server.putManifest(manifest);

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);

    // 冲突已记录，双方候选均保留
    const conflicts = await SyncMerge.listConflicts();
    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0].entityType, SyncEntityTypes.STASH_GROUP);
    assertEquals(conflicts[0].incomingValue, 'B 端改名');
    assertEquals(conflicts[0].resolved, false);

    // 暂定值采纳了 (lamport, deviceId) 字典序较大的一方（devB-offline > 本机 dev）
    const merged = await readRecord(IDBStores.STASH_GROUPS, groupId);
    assertEquals(merged.fieldRevs.title.deviceId !== localDevice || merged.title === 'B 端改名', true);
    assertEquals(merged.title, 'B 端改名');

    // 本机再次同步不会重复应用 B 的操作（operationLogs 去重）
    const again = await SyncEngine.run({ manual: true });
    assertEquals(again.success, true);
    assertEquals((await SyncMerge.listConflicts()).length, 1);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 删除以墓碑传播，回收期内拒绝离线旧副本复活", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://tomb.com", title: "待删组" }], "墓碑组");
    await SyncEngine.run({ manual: true });
    const groupId = (await LocalStashRepository.getAllGroups())[0].id;

    await LocalStashRepository.deleteGroup(groupId);
    const upload = await SyncEngine.run({ manual: true });
    assertEquals(upload.success, true);
    assertEquals((await LocalStashRepository.getAllGroups()).length, 0);

    // 模拟另一台长期离线设备用极高 lamport 复活同 id 组
    const opResurrect = {
      operationId: 'op_b_resurrect',
      deviceId: 'devB-offline',
      sequence: 2,
      lamport: 9999,
      entityType: SyncEntityTypes.STASH_GROUP,
      entityId: groupId,
      op: 'upsert',
      fields: { title: '离线副本复活', locked: false, starred: false, archived: false, createdAt: Date.now() },
      fieldRevs: { title: { lamport: 9999, deviceId: 'devB-offline', operationId: 'op_b_resurrect' } },
      createdAt: Date.now()
    };
    const batchBody = JSON.stringify(opResurrect) + '\n';
    const batchPath = 'operations/devB-offline/2-2-batchR.ndjson';
    server.files.set(batchPath, { body: batchBody, etag: server.etag() });
    const manifest = server.getManifest();
    manifest.operationFiles.push({
      deviceId: 'devB-offline', start: 2, end: 2, batchId: 'batchR', path: batchPath, sha256: await sha256Hex(batchBody)
    });
    await server.putManifest(manifest);

    await SyncEngine.run({ manual: true });
    assertEquals((await LocalStashRepository.getAllGroups()).length, 0);

    const tomb = await readRecord(IDBStores.TOMBSTONES, `${SyncEntityTypes.STASH_GROUP}::${groupId}`);
    assertEquals(typeof tomb?.expiresAt, 'number');
    assertEquals(tomb.expiresAt > Date.now(), true);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 清单条件写入被拒（412）时保持待上传状态且不覆盖远端", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    server.conflictPaths.add('manifest.json');
    await LocalStashRepository.createGroup([{ url: "https://cf.test", title: "条件写" }], "条件写组");

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, false);
    assertEquals(result.status, SyncStatus.CONFLICT);
    // 批次已上传但清单未更新：操作保持待上传，下次重试
    assertEquals((await SyncOutbox.listPending()).length > 0, true);
    assertEquals(server.getManifest(), null);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 无 ETag 服务器以兼容模式完成完整同步", async () => {
  const server = new FakeWebdavServer();
  server.noEtag = true;
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://cap.test", title: "兼容模式" }], "兼容组");
    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);
    assertEquals(result.status, SyncStatus.SYNCED);
    // 批次与清单均已写入远端，outbox 清空
    const manifest = server.getManifest();
    assertEquals(manifest.operationFiles.length, 1);
    assertEquals(server.files.has(`snapshots/${manifest.snapshotId}.json`), true);
    assertEquals((await SyncOutbox.listPending()).length, 0);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 忽略 If-Match 的网盘服务器（如 123 云盘）兼容模式下同步成功", async () => {
  const server = new FakeWebdavServer();
  server.ignoreIfMatch = true;
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://pan.test/a", title: "网盘页" }], "网盘组");

    const probe = await SyncEngine.testConnection();
    assertEquals(probe.success, true);
    assertEquals(probe.compatMode, true);
    assertEquals(probe.message.includes('兼容模式'), true);

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);
    assertEquals(result.status, SyncStatus.SYNCED);
    const manifest = server.getManifest();
    assertEquals(manifest.operationFiles.length, 1);
    assertEquals(manifest.snapshotId.startsWith('gen-0001'), true);
    assertEquals((await SyncOutbox.listPending()).length, 0);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 清单合并基于最新远端内容，不覆盖其他设备并发写入", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    // 第一次同步建立远端清单与快照基线
    await LocalStashRepository.createGroup([{ url: "https://race.com/a", title: "第一批" }], "批次一组");
    await SyncEngine.run({ manual: true });
    assertEquals((await SyncOutbox.listPending()).length, 0);

    // 本机产生新的待上传操作
    await LocalStashRepository.createGroup([{ url: "https://race.com/b", title: "第二批" }], "批次二组");

    // 在清单最终合并读取（每次运行的第二次 manifest GET）时注入设备 C 的并发写入，
    // 模拟批次上传期间其他设备已更新清单的场景
    let manifestGets = 0;
    const opC = {
      operationId: 'op_c_1',
      deviceId: 'devC',
      sequence: 1,
      lamport: 1,
      entityType: SyncEntityTypes.STASH_GROUP,
      entityId: 'groupC-devc',
      op: 'upsert',
      fields: { title: '设备C并发组', locked: false, starred: false, archived: false, createdAt: Date.now() },
      fieldRevs: { title: { lamport: 1, deviceId: 'devC', operationId: 'op_c_1' } },
      createdAt: Date.now()
    };
    const batchBodyC = JSON.stringify(opC) + '\n';
    const batchPathC = 'operations/devC/1-1-batchC.ndjson';
    server.files.set(batchPathC, { body: batchBodyC, etag: server.etag() });
    const realFetch = (url, options) => server.fetch(url, options);
    SyncEngine.fetchImpl = async (url, options) => {
      const method = (options?.method || 'GET').toUpperCase();
      const p = decodeURIComponent(new URL(url).pathname).replace(/^.*\/BetterBrowse\/?/, '');
      if (method === 'GET' && p === 'manifest.json') {
        manifestGets += 1;
        if (manifestGets === 2) {
          const m = server.getManifest();
          m.operationFiles.push({
            deviceId: 'devC', start: 1, end: 1, batchId: 'batchC', path: batchPathC, sha256: await sha256Hex(batchBodyC)
          });
          m.knownDevices.push({ deviceId: 'devC', lastSeenAt: Date.now(), retired: false });
          await server.putManifest(m);
        }
      }
      return realFetch(url, options);
    };

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);

    // 最终清单同时保留本机批次与设备 C 的并发批次（基于最新远端内容合并而非覆盖）
    const manifest = server.getManifest();
    assertEquals(manifest.operationFiles.some((f) => f.path === batchPathC), true);
    const clock = await SyncOutbox.getClock();
    assertEquals(manifest.operationFiles.some((f) => f.deviceId === clock.deviceId), true);
    // 设备 C 的数据被本机拉取合并
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.some((g) => g.id === 'groupC-devc'), true);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncMerge: 活跃度按 pageId 合并（时间戳并集 + lastActivated 取最大）", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 7 });
  try {
    await MigrationManager.runMigrations();
    const now = Date.now();
    await StorageAdapter.set(StorageKeys.ACTIVITY_STATS, {
      page_merge_1: { url: 'https://m.com', lastActivated: now - 3600_000, activationTimestamps: [now - 3600_000, now - 1800_000] }
    });

    const result = await SyncMerge.applyOperations([{
      operationId: 'op_act_1',
      deviceId: 'devB-offline',
      sequence: 1,
      lamport: 1,
      entityType: SyncEntityTypes.ACTIVITY,
      entityId: 'stats',
      op: 'upsert',
      fields: {
        pages: {
          page_merge_1: { url: 'https://m.com', lastActivated: now - 900_000, activationTimestamps: [now - 900_000] }
        }
      },
      fieldRevs: {},
      createdAt: Date.now()
    }]);
    assertEquals(result.applied, 1);

    const stats = await StorageAdapter.get(StorageKeys.ACTIVITY_STATS, {});
    const record = stats.page_merge_1;
    assertEquals(record.lastActivated, now - 900_000);
    assertEquals(record.activationTimestamps.includes(now - 3600_000), true);
    assertEquals(record.activationTimestamps.includes(now - 900_000), true);
    assertEquals(record.activationTimestamps.includes(now - 1800_000), true);
  } finally {
    await idb.restore();
  }
});

Deno.test("DeviceEventLog: 本机事件进入 deviceEvents 与 outbox，远端事件按 operationId 去重", async () => {
  const idb = installFakeIndexedDB();
  const store = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 7 });
  try {
    await MigrationManager.runMigrations();
    const event = await DeviceEventLog.append('countdown_start', { threshold: 15 });
    assertEquals(typeof event?.eventId, 'string');
    assertEquals((await DeviceEventLog.listRecent()).length, 1);

    // 同一事件从远端重放：operationId 相同（entityId 即 eventId）→ 跳过
    const result = await SyncMerge.applyOperations([{
      operationId: 'op_evt_remote_1',
      deviceId: event.deviceId,
      sequence: event.sequence,
      lamport: 1,
      entityType: SyncEntityTypes.DEVICE_EVENT,
      entityId: event.eventId,
      op: 'upsert',
      fields: { type: 'countdown_start', payload: {}, originDeviceId: event.deviceId },
      fieldRevs: {},
      createdAt: event.createdAt
    }]);
    assertEquals((await DeviceEventLog.listRecent()).length, 1);
    assertEquals(result.applied + result.skipped, 1);

    // 其他设备的事件作为新实体并存
    await SyncMerge.applyOperations([{
      operationId: 'op_evt_remote_2',
      deviceId: 'devB-offline',
      sequence: 3,
      lamport: 2,
      entityType: SyncEntityTypes.DEVICE_EVENT,
      entityId: 'evt_b_1',
      op: 'upsert',
      fields: { type: 'stash_executed', payload: {}, originDeviceId: 'devB-offline' },
      fieldRevs: {},
      createdAt: Date.now()
    }]);
    const events = await DeviceEventLog.listRecent();
    assertEquals(events.length, 2);
    assertEquals(events.some((e) => e.originDeviceId === 'devB-offline'), true);
  } finally {
    await idb.restore();
  }
});

Deno.test("SyncEngine: 连续 90 天未同步的设备在同步时自动退役", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://retire.test", title: "退役" }], "退役组");
    await SyncEngine.run({ manual: true });

    const manifest = server.getManifest();
    manifest.knownDevices.push({
      deviceId: 'dev-stale',
      lastSeenAt: Date.now() - 91 * 86400000,
      retired: false
    });
    await server.putManifest(manifest);

    const result = await SyncEngine.run({ manual: true });
    assertEquals(result.success, true);
    const updated = server.getManifest();
    const stale = updated.knownDevices.find((d) => d.deviceId === 'dev-stale');
    assertEquals(stale.retired, true);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncSnapshot: 快照 watermark 之后才重放操作", () => {
  const ops = [
    { deviceId: 'devA', sequence: 1 },
    { deviceId: 'devA', sequence: 5 },
    { deviceId: 'devB', sequence: 2 }
  ];
  const filtered = SyncSnapshot.filterAfterWatermark(ops, { devA: 3, devB: 9 });
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].sequence, 5);
});

Deno.test("SyncMerge: 冲突裁决写回页面标题、域名规则与收纳组", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://resolve.test/p", title: "本机标题" }], "本机组名");
    const groups = await LocalStashRepository.getAllGroups();
    const groupId = groups[0].id;
    const pageRecord = await IndexedDBManager.runTransaction([IDBStores.PAGES], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).getAll());
      return all[0];
    });

    await IndexedDBManager.runTransaction([IDBStores.CONFLICTS], 'readwrite', async (tx) => {
      tx.objectStore(IDBStores.CONFLICTS).put({
        conflictId: 'page-title',
        entityType: SyncEntityTypes.PAGE,
        entityId: pageRecord.pageId,
        field: 'title',
        localValue: '本机标题',
        incomingValue: '云端标题',
        resolved: false
      });
      tx.objectStore(IDBStores.CONFLICTS).put({
        conflictId: 'group-title',
        entityType: SyncEntityTypes.STASH_GROUP,
        entityId: groupId,
        field: 'title',
        localValue: '本机组名',
        incomingValue: '云端组名',
        resolved: false
      });
      tx.objectStore(IDBStores.CONFLICTS).put({
        conflictId: 'rule-github',
        entityType: SyncEntityTypes.LINK_RULES,
        entityId: 'root',
        field: 'github.com',
        localValue: 'current',
        incomingValue: 'new',
        resolved: false
      });
    });

    assertEquals((await SyncMerge.resolveConflict('page-title', 'incoming')).success, true);
    assertEquals((await SyncMerge.resolveConflict('group-title', 'local')).success, true);
    assertEquals((await SyncMerge.resolveConflict('rule-github', 'incoming')).success, true);

    const pageAfter = await readRecord(IDBStores.PAGES, pageRecord.pageId);
    assertEquals(pageAfter.title, '云端标题');
    const groupAfter = await readRecord(IDBStores.STASH_GROUPS, groupId);
    assertEquals(groupAfter.title, '本机组名');
    const rules = await StorageAdapter.get(StorageKeys.LINK_RULES, {});
    assertEquals(rules['github.com'], 'new');
    assertEquals((await SyncMerge.listConflicts()).length, 0);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});

Deno.test("SyncEngine: 当前快照损坏时回退上一份本地缓存", async () => {
  const server = new FakeWebdavServer();
  const { idb } = await setupDevice(server);
  try {
    await LocalStashRepository.createGroup([{ url: "https://snap.test/a", title: "快照页" }], "快照组");
    const first = await SyncEngine.run({ manual: true });
    assertEquals(first.success, true);
    const manifest = server.getManifest();
    const previousId = manifest.snapshotId;
    await SyncSnapshot.cacheLocal(previousId, await SyncSnapshot.buildPayload(), manifest.snapshotSha256);

    const nextId = 'gen-0002';
    manifest.previousSnapshotId = previousId;
    manifest.snapshotId = nextId;
    manifest.snapshotSha256 = 'deadbeef';
    await server.putManifest(manifest);
    server.files.set(`snapshots/${nextId}.json`, { body: '{not-json', etag: 'bad' });

    const payload = await SyncEngine.fallbackToPreviousSnapshot(
      SyncEngine._client(await WebdavCredentials.get()),
      previousId
    );
    assertEquals(Boolean(payload?.stashGroups?.length), true);

    const rebuilt = await SyncEngine.rebuildFromScratch({ confirm: true });
    assertEquals(rebuilt.success, true);
    assertEquals(rebuilt.source, 'local-snapshot');
    const refused = await SyncEngine.rebuildFromScratch({});
    assertEquals(refused.success, false);
  } finally {
    SyncEngine.fetchImpl = null;
    await idb.restore();
  }
});
