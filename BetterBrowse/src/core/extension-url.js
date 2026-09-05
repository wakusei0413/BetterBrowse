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
 * 判断标签页是否不应计入标签页数量阈值。
 * @param {{ url?: string }|null|undefined} tab
 * @returns {boolean}
 */
export function isExcludedFromTabCounting(tab) {
  const rawUrl = tab?.url;
  return !rawUrl || isOwnOptionsUrl(rawUrl) || isOwnNewTabUrl(rawUrl) || isNewTabUrl(rawUrl);
}

/**
 * 过滤出应参与标签页数量统计的标签页。
 * @param {Array<{ url?: string }>} tabs
 * @returns {Array<{ url?: string }>}
 */
export function filterCountableTabs(tabs) {
  return Array.isArray(tabs) ? tabs.filter((tab) => !isExcludedFromTabCounting(tab)) : [];
}
