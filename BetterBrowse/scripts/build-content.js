/**
 * @file build-content.js
 * @description 构建内容脚本单文件（将模块化源码合并为自包含的 content-bundle.js，确保 100% 站点兼容性）
 * @encoding UTF-8
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

export async function buildContentBundle() {
  let combinedCode = banner;
  for (const relPath of filesToBundle) {
    const fullPath = path.resolve(projectRoot, relPath);
    let content = await fs.readFile(fullPath, 'utf8');
    content = content
      .replace(/^import\s+[\s\S]*?from\s+['"].*?['"];?/gm, '')
      .replace(/^export\s+(const|let|var|class|function)\s+/gm, '$1 ')
      .replace(/^export\s+default\s+/gm, '');
    combinedCode += `\n// ===== [模块: ${relPath}] =====\n` + content + '\n';
  }
  return combinedCode + footer;
}

if (import.meta.main) {
  const outputPath = path.resolve(projectRoot, 'src/content/content-bundle.js');
  const combinedCode = await buildContentBundle();
  await fs.writeFile(outputPath, combinedCode, 'utf8');
  console.log(`✅ 已成功打包内容脚本: ${outputPath} (${combinedCode.length} 字符)`);
}
