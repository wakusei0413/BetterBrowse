/**
 * @file webdav-remote-gc.test.js
 * @description 远端回收、严格服务器上传、无条件写入服务器的并发覆盖自愈与能力探测缓存
 * @encoding UTF-8
 */

import { assert, assertEquals } from "@std/assert";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { MigrationManager } from "../BetterBrowse/src/core/storage/migration.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import { IndexedDBManager } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { LocalStashRepository } from "../BetterBrowse/src/core/stash/local-stash-repo.js";
import { WebdavCredentials } from "../BetterBrowse/src/core/sync/credentials.js";
import { SyncEngine } from "../BetterBrowse/src/core/sync/sync-engine.js";
import { WebdavClient } from "../BetterBrowse/src/core/sync/webdav-client.js";
import { embeddedTimestamp } from "../BetterBrowse/src/core/sync/remote-gc.js";
import { FakeIDBFactory } from "./helpers/fake-indexeddb.js";
import { FakeWebdavServer, installChromeStore, useDevice } from "./helpers/fake-webdav.js";

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

async function withServer(fn, setup = () => {}) {
  const server = new FakeWebdavServer();
  setup(server);
  SyncEngine.fetchImpl = (url, options) => server.fetch(url, options);
  const delay = SyncEngine.compatVerifyDelayMs;
  SyncEngine.compatVerifyDelayMs = 0;
  try {
    await fn(server);
  } finally {
    SyncEngine.fetchImpl = null;
    SyncEngine.compatVerifyDelayMs = delay;
    await IndexedDBManager.close();
  }
}

const OLD = (Date.now() - 30 * 86400000).toString(36);

/** 模拟旧数据集遗留：大量快照、未登记批次、陌生设备文件与探测残留 */
function seedLegacyJunk(server) {
  const junk = [
    'snapshots/gen-0412.json',
    'snapshots/gen-0413.json',
    `snapshots/gen-0002_${OLD}_aaaaaaaa.json`,
    `operations/dev_${OLD}_oldoldol/1-40-batch_${OLD}_bbbbbbbb.ndjson`,
    `devices/dev_${OLD}_oldoldol.json`,
    '.bb-capability-probe'
  ];
  for (const path of junk) server.files.set(path, { body: 'x'.repeat(1000), etag: server.etag() });
  return junk;
}

Deno.test("远端回收：只删清单未引用的旧文件，保留当前快照、批次、设备文件与刚写入的在途文件", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    const junk = seedLegacyJunk(server);
    // 在途文件：其他设备刚上传、尚未写入清单
    const fresh = `operations/dev_x/1-1-batch_${Date.now().toString(36)}_cccccccc.ndjson`;
    server.files.set(fresh, { body: '{}', etag: server.etag() });
    // 用户自己放在根目录的文件不得碰
    server.files.set('my-notes.txt', { body: 'hi', etag: server.etag() });

    const usage = await SyncEngine.getRemoteUsage();
    assertEquals(usage.success, true, usage.error);
    assertEquals(usage.garbageFiles, junk.length);
    assertEquals(usage.garbageBytes, junk.length * 1000);
    assertEquals(usage.skippedRecent, 1);

    const refused = await SyncEngine.cleanRemote({});
    assertEquals(refused.success, false, "缺少确认位必须拒绝");

    const cleaned = await SyncEngine.cleanRemote({ confirm: true });
    assertEquals(cleaned.success, true, cleaned.error);
    assertEquals(cleaned.deleted, junk.length);
    for (const path of junk) assertEquals(server.files.has(path), false, `${path} 应被删除`);
    assert(server.files.has(fresh), "15 分钟内的在途文件必须保留");
    assert(server.files.has('my-notes.txt'), "非本扩展管理的文件必须保留");

    const m = server.getManifest();
    assert(server.files.has(`snapshots/${m.snapshotId}.json`), "当前快照必须保留");
    for (const d of m.knownDevices) assert(server.files.has(`devices/${d.deviceId}.json`));
    for (const f of m.operationFiles) assert(server.files.has(f.path));

    // 清理后同步仍正常
    await sync('A2');
  });
});

Deno.test("远端回收：同步每天自动执行一次，远端没有清单时拒绝清理", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    const junk = seedLegacyJunk(server);
    const first = await sync('A1');
    assert(first.remoteGc, "首次同步应触发自动回收");
    for (const path of junk) assertEquals(server.files.has(path), false);

    seedLegacyJunk(server);
    const second = await sync('A2');
    assertEquals(second.remoteGc, undefined, "24 小时内不重复自动回收");

    server.files.delete('manifest.json');
    const refused = await SyncEngine.cleanRemote({ confirm: true });
    assertEquals(refused.success, false, "没有清单无法判断引用关系，必须拒绝");
  });
});

Deno.test("远端回收：服务器不支持 PROPFIND 时同步照常成功", async () => {
  await withServer(async () => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    const result = await sync('A1');
    assertEquals(result.remoteGc, undefined);
    const usage = await SyncEngine.getRemoteUsage();
    assertEquals(usage.success, false);
  }, (server) => { server.propfindStatus = 405; });
});

Deno.test("严格服务器：父目录不存在时 409 不再被当作上传成功，设备目录会先创建", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    const m = server.getManifest();
    // 清单里登记过的批次在被压缩前必须真实存在；首个快照之后批次已被压缩，改由新修改验证
    await LocalStashRepository.updateGroup((await LocalStashRepository.getAllGroups())[0].id, { title: "改" });
    await sync('A2');
    for (const f of server.getManifest().operationFiles) {
      assert(server.files.has(f.path), `清单引用的批次 ${f.path} 必须真实写入`);
    }
    assert(server.files.has(`snapshots/${m.snapshotId}.json`));
  }, (server) => { server.strictParents = true; });
});

Deno.test("无条件写入服务器：清单被并发覆盖丢掉本机批次时，写后回读会重新合并", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    await LocalStashRepository.updateGroup((await LocalStashRepository.getAllGroups())[0].id, { title: "A 改" });

    // 另一台设备在 A 写清单之后，基于 A 写入之前读到的旧清单覆盖了一次
    const before = server.files.get('manifest.json').body;
    let clobbered = false;
    server.onPut = (path) => {
      if (path !== 'manifest.json' || clobbered) return;
      const written = JSON.parse(server.files.get('manifest.json').body);
      if ((written.operationFiles || []).length === 0) return;
      clobbered = true;
      server.files.set('manifest.json', { body: before, etag: server.etag() });
    };
    await sync('A2');
    assert(clobbered, "应模拟一次并发覆盖");
    const m = server.getManifest();
    assert(m.operationFiles.length >= 1, "被覆盖后本机批次必须重新登记进清单");
    for (const f of m.operationFiles) assert(server.files.has(f.path));
  }, (server) => { server.ignoreConditions = true; });
});

Deno.test("无条件写入服务器：校验之后才发生的覆盖，下次同步自动补登记，另一台设备最终收到修改", async () => {
  await withServer(async (server) => {
    const A = await bootDevice('a');
    const groupId = (await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "原名")).group.id;
    await sync('A1');
    const B = await bootDevice('b');
    await sync('B1');

    await useDevice(A.factory, A.store);
    const before = server.files.get('manifest.json').body;
    await LocalStashRepository.updateGroup(groupId, { title: "A 改名" });
    await sync('A2');
    // A 校验通过之后，另一台设备用旧清单覆盖（A 的批次登记丢失）
    server.files.set('manifest.json', { body: before, etag: server.etag() });

    await sync('A3'); // 补登记
    await useDevice(B.factory, B.store);
    await sync('B2');
    const groups = await LocalStashRepository.getAllGroups();
    assertEquals(groups.find((g) => g.id === groupId)?.title, "A 改名", "被覆盖丢失的修改应经补登记传到其他设备");
  }, (server) => { server.ignoreConditions = true; });
});

Deno.test("能力探测结果缓存：连续同步不重复执行 7 个请求的探测", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await sync('A1');
    const mkcolBefore = server.requestCounts.MKCOL || 0;
    await sync('A2');
    await sync('A3');
    assertEquals((server.requestCounts.MKCOL || 0) - mkcolBefore, 0, "缓存期内不再执行目录探测");
    assertEquals(server.files.has('.bb-capability-probe'), false);
  });
});

Deno.test("WebdavClient.listDetailed：解析绝对 URL href、目录与大小，跳过目录自身", async () => {
  const body = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>https://dav.test/dav/BetterBrowse/snapshots/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>https://dav.test/dav/BetterBrowse/snapshots/gen-0001.json</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat></D:response>
    <D:response><D:href>/dav/BetterBrowse/snapshots/%E4%B8%AD%E6%96%87.json</D:href><D:propstat><D:prop><D:getcontentlength>7</D:getcontentlength></D:prop></D:propstat></D:response>
  </D:multistatus>`;
  const client = new WebdavClient({
    serverUrl: 'https://dav.test/dav/',
    fetchImpl: async () => new Response(body, { status: 207 })
  });
  const items = await client.listDetailed('snapshots');
  assertEquals(items, [
    { name: 'gen-0001.json', size: 2048, isDir: false },
    { name: '中文.json', size: 7, isDir: false }
  ]);
  assert(embeddedTimestamp(`gen-0001_${Date.now().toString(36)}_abcdefgh.json`) > 0);
  assertEquals(embeddedTimestamp('gen-0412.json'), 0);
});

Deno.test("远端回收：按时间预算分段删除，返回剩余数量供续跑", async () => {
  const { RemoteGarbageCollector } = await import("../BetterBrowse/src/core/sync/remote-gc.js");
  const deleted = [];
  const slowClient = {
    delete: async (path) => {
      deleted.push(path);
      await new Promise((r) => setTimeout(r, 20));
      return { status: 204 };
    }
  };
  const garbage = Array.from({ length: 50 }, (_, i) => ({ path: `snapshots/gen-${i}.json`, size: 10 }));
  const first = await RemoteGarbageCollector.collect(slowClient, garbage, { deadline: Date.now() + 100 });
  assert(first.deleted > 0 && first.deleted < 50, `应在预算内只删一部分，实际 ${first.deleted}`);
  assertEquals(first.remaining, 50 - first.deleted);
  assertEquals(first.remainingBytes, first.remaining * 10);
  const rest = await RemoteGarbageCollector.collect(slowClient, garbage.slice(first.deleted));
  assertEquals(rest.remaining, 0);
  assertEquals(deleted.length, 50);
});

Deno.test("服务器拒绝（403）与认证失败（401）分开报告，自动同步按失败退避，手动同步成功后清除退避", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await sync('A1');

    // 模拟 123 云盘限流：所有请求 403 {"code":1010}
    const realFetch = server.fetch.bind(server);
    let mode = 403;
    SyncEngine.fetchImpl = (url, options) => (mode
      ? Promise.resolve(new Response(mode === 403 ? '{"code":1010,"message":"s err"}' : '', { status: mode }))
      : realFetch(url, options));

    const rejected = await SyncEngine.run({ manual: true });
    assertEquals(rejected.status, 'server_rejected');
    assert(/拒绝请求（HTTP 403/.test(rejected.error), rejected.error);
    assert(!/认证失败/.test(rejected.error), "403 不得误报为认证失败");

    const auto = await SyncEngine.run({});
    assertEquals(auto.skipped, true, "退避期内自动同步直接跳过，不再请求服务器");
    assert(/自动同步暂停至/.test(auto.error));

    mode = 401;
    const unauthorized = await SyncEngine.run({ manual: true });
    assertEquals(unauthorized.status, 'auth_failed');
    assert(/请检查账号与密码/.test(unauthorized.error));

    mode = 0;
    await sync('恢复后手动同步');
    const resumed = await SyncEngine.run({});
    assertEquals(resumed.success, true, "手动同步成功后退避清除，自动同步恢复");
  });
});

Deno.test("远端读取错误分类：限流期间读快照或批次返回 403/503 不得判为数据损坏，只有 404 才算缺失", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    const B = await bootDevice('b');
    const snapshotPath = `snapshots/${server.getManifest().snapshotId}.json`;

    const realFetch = server.fetch.bind(server);
    let failStatus = 403;
    SyncEngine.fetchImpl = (url, options) => {
      const method = (options?.method || 'GET').toUpperCase();
      if (failStatus && method === 'GET' && decodeURIComponent(url).endsWith(snapshotPath)) {
        return Promise.resolve(new Response('{"code":1010,"message":"s err"}', { status: failStatus }));
      }
      return realFetch(url, options);
    };

    const throttled = await SyncEngine.run({ manual: true });
    assertEquals(throttled.status, 'server_rejected', `403 应判为服务器拒绝：${throttled.error}`);

    failStatus = 503;
    const unavailable = await SyncEngine.run({ manual: true });
    assertEquals(unavailable.status, 'unknown');
    assert(/暂时失败（HTTP 503）/.test(unavailable.error), unavailable.error);

    failStatus = 404;
    const missing = await SyncEngine.run({ manual: true });
    assertEquals(missing.status, 'corrupt', "快照确实不存在才是数据损坏");

    failStatus = 0;
    await useDevice(B.factory, B.store);
    await sync('恢复后 B 正常配对');
    assertEquals((await LocalStashRepository.getAllGroups()).length, 1);
  });
});

Deno.test("请求节流：无变化的同步只读一次清单，不重复下载已应用快照、不重写设备确认", async () => {
  await withServer(async (server) => {
    await bootDevice('a');
    await LocalStashRepository.createGroup([{ url: "https://t.example/1", title: "页" }], "组");
    await sync('A1');
    await sync('A2'); // 写入设备确认缓存

    const log = [];
    const realFetch = server.fetch.bind(server);
    SyncEngine.fetchImpl = (url, options) => {
      log.push(`${(options?.method || 'GET').toUpperCase()} ${decodeURIComponent(new URL(url).pathname).replace(/^.*\/BetterBrowse\/?/, '')}`);
      return realFetch(url, options);
    };
    await sync('A3');
    assertEquals(log, ['GET manifest.json'], `无变化同步应只有一次清单读取，实际：${log.join('，')}`);
  });
});
