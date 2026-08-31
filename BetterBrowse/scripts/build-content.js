/**
 * @file build-content.js
 * @description 构建内容脚本单文件（将模块化源码合并为自包含的 content-bundle.js，确保 100% 站点兼容性）
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

const banner = `/**
 * @file content-bundle.js
 * @description Better Browse 内容脚本打包产物（自包含、无外部依赖、100% 站点兼容）
 * @encoding UTF-8
 */
(function() {
  'use strict';
  // 防重复执行守卫：后台广播倒计时卡片时会对未响应的标签页动态重注入本产物，
  // 二次执行会导致监听器叠加（如一次点击开两个标签），必须在最顶部拦截
  if (window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__) {
    return;
  }
  window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__ = true;
`;

const footer = `
})();
`;

// 需要按依赖顺序打包的模块源码
const filesToBundle = [
  'src/constants/action-types.js',
  'src/constants/config.js',
  'src/core/logging/runtime-logger.js',
  'src/core/link/link-matcher.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/link-interceptor.js',
  'src/content/index.js'
];

/**
 * 剥离 ES 模块语法，使其可在经典脚本（IIFE）作用域中执行
 * @param {string} content - 单个模块源码
 * @returns {string}
 */
function stripModuleSyntax(content) {
  return content
    // 具名/默认导入（含多行）
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
    // 副作用导入（无 from 子句，如 import './x.js';）
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    // 命名导出（含 async 函数声明）
    .replace(/^export\s+(async\s+)?(const|let|var|class|function)\s+/gm, '$1$2 ')
    // 默认导出
    .replace(/^export\s+default\s+/gm, '');
}

export async function buildContentBundle() {
  let combinedCode = banner;
  for (const relPath of filesToBundle) {
    const fullPath = resolve(projectRoot, relPath);
    const content = stripModuleSyntax(await Deno.readTextFile(fullPath));
    combinedCode += `\n// ===== [模块: ${relPath}] =====\n` + content + '\n';
  }
  return combinedCode + footer;
}

if (import.meta.main) {
  const outputPath = resolve(projectRoot, 'src/content/content-bundle.js');
  const combinedCode = await buildContentBundle();
  await Deno.writeTextFile(outputPath, combinedCode);
  console.log(`✅ 已成功打包内容脚本: ${outputPath} (${combinedCode.length} 字符)`);
}
