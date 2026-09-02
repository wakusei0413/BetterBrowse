/**
 * @file link-notifier.js
 * @description 向受影响的 HTTP(S) 框架投递链接模式，避免全标签整表规则广播
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkService } from '../core/link/link-service.js';
import { LinkMatcher } from '../core/link/link-matcher.js';
import { MessageBus } from '../core/bus/message-bus.js';

function isHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

function domainMatches(pageDomain, targetDomain) {
  if (!pageDomain || !targetDomain) return false;
  const page = pageDomain.toLowerCase();
  const target = targetDomain.toLowerCase();
  return page === target
    || page === `www.${target}`
    || target === `www.${page}`
    || page.endsWith(`.${target}`);
}

/**
 * 通知扩展页面（选项页 / 弹窗），不遍历网页标签。
 * @param {string} action
 * @param {any} [payload]
 */
export function notifyExtensionPages(action, payload = {}) {
  try {
    const result = chrome.runtime.sendMessage({ action, payload });
    MessageBus.settleChromePromise(result);
  } catch {
    // 没有接收方时忽略
  }
}

/**
 * 向指定标签的顶层框架发送消息。
 * @param {number} tabId
 * @param {string} action
 * @param {any} [payload]
 * @param {number} [timeoutMs=400]
 */
export function notifyTopFrame(tabId, action, payload = null, timeoutMs = 400) {
  return MessageBus.sendToFrame(tabId, 0, action, payload, timeoutMs).catch(() => {});
}

/**
 * 向需要刷新跳转模式的框架投递 effectiveMode。
 * @param {{ domain?: string, global?: boolean, clearAll?: boolean }} [scope]
 */
export async function notifyLinkFrames(scope = {}) {
  const { domain = '', global = false, clearAll = false } = scope;
  try {
    const tabs = await chrome.tabs.query({});
    const [rules, globalRule] = await Promise.all([
      LinkService.getAllRules(),
      LinkService.getGlobalRule()
    ]);
    const httpTabs = tabs.filter((tab) => tab?.id && isHttpUrl(tab.url));
    await Promise.all(httpTabs.map(async (tab) => {
      let frames = [{ frameId: 0, url: tab.url }];
      try {
        if (chrome.webNavigation?.getAllFrames) {
          const listed = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          if (Array.isArray(listed) && listed.length > 0) frames = listed;
        }
      } catch {
        // 无 webNavigation 时退回顶层框架
      }
      await Promise.all(frames.map(async (frame) => {
        const url = frame.url || '';
        if (!isHttpUrl(url) || !Number.isInteger(frame.frameId) || frame.frameId < 0) return;
        const pageDomain = LinkMatcher.extractDomain(url);
        if (!global && !clearAll && domain && !domainMatches(pageDomain, domain)) return;
        const effectiveMode = LinkMatcher.resolveEffectiveMode({
          domain: pageDomain,
          linkRules: rules,
          globalLinkRule: globalRule
        });
        await MessageBus.sendToFrame(
          tab.id,
          frame.frameId,
          ActionTypes.NOTIFY_RULE_UPDATED,
          { effectiveMode },
          400
        ).catch(() => {});
      }));
    }));
  } catch (err) {
    console.warn('[LinkNotifier] 框架通知异常:', err);
  }
}
