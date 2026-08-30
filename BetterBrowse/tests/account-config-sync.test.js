/**
 * @file account-config-sync.test.js
 * @description 浏览器账号偏好镜像：切片剥离、配额跳过、hydrate、相等忽略与凭据隔离
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { StorageKeys } from "../src/constants/storage-keys.js";
import { DefaultConfig } from "../src/constants/config.js";
import { ACCOUNT_CONFIG_MAX_BYTES, ACCOUNT_CONFIG_PAYLOAD_VERSION } from "../src/core/sync/sync-constants.js";
import { StorageAdapter } from "../src/core/storage/storage-adapter.js";
import { MigrationManager } from "../src/core/storage/migration.js";
import { AccountConfigSync } from "../src/core/sync/account-config-sync.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

function installMockStorage(initialData = {}, { withSync = true } = {}) {
  const localStore = { ...initialData };
  const syncStore = {};
  const listeners = [];
  const chromeObj = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: () => Promise.resolve()
    },
    storage: {
      local: {
        get: (keys, callback) => {
          if (typeof keys === 'string') return callback({ [keys]: localStore[keys] });
          if (Array.isArray(keys)) {
            const res = {};
            keys.forEach((k) => { res[k] = localStore[k]; });
            return callback(res);
          }
          callback({});
        },
        set: (items, callback) => {
          Object.assign(localStore, items);
          callback?.();
        }
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn)
      }
    }
  };
  if (withSync) {
    chromeObj.storage.sync = {
      get: (keys, callback) => {
        if (typeof keys === 'string') return callback({ [keys]: syncStore[keys] });
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach((k) => { res[k] = syncStore[k]; });
          return callback(res);
        }
        callback({ ...syncStore });
      },
      set: (items, callback) => {
        const changes = {};
        for (const [key, value] of Object.entries(items || {})) {
          changes[key] = { oldValue: syncStore[key], newValue: value };
          syncStore[key] = value;
        }
        callback?.();
        for (const fn of listeners) fn(changes, 'sync');
      }
    };
  }
  globalThis.chrome = chromeObj;
  return { localStore, syncStore, listeners };
}

async function setupIdb(schema = 8, { withSync = true } = {}) {
  AccountConfigSync.resetForTests();
  const idb = installFakeIndexedDB();
  const stores = installMockStorage({ [StorageKeys.SCHEMA_VERSION]: schema }, { withSync });
  await MigrationManager.runMigrations();
  await AccountConfigSync.flushPending();
  AccountConfigSync.resetForTests();
  return { idb, ...stores };
}

Deno.test("AccountConfigSync.slice: 剥离 fieldRevs、凭据与域名表，只保留偏好切片", () => {
  const sliced = AccountConfigSync.slice({
    tabThreshold: 22,
    fieldRevs: { tabThreshold: { lamport: 9 } },
    username: 'should-not-appear',
    password: 'secret',
    linkRules: { 'example.com': 'new' },
    webdavSync: {
      enabled: true,
      autoSync: false,
      serverUrl: 'https://dav.example.com/dav/',
      username: 'alice',
      password: 'secret'
    },
    accountConfigSync: { enabled: true },
    stashSettings: { restoreBehavior: 'keep', fieldRevs: { x: 1 } }
  });
  assertEquals(sliced.tabThreshold, 22);
  assertEquals(sliced.fieldRevs, undefined);
  assertEquals(sliced.username, undefined);
  assertEquals(sliced.password, undefined);
  assertEquals(sliced.linkRules, undefined);
  assertEquals(sliced.webdavSync.serverUrl, 'https://dav.example.com/dav/');
  assertEquals(sliced.webdavSync.enabled, true);
  assertEquals(sliced.webdavSync.autoSync, false);
  assertEquals(sliced.webdavSync.username, undefined);
  assertEquals(sliced.webdavSync.password, undefined);
  assertEquals(sliced.stashSettings.restoreBehavior, 'keep');
  assertEquals(sliced.stashSettings.fieldRevs, undefined);
  assertEquals(sliced.accountConfigSync.enabled, true);
});

Deno.test("AccountConfigSync.buildPayload: 超过 8000 字节则跳过写入", () => {
  const huge = AccountConfigSync.slice(DefaultConfig);
  huge.webdavSync.serverUrl = `https://dav.example.com/${'a'.repeat(ACCOUNT_CONFIG_MAX_BYTES)}`;
  const built = AccountConfigSync.buildPayload(huge);
  assertEquals(built, null);
  const ok = AccountConfigSync.buildPayload(AccountConfigSync.slice(DefaultConfig));
  assertEquals(ok.payload.v, ACCOUNT_CONFIG_PAYLOAD_VERSION);
  assertEquals(ok.bytes > 0, true);
  assertEquals(ok.bytes <= ACCOUNT_CONFIG_MAX_BYTES, true);
});

Deno.test("AccountConfigSync: 本机写配置后异步镜像到 chrome.storage.sync，不含密码与域名表", async () => {
  const { syncStore } = await setupIdb();
  try {
    await StorageAdapter.updateUserConfig({
      tabThreshold: 28,
      webdavSync: { enabled: true, serverUrl: 'https://dav.test/dav/' }
    });
    await AccountConfigSync.flushPending();
    const payload = syncStore[StorageKeys.ACCOUNT_CONFIG];
    assertEquals(payload?.v, ACCOUNT_CONFIG_PAYLOAD_VERSION);
    assertEquals(payload.config.tabThreshold, 28);
    assertEquals(payload.config.webdavSync.serverUrl, 'https://dav.test/dav/');
    assertEquals(JSON.stringify(payload).includes('password'), false);
    assertEquals(payload.config.linkRules, undefined);
    assertEquals(syncStore[StorageKeys.USER_CONFIG], undefined);
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync: chrome.storage.sync 缺失时跳过，不回退 local", async () => {
  const { localStore } = await setupIdb(8, { withSync: false });
  try {
    const mirrored = await AccountConfigSync.mirror({ tabThreshold: 40 });
    assertEquals(mirrored, false);
    assertEquals(localStore[StorageKeys.ACCOUNT_CONFIG], undefined);
    assertEquals(AccountConfigSync.getSyncArea(), null);
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync.hydrate: 本机仍是默认值时采用账号偏好", async () => {
  const { syncStore } = await setupIdb();
  try {
    const incoming = AccountConfigSync.slice({
      ...DefaultConfig,
      tabThreshold: 42,
      webdavSync: { enabled: true, autoSync: true, serverUrl: 'https://dav.other/dav/' }
    });
    syncStore[StorageKeys.ACCOUNT_CONFIG] = {
      v: ACCOUNT_CONFIG_PAYLOAD_VERSION,
      updatedAt: Date.now() + 1000,
      config: incoming
    };
    const result = await AccountConfigSync.hydrate();
    assertEquals(result, 'applied');
    const local = await StorageAdapter.getUserConfig();
    assertEquals(local.tabThreshold, 42);
    assertEquals(local.webdavSync.serverUrl, 'https://dav.other/dav/');
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync.hydrate: 本机已有偏好且账号为空时推上去", async () => {
  const { syncStore } = await setupIdb();
  try {
    await StorageAdapter.updateUserConfig({ tabThreshold: 33 });
    await AccountConfigSync.flushPending();
    delete syncStore[StorageKeys.ACCOUNT_CONFIG];
    AccountConfigSync.resetForTests();
    const result = await AccountConfigSync.hydrate();
    assertEquals(result, 'pushed');
    assertEquals(syncStore[StorageKeys.ACCOUNT_CONFIG].config.tabThreshold, 33);
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync.applyRemote: 切片相等则忽略，避免回环覆盖", async () => {
  const env = await setupIdb();
  try {
    await StorageAdapter.updateUserConfig({ tabThreshold: 19 });
    await AccountConfigSync.flushPending();
    const before = env.syncStore[StorageKeys.ACCOUNT_CONFIG];
    const applied = await AccountConfigSync.applyRemote(before);
    assertEquals(applied, false);
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync.applyRemote: 远端偏好写入 IndexedDB 并进入本机权威配置", async () => {
  await setupIdb();
  try {
    const incoming = {
      v: ACCOUNT_CONFIG_PAYLOAD_VERSION,
      updatedAt: Date.now(),
      config: AccountConfigSync.slice({
        ...DefaultConfig,
        tabThreshold: 51,
        countdownSeconds: 8
      })
    };
    const applied = await AccountConfigSync.applyRemote(incoming);
    assertEquals(applied, true);
    const local = await StorageAdapter.getUserConfig();
    assertEquals(local.tabThreshold, 51);
    assertEquals(local.countdownSeconds, 8);
  } finally {
    AccountConfigSync.resetForTests();
  }
});

Deno.test("AccountConfigSync.sanitizeIncoming: 丢掉密码与未知机密字段", () => {
  const clean = AccountConfigSync.sanitizeIncoming({
    v: ACCOUNT_CONFIG_PAYLOAD_VERSION,
    config: {
      tabThreshold: 16,
      username: 'alice',
      password: 'secret',
      webdavSync: { serverUrl: 'https://dav.test/dav/', username: 'alice', password: 'secret' }
    }
  });
  assertEquals(clean.tabThreshold, 16);
  assertEquals(clean.username, undefined);
  assertEquals(clean.password, undefined);
  assertEquals(clean.webdavSync.username, undefined);
  assertEquals(clean.webdavSync.password, undefined);
});

Deno.test("StorageAdapter.mergeUserConfig: 补齐 accountConfigSync 默认值", () => {
  const merged = StorageAdapter.mergeUserConfig({ tabThreshold: 18 });
  assertEquals(merged.accountConfigSync.enabled, true);
  assertEquals(merged.tabThreshold, 18);
});
