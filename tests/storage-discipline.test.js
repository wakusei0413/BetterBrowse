/**
 * @file storage-discipline.test.js
 * @description 存储纪律静态护栏回归测试
 * @encoding UTF-8
 */

import { assert, assertEquals } from '@std/assert';
import { checkStorageDisciplineSources, runStorageDisciplineChecks } from '../BetterBrowse/scripts/verify-storage-discipline.js';

Deno.test('存储纪律：字面嵌套写锁报告错误', () => {
  const result = checkStorageDisciplineSources({
    'src/core/example.js': 'withWriteLock(async () => { withWriteLock(async () => {}); });'
  });
  assertEquals(result.errors.length, 1);
  assert(result.errors[0].includes('嵌套'));
});

Deno.test('存储纪律：门面外直接 storage.set 报告错误', () => {
  const result = checkStorageDisciplineSources({
    'src/core/example.js': 'chrome.storage.local.set({ value: 1 });'
  });
  assertEquals(result.errors.length, 1);
  assert(result.errors[0].includes('存储门面'));
});

Deno.test('存储纪律：真实源码无硬错误', async () => {
  const result = await runStorageDisciplineChecks();
  assertEquals(result.errors, []);
  assert(result.warnings.length <= 3);
});
