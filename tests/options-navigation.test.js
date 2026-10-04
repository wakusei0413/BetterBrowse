/**
 * @file options-navigation.test.js
 * @description 校验设置页三级路由、父分类、入口卡片与面板结构保持一致
 * @encoding UTF-8
 */

import { assert, assertEquals } from '@std/assert';
import { dirname, fromFileUrl, resolve } from '@std/path';
import {
  SETTINGS_SUBTABS,
  SETTINGS_TERTIARY_ROUTES
} from '../BetterBrowse/src/options/constants.js';

const root = dirname(fromFileUrl(import.meta.url));
const optionsHtmlPath = resolve(root, '../BetterBrowse/src/options/options.html');

Deno.test('设置页每个三级路由都有合法父分类、入口卡片与独立面板', async () => {
  const html = await Deno.readTextFile(optionsHtmlPath);
  const routes = Object.entries(SETTINGS_TERTIARY_ROUTES);

  assert(routes.length > 0, '至少应声明一个三级设置路由');
  for (const [route, meta] of routes) {
    assert(SETTINGS_SUBTABS.includes(meta.parent), `${route} 的父分类 ${meta.parent} 不存在`);
    assert(meta.title.trim().length > 0, `${route} 缺少显示标题`);
    assert(html.includes(`data-settings-route="${route}"`), `${route} 缺少入口卡片`);
    assert(html.includes(`id="tab-${route}"`), `${route} 缺少独立面板`);
  }
});

Deno.test('设置页三级路由名称与面板 ID 均保持唯一', () => {
  const routes = Object.keys(SETTINGS_TERTIARY_ROUTES);
  assertEquals(new Set(routes).size, routes.length);
  assertEquals(new Set(routes.map((route) => `tab-${route}`)).size, routes.length);
});

Deno.test('管理中心导航与主页结构：侧栏显示主页且兼容 #search 与 #home', async () => {
  const html = await Deno.readTextFile(optionsHtmlPath);
  assert(html.includes('id="navTabSearch"'), '侧边栏主页按钮必须保留 navTabSearch ID 保证向后兼容');
  assert(html.includes('主页</span>'), '侧栏导航标签已更新为「主页」');
  assert(html.includes('id="tab-search"'), '主页面板必须使用 tab-search 承载');
  assert(html.includes('id="tab-stash"'), '默认时间线面板结构完整');
});

Deno.test('管理中心主页必须允许面板滚动，不得继承时间线 overflow:hidden', async () => {
  const cssPath = resolve(root, '../BetterBrowse/src/options/options.css');
  const css = await Deno.readTextFile(cssPath);
  const start = css.indexOf('#tab-search.tab-panel.search-panel.active');
  assert(start >= 0, '必须单独覆盖主页面板滚动，不能沿用 .tab-panel 的 overflow:hidden');
  const block = css.slice(start, start + 280);
  assert(block.includes('overflow-y: auto'), '主页面板必须允许纵向滚动');
  assert(block.includes('display: block'), '主页面板不得以 flex 列裁切整页内容');
});

Deno.test('搜索收敛：时间线不再内置搜索框，全部检索交由主页承载', async () => {
  const html = await Deno.readTextFile(optionsHtmlPath);
  assert(!html.includes('id="stashSearchInput"'), '时间线必须移除内嵌搜索输入框');
  assert(!html.includes('id="btnStashSearchClear"'), '时间线必须移除搜索清空按钮');
  assert(html.includes('id="btnStashSearchInHome"'), '时间线必须提供跳转主页搜索的入口按钮');

  const stashPath = resolve(root, '../BetterBrowse/src/options/components/stash-tab.js');
  const stash = await Deno.readTextFile(stashPath);
  assert(!/getSearchQuery|searchItemFilter|stashSearchInput/.test(stash), '时间线组件不得保留本地搜索过滤逻辑');
  assert(stash.includes('openHomeSearch'), '时间线必须暴露跳转主页搜索的方法');
  assert(stash.includes('onSearchInHome'), '时间线必须支持宿主注入跳转回调');

  const homePath = resolve(root, '../BetterBrowse/src/home/home-view.js');
  const home = await Deno.readTextFile(homePath);
  assert(home.includes('focusSearch('), '主页共享视图必须暴露 focusSearch 统一检索入口');
});

Deno.test('管理中心主页：视图就绪前已离开主页时不得再激活（避免隐藏主页抢占快捷键与拉取数据）', async () => {
  globalThis.document = globalThis.document || { getElementById: () => null };
  const { SearchHomeComponent } = await import('../BetterBrowse/src/options/components/search-home.js');
  const component = new SearchHomeComponent({ container: null });
  let resolveReady;
  let activated = 0;
  component.view = {
    ready: new Promise((resolve) => { resolveReady = resolve; }),
    activate: () => { activated += 1; },
    deactivate: () => {}
  };
  component.activate();
  component.deactivate();
  resolveReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(activated, 0);

  component.activate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(activated, 1);
});

Deno.test('管理中心路由：只响应后台定向的 SWITCH_OPTIONS_TAB，路由支持查询串且未知路由回落时间线', async () => {
  const source = await Deno.readTextFile(resolve(root, '../BetterBrowse/src/options/options.js'));
  assert(source.includes('ActionTypes.SWITCH_OPTIONS_TAB'), '选项页必须响应 SWITCH_OPTIONS_TAB');
  assert(!/message\.action === ActionTypes\.OPEN_OPTIONS_PAGE/.test(source), 'OPEN_OPTIONS_PAGE 是发往后台的请求，选项页不得响应');
  assert(source.includes(".split('?')"), 'switchTab 必须解析 view?query 路由');
  assert(source.includes('未知路由回落到时间线'), '未知路由必须回落时间线');
});
