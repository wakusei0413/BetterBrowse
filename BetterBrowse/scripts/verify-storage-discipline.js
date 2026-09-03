/**
 * @file verify-storage-discipline.js
 * @description 校验存储门面、写锁与内容脚本产物的静态纪律
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';
import { walk } from '@std/fs';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');
const STORAGE_WHITELIST = new Set([
  'src/core/stash/local-stash-repo.js', 'src/core/storage/storage-adapter.js',
  'src/core/storage/migration.js', 'src/core/storage/indexed-db.js',
  'src/core/sync/credentials.js', 'src/core/sync/account-config-sync.js',
  'src/constants/storage-keys.js', 'src/constants/config.js'
]);

/** 对给定源码执行纯文本纪律检查。 */
export function checkStorageDisciplineSources(files) {
  const errors = [];
  const warnings = [];
  for (const [file, source] of Object.entries(files)) {
    const lines = source.split(/\r?\n/);
    const lockStarts = [...source.matchAll(/withWriteLock\s*\(\s*async\s*\(\)\s*=>\s*\{/g)];
    for (const match of lockStarts) {
      const open = source.indexOf('{', match.index);
      let depth = 0; let close = open;
      for (; close < source.length; close += 1) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}' && --depth === 0) break;
      }
      const body = source.slice(open + 1, close);
      if (/withWriteLock\s*\(\s*async\s*\(\)\s*=>\s*\{/.test(body)) {
        const line = source.slice(0, match.index).split('\n').length;
        errors.push(`${file}:${line} 字面嵌套 withWriteLock`);
      }
    }
    if (!STORAGE_WHITELIST.has(file) && /chrome\.storage\.(?:local|sync)\.set\s*\(/.test(source)) {
      const line = lines.findIndex((line) => /chrome\.storage\.(?:local|sync)\.set\s*\(/.test(line)) + 1;
      errors.push(`${file}:${line} 绕过存储门面直接调用 chrome.storage.set`);
    }
    if (/setTimeout\s*\(/.test(source) && /src\/background\//.test(file) && !/chrome\.alarms/.test(source)) {
      warnings.push(`${file}：使用 setTimeout 且未发现 chrome.alarms 兜底，请确认 Service Worker 休眠场景`);
    }
  }
  for (const file of ['src/content/content-bundle.js', 'src/content/frame-content-bundle.js']) {
    const source = files[file] || '';
    if (/chrome\.storage\.(?:local|sync)\.(?:get|set|remove|clear)\s*\(|indexedDB\.open\s*\(/.test(source)) {
      errors.push(`${file}:1 内容脚本产物直接访问存储`);
    }
  }
  return { errors, warnings };
}

export async function runStorageDisciplineChecks(root = projectRoot) {
  const files = {};
  for await (const entry of walk(root, { includeDirs: false, exts: ['.js'] })) {
    const file = entry.path.replaceAll('\\', '/');
    const rel = file.slice(root.replaceAll('\\', '/').length + 1);
    if (rel.startsWith('src/') && !rel.endsWith('options.js') && !rel.includes('/options/')) {
      files[rel] = await Deno.readTextFile(entry.path);
    }
  }
  const result = checkStorageDisciplineSources(files);
  for (const error of result.errors) console.error(`[FAIL] ${error}`);
  for (const warning of result.warnings) console.warn(`[WARN] ${warning}`);
  if (result.errors.length === 0) console.log(`[PASS] 存储纪律校验通过（警告 ${result.warnings.length} 条）`);
  return result;
}

if (import.meta.main) {
  const result = await runStorageDisciplineChecks();
  if (result.errors.length > 0) Deno.exit(1);
}
