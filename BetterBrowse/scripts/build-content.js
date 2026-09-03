/**
 * @file build-content.js
 * @description 构建顶层完整内容脚本与 iframe 轻量内容脚本
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

export const BUNDLE_SPECS = [
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

async function sha256Short(content) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

async function buildBundle(spec) {
  const sources = [];
  for (const relPath of spec.files) {
    const raw = await Deno.readTextFile(resolve(projectRoot, relPath));
    sources.push({ path: relPath, hash: await sha256Short(raw) });
  }
  const fingerprint = sources.map(({ path, hash }) => `${path}=${hash}`).join(';');
  let combinedCode = `/**
 * @file ${spec.output.split('/').at(-1)}
 * @description ${spec.description}
 * @encoding UTF-8
 * @betterbrowse-sources ${fingerprint}
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

export async function checkContentBundlesFresh() {
  const stale = [];
  const ok = [];
  for (const spec of BUNDLE_SPECS) {
    const outputPath = resolve(projectRoot, spec.output);
    let actual;
    try {
      actual = await Deno.readTextFile(outputPath);
    } catch {
      stale.push({ output: spec.output, reason: '产物不存在', changed: spec.files });
      continue;
    }
    const match = actual.match(/@betterbrowse-sources ([^\n]+)/);
    const expected = [];
    for (const relPath of spec.files) {
      expected.push(`${relPath}=${await sha256Short(await Deno.readTextFile(resolve(projectRoot, relPath)))}`);
    }
    if (!match || match[1].trim() !== expected.join(';')) {
      const actualMap = new Map((match?.[1] || '').split(';').filter(Boolean).map((entry) => entry.split('=')));
      const changed = expected.filter((entry) => actualMap.get(entry.split('=')[0]) !== entry.split('=')[1]).map((entry) => entry.split('=')[0]);
      stale.push({ output: spec.output, reason: '源文件哈希不匹配', changed });
    } else {
      ok.push(spec.output);
    }
  }
  return { stale, ok };
}


export async function buildContentBundle() {
  return await buildBundle(BUNDLE_SPECS[0]);
}

export async function buildFrameContentBundle() {
  return await buildBundle(BUNDLE_SPECS[1]);
}

if (import.meta.main) {
    for (const spec of BUNDLE_SPECS) {
    const outputPath = resolve(projectRoot, spec.output);
    const combinedCode = await buildBundle(spec);
    await Deno.writeTextFile(outputPath, combinedCode);
    console.log(`[PASS] 已打包内容脚本: ${outputPath} (${combinedCode.length} 字符)`);
  }
}
