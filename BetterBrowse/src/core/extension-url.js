/**
 * @file extension-url.js
 * @description 扩展内部页面 URL 判定工具，避免使用可被普通网站伪造的模糊字符串匹配
 * @encoding UTF-8
 */

/**
 * 判断 URL 是否为当前扩展的选项页。
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isOwnOptionsUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;

  const extensionUrl = globalThis.chrome?.runtime?.getURL?.('src/options/options.html');
  if (!extensionUrl) return false;

  return rawUrl === extensionUrl
    || rawUrl.startsWith(`${extensionUrl}#`)
    || rawUrl.startsWith(`${extensionUrl}?`);
}

/**
 * 判断标签页是否为当前扩展的选项页（含尚未完成导航的 pendingUrl）。
 * 会话恢复或刚创建时 tab.url 可能为空，必须同时检查 pendingUrl，避免误判为缺失而再开一份。
 * @param {{ url?: string, pendingUrl?: string }|null|undefined} tab
 * @returns {boolean}
 */
export function isOwnOptionsTab(tab) {
  if (!tab || typeof tab !== 'object') return false;
  return isOwnOptionsUrl(tab.url) || isOwnOptionsUrl(tab.pendingUrl);
}

/**
 * 判断 URL 是否为当前扩展的独立新标签页。
 * 必须与 options.html 严格区分，避免被 pinned-tab-guard 误认为固定小标签。
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isOwnNewTabUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;

  const extensionUrl = globalThis.chrome?.runtime?.getURL?.('src/newtab/newtab.html');
  if (!extensionUrl) return false;

  return rawUrl === extensionUrl
    || rawUrl.startsWith(`${extensionUrl}#`)
    || rawUrl.startsWith(`${extensionUrl}?`);
}

/**
 * 判断 URL 是否为当前扩展内部页面（选项管理中心或独立新标签页）。
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isOwnExtensionPageUrl(rawUrl) {
  return isOwnOptionsUrl(rawUrl) || isOwnNewTabUrl(rawUrl);
}

/**
 * 判断 URL 是否为浏览器新标签页或无内容空白页。
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isNewTabUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;

  const normalizedUrl = rawUrl.trim().toLowerCase();
  return normalizedUrl === 'about:blank'
    || normalizedUrl === 'chrome://newtab'
    || normalizedUrl.startsWith('chrome://newtab/')
    || normalizedUrl === 'chrome://new-tab-page'
    || normalizedUrl.startsWith('chrome://new-tab-page/')
    || normalizedUrl === 'edge://newtab'
    || normalizedUrl.startsWith('edge://newtab/');
}

/**
 * 取标签页当前应被认定的目标 URL。
 * 导航提交前 tab.url 仍可能为空或停留在 about:blank，此时必须以 pendingUrl 作为目标页面，
 * 因此计数、倒计时卡片广播与表单探测三处必须共用本函数，任何一处单独退回 tab.url
 * 都会造成"算得进阈值却拿不到卡片/探不到表单"的口径分裂。
 * @param {{ url?: string, pendingUrl?: string }|null|undefined} tab
 * @returns {string} 目标 URL，未知时返回空字符串
 */
export function getTabTargetUrl(tab) {
  const rawUrl = tab?.pendingUrl || tab?.url;
  return typeof rawUrl === 'string' ? rawUrl : '';
}

/**
 * 判断标签页是否不应计入标签页数量阈值。
 * @param {{ url?: string, pendingUrl?: string }|null|undefined} tab
 * @returns {boolean}
 */
export function isExcludedFromTabCounting(tab) {
  const rawUrl = getTabTargetUrl(tab);
  return !rawUrl || isOwnOptionsUrl(rawUrl) || isOwnNewTabUrl(rawUrl) || isNewTabUrl(rawUrl);
}

/**
 * 判断标签页目标 URL 是否为可注入内容脚本的普通网页。
 * @param {{ url?: string, pendingUrl?: string }|null|undefined} tab
 * @returns {boolean}
 */
export function isInjectableWebTab(tab) {
  const rawUrl = getTabTargetUrl(tab);
  return rawUrl.startsWith('http://') || rawUrl.startsWith('https://');
}

/**
 * 过滤出应参与标签页数量统计的标签页。
 * @param {Array<{ url?: string, pendingUrl?: string }>} tabs
 * @returns {Array<{ url?: string, pendingUrl?: string }>}
 */
export function filterCountableTabs(tabs) {
  return Array.isArray(tabs) ? tabs.filter((tab) => !isExcludedFromTabCounting(tab)) : [];
}
