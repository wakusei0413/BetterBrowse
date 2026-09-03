/**
 * @file verify-versioning.js
 * @description 校验五套版本号的唯一事实源、迁移边界与注释护栏
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

function numberOf(source, name) {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

function failureList({ api, config, indexed, format, migration, indexedSource, manifest, bumpSource }) {
  const failures = [];
  const revisions = [
    ['API_VERSION', api.value, 'src/constants/api-version.js'],
    ['LOCAL_DATA_SCHEMA_REVISION', config.value, 'src/constants/config.js'],
    ['INDEXED_DB_SCHEMA_REVISION', indexed.value, 'src/core/storage/indexed-db.js'],
    ['FULL_BACKUP_FORMAT_REVISION', format.value, 'src/constants/format-revisions.js']
  ];
  for (const [name, value, file] of revisions) {
    if (!Number.isSafeInteger(value) || value < 1) failures.push(`${file}：${name} 必须是正整数`);
  }
  if (!/export\s+const\s+API_VERSION\s*=/.test(api.source) || !/manifest\.json/.test(api.source)) {
    failures.push('src/constants/api-version.js：必须说明 API_VERSION 与软件版本独立管理');
  }
  if (!/本地数据修订/.test(config.source) || !/什么时候|递增|迁移/.test(config.source)) {
    failures.push('src/constants/config.js：LOCAL_DATA_SCHEMA_REVISION 缺少“管什么/何时递增”的简体中文说明');
  }
  if (!/新增对象仓储或索引时递增/.test(indexedSource) || !/单调递增/.test(indexedSource)) {
    failures.push('src/core/storage/indexed-db.js：INDEXED_DB_SCHEMA_REVISION 缺少单调递增与适用范围说明');
  }
  if (!/持久化|格式修订/.test(format.source) || !/备份/.test(format.source)) {
    failures.push('src/constants/format-revisions.js：备份格式修订缺少持久化兼容边界说明');
  }
  if (indexed.value < indexed.maxMigrationReference) {
    failures.push(`src/core/storage/indexed-db.js：INDEXED_DB_SCHEMA_REVISION=${indexed.value} 小于迁移器最高修订 ${indexed.maxMigrationReference}`);
  }
  if (!/onupgradeneeded[\s\S]{0,500}_ensureSchema/.test(indexedSource)) {
    failures.push('src/core/storage/indexed-db.js：onupgradeneeded 未调用 _ensureSchema，不能证明抬高修订号会建表');
  }
  if (!new RegExp(`LOCAL_DATA_SCHEMA_REVISION\\b`).test(migration.source) || !new RegExp(`至\\s*\\$?\\{?LOCAL_DATA_SCHEMA_REVISION`).test(migration.source)) {
    failures.push('src/core/storage/migration.js：迁移目标未使用 LOCAL_DATA_SCHEMA_REVISION 唯一事实源');
  }
  if (/manifest(?:Path|\.json)|manifest\.version|version_name/.test(bumpSource)) {
    failures.push('scripts/bump-api-version.js：不得读取或修改 Manifest 软件版本');
  }
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) {
    failures.push(`manifest.json：软件版本 ${manifest.version || '(空)'} 不符合 Chrome 数字格式`);
  }
  return failures;
}

/** 纯函数版本号校验，便于单元测试与其他门禁复用。 */
export function checkVersioningSources(input) {
  const migrationNumbers = [...(input.migration.matchAll(/currentVersion\s*<\s*(\d+)/g))].map((m) => Number(m[1]));
  const indexedValue = numberOf(input.indexed, 'INDEXED_DB_SCHEMA_REVISION');
  const data = {
    api: { source: input.api, value: numberOf(input.api, 'API_VERSION') },
    config: { source: input.config, value: numberOf(input.config, 'LOCAL_DATA_SCHEMA_REVISION') },
    indexed: { value: indexedValue, maxMigrationReference: Math.max(0, ...migrationNumbers) },
    format: { source: input.format, value: numberOf(input.format, 'FULL_BACKUP_FORMAT_REVISION') },
    migration: { source: input.migration },
    indexedSource: input.indexed,
    manifest: input.manifest,
    bumpSource: input.bump
  };
  return failureList(data);
}

export async function runVersioningChecks(root = projectRoot) {
  const read = (path) => Deno.readTextFile(resolve(root, path));
  const [api, config, indexed, format, migration, bump, manifestText] = await Promise.all([
    read('src/constants/api-version.js'), read('src/constants/config.js'), read('src/core/storage/indexed-db.js'),
    read('src/constants/format-revisions.js'), read('src/core/storage/migration.js'), read('scripts/bump-api-version.js'),
    read('manifest.json')
  ]);
  const failures = checkVersioningSources({ api, config, indexed, format, migration, bump, manifest: JSON.parse(manifestText) });
  if (failures.length === 0) console.log('[PASS] 五套版本号事实源、迁移边界与注释护栏通过');
  else for (const failure of failures) console.error(`[FAIL] ${failure}`);
  return { pass: failures.length === 0, failures };
}

if (import.meta.main) {
  const result = await runVersioningChecks();
  if (!result.pass) Deno.exit(1);
}
