/**
 * @file message-bus.js
 * @description 统一跨端消息通讯总线（封装 Chrome 消息通信与安全错误处理）
 * @encoding UTF-8
 */

import { isActionAuthorized } from '../security/message-authorizer.js';

export class MessageBus {
  /**
   * 吞掉 Chrome MV3 在传入 callback 时仍可能返回的拒绝 Promise。
   * 典型症状：Uncaught (in promise) Error: No tab with id / Receiving end does not exist
   * @param {any} result
   */
  static settleChromePromise(result) {
    if (result != null && typeof result.then === 'function') {
      result.then(() => {}, () => {});
    }
    return result;
  }

  /**
   * 发送消息至后台 Service Worker
   * @param {string} action - 动作名称（来自 ActionTypes）
   * @param {any} [payload=null] - 消息负载数据
   * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
   */
  static async sendToBackground(action, payload = null) {
    return new Promise((resolve) => {
      try {
        const chromeResult = chrome.runtime.sendMessage({ action, payload }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({
              success: false,
              error: lastError.message || '后台服务连接失败'
            });
            return;
          }
          resolve(response || { success: false, error: '后台未处理该动作' });
        });
        this.settleChromePromise(chromeResult);
      } catch (err) {
        resolve({
          success: false,
          error: err.message || '发送后台消息异常'
        });
      }
    });
  }

  /**
   * 发送消息至指定标签页的内容脚本（Content Script）
   * @param {number} tabId - 目标标签页 ID
   * @param {string} action - 动作名称
   * @param {any} [payload=null] - 负载数据
   * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
   */
  static async sendToTab(tabId, action, payload = null, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ success: false, error: '内容脚本响应超时' });
        }
      }, Math.max(100, timeoutMs));
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      try {
        const chromeResult = chrome.tabs.sendMessage(tabId, { action, payload }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            // 很多特殊标签页（如 chrome://, edge://, 空白页）无法注入脚本，属正常预期
            finish({
              success: false,
              error: lastError.message
            });
            return;
          }
          finish(response || { success: true });
        });
        // MV3：即使传入 callback，sendMessage 仍可能返回会拒绝的 Promise
        this.settleChromePromise(chromeResult);
      } catch (err) {
        finish({
          success: false,
          error: err.message
        });
      }
    });
  }

  /**
   * 注册统一消息监听处理器
   * @param {Record<string, (payload: any, sender: chrome.runtime.MessageSender) => Promise<any> | any>} handlersMap - 动作与处理函数映射表
   */
  static registerListener(handlersMap) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.action) return false;

      // 来源授权：内容脚本与未知来源只能调用各自白名单内的 action
      // （AI 桥接请求由 AIBridgeManager 直接调用 handler，不经过此通道）
      if (!isActionAuthorized(message.action, sender)) {
        console.warn(`[MessageBus] 拒绝未授权来源调用 ${message.action}`);
        sendResponse({ success: false, error: '未授权的消息来源' });
        return false;
      }

      const handler = handlersMap[message.action];
      if (!handler) {
        return false;
      }

      // 执行异步或同步处理器
      Promise.resolve()
        .then(() => handler(message.payload, sender))
        .then((result) => {
          sendResponse({
            success: true,
            data: result
          });
        })
        .catch((error) => {
          console.error(`[MessageBus] 处理动作 ${message.action} 失败:`, error);
          sendResponse({
            success: false,
            error: error.message || '内部处理异常'
          });
        });

      // 返回 true 保持异步 sendResponse 通道打开
      return true;
    });
  }
}

