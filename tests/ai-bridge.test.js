/**
 * @file ai-bridge.test.js
 * @description AI 桥接测试（阶段三）：人机能力对等断言、确认位强制、凭据出口复查、尺寸限制与审计日志
 * @encoding UTF-8
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ActionTypes } from "../BetterBrowse/src/constants/action-types.js";
import { StorageKeys } from "../BetterBrowse/src/constants/storage-keys.js";
import { StorageAdapter } from "../BetterBrowse/src/core/storage/storage-adapter.js";
import {
  AI_ACTION_DOCS,
  AI_CONFIRM_REQUIRED_ACTIONS,
  buildCapabilitiesDescriptor
} from "../BetterBrowse/src/core/ai/ai-capabilities.js";
import { createActionHandlers } from "../BetterBrowse/src/background/action-handlers.js";
import { AIBridgeManager } from "../BetterBrowse/src/background/ai-bridge.js";
import { RuntimeLogRepository } from "../BetterBrowse/src/core/logging/runtime-log-repository.js";
import { IndexedDBManager } from "../BetterBrowse/src/core/storage/indexed-db.js";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.js";

/**
 * 安装 chrome.storage 内存模拟（与 indexed-db-stash.test.js 保持同一模式）
 */
function installMockStorage(initialData = {}) {
  const store = { ...initialData };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      id: "testextensionidaaaaaaaaaaaaaaa",
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
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } }
  };
  return store;
}

/**
 * 人类 UI 使用的 action 全集（弹窗 / 选项页 6 个 Tab / 右键菜单 / 倒计时卡片）
 * 来源盘点见 docs/03-ai-skill-bridge.md §6。新增人类功能时必须同步补充此清单，
 * parity 断言会强制 AI 能力清单覆盖它——"人类有的 AI 必有"。
 */
const HUMAN_UI_ACTIONS = [
  // 弹窗与域名规则页
  ActionTypes.GET_TAB_COUNT_INFO,
  ActionTypes.GET_COUNTDOWN_STATUS,
  ActionTypes.SET_LINK_RULE,
  ActionTypes.GET_DOMAIN_RULES,
  ActionTypes.SET_DOMAIN_RULE,
  ActionTypes.REMOVE_DOMAIN_RULE,
  ActionTypes.CLEAR_DOMAIN_RULES,
  // 收纳箱 Tab
  ActionTypes.EXECUTE_STASH,
  ActionTypes.GET_STASH_GROUPS,
  ActionTypes.UPDATE_STASH_GROUP,
  ActionTypes.RESTORE_STASH_GROUP,
  ActionTypes.RESTORE_STASH_ITEM,
  ActionTypes.RESTORE_STASH_GROUP_DATA,
  ActionTypes.DELETE_STASH_GROUP,
  ActionTypes.DELETE_STASH_ITEM,
  ActionTypes.CLEAR_ALL_STASH,
  ActionTypes.DEDUPLICATE_STASH_DATA,
  // 备份 Tab
  ActionTypes.EXPORT_FULL_BACKUP,
  ActionTypes.RESTORE_FULL_BACKUP,
  ActionTypes.IMPORT_THIRD_PARTY_DATA,
  ActionTypes.EXPORT_ONETAB_TEXT,
  // 设置与规则 Tab
  ActionTypes.GET_CONFIG,
  ActionTypes.UPDATE_CONFIG,
  // 入口类
  ActionTypes.OPEN_PINNED_STASH_TAB,
  ActionTypes.OPEN_OPTIONS_PAGE,
  // WebDAV 同步 Tab
  ActionTypes.GET_SYNC_STATUS,
  ActionTypes.SAVE_WEBDAV_CREDENTIALS,
  ActionTypes.TEST_WEBDAV_CONNECTION,
  ActionTypes.RUN_SYNC_NOW,
  ActionTypes.LIST_SYNC_CONFLICTS,
  ActionTypes.RESOLVE_SYNC_CONFLICT,
  ActionTypes.LIST_SYNC_DEVICES,
  ActionTypes.RETIRE_SYNC_DEVICE,
  ActionTypes.LIST_AUTO_BACKUPS,
  ActionTypes.RESTORE_AUTO_BACKUP,
  ActionTypes.DELETE_AUTO_BACKUP,
  ActionTypes.ADD_STASH_ITEM,
  ActionTypes.UPDATE_STASH_ITEM,
  ActionTypes.GET_SYNC_RECOVERY_INFO,
  ActionTypes.FALLBACK_PREVIOUS_SNAPSHOT,
  ActionTypes.REBUILD_SYNC_FROM_SCRATCH,
  ActionTypes.QUERY_RUNTIME_LOGS,
  ActionTypes.CLEAR_RUNTIME_LOGS
];

/** 构建最小依赖的共享处理映射（不触发真实服务调用） */
function buildHandlers() {
  return createActionHandlers({
    stashService: {},
    activityTracker: { getStats: () => ({}) },
    thresholdMonitor: {},
    broadcastToTabs: async () => {},
    aiBridge: {
      getStatusSummary: () => ({ armed: false, state: 'disabled' }),
      onConfigUpdated: () => {}
    }
  });
}

Deno.test("AI 对等：人类 UI 使用的全部动作都在共享处理映射与能力文档中", () => {
  const handlers = buildHandlers();
  const handlerKeys = new Set(Object.keys(handlers));

  for (const action of HUMAN_UI_ACTIONS) {
    assertEquals(handlerKeys.has(action), true, `人类 UI 动作 ${action} 未挂载到共享处理映射`);
    assertEquals(
      typeof AI_ACTION_DOCS[action] === 'object',
      true,
      `人类 UI 动作 ${action} 缺少 AI 能力参数文档`
    );
  }

  for (const action of handlerKeys) {
    assertEquals(typeof AI_ACTION_DOCS[action] === 'object', true, `动作 ${action} 缺少 AI 能力参数文档`);
  }

  // 能力自描述清单应把全部动作标记为可用
  const descriptor = buildCapabilitiesDescriptor({
    availableActions: [...handlerKeys]
  });
  const unavailable = descriptor.actions.filter((entry) => !entry.available).map((entry) => entry.action);
  assertEquals(unavailable, [], `能力清单存在不可用动作: ${unavailable.join(',')}`);
  assertEquals(descriptor.confirmRequired.sort(), [...AI_CONFIRM_REQUIRED_ACTIONS].sort());
});

/**
 * 构建注入了桩处理映射与响应捕获的桥接管理器
 */
function buildBridge(handlerMap) {
  const manager = new AIBridgeManager();
  manager._handlers = handlerMap;
  manager._armed = true;
  const responses = new Map();
  manager._sendResponse = (reqId, response) => {
    responses.set(reqId, response);
  };
  return { manager, responses };
}

Deno.test("AI 治理：确认位强制（镜像人类 UI 确认弹窗）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const calls = [];
    const { manager, responses } = buildBridge({
      [ActionTypes.DELETE_STASH_GROUP]: async (payload) => {
        calls.push(payload);
        return true;
      },
      [ActionTypes.CLEAR_ALL_STASH]: async () => true
    });

    // 未携带 confirm：拒绝且 handler 不被调用
    await manager._processRequest('r1', ActionTypes.DELETE_STASH_GROUP, { groupId: 'g1' });
    assertEquals(responses.get('r1').success, false);
    assertStringIncludes(responses.get('r1').error, 'confirm');
    assertEquals(calls.length, 0);

    // 携带 confirm: true：放行
    await manager._processRequest('r2', ActionTypes.DELETE_STASH_GROUP, { groupId: 'g1', confirm: true });
    assertEquals(responses.get('r2').success, true);
    assertEquals(calls.length, 1);

    // confirm: false 同样拒绝
    await manager._processRequest('r3', ActionTypes.CLEAR_ALL_STASH, { confirm: false });
    assertEquals(responses.get('r3').success, false);

    assertEquals(AI_CONFIRM_REQUIRED_ACTIONS.has(ActionTypes.RESTORE_STASH_GROUP_DATA), true);
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 治理：凭据出口复查（password 字段与凭据键名绝不外泄）", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const { manager, responses } = buildBridge({
      LEAKY: async () => ({ ok: true, password: 'secret-password', nested: { apiKey: 'k' } }),
      CRED_KEY: async () => ({ data: 'bb_webdav_credentials' })
    });

    await manager._processRequest('r1', 'LEAKY', {});
    assertEquals(responses.get('r1').success, false);
    assertStringIncludes(responses.get('r1').error, '凭据');

    await manager._processRequest('r2', 'CRED_KEY', {});
    assertEquals(responses.get('r2').success, false);
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 治理：payload 尺寸限制与未知动作拒绝", async () => {
  const idb = installFakeIndexedDB();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    const { manager, responses } = buildBridge({
      ECHO: async (payload) => payload
    });

    // 尺寸超限（> 8MB 字符）
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
    await manager._processRequest('r1', 'ECHO', { blob: huge });
    assertEquals(responses.get('r1').success, false);
    assertStringIncludes(responses.get('r1').error, '超出上限');

    // 未知动作
    await manager._processRequest('r2', 'NOT_EXIST', {});
    assertEquals(responses.get('r2').success, false);
    assertStringIncludes(responses.get('r2').error, '不支持的动作');

    // 正常回显
    await manager._processRequest('r3', 'ECHO', { hello: '世界' });
    assertEquals(responses.get('r3').success, true);
    assertEquals(responses.get('r3').data.hello, '世界');
  } finally {
    await idb.restore();
  }
});

Deno.test("AI 治理：审计日志（成功与失败均记录；凭据内容永不落审计）", async () => {
  const idb = installFakeIndexedDB();
  await IndexedDBManager.close();
  RuntimeLogRepository._writeQueue = Promise.resolve();
  installMockStorage({ [StorageKeys.SCHEMA_VERSION]: 8 });
  try {
    await RuntimeLogRepository.clear();
    const { manager } = buildBridge({
      [ActionTypes.SAVE_WEBDAV_CREDENTIALS]: async () => ({ success: true }),
      FAILING: async () => {
        throw new Error('模拟失败');
      },
      [ActionTypes.UPDATE_CONFIG]: async () => true
    });

    await manager._processRequest('r1', ActionTypes.SAVE_WEBDAV_CREDENTIALS, {
      serverUrl: 'https://dav.example.com',
      username: 'alice',
      password: 'top-secret'
    });
    await manager._processRequest('r2', 'FAILING', { keyword: 'k' });
    await manager._processRequest('r3', ActionTypes.UPDATE_CONFIG, { tabThreshold: 20 });

    // 审计为发射后不管（不阻塞响应），测试直接等待内部串行队列落盘
    await manager._auditQueue;

    const audit = (await RuntimeLogRepository.query({ category: 'audit', limit: 100 })).entries;
    const currentActions = [ActionTypes.UPDATE_CONFIG, 'FAILING', ActionTypes.SAVE_WEBDAV_CREDENTIALS];
    const currentAudit = audit.filter((entry) => currentActions.includes(entry.source));
    assertEquals(currentAudit.length >= 3, true);
    // 最新的目标记录在前
    assertEquals(currentAudit[0].source, ActionTypes.UPDATE_CONFIG);
    assertStringIncludes(currentAudit[0].message, 'tabThreshold');

    // 失败记录带错误
    const failEntry = currentAudit.find((entry) => entry.source === 'FAILING');
    assertEquals(failEntry.level, 'error');
    assertStringIncludes(failEntry.message, '模拟失败');

    // 凭据动作：内容不落审计，绝无密码
    const credEntry = currentAudit.find((entry) => entry.source === ActionTypes.SAVE_WEBDAV_CREDENTIALS);
    assertEquals(credEntry.level, 'info');
    const auditText = JSON.stringify(audit);
    assertEquals(auditText.includes('top-secret'), false);
    assertEquals(auditText.includes('alice'), false);
  } finally {
    await IndexedDBManager.close();
    await idb.restore();
  }
});

Deno.test("AI 对等：SET_DOMAIN_RULE / OPEN_ONE_TAB 与兼容动作共用同一 handler", () => {
  const handlers = buildHandlers();
  assertEquals(handlers[ActionTypes.SET_DOMAIN_RULE], handlers[ActionTypes.SET_LINK_RULE]);
  assertEquals(handlers[ActionTypes.OPEN_ONE_TAB], handlers[ActionTypes.OPEN_PINNED_STASH_TAB]);
});
