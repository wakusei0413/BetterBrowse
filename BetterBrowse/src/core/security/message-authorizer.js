/**
 * @file message-authorizer.js
 * @description 后台消息来源授权：按来源（扩展自身页面 / 内容脚本 / 未知）限定可调用的 action 白名单
 *
 * 背景：Manifest V3 内容脚本注入在 <all_urls>，任意已注入页面理论上都能向后台
 * sendMessage。虽然普通网页主世界无法直接调用 chrome.runtime.sendMessage，但一旦
 * 出现内容脚本消息转发漏洞、或后续追加 externally_connectable，未做来源鉴权的后台
 * 将把整套 action（含导出、删除、配置修改、批量收纳）暴露给网页。本模块按来源类型
 * 强制最小权限：内容脚本只能调用其运行所需的极小动作集，扩展自身页面可调用全部。
 * @encoding UTF-8
 */

import { ActionTypes } from '../../constants/action-types.js';

/**
 * 内容脚本（注入到任意网页的隔离世界）允许调用后台的最小动作集。
 * 任何不在此集合内的 action，来自内容脚本来源一律拒绝。
 *
 * 盘点依据（src/content/ 下所有向后台发送消息的路径）：
 * - GET_PAGE_LINK_CONTEXT：link-interceptor 初始化时拉取当前页跳转上下文
 * - OPEN_TAB_BACKGROUND：link-interceptor 捕获链接点击 / 主世界桥接事件后转发
 * - APPEND_RUNTIME_LOG：index.js 运行日志写入器
 * - CANCEL_AUTO_STASH / CONFIRM_AUTO_STASH：countdown-banner 倒计时卡片按钮
 */
const CONTENT_ALLOWED_ACTIONS = new Set([
  ActionTypes.GET_PAGE_LINK_CONTEXT,
  ActionTypes.OPEN_TAB_BACKGROUND,
  ActionTypes.APPEND_RUNTIME_LOG,
  ActionTypes.CANCEL_AUTO_STASH,
  ActionTypes.CONFIRM_AUTO_STASH
]);

/**
 * 判定消息来源类型。
 * @param {chrome.runtime.MessageSender|undefined|null} sender
 * @returns {'internal'|'content'|'unknown'}
 */
export function classifySender(sender) {
  if (!sender) return 'unknown';

  const ownOrigin = globalThis.chrome?.runtime?.getURL?.('') || '';

  // 扩展自身页面（popup / options）：sender.url 以 chrome-extension://<id>/ 开头。
  // 判定只认 sender.url 是否本扩展来源，不看 sender.tab —— 选项页通常在普通标签页
  // 里打开（从 chrome://extensions 点「选项」或从 popup 跳转），此时 Chrome 也会
  // 给 sender.tab 赋值；若额外要求 !sender.tab，会把 options 误判成内容脚本来源，
  // 导致 GET_CONFIG / GET_STASH_GROUPS / 导入 / 同步等动作全部被拒、UI 数据清空。
  // 内容脚本的 sender.url 是网页 URL（非 chrome-extension://），不可能匹配本扩展
  // 来源，因此单凭 sender.url 即可安全区分，不会把网页内容脚本放进 internal。
  if (ownOrigin && typeof sender.url === 'string' && sender.url.startsWith(ownOrigin)) {
    return 'internal';
  }

  // 内容脚本：注入在网页中，sender.tab 必然存在；iframe 内的内容脚本还带 frameId
  if (sender.tab || typeof sender.frameId === 'number') {
    return 'content';
  }

  return 'unknown';
}

/**
 * 判定消息是否被授权执行。
 *
 * - internal（扩展自身页面）：全部 action 放行
 * - content（内容脚本）：仅 CONTENT_ALLOWED_ACTIONS 放行
 * - unknown（无法识别的来源，如未来追加 externally_connectable 后的外部网页）：拒绝
 *
 * 注意：AI 桥接请求由 AIBridgeManager 直接调用共享 handler（sender=null），不经过
 * chrome.runtime.onMessage 通道，因此本函数不约束 AI 路径——AI 侧由确认位、payload
 * 尺寸、凭据出口复查与审计日志单独治理。
 * @param {string} action
 * @param {chrome.runtime.MessageSender|undefined|null} sender
 * @returns {boolean}
 */
export function isActionAuthorized(action, sender) {
  const source = classifySender(sender);
  if (source === 'internal') return true;
  if (source === 'content') return CONTENT_ALLOWED_ACTIONS.has(action);
  return false;
}

/**
 * 弹窗生命周期端口只接受本扩展 popup.html，且不得带内容脚本的 sender.tab。
 * 任意网页隔离世界也能 chrome.runtime.connect，不能把断开事件当成图标双击全量收纳。
 * @param {chrome.runtime.Port|undefined|null} port
 * @returns {boolean}
 */
export function isTrustedPopupLifecyclePort(port) {
  if (!port || port.name !== 'popup-lifecycle') return false;
  if (port.sender?.tab) return false;
  const ownPopupUrl = globalThis.chrome?.runtime?.getURL?.('src/popup/popup.html') || '';
  const senderUrl = typeof port.sender?.url === 'string' ? port.sender.url : '';
  if (!ownPopupUrl || !senderUrl) return false;
  return senderUrl === ownPopupUrl
    || senderUrl.startsWith(`${ownPopupUrl}#`)
    || senderUrl.startsWith(`${ownPopupUrl}?`);
}

export { CONTENT_ALLOWED_ACTIONS };
