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
  isOwnOptionsTab,
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

test('isOwnOptionsTab 同时识别 url 与 pendingUrl，且绝不把 newtab 当成 options', () => {
  installChrome();
  const optionsUrl = 'chrome-extension://test/src/options/options.html#stash';
  const newtabUrl = 'chrome-extension://test/src/newtab/newtab.html';

  assert.equal(isOwnOptionsTab({ url: optionsUrl }), true);
  assert.equal(isOwnOptionsTab({ url: '', pendingUrl: optionsUrl }), true, '会话恢复中的 pendingUrl 必须视为已存在的收纳箱');
  assert.equal(isOwnOptionsTab({ url: newtabUrl }), false);
  assert.equal(isOwnOptionsTab({ url: '', pendingUrl: newtabUrl }), false, 'pendingUrl 为 newtab 时不得误判为 options');
  assert.equal(isOwnOptionsTab(null), false);
  assert.equal(isOwnOptionsTab(undefined), false);
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

test('待导航标签页按 pendingUrl 参与计数，扩展页与内部页仍排除', () => {
  installChrome();
  assert.equal(
    isExcludedFromTabCounting({ url: '', pendingUrl: 'https://example.com' }),
    false,
    'URL 尚未提交时不得漏计普通网页'
  );
  assert.equal(
    isExcludedFromTabCounting({ url: '', pendingUrl: 'chrome-extension://test/src/options/options.html' }),
    true
  );
  assert.equal(
    isExcludedFromTabCounting({ url: '', pendingUrl: 'chrome-extension://test/src/newtab/newtab.html' }),
    true
  );
  assert.equal(
    isExcludedFromTabCounting({ url: 'https://example.com', pendingUrl: 'chrome://newtab/' }),
    true,
    '导航目标为内部页时应优先按 pendingUrl 排除'
  );

  const tabs = [
    { id: 1, url: '', pendingUrl: 'https://pending.example' },
    { id: 2, url: 'https://ready.example' },
    { id: 3, url: '', pendingUrl: 'chrome-extension://test/src/options/options.html' },
    { id: 4, url: '', pendingUrl: 'chrome://newtab/' },
    { id: 5, url: '', pendingUrl: '' }
  ];
  assert.deepEqual(filterCountableTabs(tabs).map((tab) => tab.id), [1, 2]);
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
