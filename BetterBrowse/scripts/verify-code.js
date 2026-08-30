/**
 * @file verify-code.js
 * @description 静态代码规范、Manifest 权限、全量文件完整性与 UTF-8 编码校验器
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';
import { buildContentBundle } from './build-content.js';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

const allJsFiles = [
  'src/constants/action-types.js',
  'src/constants/config.js',
  'src/constants/storage-keys.js',
  'src/core/bus/message-bus.js',
  'src/core/storage/storage-adapter.js',
  'src/core/storage/indexed-db.js',
  'src/core/storage/migration.js',
  'src/core/extension-url.js',
  'src/core/link/link-matcher.js',
  'src/core/link/link-service.js',
  'src/core/rules/base-rule.js',
  'src/core/rules/audible-rule.js',
  'src/core/rules/form-guard-rule.js',
  'src/core/rules/recent-active-rule.js',
  'src/core/rules/frequency-rule.js',
  'src/core/rules/pinned-rule.js',
  'src/core/rules/rule-engine.js',
  'src/core/stash/local-stash-repo.js',
  'src/core/stash/indexed-stash-repo.js',
  'src/core/stash/onetab-converter.js',
  'src/core/stash/stash-service.js',
  'src/core/ai/ai-capabilities.js',
  'src/core/sync/sync-constants.js',
  'src/core/sync/crypto-util.js',
  'src/core/sync/credentials.js',
  'src/core/sync/webdav-client.js',
  'src/core/sync/outbox.js',
  'src/core/sync/merge.js',
  'src/core/sync/snapshot.js',
  'src/core/sync/sync-engine.js',
  'src/core/sync/device-events.js',
  'src/core/sync/account-config-sync.js',
  'src/background/activity-tracker.js',
  'src/background/threshold-monitor.js',
  'src/background/pinned-tab-guard.js',
  'src/background/context-menu-manager.js',
  'src/background/stash-badge.js',
  'src/background/sync-scheduler.js',
  'src/background/action-handlers.js',
  'src/background/ai-bridge.js',
  'src/background/service-worker.js',
  'src/content/link-interceptor.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/main-world-bridge.js',
  'src/content/index.js',
  'src/content/content-bundle.js',
  'src/popup/popup.js',
  'src/options/options.js',
  'native-host/bb_native_host.js',
  'native-host/install.js',
  'native-host/uninstall.js'
];

console.log('=== 开始代码与静态规范校验 ===\n');

let hasError = false;

function resolveProject(relPath) {
  return resolve(projectRoot, relPath);
}

// 1. 验证文件存在性与 UTF-8 编码
for (const file of allJsFiles) {
  const fullPath = resolveProject(file);
  try {
    const buffer = await Deno.readFile(fullPath);
    // 检查 BOM
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      console.error(`[FAIL] 文件包含 UTF-8 BOM: ${file}`);
      hasError = true;
      continue;
    }
    const content = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (content.includes('\ufffd')) {
      console.error(`[FAIL] 文件存在 UTF-8 乱码字符: ${file}`);
      hasError = true;
    } else {
      console.log(`[PASS] ${file} (UTF-8 正常, 大小: ${content.length} 字符)`);
    }
  } catch (_err) {
    console.error(`[FAIL] 文件不存在: ${file}`);
    hasError = true;
  }
}

// 2. 验证 manifest.json
const manifestPath = resolveProject('manifest.json');
try {
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  if (manifest.manifest_version !== 3) {
    console.error('[FAIL] Manifest 版本必须为 3');
    hasError = true;
  } else {
    console.log(`\n[PASS] manifest.json 格式正确 (Manifest V${manifest.manifest_version}, 名称: ${manifest.name})`);
  }
  if (manifest.version_name !== 'Milestone 2') {
    console.error('[FAIL] manifest.json 展示版本必须为 Milestone 2');
    hasError = true;
  } else {
    console.log('[PASS] 扩展展示版本为 Milestone 2');
  }
  if (!manifest.permissions?.includes('contextMenus')) {
    console.error('[FAIL] manifest.json 缺少 contextMenus 权限');
    hasError = true;
  }
} catch (err) {
  console.error('[FAIL] manifest.json 解析失败:', err);
  hasError = true;
}

// 3. 验证图标资源
const iconSizes = [16, 32, 48, 128, 256, 512];
for (const size of iconSizes) {
  const iconPath = resolveProject(`src/icons/icon${size}.png`);
  try {
    const stat = await Deno.stat(iconPath);
    if (stat.isFile && stat.size > 0) {
      console.log(`[PASS] 图标存在: src/icons/icon${size}.png (${stat.size} 字节)`);
    } else {
      console.error(`[FAIL] 图标文件异常: icon${size}.png`);
      hasError = true;
    }
  } catch {
    console.error(`[FAIL] 图标缺失: icon${size}.png`);
    hasError = true;
  }
}

// 4. 验证 HTML 文件 ID 唯一性与编码
const htmlFiles = ['src/popup/popup.html', 'src/options/options.html'];
for (const htmlFile of htmlFiles) {
  const fullPath = resolveProject(htmlFile);
  try {
    const content = await Deno.readTextFile(fullPath);
    const idRegex = /\bid=["']([^"']+)["']/g;
    const ids = new Set();
    let match;
    let dupes = false;
    while ((match = idRegex.exec(content)) !== null) {
      const id = match[1];
      if (ids.has(id)) {
        console.error(`[FAIL] ${htmlFile} 中存在重复的 DOM ID: ${id}`);
        hasError = true;
        dupes = true;
      }
      ids.add(id);
    }
    if (!dupes) {
      console.log(`[PASS] ${htmlFile} (DOM ID 均唯一, 共 ${ids.size} 个 ID)`);
    }
  } catch (_e) {
    console.error(`[FAIL] 无法读取 HTML 文件: ${htmlFile}`);
    hasError = true;
  }
}

// 5. 校验内容脚本产物与当前源码严格一致，防止源码/Bundle 双真值分叉
try {
  const expectedBundle = await buildContentBundle();
  const actualBundle = await Deno.readTextFile(resolveProject('src/content/content-bundle.js'));
  if (expectedBundle !== actualBundle) {
    console.error('[FAIL] src/content/content-bundle.js 与当前内容脚本源码不一致，请执行 deno task bundle');
    hasError = true;
  } else {
    console.log('[PASS] content-bundle.js 与源码一致');
  }

  // 产物语法自检：import/export 剥离不完整会产出非法脚本且浏览器静默失败，此处直接拦截
  try {
    // eslint-disable-next-line no-new-func
    new Function(actualBundle);
    console.log('[PASS] content-bundle.js 语法自检通过');
  } catch (syntaxErr) {
    console.error('[FAIL] content-bundle.js 存在语法错误（请检查 build-content.js 的模块语法剥离规则）:', syntaxErr.message);
    hasError = true;
  }
} catch (err) {
  console.error('[FAIL] 内容脚本产物一致性校验异常:', err);
  hasError = true;
}

// 6. 内容脚本不得直读 chrome.storage / IndexedDB（必须经后台消息返回最小必要字段）
const contentSourceFiles = [
  'src/content/link-interceptor.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/index.js',
  'src/content/main-world-bridge.js'
];
const forbiddenStorageAccess = /chrome\.storage(?:\.local|\.sync)?\.(?:get|set|remove|clear)\b|indexedDB\.open\b/;
for (const file of contentSourceFiles) {
  const fullPath = resolveProject(file);
  try {
    const content = await Deno.readTextFile(fullPath);
    if (forbiddenStorageAccess.test(content)) {
      console.error(`[FAIL] ${file} 直接访问了 chrome.storage 或 IndexedDB，内容脚本必须经后台消息获取最小必要字段`);
      hasError = true;
    } else {
      console.log(`[PASS] ${file} 未直读存储`);
    }
  } catch {
    console.error(`[FAIL] 无法读取内容脚本: ${file}`);
    hasError = true;
  }
}

if (hasError) {
  console.error('\n❌ 静态代码规范校验未通过，请修复上述问题！');
  Deno.exit(1);
} else {
  console.log('\n✨ 全部代码与静态规范校验通过！');
}
