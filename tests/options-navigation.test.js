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
