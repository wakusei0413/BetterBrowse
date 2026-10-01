/**
 * @file pinned-tab-guard.test.js
 * @description 常驻收纳箱“每个窗口恰好一个”不变量：并发创建、pendingUrl、去重与 newtab 隔离
 * @encoding UTF-8
 */

import { assertEquals } from '@std/assert';
import { StashService } from '../BetterBrowse/src/core/stash/stash-service.js';
import { isOwnOptionsTab } from '../BetterBrowse/src/core/extension-url.js';

const OPTIONS_URL = 'chrome-extension://test/src/options/options.html';
const OPTIONS_STASH_URL = `${OPTIONS_URL}#stash`;
const OPTIONS_SETTINGS_URL = `${OPTIONS_URL}#stash-settings`;
const NEWTAB_URL = 'chrome-extension://test/src/newtab/newtab.html';

/**
 * 安装内存版 chrome.tabs，用于观察创建、钉住、移动与关闭。
 * @param {Array<Record<string, unknown>>} [initialTabs=[]]
 */
function installPinnedTabChrome(initialTabs = []) {
  let tabs = initialTabs.map((tab, index) => ({
    id: tab.id ?? index + 1,
    windowId: tab.windowId ?? 1,
    url: tab.url ?? '',
    pendingUrl: tab.pendingUrl ?? '',
    pinned: Boolean(tab.pinned),
    index: Number.isInteger(tab.index) ? tab.index : index,
    active: Boolean(tab.active),
    title: tab.title || tab.url || '无标题页面'
  }));
  let nextId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1;
  const stats = { createCount: 0, removedIds: [] };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`
    },
    tabs: {
      query: async (options = {}) => {
        return tabs
          .filter((tab) => {
            if (typeof options.windowId === 'number') return tab.windowId === options.windowId;
            return true;
          })
          .map((tab) => ({ ...tab }));
      },
      create: async (props = {}) => {
        stats.createCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const created = {
          id: nextId++,
          windowId: props.windowId ?? 1,
          url: props.url || '',
          pendingUrl: '',
          pinned: Boolean(props.pinned),
          index: Number.isInteger(props.index) ? props.index : tabs.length,
          active: Boolean(props.active),
          title: 'BetterBrowse 管理中心'
        };
        for (const existing of tabs) {
          if (existing.windowId === created.windowId && existing.index >= created.index) {
            existing.index += 1;
          }
        }
        tabs.push(created);
        return { ...created };
      },
      update: async (id, props = {}) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        Object.assign(tab, props);
        return { ...tab };
      },
      move: async (id, destination = {}) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        if (Number.isInteger(destination.index)) tab.index = destination.index;
        return { ...tab };
      },
      remove: async (ids) => {
        const idList = Array.isArray(ids) ? ids : [ids];
        stats.removedIds.push(...idList);
        tabs = tabs.filter((tab) => !idList.includes(tab.id));
      }
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }]
    }
  };

  StashService._pinnedStashLocks?.clear?.();
  return {
    stats,
    getTabs: (windowId = 1) => tabs.filter((tab) => tab.windowId === windowId).map((tab) => ({ ...tab })),
    getOptionsTabs: (windowId = 1) => tabs.filter((tab) => tab.windowId === windowId && isOwnOptionsTab(tab))
  };
}

Deno.test('ensurePinnedStashTab: 并发两次调用只创建一次，窗口内只留一个钉在 0 的 options', async () => {
  const env = installPinnedTabChrome([
    { id: 2, windowId: 1, url: 'https://example.com', pinned: false, index: 0, active: true }
  ]);

  await Promise.all([
    StashService.ensurePinnedStashTab(false, 1),
    StashService.ensurePinnedStashTab(false, 1)
  ]);

  const optionsTabs = env.getOptionsTabs(1);
  assertEquals(env.stats.createCount, 1);
  assertEquals(optionsTabs.length, 1);
  assertEquals(optionsTabs[0].pinned, true);
  assertEquals(optionsTabs[0].index, 0);
  assertEquals(optionsTabs[0].url, OPTIONS_STASH_URL);
});

Deno.test('ensurePinnedStashTab: 已有两个钉住的 options 时关掉多余的，留下 index 0 且不改 hash', async () => {
  const env = installPinnedTabChrome([
    { id: 10, windowId: 1, url: OPTIONS_STASH_URL, pinned: true, index: 0, active: false },
    { id: 11, windowId: 1, url: OPTIONS_SETTINGS_URL, pinned: true, index: 1, active: true },
    { id: 12, windowId: 1, url: 'https://example.com', pinned: false, index: 2, active: false }
  ]);

  const keeper = await StashService.ensurePinnedStashTab(false, 1);
  const optionsTabs = env.getOptionsTabs(1);
  const remaining = env.getTabs(1);

  assertEquals(env.stats.createCount, 0);
  assertEquals(optionsTabs.length, 1);
  assertEquals(optionsTabs[0].id, 10);
  assertEquals(optionsTabs[0].url, OPTIONS_STASH_URL, '不得把已有收纳箱 hash 改写成默认 #stash');
  assertEquals(optionsTabs[0].pinned, true);
  assertEquals(optionsTabs[0].index, 0);
  assertEquals(env.stats.removedIds.includes(11), true);
  assertEquals(remaining.some((tab) => tab.id === 12), true, '普通网页不得被去重关掉');
  assertEquals(keeper?.id, 10);
});

Deno.test('ensurePinnedStashTab: 仅有 pendingUrl 的恢复中 options 视为已存在，不再创建', async () => {
  const env = installPinnedTabChrome([
    {
      id: 3,
      windowId: 1,
      url: '',
      pendingUrl: OPTIONS_STASH_URL,
      pinned: true,
      index: 0,
      active: false
    },
    { id: 4, windowId: 1, url: 'https://example.com', pinned: false, index: 1, active: true }
  ]);

  await StashService.ensurePinnedStashTab(false, 1);
  assertEquals(env.stats.createCount, 0);
  assertEquals(env.getOptionsTabs(1).length, 1);
  assertEquals(env.getOptionsTabs(1)[0].id, 3);
});

Deno.test('ensurePinnedStashTab: 同窗口 newtab.html 不被钉、不被关、不被挪到 0', async () => {
  const env = installPinnedTabChrome([
    { id: 20, windowId: 1, url: OPTIONS_STASH_URL, pinned: true, index: 0, active: false },
    { id: 21, windowId: 1, url: NEWTAB_URL, pinned: false, index: 1, active: true }
  ]);

  await StashService.ensurePinnedStashTab(false, 1);
  const tabs = env.getTabs(1);
  const newtab = tabs.find((tab) => tab.id === 21);

  assertEquals(env.stats.createCount, 0);
  assertEquals(env.getOptionsTabs(1).length, 1);
  assertEquals(tabs.some((tab) => tab.id === 21), true);
  assertEquals(newtab?.url, NEWTAB_URL);
  assertEquals(newtab?.pinned, false);
  assertEquals(newtab?.index, 1);
  assertEquals(env.stats.removedIds.includes(21), false);
});

Deno.test('ensurePinnedStashTab: 空窗口跳过，避免尚未有标签时误创建', async () => {
  const env = installPinnedTabChrome([]);
  const result = await StashService.ensurePinnedStashTab(false, 1);
  assertEquals(result, null);
  assertEquals(env.stats.createCount, 0);
  assertEquals(env.getTabs(1).length, 0);
});

Deno.test('ensurePinnedStashTab: 不同窗口各自保留一个常驻收纳箱', async () => {
  const env = installPinnedTabChrome([
    { id: 31, windowId: 1, url: OPTIONS_STASH_URL, pinned: true, index: 0, active: false },
    { id: 32, windowId: 2, url: OPTIONS_STASH_URL, pinned: true, index: 0, active: false }
  ]);

  await StashService.ensurePinnedStashTab(false, 1);
  await StashService.ensurePinnedStashTab(false, 2);

  assertEquals(env.stats.createCount, 0);
  assertEquals(env.getOptionsTabs(1).length, 1);
  assertEquals(env.getOptionsTabs(2).length, 1);
});
