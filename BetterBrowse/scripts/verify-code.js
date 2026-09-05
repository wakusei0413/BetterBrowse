/**
 * @file verify-code.js
 * @description 静态代码规范、Manifest 权限、全量文件完整性与 UTF-8 编码校验器
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, relative, resolve } from '@std/path';
import { walk } from '@std/fs';
import { buildContentBundle, buildFrameContentBundle } from './build-content.js';
import { runActionContractChecks } from './verify-action-contract.js';
import { runVersioningChecks } from './verify-versioning.js';
import { runStorageDisciplineChecks } from './verify-storage-discipline.js';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');
const repositoryRoot = resolve(projectRoot, '..');

const allJsFiles = new Set([
  'src/constants/api-version.js',
  'src/constants/action-types.js',
  'src/constants/config.js',
  'src/constants/format-revisions.js',
  'src/constants/storage-keys.js',
  'src/core/bus/message-bus.js',
  'src/core/security/message-authorizer.js',
  'src/core/storage/storage-adapter.js',
  'src/core/storage/indexed-db.js',
  'src/core/storage/migration.js',
  'src/core/logging/runtime-logger.js',
  'src/core/logging/runtime-log-repository.js',
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
  'src/background/sync-scheduler.js',
  'src/background/action-handlers.js',
  'src/background/ai-bridge.js',
  'src/background/service-worker.js',
  'src/content/link-interceptor.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/main-world-bridge.js',
  'src/content/index.js',
  'src/content/frame-index.js',
  'src/content/content-bundle.js',
  'src/content/frame-content-bundle.js',
  'src/background/link-notifier.js',
  'src/popup/popup.js',
  'src/options/list-window.js',
  'src/options/constants.js',
  'src/options/components/toast.js',
  'src/options/components/stash-tab.js',
  'src/options/components/stash-settings.js',
  'src/options/components/rules-config.js',
  'src/options/components/domain-rules.js',
  'src/options/components/backup.js',
  'src/options/components/webdav-sync.js',
  'src/options/components/ai-bridge.js',
  'src/options/components/runtime-log.js',
  'src/options/components/about.js',
  'src/options/components/search-home.js',
  'src/options/ui/custom-select.js',
  'src/options/ui/time-tree.js',
  'src/options/options.js',
  'native-host/bb_native_host.js',
  'native-host/install.js',
  'native-host/uninstall.js',
  'scripts/bump-api-version.js',
  'scripts/verify-action-contract.js',
  'scripts/verify-versioning.js'
]);

const allPythonFiles = new Set([
  '../skills/BetterBrowse/scripts/betterbrowse_client.py',
  '../tests/python/test_betterbrowse_client.py'
]);

// 自动纳入扩展根目录下新增的 JavaScript 模块，避免手写清单遗漏新文件。
for await (const entry of walk(projectRoot, { includeDirs: false, exts: ['.js'] })) {
  allJsFiles.add(relative(projectRoot, entry.path).replaceAll('\\', '/'));
}

// 自动纳入 Skill 与测试目录中的 Python 源文件，缓存目录由 .gitignore 排除且不参与校验。
for (const pythonRoot of [
  resolve(repositoryRoot, 'skills/BetterBrowse'),
  resolve(repositoryRoot, 'tests/python')
]) {
  try {
    for await (const entry of walk(pythonRoot, { includeDirs: false, exts: ['.py'] })) {
      allPythonFiles.add(relative(projectRoot, entry.path).replaceAll('\\', '/'));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

const allSourceFiles = new Set([...allJsFiles, ...allPythonFiles]);

console.log('=== 开始代码与静态规范校验 ===\n');

let hasError = false;

function resolveProject(relPath) {
  return resolve(projectRoot, relPath);
}

// 1. 验证 JavaScript 与 Python 文件存在性及 UTF-8 编码
for (const file of allSourceFiles) {
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

// Python 使用内存 AST 编译检查语法；-B 与 sys.dont_write_bytecode 双重确保不生成 __pycache__。
try {
  const pythonExecutable = Deno.env.get('PYTHON') || 'python';
  const pythonPaths = [...allPythonFiles].map(resolveProject);
  const syntaxScript = [
    'import ast, pathlib, sys',
    'sys.dont_write_bytecode = True',
    'minimum = (3, 9)',
    'if sys.version_info < minimum:',
    '    raise SystemExit(f"需要 Python 3.9+，当前为 {sys.version.split()[0]}")',
    'for filename in sys.argv[1:]:',
    '    source = pathlib.Path(filename).read_text(encoding="utf-8")',
    '    ast.parse(source, filename=filename, feature_version=(3, 9))'
  ].join('\n');
  const output = await new Deno.Command(pythonExecutable, {
    args: ['-B', '-c', syntaxScript, ...pythonPaths],
    stdout: 'piped',
    stderr: 'piped'
  }).output();
  if (!output.success) {
    console.error('[FAIL] Python 3.9+ 语法检查失败:', new TextDecoder().decode(output.stderr).trim());
    hasError = true;
  } else {
    console.log(`[PASS] Python 3.9+ 语法检查通过（${pythonPaths.length} 个文件，未生成 pycache）`);
  }
} catch (err) {
  console.error('[FAIL] 无法执行 Python 3.9+ 语法检查:', err.message);
  hasError = true;
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
  const apiVersionSource = await Deno.readTextFile(resolveProject('src/constants/api-version.js'));
  const apiVersionMatch = /export const API_VERSION = (\d+);/.exec(apiVersionSource);
  const apiVersion = Number(apiVersionMatch?.[1]);
  if (!/^\d+(?:\.\d+){0,3}$/.test(String(manifest.version || ''))) {
    console.error('[FAIL] manifest.json 软件版本不符合 Chrome 的数字版本格式');
    hasError = true;
  } else {
    console.log(`[PASS] 软件发布版本独立有效 (${manifest.version_name || manifest.version})`);
  }
  if (!Number.isSafeInteger(apiVersion) || apiVersion < 1) {
    console.error('[FAIL] API_VERSION 必须是裸正整数');
    hasError = true;
  } else {
    console.log(`[PASS] 内部 API 版本为裸整数 ${apiVersion}，与软件发布版本独立`);
  }
  if (!manifest.permissions?.includes('contextMenus')) {
    console.error('[FAIL] manifest.json 缺少 contextMenus 权限');
    hasError = true;
  }
} catch (err) {
  console.error('[FAIL] manifest.json 解析失败:', err);
  hasError = true;
}

// 3. API 版本只能在唯一事实源中定义，其他组件必须导入或从 bridge.json 读取
const duplicateVersionFiles = [
  'src/core/ai/ai-capabilities.js',
  'src/background/ai-bridge.js',
  'native-host/bb_native_host.js'
];
const duplicateVersionPattern = /\b(?:AI_BRIDGE_PROTO|PROTOCOL_VERSION)\b|\b(?:const|let|var)\s+API_VERSION\s*=/;
for (const file of duplicateVersionFiles) {
  const content = await Deno.readTextFile(resolveProject(file));
  if (duplicateVersionPattern.test(content)) {
    console.error(`[FAIL] ${file} 定义了独立 API 版本，必须使用 src/constants/api-version.js`);
    hasError = true;
  } else {
    console.log(`[PASS] ${file} 未定义独立 API 版本`);
  }
}

const pythonClientPath = '../skills/BetterBrowse/scripts/betterbrowse_client.py';
const pythonClientSource = await Deno.readTextFile(resolveProject(pythonClientPath));
const pythonHardcodedVersionPattern = /^\s*(?:API_VERSION|PROTOCOL_VERSION|AI_BRIDGE_PROTO)\s*=|["']apiVersion["']\s*:\s*\d+/m;
if (pythonHardcodedVersionPattern.test(pythonClientSource)) {
  console.error(`[FAIL] ${pythonClientPath} 硬编码了 API 版本，必须从 bridge.json.apiVersion 读取`);
  hasError = true;
} else if (!/info\[["']apiVersion["']\]/.test(pythonClientSource)) {
  console.error(`[FAIL] ${pythonClientPath} 未从 bridge.json 信息读取 apiVersion`);
  hasError = true;
} else {
  console.log(`[PASS] ${pythonClientPath} 从 bridge.json 读取 API 版本且未硬编码`);
}

const apiBumpSource = await Deno.readTextFile(resolveProject('scripts/bump-api-version.js'));
if (/manifest(?:Path|\.json)|manifest\.version|version_name/.test(apiBumpSource)) {
  console.error('[FAIL] api-version-bump 不得读取或修改软件发布版本');
  hasError = true;
} else {
  console.log('[PASS] API 版本递增工具与软件发布版本完全解耦');
}

// 4. 验证图标资源
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

// 5. 验证 HTML 文件 ID 唯一性与编码
const htmlFiles = ['src/popup/popup.html', 'src/options/options.html', 'src/newtab/newtab.html'];
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

// 6. 校验内容脚本产物与当前源码严格一致，防止源码/Bundle 双真值分叉
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

  const expectedFrameBundle = await buildFrameContentBundle();
  const actualFrameBundle = await Deno.readTextFile(resolveProject('src/content/frame-content-bundle.js'));
  if (expectedFrameBundle !== actualFrameBundle) {
    console.error('[FAIL] src/content/frame-content-bundle.js 与当前 iframe 内容脚本源码不一致，请执行 deno task bundle');
    hasError = true;
  } else {
    console.log('[PASS] frame-content-bundle.js 与源码一致');
  }
  try {
    new Function(actualFrameBundle);
    console.log('[PASS] frame-content-bundle.js 语法自检通过');
  } catch (syntaxErr) {
    console.error('[FAIL] frame-content-bundle.js 存在语法错误:', syntaxErr.message);
    hasError = true;
  }
} catch (err) {
  console.error('[FAIL] 内容脚本产物一致性校验异常:', err);
  hasError = true;
}

// 7. 内容脚本不得直读 chrome.storage / IndexedDB（必须经后台消息返回最小必要字段）
const contentSourceFiles = [
  'src/content/link-interceptor.js',
  'src/content/form-detector.js',
  'src/content/countdown-banner.js',
  'src/content/index.js',
  'src/content/frame-index.js',
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

// 8. 已绑定标识符必须有对应导入/声明，避免 SW 事件回调在运行时 ReferenceError
//    典型回归：pinned-tab-guard.js 使用 isOwnOptionsUrl 却漏掉 import
const identifierBindingFiles = [
  'src/background/pinned-tab-guard.js',
  'src/background/context-menu-manager.js',
  'src/background/threshold-monitor.js',
  'src/background/service-worker.js',
  'src/background/action-handlers.js',
  'src/core/stash/stash-service.js',
  'src/core/rules/rule-engine.js'
];
const identifierUseRegex = /\b(isOwnOptionsUrl|isOwnNewTabUrl|isOwnExtensionPageUrl|isExcludedFromTabCounting|isNewTabUrl|filterCountableTabs)\b/g;
for (const file of identifierBindingFiles) {
  const fullPath = resolveProject(file);
  try {
    const content = await Deno.readTextFile(fullPath);
    const used = new Set();
    let match;
    while ((match = identifierUseRegex.exec(content)) !== null) {
      used.add(match[1]);
    }
    const missing = [...used].filter((name) => {
      const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]+['"]`);
      const declRe = new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`);
      const exportRe = new RegExp(`export\\s+function\\s+${name}\\b`);
      return !importRe.test(content) && !declRe.test(content) && !exportRe.test(content);
    });
    if (missing.length > 0) {
      console.error(`[FAIL] ${file} 使用了未导入标识符: ${missing.join(', ')}`);
      hasError = true;
    } else if (used.size > 0) {
      console.log(`[PASS] ${file} 标识符绑定完整 (${[...used].join(', ')})`);
    }
  } catch {
    console.error(`[FAIL] 无法读取绑定校验文件: ${file}`);
    hasError = true;
  }
}

// 9. 校验后台动作与 AI / 内容脚本 / 人类 UI 的静态契约
try {
  const actionContract = await runActionContractChecks(projectRoot);
  if (!actionContract.pass) hasError = true;
} catch (err) {
  console.error('[FAIL] 动作静态契约校验异常:', err);
  hasError = true;
}

// 10. 校验五套版本号的唯一事实源与迁移边界
try {
  const versioning = await runVersioningChecks(projectRoot);
  if (!versioning.pass) hasError = true;
} catch (err) {
  console.error('[FAIL] 版本号护栏校验异常:', err);
  hasError = true;
}

// 11. 校验存储门面、写锁与内容脚本产物访问纪律
try {
  const storageDiscipline = await runStorageDisciplineChecks(projectRoot);
  if (storageDiscipline.errors.length > 0) hasError = true;
} catch (err) {
  console.error('[FAIL] 存储纪律校验异常:', err);
  hasError = true;
}

// 12. 对外品牌名称统一使用 BetterBrowse，禁止重新引入带空格写法。
// 禁用短语用拼接生成，避免校验器源码自身被扫成违规。
const spacedBrand = ['Better', 'Browse'].join(' ');
const verifierRelPath = relative(repositoryRoot, fromFileUrl(import.meta.url)).replaceAll('\\', '/');
const brandScanSkip = /(?:^|[\\/])(?:\.git|\.zcode|\.vscode|\.idea|node_modules|\.deno|\.tmp-verify|\.thumbnails|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|dist|build|coverage|htmlcov)(?:[\\/]|$)/;
const spacedBrandMatches = [];
for await (const entry of walk(repositoryRoot, {
  includeDirs: false,
  exts: ['.js', '.py', '.html', '.md', '.json'],
  skip: [brandScanSkip]
})) {
  const relPath = relative(repositoryRoot, entry.path).replaceAll('\\', '/');
  if (relPath === verifierRelPath) continue;
  const content = await Deno.readTextFile(entry.path);
  if (content.includes(spacedBrand)) {
    spacedBrandMatches.push(relPath);
  }
}
if (spacedBrandMatches.length > 0) {
  console.error(`[FAIL] 项目品牌名称必须写作 BetterBrowse，以下文件仍使用带空格写法: ${spacedBrandMatches.join(', ')}`);
  hasError = true;
} else {
  console.log('[PASS] 项目品牌展示名称已统一为 BetterBrowse');
}

if (hasError) {
  console.error('\n❌ 静态代码规范校验未通过，请修复上述问题！');
  Deno.exit(1);
} else {
  console.log('\n✨ 全部代码与静态规范校验通过！');
}
