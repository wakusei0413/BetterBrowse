/**
 * @file extension-url.test.js
 * @description 扩展页面与标签页数量过滤规则测试
 * @encoding UTF-8
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterCountableTabs,
  isExcludedFromTabCounting,
  isNewTabUrl,
  isOwnExtensionPageUrl,
  isOwnNewTabUrl,
  isOwnOptionsUrl
} from '../BetterBrowse/src/core/extension-url.js';

function installChrome() {
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };
}

test('扩展自身选项页会被识别为不可计数标签页', () => {
  installChrome();
  assert.equal(isOwnOptionsUrl('chrome-extension://test/src/options/options.html'), true);
  assert.equal(isOwnOptionsUrl('chrome-extension://test/src/newtab/newtab.html'), false, 'options判定不能误判newtab');
  assert.equal(isOwnOptionsUrl('https://example.com/src/options/options.html'), false);
  assert.equal(isExcludedFromTabCounting({ url: 'chrome-extension://test/src/options/options.html#stash' }), true);
});

test('独立新标签页识别、排除计数与保护', () => {
  installChrome();
  const newtabUrl = 'chrome-extension://test/src/newtab/newtab.html';
  assert.equal(isOwnNewTabUrl(newtabUrl), true);
  assert.equal(isOwnNewTabUrl(`${newtabUrl}#search`), true);
  assert.equal(isOwnNewTabUrl('chrome-extension://test/src/options/options.html'), false);
  assert.equal(isOwnOptionsUrl(newtabUrl), false, 'pinned-tab-guard 绝对不可将 newtab 识别为 options');
  assert.equal(isOwnExtensionPageUrl(newtabUrl), true);
  assert.equal(isOwnExtensionPageUrl('chrome-extension://test/src/options/options.html'), true);
  assert.equal(isOwnExtensionPageUrl('https://example.com'), false);
  assert.equal(isExcludedFromTabCounting({ url: newtabUrl }), true);
});

test('新标签页与空白页会被识别为不可计数标签页', () => {
  assert.equal(isNewTabUrl('chrome://newtab/'), true);
  assert.equal(isNewTabUrl('chrome://newtab'), true);
  assert.equal(isNewTabUrl('edge://newtab/'), true);
  assert.equal(isNewTabUrl('about:blank'), true);
  assert.equal(isNewTabUrl('https://example.com'), false);
});

test('标签页数量过滤仅保留普通网页', () => {
  installChrome();
  const tabs = [
    { id: 1, url: 'https://example.com' },
    { id: 2, url: 'chrome-extension://test/src/options/options.html#stash' },
    { id: 3, url: 'chrome://newtab/' },
    { id: 4, url: 'about:blank' },
    { id: 5, url: 'https://another.example' }
  ];
  assert.deepEqual(filterCountableTabs(tabs).map((tab) => tab.id), [1, 5]);
});
