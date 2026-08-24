import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const allJsFiles = [
  'src/constants/action-types.js',
  'src/constants/config.js',
  'src/constants/storage-keys.js',
  'src/core/bus/message-bus.js',
  'src/core/storage/storage-adapter.js',
  'src/core/storage/migration.js',
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
  'src/core/stash/onetab-converter.js',
  'src/core/stash/stash-service.js',
  'src/background/activity-tracker.js',
  'src/background/threshold-monitor.js',
  'src/background/pinned-tab-guard.js',
  'src/background/service-worker.js',
  'src/content/link-interceptor.js',
  'src/content/form-detector.js',
  'src/content/main-world-bridge.js',
  'src/content/index.js',
  'src/content/content-bundle.js',
  'src/popup/popup.js',
  'src/options/options.js'
];

console.log('=== 开始代码与静态规范校验 ===');

let hasError = false;

// 1. 验证文件存在性与 UTF-8 编码
for (const file of allJsFiles) {
  const fullPath = path.resolve(projectRoot, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`[FAIL] 文件不存在: ${file}`);
    hasError = true;
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  if (content.includes('\ufffd')) {
    console.error(`[FAIL] 文件存在 UTF-8 乱码字符: ${file}`);
    hasError = true;
  } else {
    console.log(`[PASS] ${file} (UTF-8 正常, 大小: ${content.length} 字符)`);
  }
}

// 2. 验证 manifest.json
const manifestPath = path.resolve(projectRoot, 'manifest.json');
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`[PASS] manifest.json 格式正确 (Manifest V${manifest.manifest_version}, 名称: ${manifest.name})`);
} catch (err) {
  console.error('[FAIL] manifest.json 解析失败:', err);
  hasError = true;
}

// 3. 验证图标资源
const iconSizes = [16, 32, 48, 128];
for (const size of iconSizes) {
  const iconPath = path.resolve(projectRoot, `src/icons/icon${size}.png`);
  if (!fs.existsSync(iconPath)) {
    console.error(`[FAIL] 图标缺失: icon${size}.png`);
    hasError = true;
  } else {
    console.log(`[PASS] 图标存在: src/icons/icon${size}.png`);
  }
}

// 4. 验证 HTML 文件
['src/popup/popup.html', 'src/options/options.html'].forEach((htmlFile) => {
  const full = path.resolve(projectRoot, htmlFile);
  if (!fs.existsSync(full)) {
    console.error(`[FAIL] HTML 缺失: ${htmlFile}`);
    hasError = true;
  } else {
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes('charset="UTF-8"')) {
      console.error(`[FAIL] HTML 缺少 charset="UTF-8" 声明: ${htmlFile}`);
      hasError = true;
    } else {
      console.log(`[PASS] HTML 正常: ${htmlFile}`);
    }
  }
});

if (hasError) {
  console.error('\n❌ 存在校验失败项！');
  process.exit(1);
} else {
  console.log('\n✅ 全部文件与静态规范校验 100% 通过！');
}

