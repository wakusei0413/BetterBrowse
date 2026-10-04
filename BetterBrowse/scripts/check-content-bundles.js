/**
 * @file check-content-bundles.js
 * @description 快速检查内容脚本产物是否与源文件哈希一致
 * @encoding UTF-8
 */

import { checkContentBundlesFresh } from './build-content.js';

const result = await checkContentBundlesFresh();
for (const output of result.ok) console.log(`[PASS] 内容脚本产物最新: ${output}`);
for (const item of result.stale) {
  console.error(`[FAIL] 内容脚本产物过期: ${item.output}（${item.reason}）`);
  if (item.changed?.length) console.error(`       变更源文件: ${item.changed.join(', ')}`);
  console.error('       请执行: deno task bundle');
}
if (result.stale.length > 0) Deno.exit(1);
