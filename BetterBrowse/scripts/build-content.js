/**
 * @file build-content.js
 * @description 构建顶层完整内容脚本与 iframe 轻量内容脚本
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

const bundles = [
  {
    output: 'src/content/content-bundle.js',
    description: 'BetterBrowse 顶层页面完整内容脚本打包产物',
    guard: `  if (window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__) return;
  window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__ = true;`,
    files: [
      'src/constants/action-types.js',
      'src/constants/config.js',
      'src/core/logging/runtime-logger.js',
      'src/core/link/link-matcher.js',
      'src/content/form-detector.js',
      'src/content/countdown-banner.js',
      'src/content/link-interceptor.js',
      'src/content/index.js'
    ]
  },
  {
    output: 'src/content/frame-content-bundle.js',
    description: 'BetterBrowse iframe 轻量内容脚本打包产物',
    guard: `  if (window.top === window.self || window.__BETTER_BROWSE_FRAME_BUNDLE_LOADED__) return;
  window.__BETTER_BROWSE_FRAME_BUNDLE_LOADED__ = true;`,
    files: [
      'src/constants/action-types.js',
      'src/constants/config.js',
      'src/core/link/link-matcher.js',
      'src/content/form-detector.js',
      'src/content/link-interceptor.js',
      'src/content/frame-index.js'
    ]
  }
];

function stripModuleSyntax(content) {
  return content
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(async\s+)?(const|let|var|class|function)\s+/gm, '$1$2 ')
    .replace(/^export\s+default\s+/gm, '');
}

async function buildBundle(spec) {
  let combinedCode = `/**
 * @file ${spec.output.split('/').at(-1)}
 * @description ${spec.description}
 * @encoding UTF-8
 */
(function() {
  'use strict';
${spec.guard}
`;

  for (const relPath of spec.files) {
    const content = stripModuleSyntax(await Deno.readTextFile(resolve(projectRoot, relPath)));
    combinedCode += `\n// ===== [模块: ${relPath}] =====\n${content}\n`;
  }
  return `${combinedCode}\n})();\n`;
}

export async function buildContentBundle() {
  return await buildBundle(bundles[0]);
}

export async function buildFrameContentBundle() {
  return await buildBundle(bundles[1]);
}

if (import.meta.main) {
  for (const spec of bundles) {
    const outputPath = resolve(projectRoot, spec.output);
    const combinedCode = await buildBundle(spec);
    await Deno.writeTextFile(outputPath, combinedCode);
    console.log(`[PASS] 已打包内容脚本: ${outputPath} (${combinedCode.length} 字符)`);
  }
}
