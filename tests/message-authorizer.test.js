/**
 * @file message-authorizer.test.js
 * @description 后台消息来源授权测试（H-1 修复回归门禁）
 *
 * 验证任意已注入内容脚本的网页无法调用敏感 action（导出、删除、配置修改、批量收纳），
 * 只允许内容脚本运行所需的极小动作集。覆盖扩展自身页面（popup/options）、内容脚本与
 * 未知来源三类，并构造"恶意网页冒充内容脚本调用敏感 action"的攻击路径。
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionTypes } from '../BetterBrowse/src/constants/action-types.js';
import {
  classifySender,
  isActionAuthorized,
  isTrustedPopupLifecyclePort,
  CONTENT_ALLOWED_ACTIONS
} from '../BetterBrowse/src/core/security/message-authorizer.js';

function installChrome() {
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test-id/${path}`,
      id: 'test-id'
    }
  };
}

const OWN_OPTIONS_URL = 'chrome-extension://test-id/src/options/options.html';
const OWN_POPUP_URL = 'chrome-extension://test-id/src/popup/popup.html';

test('来源分类：扩展自身页面为 internal', () => {
  installChrome();
  assert.equal(classifySender({ url: OWN_OPTIONS_URL }), 'internal');
  assert.equal(classifySender({ url: OWN_POPUP_URL }), 'internal');
  assert.equal(classifySender({ url: 'chrome-extension://test-id/src/options/options.html#stash' }), 'internal');
});

test('回归（H-1 修复）：扩展页面在普通标签页里打开仍为 internal', () => {
  // 选项页几乎总是在普通标签页里打开（chrome://extensions 点「选项」、从 popup
  // 跳转），此时 Chrome 给 sender.tab 赋值。若判定 internal 时额外要求 !sender.tab，
  // 会把 options 误判成内容脚本来源，导致 GET_CONFIG / GET_STASH_GROUPS / 导入 /
  // 同步等动作全部被拒、UI 数据清空。internal 只应看 sender.url 是否本扩展来源。
  installChrome();
  const optionsInTabSender = {
    url: OWN_OPTIONS_URL,
    tab: { id: 1, url: OWN_OPTIONS_URL }
  };
  assert.equal(classifySender(optionsInTabSender), 'internal');
  // 敏感 action 在此来源下必须放行（对应 UI 实际调用的数据/配置/导入动作）
  assert.equal(isActionAuthorized(ActionTypes.GET_CONFIG, optionsInTabSender), true);
  assert.equal(isActionAuthorized(ActionTypes.GET_STASH_GROUPS, optionsInTabSender), true);
  assert.equal(isActionAuthorized(ActionTypes.IMPORT_STASH_DATA, optionsInTabSender), true);
  assert.equal(isActionAuthorized(ActionTypes.UPDATE_CONFIG, optionsInTabSender), true);
  assert.equal(isActionAuthorized(ActionTypes.RUN_SYNC_NOW, optionsInTabSender), true);
  assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, optionsInTabSender), true);
});

test('来源分类：内容脚本（带 sender.tab）为 content', () => {
  installChrome();
  assert.equal(classifySender({ tab: { id: 1, url: 'https://example.com' } }), 'content');
  assert.equal(classifySender({ tab: { id: 1 }, frameId: 0 }), 'content');
  assert.equal(classifySender({ frameId: 7 }), 'content');
});

test('来源分类：无 sender.url 且无 sender.tab 为 unknown', () => {
  installChrome();
  assert.equal(classifySender(undefined), 'unknown');
  assert.equal(classifySender(null), 'unknown');
  assert.equal(classifySender({}), 'unknown');
});

test('来源分类：url 不是本扩展页面的来源为 content/unknown，不会被误判为 internal', () => {
  installChrome();
  // 网页伪造的 sender.url（协议与扩展 ID 不匹配）：无 tab 视为 unknown（更严格）
  assert.equal(classifySender({ url: 'https://evil.example.com/' }), 'unknown');
  assert.notEqual(classifySender({ url: 'https://evil.example.com/' }), 'internal');
  // 带 tab 的网页来源（真实内容脚本路径）才判为 content
  assert.equal(classifySender({ tab: { url: 'https://evil.example.com/' } }), 'content');
});

test('授权：扩展自身页面可调用全部敏感 action', () => {
  installChrome();
  const internalSender = { url: OWN_OPTIONS_URL };
  for (const action of [
    ActionTypes.EXPORT_FULL_BACKUP,
    ActionTypes.EXPORT_STASH_DATA,
    ActionTypes.DELETE_STASH_GROUP,
    ActionTypes.DELETE_STASH_ITEM,
    ActionTypes.CLEAR_ALL_STASH,
    ActionTypes.RESTORE_FULL_BACKUP,
    ActionTypes.UPDATE_CONFIG,
    ActionTypes.SET_LINK_RULE,
    ActionTypes.CLEAR_DOMAIN_RULES,
    ActionTypes.EXECUTE_STASH
  ]) {
    assert.equal(isActionAuthorized(action, internalSender), true, `internal 应允许调用 ${action}`);
  }
});

test('授权：内容脚本只能调用白名单内的极小动作集', () => {
  installChrome();
  const contentSender = { tab: { id: 1, url: 'https://example.com' } };
  // 白名单内放行
  for (const action of CONTENT_ALLOWED_ACTIONS) {
    assert.equal(isActionAuthorized(action, contentSender), true, `content 应允许调用 ${action}`);
  }
  // 白名单外的敏感 action 一律拒绝
  for (const action of [
    ActionTypes.EXPORT_FULL_BACKUP,
    ActionTypes.EXPORT_STASH_DATA,
    ActionTypes.DELETE_STASH_GROUP,
    ActionTypes.DELETE_STASH_ITEM,
    ActionTypes.CLEAR_ALL_STASH,
    ActionTypes.RESTORE_FULL_BACKUP,
    ActionTypes.UPDATE_CONFIG,
    ActionTypes.CLEAR_DOMAIN_RULES,
    ActionTypes.EXECUTE_STASH,
    ActionTypes.GET_STASH_GROUPS,
    ActionTypes.IMPORT_STASH_DATA,
    ActionTypes.SET_GLOBAL_LINK_RULE
  ]) {
    assert.equal(isActionAuthorized(action, contentSender), false, `content 不得调用 ${action}`);
  }
});

test('安全（H-1 回归）：恶意网页冒充内容脚本来源调用敏感 action 被拒绝', () => {
  installChrome();
  // 攻击路径：恶意网页内容脚本上下文发送 chrome.runtime.sendMessage
  // （内容脚本注入在 <all_urls>，网页可触发其上下文）尝试读取 / 删除收纳数据
  const attackerSender = { tab: { id: 999, url: 'https://evil.example.com/attack' } };
  assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.GET_STASH_GROUPS, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.DELETE_STASH_GROUP, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.CLEAR_ALL_STASH, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.UPDATE_CONFIG, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.EXECUTE_STASH, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.RESTORE_FULL_BACKUP, attackerSender), false);
  assert.equal(isActionAuthorized(ActionTypes.CLEAR_DOMAIN_RULES, attackerSender), false);

  // 但同来源的链接跳转上下文与后台开标签页（内容脚本合法职责）仍可用
  assert.equal(isActionAuthorized(ActionTypes.GET_PAGE_LINK_CONTEXT, attackerSender), true);
  assert.equal(isActionAuthorized(ActionTypes.OPEN_TAB_BACKGROUND, attackerSender), true);
  assert.equal(isActionAuthorized(ActionTypes.APPEND_RUNTIME_LOG, attackerSender), true);
});

test('安全（H-1 回归）：未知来源（无 sender.url 且无 sender.tab）调用任意 action 被拒绝', () => {
  installChrome();
  assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, undefined), false);
  assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, null), false);
  assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, {}), false);
  // 即便是白名单内的动作，未知来源同样拒绝
  assert.equal(isActionAuthorized(ActionTypes.OPEN_TAB_BACKGROUND, {}), false);
  assert.equal(isActionAuthorized(ActionTypes.APPEND_RUNTIME_LOG, undefined), false);
});

test('安全（H-1 回归）：伪造 sender.url 指向本扩展页面但协议不匹配不得放行', () => {
  installChrome();
  // 攻击者构造与扩展 URL 字面相似但协议不是 chrome-extension:// 的地址
  const forgedSenders = [
    { url: 'https://test-id/src/options/options.html' },
    { url: 'http://chrome-extension://test-id/src/options/options.html' },
    { url: 'chrome-extension://other-extension-id/src/options/options.html' }
  ];
  for (const sender of forgedSenders) {
    assert.equal(isActionAuthorized(ActionTypes.EXPORT_FULL_BACKUP, sender), false);
    assert.equal(isActionAuthorized(ActionTypes.UPDATE_CONFIG, sender), false);
  }
});

test('弹窗生命周期端口：只接受本扩展 popup.html 且不得带 sender.tab', () => {
  installChrome();
  assert.equal(isTrustedPopupLifecyclePort({
    name: 'popup-lifecycle',
    sender: { url: OWN_POPUP_URL }
  }), true);
  assert.equal(isTrustedPopupLifecyclePort({
    name: 'popup-lifecycle',
    sender: { url: `${OWN_POPUP_URL}#stash` }
  }), true);
  assert.equal(isTrustedPopupLifecyclePort({
    name: 'popup-lifecycle',
    sender: { url: OWN_POPUP_URL, tab: { id: 1, url: 'https://example.com' } }
  }), false);
  assert.equal(isTrustedPopupLifecyclePort({
    name: 'popup-lifecycle',
    sender: { url: 'https://evil.example.com/' }
  }), false);
  assert.equal(isTrustedPopupLifecyclePort({
    name: 'other',
    sender: { url: OWN_POPUP_URL }
  }), false);
});
