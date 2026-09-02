/**
 * @file api-version.test.js
 * @description BetterBrowse 软件发布版本与内部 API 版本独立契约测试
 * @encoding UTF-8
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import {
  API_VERSION,
  apiVersionMismatchMessage,
  readApiVersion
} from '../BetterBrowse/src/constants/api-version.js';
import { buildCapabilitiesDescriptor } from '../BetterBrowse/src/core/ai/ai-capabilities.js';
import { AIBridgeManager } from '../BetterBrowse/src/background/ai-bridge.js';

Deno.test('版本边界：软件发布版本与内部 API 版本各自独立', async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL('../BetterBrowse/manifest.json', import.meta.url)));
  const bumpSource = await Deno.readTextFile(new URL('../BetterBrowse/scripts/bump-api-version.js', import.meta.url));
  assertEquals(Number.isSafeInteger(API_VERSION) && API_VERSION > 0, true);
  assertEquals(/^\d+(?:\.\d+){0,3}$/.test(manifest.version), true);
  assertEquals(manifest.version_name, 'Milestone 4');
  assertEquals(/manifest(?:Path|\.json)|manifest\.version|version_name/.test(bumpSource), false);
});

Deno.test('API 版本：能力清单和状态统一使用 apiVersion', () => {
  const descriptor = buildCapabilitiesDescriptor({ softwareVersion: 'Milestone 2' });
  assertEquals(descriptor.apiVersion, API_VERSION);
  assertEquals(descriptor.softwareVersion, 'Milestone 2');
  assertEquals(Object.hasOwn(descriptor, 'protocol'), false);
  assertEquals(Object.hasOwn(descriptor, 'extensionVersion'), false);
  assertEquals(Object.hasOwn(descriptor, 'schemaVersion'), false);
  assertEquals(descriptor.internalRevisions.localDataSchema, 10);
  assertEquals(descriptor.internalRevisions.indexedDbSchema, 11);

  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.0.0', version_name: 'Milestone 2' })
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
  };
  try {
    const status = new AIBridgeManager().getStatusSummary();
    assertEquals(status.apiVersion, API_VERSION);
    assertEquals(status.softwareVersion, 'Milestone 2');
    assertEquals(status.peerApiVersion, null);
    assertEquals(Object.hasOwn(status, 'protocol'), false);
  } finally {
    delete globalThis.chrome;
  }
});

Deno.test('API 版本：读取历史字段但新输出只写 apiVersion', () => {
  assertEquals(readApiVersion({ apiVersion: API_VERSION }), API_VERSION);
  assertEquals(readApiVersion({ proto: API_VERSION }), API_VERSION);
  assertEquals(readApiVersion({ protocol: API_VERSION }), API_VERSION);
  assertEquals(readApiVersion({ v: API_VERSION }), API_VERSION);
  assertEquals(readApiVersion({ apiVersion: 0 }), null);
  assertEquals(readApiVersion({}), null);
  assertStringIncludes(apiVersionMismatchMessage(API_VERSION + 1), `本地 ${API_VERSION}`);
});

Deno.test('API 版本：扩展拒绝编号不一致的宿主', () => {
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.0.0', version_name: 'Milestone 2' })
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
  };
  try {
    const manager = new AIBridgeManager();
    let disconnected = false;
    manager._port = { disconnect: () => { disconnected = true; } };
    manager._state = 'connecting';
    manager._handleNativeMessage({ internal: 'ready', apiVersion: API_VERSION + 1 });
    const status = manager.getStatusSummary();
    assertEquals(status.state, 'incompatible');
    assertEquals(status.peerApiVersion, API_VERSION + 1);
    assertEquals(disconnected, true);
    assertStringIncludes(status.lastError, 'API 版本不兼容');
  } finally {
    delete globalThis.chrome;
  }
});

Deno.test('API 版本：大响应分块携带统一裸整数', () => {
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.0.0', version_name: 'Milestone 2' })
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
  };
  try {
    const manager = new AIBridgeManager();
    manager._port = {};
    const frames = [];
    manager._postDirect = (frame) => frames.push(frame);
    manager._sendResponse('large-response', { success: true, data: 'x'.repeat(200001) });
    assertEquals(frames.length > 1, true);
    assertEquals(frames.every((frame) => frame.apiVersion === API_VERSION), true);
    assertEquals(frames.every((frame) => frame.v === undefined), true);
  } finally {
    delete globalThis.chrome;
  }
});

Deno.test('API 版本：宿主与客户端不定义第二个硬编码版本', async () => {
  const host = await Deno.readTextFile(new URL('../BetterBrowse/native-host/bb_native_host.js', import.meta.url));
  const client = await Deno.readTextFile(new URL('../skills/better-browse/scripts/bb-bridge-client.js', import.meta.url));
  assertEquals(host.includes("from '../src/constants/api-version.js'"), true);
  assertEquals(/\b(?:AI_BRIDGE_PROTO|PROTOCOL_VERSION)\b/.test(host), false);
  assertEquals(/\b(?:AI_BRIDGE_PROTO|PROTOCOL_VERSION)\b/.test(client), false);
  assertEquals(/\b(?:const|let|var)\s+API_VERSION\s*=/.test(host + client), false);
  assertEquals(client.includes('info.apiVersion'), true);
});
