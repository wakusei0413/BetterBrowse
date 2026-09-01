/**
 * @file runtime-log.test.js
 * @description 统一运行日志规范化、持久化、筛选、清理与环形保留测试
 * @encoding UTF-8
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { IndexedDBManager, IDBStores } from '../BetterBrowse/src/core/storage/indexed-db.js';
import { RuntimeLogRepository, RUNTIME_LOG_LIMIT } from '../BetterBrowse/src/core/logging/runtime-log-repository.js';
import { normalizeConsoleEntry } from '../BetterBrowse/src/core/logging/runtime-logger.js';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.js';

async function withDatabase(run) {
  const idb = installFakeIndexedDB();
  await IndexedDBManager.close();
  RuntimeLogRepository._writeQueue = Promise.resolve();
  try {
    await run();
  } finally {
    await IndexedDBManager.close();
    idb.restore();
  }
}

Deno.test('运行日志：控制台参数提取来源并遮蔽敏感字段与循环引用', () => {
  const circular = { name: '测试对象', password: '不能出现' };
  circular.self = circular;
  const entry = normalizeConsoleEntry('error', [
    '[SyncEngine] 同步失败 password=plain-secret Authorization:Bearer-token',
    circular
  ], 'background');
  assertEquals(entry.source, 'SyncEngine');
  assertEquals(entry.level, 'error');
  assertStringIncludes(entry.message, '[已遮蔽]');
  assertStringIncludes(entry.message, '[循环引用]');
  assertEquals(entry.message.includes('不能出现'), false);
  assertEquals(entry.message.includes('plain-secret'), false);
  assertEquals(entry.message.includes('Bearer-token'), false);
});

Deno.test('运行日志：并发追加后可按级别、来源和关键字倒序筛选', async () => {
  await withDatabase(async () => {
    await Promise.all([
      RuntimeLogRepository.append({ id: 'a', ts: 10, level: 'info', source: 'ServiceWorker', message: '启动完成' }),
      RuntimeLogRepository.append({ id: 'b', ts: 30, level: 'error', source: 'SyncEngine', message: '远端同步失败' }),
      RuntimeLogRepository.append({ id: 'c', ts: 20, level: 'warn', source: 'SyncEngine', message: '进入兼容模式' })
    ]);
    const result = await RuntimeLogRepository.query({ source: 'SyncEngine', keyword: '同步', limit: 20 });
    assertEquals(result.total, 1);
    assertEquals(result.entries[0].id, 'b');
    assertEquals(result.sources, ['ServiceWorker', 'SyncEngine']);
  });
});

Deno.test('运行日志：分类清理只删除 AI 审计，全量清理删除剩余日志', async () => {
  await withDatabase(async () => {
    await RuntimeLogRepository.append({ id: 'runtime', ts: 1, category: 'runtime', message: '运行记录' });
    await RuntimeLogRepository.append({ id: 'audit', ts: 2, category: 'audit', source: 'GET_CONFIG', message: '-' });
    await RuntimeLogRepository.clear({ category: 'audit' });
    assertEquals((await RuntimeLogRepository.query({ limit: 10 })).entries.map((entry) => entry.id), ['runtime']);
    await RuntimeLogRepository.clear();
    assertEquals((await RuntimeLogRepository.query({ limit: 10 })).total, 0);
  });
});

Deno.test('运行日志：超过上限时删除最旧记录', async () => {
  await withDatabase(async () => {
    await IndexedDBManager.runTransaction(IDBStores.RUNTIME_LOGS, 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.RUNTIME_LOGS);
      for (let i = 0; i < RUNTIME_LOG_LIMIT; i++) {
        await IndexedDBManager.requestToPromise(store.put({
          id: `log-${i}`,
          ts: i,
          level: 'info',
          source: '测试',
          context: 'test',
          category: 'runtime',
          message: `记录 ${i}`
        }));
      }
    });
    await RuntimeLogRepository.append({ id: 'log-new', ts: RUNTIME_LOG_LIMIT, message: '最新记录' });
    const result = await RuntimeLogRepository.query({ limit: RUNTIME_LOG_LIMIT });
    assertEquals(result.total, RUNTIME_LOG_LIMIT);
    assertEquals(result.entries.at(-1).id, 'log-1');
  });
});
