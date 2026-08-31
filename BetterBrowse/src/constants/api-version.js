/**
 * @file api-version.js
 * @description BetterBrowse 唯一 API 版本事实源
 * @encoding UTF-8
 */

/**
 * BetterBrowse 内部 API 版本号。
 *
 * 该值采用裸正整数，只在 BetterBrowse 跨组件 API 契约发生不兼容变化时递增。
 * 软件发布版本由 manifest.json 独立管理，二者不得联动。
 */
export const API_VERSION = 1;

/**
 * 从当前字段或历史兼容字段读取 API 版本。
 * 缺少版本字段时返回 null，由具体边界决定是否接受旧消息。
 * @param {any} value
 * @returns {number | null}
 */
export function readApiVersion(value) {
  const raw = value?.apiVersion ?? value?.proto ?? value?.protocol ?? value?.v;
  const version = Number(raw);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

/**
 * 生成统一的版本不兼容错误文本。
 * @param {number | null} peerApiVersion
 * @returns {string}
 */
export function apiVersionMismatchMessage(peerApiVersion) {
  return `API 版本不兼容：本地 ${API_VERSION}，对端 ${peerApiVersion ?? '未知'}`;
}
