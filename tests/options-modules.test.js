/**
 * @file options-modules.test.js
 * @description 校验选项页拆分后的 ESM 具名导出与互相导入
 * @encoding UTF-8
 */

import { assert, assertEquals } from '@std/assert';
import { dirname, fromFileUrl, resolve } from '@std/path';

const optionsRoot = resolve(dirname(fromFileUrl(import.meta.url)), '../BetterBrowse/src/options');

function extractNamedImports(source) {
  const result = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const names = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).at(0)).filter(Boolean);
    result.push({ names, from: match[2] });
  }
  return result;
}

function extractNamedExports(source) {
  const names = [
    ...[...source.matchAll(/^export (?:async\s+)?(?:class|const|function|let|var)\s+(\w+)/gm)].map((m) => m[1])
  ];
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    names.push(...match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).at(0)).filter(Boolean));
  }
  return new Set(names);
}

Deno.test('选项页模块的具名导入都能在目标文件找到对应导出', async () => {
  const files = [];
  for await (const entry of Deno.readDir(optionsRoot)) {
    if (entry.isFile && entry.name.endsWith('.js')) files.push(entry.name);
  }
  for (const dir of ['components', 'ui']) {
    for await (const entry of Deno.readDir(resolve(optionsRoot, dir))) {
      if (entry.isFile && entry.name.endsWith('.js')) files.push(`${dir}/${entry.name}`);
    }
  }

  const missing = [];
  for (const rel of files) {
    const source = await Deno.readTextFile(resolve(optionsRoot, rel));
    for (const item of extractNamedImports(source)) {
      if (!item.from.startsWith('.')) continue;
      const targetPath = resolve(optionsRoot, rel, '..', item.from);
      let targetSource;
      try {
        targetSource = await Deno.readTextFile(targetPath);
      } catch {
        missing.push(`${rel} 导入 ${item.from}，但目标文件不存在`);
        continue;
      }
      const exports = extractNamedExports(targetSource);
      for (const name of item.names) {
        if (!exports.has(name)) missing.push(`${rel} 从 ${item.from} 导入 ${name}，但目标文件未导出`);
      }
    }
  }

  assertEquals(missing, [], missing.join('\n'));
});

Deno.test('选项页关键类均已导出', async () => {
  const required = {
    'options.js': ['OptionsApp'],
    'constants.js': ['SETTINGS_SUBTAB_TITLES', 'SETTINGS_SUBTABS', 'SETTINGS_TERTIARY_ROUTES'],
    'components/ai-bridge.js': ['AIBridgeComponent'],
    'components/stash-tab.js': ['StashTabComponent'],
    'components/toast.js': ['Toast'],
    'ui/time-tree.js': ['TimeTreeBuilder', 'SingleLineTimelineScrollbar'],
    'ui/custom-select.js': ['CustomSelectEnhancer']
  };
  for (const [file, names] of Object.entries(required)) {
    const source = await Deno.readTextFile(resolve(optionsRoot, file));
    const exports = extractNamedExports(source);
    for (const name of names) assert(exports.has(name), `${file} 缺少导出 ${name}`);
  }
});
