/**
 * @file build-content.mjs
 * @description 构建内容脚本单文件（将模块化源码打包为自包含的 content-bundle.js，确保 100% 站点兼容性）
 * @encoding UTF-8
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const banner = `/**
 * @file content-bundle.js
 * @description Better Browse 内容脚本打包产物（自包含、无外部依赖、100% 站点兼容）
 * @encoding UTF-8
 */
(function() {
  'use strict';
`;

const footer = `
})();
`;

// 需要按依赖顺序打包的模块源码
const filesToBundle = [
  'src/constants/action-types.js',
  'src/constants/storage-keys.js',
  'src/constants/config.js',
  'src/core/link/link-matcher.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/link-interceptor.js',
  'src/content/index.js'
];

let combinedCode = banner;

for (const relPath of filesToBundle) {
  const fullPath = path.resolve(projectRoot, relPath);
  let content = fs.readFileSync(fullPath, 'utf-8');

  // 移除 import 和 export 语句以适配自包含 IIFE
  content = content
    .replace(/^import\s+[\s\S]*?from\s+['"].*?['"];?/gm, '')
    .replace(/^export\s+(const|let|var|class|function|default)\s+/gm, '$1 ');

  combinedCode += `\n// ===== [模块: ${relPath}] =====\n` + content + '\n';
}

combinedCode += footer;

const outputPath = path.resolve(projectRoot, 'src/content/content-bundle.js');
fs.writeFileSync(outputPath, combinedCode, 'utf-8');
console.log(`Successfully built content-bundle.js at ${outputPath} (${combinedCode.length} bytes)`);

