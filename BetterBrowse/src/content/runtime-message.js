/**
 * @file runtime-message.js
 * @description 内容脚本向后台发消息的统一安全封装
 * @encoding UTF-8
 */

/**
 * 向后台发送消息，永不抛错：扩展重载后上下文失效、Service Worker 无接收端或超时都按 null 返回。
 * 回调中显式消费 runtime.lastError，并吞掉 MV3 在回调模式下仍可能返回的拒绝 Promise，避免控制台错误噪音。
 * @param {{ action: string, payload?: any }} message
 * @param {number} [timeoutMs=0] - 大于 0 时超时按 null 返回（后台无响应时不让调用方永久等待）
 * @returns {Promise<any>}
 */
export function sendRuntimeMessage(message, timeoutMs = 0) {
  return new Promise((resolve) => {
    if (!chrome.runtime?.id) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => finish(null), timeoutMs) : null;
    try {
      const result = chrome.runtime.sendMessage(message, (response) => {
        finish(chrome.runtime.lastError ? null : response);
      });
      if (result != null && typeof result.then === 'function') result.then(() => {}, () => {});
    } catch {
      finish(null);
    }
  });
}
