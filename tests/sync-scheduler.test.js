/**
 * @file sync-scheduler.test.js
 * @description 云端同步周期闹钟不得在 SW 重启 / 配置保存时被重置
 * @encoding UTF-8
 */

import { assert, assertEquals } from "@std/assert";
import { SyncScheduler } from "../BetterBrowse/src/background/sync-scheduler.js";
import { SYNC_ALARM_MINUTES } from "../BetterBrowse/src/core/sync/sync-constants.js";

function installAlarmChrome(existing) {
  const created = [];
  globalThis.chrome = {
    alarms: {
      get: async () => existing,
      create: (name, info) => created.push({ name, ...info }),
      clear: () => {},
    },
  };
  return created;
}

const enabledConfig = { webdavSync: { enabled: true, autoSync: true } };

Deno.test("SyncScheduler：已有同周期闹钟时不重建（避免周期计时被清零）", async () => {
  const created = installAlarmChrome({ name: "better-browse-webdav-sync", periodInMinutes: SYNC_ALARM_MINUTES });
  SyncScheduler.onConfigUpdated(enabledConfig);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(created.length, 0);
});

Deno.test("SyncScheduler：闹钟缺失或周期不同则创建", async () => {
  const created = installAlarmChrome(undefined);
  SyncScheduler.onConfigUpdated(enabledConfig);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(created.length, 1);
  assertEquals(created[0].periodInMinutes, SYNC_ALARM_MINUTES);

  const recreated = installAlarmChrome({ name: "better-browse-webdav-sync", periodInMinutes: SYNC_ALARM_MINUTES + 1 });
  SyncScheduler.onConfigUpdated(enabledConfig);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(recreated.length, 1);
});

Deno.test("SyncScheduler：距上次自动同步不足最小间隔时顺延，连续修改只触发一次同步", async () => {
  const { SyncScheduler } = await import("../BetterBrowse/src/background/sync-scheduler.js");
  const { SYNC_DEBOUNCE_MS, SYNC_MIN_INTERVAL_MS } = await import("../BetterBrowse/src/core/sync/sync-constants.js");
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return 0; };
  try {
    SyncScheduler._autoSyncEnabled = true;
    SyncScheduler._lastAutoRunAt = 0;
    SyncScheduler.scheduleDebounced();
    SyncScheduler._lastAutoRunAt = Date.now() - 10000;
    SyncScheduler.scheduleDebounced();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    SyncScheduler._autoSyncEnabled = null;
    SyncScheduler._timer = null;
  }
  assertEquals(delays[0], SYNC_DEBOUNCE_MS, "很久没同步时按常规防抖");
  assert(delays[1] >= SYNC_MIN_INTERVAL_MS - 10000 - 50 && delays[1] <= SYNC_MIN_INTERVAL_MS - 10000, `10 秒前刚同步过应顺延到满 60 秒，实际 ${delays[1]}`);
});
