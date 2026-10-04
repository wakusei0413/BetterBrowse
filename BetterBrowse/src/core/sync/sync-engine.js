/**
 * @file sync-engine.js
 * @description WebDAV 推/拉/合并/清单条件更新/快照压缩与设备退役
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { WebdavCredentials } from './credentials.js';
import { WebdavClient, describeAuthFailure } from './webdav-client.js';
import { SyncOutbox } from './outbox.js';
import { SyncMerge } from './merge.js';
import { SyncSnapshot } from './snapshot.js';
import { sha256Hex } from './crypto-util.js';
import { REMOTE_GC_INTERVAL_MS, RemoteGarbageCollector } from './remote-gc.js';
import {
  DEVICE_RETIRE_AFTER_MS,
  REMOTE_HARD_QUOTA_BYTES,
  REMOTE_SOFT_QUOTA_BYTES,
  SNAPSHOT_MIN_AGE_MS,
  SNAPSHOT_MIN_OPS,
  SYNC_CLOCK_KEY,
  WEBDAV_FORMAT_REVISION,
  SyncStatus
} from './sync-constants.js';

const STATUS_KEY = 'status';
const MANIFEST_CACHE_KEY = 'manifestCache';
/** 已应用过的远端批次路径：批次文件不可变，应用过的不必每次同步重新下载 */
const APPLIED_FILES_KEY = 'appliedFiles';
/** 本机已上传、尚未被快照覆盖的批次：清单在无条件写入的服务器上可能被并发覆盖丢失，据此补登记 */
const OWN_UPLOADS_KEY = 'ownUploads';
/** 能力探测缓存：探测本身要 7 个请求，不必每次同步都做 */
const PROBE_CACHE_KEY = 'probeCache';
const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 自动同步失败退避：被服务器拒绝、认证失败或网络失败后暂停自动同步，避免限流期间持续请求 */
const BACKOFF_KEY = 'backoff';
/** 上次写入的设备确认（内容未变时不重复 PUT） */
const ACK_CACHE_KEY = 'ackCache';
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
/** 远端自动回收记录 */
const REMOTE_GC_KEY = 'remoteGc';
/** 兼容模式写清单后回读校验前的等待（让并发写入方的 PUT 先落地） */
const COMPAT_VERIFY_DELAY_MS = 1500;
/** 手动清理单次时间预算：AI 桥接单请求上限 60 秒，留出盘点与响应余量；剩余部分由调用方续跑 */
const MANUAL_GC_BUDGET_MS = 40000;
/** 同步内自动回收的时间预算：不让一次同步被大量删除拖长，没删完的下次同步继续 */
const AUTO_GC_BUDGET_MS = 20000;

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export class SyncEngine {
  /** 测试可注入的 fetch */
  static fetchImpl = null;

  static _running = false;

  /** 兼容模式写后回读等待（测试可调小） */
  static compatVerifyDelayMs = COMPAT_VERIFY_DELAY_MS;

  /**
   * 读取同步状态快照（供选项页）
   */
  static async getStatus() {
    const [meta, pending, conflicts, credentials, config] = await Promise.all([
      this._getMeta(STATUS_KEY),
      SyncOutbox.listPending(),
      IndexedDBManager.isSupported()
        ? IndexedDBManager.runTransaction([IDBStores.CONFLICTS], 'readonly', async (tx) => {
          const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.CONFLICTS).getAll());
          return (all || []).filter((item) => !item.resolved);
        })
        : [],
      WebdavCredentials.get(),
      StorageAdapter.getUserConfig()
    ]);
    const clock = await SyncOutbox.getClock();
    return {
      status: meta?.status || SyncStatus.IDLE,
      message: meta?.message || '',
      lastSyncAt: meta?.lastSyncAt || 0,
      pendingCount: pending.length,
      conflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
      deviceId: clock?.deviceId || '',
      generation: meta?.generation || 0,
      enabled: config.webdavSync?.enabled === true,
      autoSync: config.webdavSync?.autoSync !== false,
      serverUrl: credentials.serverUrl || config.webdavSync?.serverUrl || '',
      username: credentials.username || '',
      hasPassword: Boolean(credentials.password)
    };
  }

  static async _getMeta(key) {
    try {
      return await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readonly', async (tx) => {
        const record = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SYNC_META).get(key));
        return record?.value || null;
      });
    } catch {
      return null;
    }
  }

  static async _setMeta(key, value) {
    await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readwrite', async (tx) => {
      tx.objectStore(IDBStores.SYNC_META).put({ key, value, updatedAt: Date.now() });
    });
  }

  static async _setStatus(status, message = '', extra = {}) {
    const prev = (await this._getMeta(STATUS_KEY)) || {};
    await this._setMeta(STATUS_KEY, {
      ...prev,
      ...extra,
      status,
      message,
      updatedAt: Date.now()
    });
  }

  /**
   * 仅补写状态元数据字段（不改状态机与文案）
   * @param {Record<string, any>} patch
   */
  static async _patchStatusMeta(patch) {
    const prev = (await this._getMeta(STATUS_KEY)) || {};
    await this._setMeta(STATUS_KEY, { ...prev, ...patch, updatedAt: Date.now() });
  }

  /**
   * 测试连接并探测 ETag 能力（条件写入缺失时进入兼容模式而非拒绝）
   */
  static async testConnection() {
    const creds = await WebdavCredentials.get();
    if (!creds.serverUrl) return { success: false, error: '请先填写 WebDAV 地址' };
    try {
      const client = this._client(creds);
      const probe = await client.probeCapability();
      if (!probe.ok) {
        const status = this._statusForHttp(probe.httpStatus) || SyncStatus.CAPABILITY_MISSING;
        await this._setStatus(status, probe.reason || '服务器能力不足');
        return { success: false, error: probe.reason, status };
      }
      await this._setMeta(BACKOFF_KEY, null);
      await this._setMeta(PROBE_CACHE_KEY, { serverUrl: creds.serverUrl, at: Date.now(), probe });
      if (probe.etagSupport === 'full') {
        await this._setStatus(SyncStatus.IDLE, '连接与条件写入探测通过');
        return { success: true, message: '连接与 ETag 条件写入探测通过' };
      }
      await this._setStatus(SyncStatus.IDLE, `已连接（兼容模式：${probe.reason}）`);
      return {
        success: true,
        compatMode: true,
        message: `连接成功（兼容模式：${probe.reason}）。清单更新将采用"读取最新-合并-写入"保护，可正常同步`
      };
    } catch (err) {
      const status = this._statusForError(err);
      await this._setStatus(status, err.message);
      return { success: false, error: err.message, status };
    }
  }

  /**
   * @param {number | undefined} httpStatus
   * @returns {string | null}
   */
  static _statusForHttp(httpStatus) {
    if (httpStatus === 403 || httpStatus === 429) return SyncStatus.SERVER_REJECTED;
    if (httpStatus === 401) return SyncStatus.AUTH_FAILED;
    return null;
  }

  /**
   * @param {any} err
   * @returns {string}
   */
  static _statusForError(err) {
    if (err?.code === 'CORRUPT') return SyncStatus.CORRUPT;
    return this._statusForHttp(Number(err?.status))
      || (err?.code === 'AUTH_FAILED' || /认证/.test(err?.message || '') ? SyncStatus.AUTH_FAILED : SyncStatus.UNKNOWN);
  }

  /**
   * 失败是否应触发自动同步退避（服务器拒绝、认证失败、网络不可达）
   * @param {{ success?: boolean, status?: string, error?: string }} result
   */
  static _shouldBackoff(result) {
    if (!result || result.success || result.skipped) return false;
    if ([SyncStatus.SERVER_REJECTED, SyncStatus.AUTH_FAILED].includes(result.status)) return true;
    return result.status === SyncStatus.UNKNOWN && /请求失败|暂时失败|超时|timed out|network/i.test(result.error || '');
  }

  /**
   * 远端读取结果是否表示「文件确实不存在」
   * @param {{ status: number }} res
   */
  static _isMissing(res) {
    return res.status === 404 || res.status === 410;
  }

  /**
   * 读取失败但不是「文件不存在」时抛出分类错误：认证失败 / 服务器拒绝（限流）/ 服务器暂时故障。
   * 网盘限流期间 GET 会返回 403，若一律视为缺失，会把完好的远端误判为数据损坏，诱导用户执行从零重建。
   * @param {{ status: number, body?: string }} res
   * @param {string} path
   */
  static _throwIfUnreadable(res, path) {
    if (res.status < 400 || this._isMissing(res)) return;
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(describeAuthFailure(res)), { code: 'AUTH_FAILED', status: res.status });
    }
    if (res.status === 429) {
      throw Object.assign(new Error(`WebDAV 服务器拒绝请求（HTTP 429，请求过于频繁，稍后会自动重试）：${path}`), { status: 429 });
    }
    throw Object.assign(new Error(`读取 ${path} 暂时失败（HTTP ${res.status}），稍后重试`), { status: res.status });
  }

  static async _updateBackoff(result) {
    if (result?.success) {
      if (await this._getMeta(BACKOFF_KEY)) await this._setMeta(BACKOFF_KEY, null);
      return;
    }
    if (!this._shouldBackoff(result)) return;
    const prev = (await this._getMeta(BACKOFF_KEY)) || {};
    const level = (Number(prev.level) || 0) + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (level - 1));
    await this._setMeta(BACKOFF_KEY, { level, until: Date.now() + delay, status: result.status, error: result.error || '' });
    console.warn(`[SyncEngine] 自动同步暂停 ${Math.round(delay / 60000)} 分钟（连续第 ${level} 次失败）：${result.error || result.status}`);
  }

  static _client(creds) {
    return new WebdavClient({
      serverUrl: creds.serverUrl,
      username: creds.username,
      password: creds.password,
      fetchImpl: this.fetchImpl || undefined
    });
  }

  /**
   * 执行一次完整同步。自动同步在退避期内直接跳过；手动同步不受退避限制，成功后清除退避。
   * @param {{ manual?: boolean }} [options]
   */
  static async run(options = {}) {
    if (options.manual !== true) {
      const backoff = await this._getMeta(BACKOFF_KEY);
      if (Number(backoff?.until) > Date.now()) {
        return {
          success: false,
          skipped: true,
          status: backoff.status,
          error: `自动同步暂停至 ${new Date(backoff.until).toLocaleTimeString('zh-CN')}（上次失败：${backoff.error || backoff.status}）`
        };
      }
    }
    const result = await this._runOnce(options);
    await this._updateBackoff(result).catch(() => {});
    return result;
  }

  static async _runOnce(options = {}) {
    if (this._running) return { success: false, skipped: true, error: '同步正在进行' };
    this._running = true;
    try {
      const config = await StorageAdapter.getUserConfig();
      if (config.webdavSync?.enabled !== true && options.manual !== true) {
        return { success: false, error: '未启用云端同步' };
      }
      const creds = await WebdavCredentials.get();
      if (!creds.serverUrl) {
        await this._setStatus(SyncStatus.IDLE, '未配置 WebDAV');
        return { success: false, error: '未配置 WebDAV' };
      }
      const client = this._client(creds);
      const startedAt = Date.now();
      const probe = await this._probeWithCache(client, creds.serverUrl);
      if (!probe.ok) {
        const status = this._statusForHttp(probe.httpStatus) || SyncStatus.CAPABILITY_MISSING;
        await this._setStatus(status, probe.reason || '服务器能力不足');
        return { success: false, error: probe.reason, status };
      }
      // 兼容模式：服务器不支持条件写入（如部分网盘 WebDAV），
      // 清单更新退化为"读取最新-合并-写入"，并发保护较弱但可正常同步
      const compatNote = probe.etagSupport === 'full'
        ? ''
        : `兼容模式：${probe.reason}；清单更新采用"读取最新-合并-写入"保护`;
      client.conditionWrites = probe.etagSupport !== 'partial';

      let current = await this._loadManifest(client);
      if (current.corrupt) {
        await this._setStatus(SyncStatus.CORRUPT, current.error || '远端数据损坏');
        return { success: false, error: current.error, status: SyncStatus.CORRUPT };
      }

      // 数据集配对：新设备首次接入时采纳远端 datasetId；
      // 本机已同步过其他数据集则视为连错目录（数据损坏），绝不静默切换
      if (current.manifest?.datasetId) {
        const clock = await SyncOutbox.getClock();
        if (clock.datasetId && clock.datasetId !== current.manifest.datasetId) {
          const status = await this._getMeta(STATUS_KEY);
          if (status?.lastSyncAt) {
            await this._setStatus(SyncStatus.CORRUPT, '远端数据集与本机历史不一致，请检查是否连错目录');
            return { success: false, error: '远端数据集与本机历史不一致', status: SyncStatus.CORRUPT };
          }
          await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readwrite', async (tx) => {
            const store = tx.objectStore(IDBStores.SYNC_META);
            const record = await IndexedDBManager.requestToPromise(store.get(SYNC_CLOCK_KEY));
            if (record?.value) {
              record.value.datasetId = current.manifest.datasetId;
              store.put({ key: SYNC_CLOCK_KEY, value: record.value, updatedAt: Date.now() });
            }
          });
        }
      } else if (current.missing) {
        // 有同步历史但远端清单消失：远端可能被清空或连错目录，
        // 绝不允许静默按"空数据集"重建（否则墓碑丢失、已删数据会被复活）
        const status = await this._getMeta(STATUS_KEY);
        if (status?.lastSyncAt) {
          await this._setStatus(SyncStatus.CORRUPT, '远端清单缺失，远端数据可能被清空或目录错误');
          return { success: false, error: '远端清单缺失', status: SyncStatus.CORRUPT };
        }
      }

      if (current.manifest) {
        const healed = await this._healOwnUploads(client, current.manifest);
        if (healed.manifest) current = { manifest: healed.manifest, etag: healed.etag };
      }

      const pending = await SyncOutbox.listPending();
      if (pending.length > 0) {
        const uploaded = await this._uploadPending(client, pending, current.manifest);
        if (!uploaded.success) {
          await this._setStatus(uploaded.status || SyncStatus.UNKNOWN, uploaded.error);
          return uploaded;
        }
        current = { manifest: uploaded.manifest, etag: uploaded.etag };
      }

      const pull = await this._pullAndApply(client, current);
      if (!pull.success) {
        await this._setStatus(pull.status || SyncStatus.UNKNOWN, pull.error);
        return pull;
      }

      const compacted = await this._maybeSnapshot(client, pull.manifest, pull.etag);
      const finalManifest = compacted.manifest || pull.manifest;
      const finalEtag = compacted.etag || pull.etag;
      await this._ackDevice(client, finalManifest);
      await this._retireStaleDevices(client, finalManifest, finalEtag);

      await IndexedDBManager.withWriteLock(() => SyncMerge.pruneHistory()).catch(() => {});
      const gc = await this._maybeCollectRemote(client).catch((err) => {
        console.warn('[SyncEngine] 远端自动回收失败:', err?.message || err);
        return null;
      });

      const leftover = await SyncOutbox.listPending();
      const status = leftover.length > 0 ? SyncStatus.PENDING : SyncStatus.SYNCED;
      await this._setStatus(status, compatNote, {
        lastSyncAt: Date.now(),
        generation: finalManifest?.generation || 0
      });
      await this._setMeta(MANIFEST_CACHE_KEY, { manifest: finalManifest, etag: finalEtag });
      console.info(
        `[SyncEngine] 同步完成：上传 ${pending.length} 条操作，下载 ${pull.downloadedFiles || 0} 个批次，`
        + `应用 ${pull.applied || 0} 条，冲突 ${pull.conflicts || 0} 条，第 ${finalManifest?.generation || 0} 代，`
        + `耗时 ${Date.now() - startedAt}ms`
        + (gc ? `，远端回收 ${gc.deleted} 个文件（${formatBytes(gc.freedBytes)}）` : '')
      );
      return { success: true, status, pendingCount: leftover.length, ...(gc ? { remoteGc: gc } : {}) };
    } catch (err) {
      const status = this._statusForError(err);
      await this._setStatus(status, err.message || '未知错误');
      console.warn('[SyncEngine] 同步失败:', err.message || err);
      return { success: false, error: err.message, status };
    } finally {
      this._running = false;
    }
  }

  static async _loadManifest(client) {
    let res;
    let lastNetworkError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        res = await client.get('manifest.json');
        lastNetworkError = null;
        break;
      } catch (err) {
        lastNetworkError = err;
      }
    }
    if (lastNetworkError) throw lastNetworkError;
    if (res.status === 404) {
      return { manifest: null, etag: '', missing: true };
    }
    this._throwIfUnreadable(res, 'manifest.json');
    if (res.status >= 400) {
      return { corrupt: true, error: `读取清单失败（HTTP ${res.status}）` };
    }
    try {
      const manifest = JSON.parse(res.body || '{}');
      return { manifest, etag: res.etag };
    } catch {
      return { corrupt: true, error: '清单 JSON 损坏' };
    }
  }

  static _emptyManifest(clock) {
    return {
      formatVersion: WEBDAV_FORMAT_REVISION,
      datasetId: clock.datasetId,
      generation: 0,
      snapshotId: '',
      snapshotSha256: '',
      snapshotWatermarks: {},
      previousSnapshotId: '',
      updatedAt: Date.now(),
      knownDevices: [],
      operationFiles: [],
      tombstoneWatermark: 0
    };
  }

  /**
   * 清单统一写入通道：重新读取远端最新清单 → 在其上合并变更 → 条件写入 → 412 重试
   * 禁止基于运行开始时的缓存清单直接覆盖（会吞掉同步期间其他设备的并发写入）。
   * 兼容模式（服务器忽略 If-Match / 无 ETag）下退化为非条件写入，仍保证先读后写。
   * @param {{ conditionWrites?: boolean }} client
   * @param {(freshManifest: object | null, freshEtag: string) => Promise<object | null> | object | null} buildNext
   *   基于最新远端清单计算下一版本；返回 null 表示放弃本次写入（非错误）
   * @param {{ maxAttempts?: number, verify?: (manifest: object | null) => boolean }} [options]
   *   verify：兼容模式下写入后等待片刻回读，确认本次变更仍在（未被并发写入方覆盖），否则重新合并写入
   * @returns {Promise<{ ok: boolean, aborted?: boolean, manifest?: object | null, etag?: string, error?: string, status?: string }>}
   */
  static async _updateManifest(client, buildNext, { maxAttempts = 3, verify = null } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const fresh = await this._loadManifest(client);
      if (fresh.corrupt) {
        return { ok: false, error: fresh.error, status: SyncStatus.CORRUPT };
      }
      let next;
      try {
        next = await buildNext(fresh.manifest, fresh.etag);
      } catch (err) {
        return {
          ok: false,
          error: err.message,
          status: err.code === 'CORRUPT' ? SyncStatus.CORRUPT : SyncStatus.UNKNOWN
        };
      }
      if (!next) {
        return { ok: true, aborted: true, manifest: fresh.manifest, etag: fresh.etag };
      }
      const condition = client.conditionWrites === false
        ? {}
        : (fresh.etag ? { ifMatch: fresh.etag } : { ifNoneMatch: '*' });
      const put = await client.put('manifest.json', JSON.stringify(next, null, 2), condition);
      if ([200, 201, 204].includes(put.status)) {
        if (client.conditionWrites !== false || typeof verify !== 'function') {
          return { ok: true, manifest: next, etag: put.etag };
        }
        await new Promise((resolve) => setTimeout(resolve, this.compatVerifyDelayMs));
        const check = await this._loadManifest(client);
        if (!check.corrupt && verify(check.manifest)) {
          return { ok: true, manifest: check.manifest, etag: check.etag };
        }
        console.warn('[SyncEngine] 兼容模式下清单被并发写入覆盖，重新合并写入');
        continue;
      }
      if (put.status === 401 || put.status === 403) {
        return { ok: false, error: describeAuthFailure(put), status: this._statusForHttp(put.status) };
      }
    }
    return {
      ok: false,
      error: '清单条件写入冲突，将在下次重试',
      status: SyncStatus.CONFLICT
    };
  }

  static async _uploadPending(client, pending, remoteManifest) {
    const clock = await SyncOutbox.getClock();
    const batchId = SyncOutbox.randomId('batch');
    const start = pending[0].sequence;
    const end = pending[pending.length - 1].sequence;
    const path = `operations/${clock.deviceId}/${start}-${end}-${batchId}.ndjson`;
    const body = pending.map((op) => JSON.stringify(op)).join('\n') + '\n';
    const sha256 = await sha256Hex(body);
    // 严格服务器（Nextcloud、坚果云等）不会自动创建父目录，PUT 返回 409 表示"没写进去"，不是成功
    await client.mkcol(`operations/${clock.deviceId}`).catch(() => {});
    const put = await client.put(path, body, { contentType: 'application/x-ndjson' });
    if (![200, 201, 204].includes(put.status)) {
      if (put.status === 401 || put.status === 403) {
        return { success: false, error: describeAuthFailure(put), status: this._statusForHttp(put.status) };
      }
      return { success: false, error: `上传批次失败（HTTP ${put.status}）`, status: SyncStatus.UNKNOWN };
    }

    // 清单必须合并进"当前最新"的远端清单：批次上传期间其他设备可能已写入
    // 新批次或新设备记录，基于运行开始时的缓存覆盖会造成静默丢数据
    const fileEntry = { deviceId: clock.deviceId, start, end, batchId, path, sha256 };
    // 先登记：即使随后清单写入失败或被并发覆盖，下次同步也能把这个批次补回清单
    await this._recordOwnUpload(fileEntry);
    const res = await this._updateManifest(client, (fresh) => {
      if (fresh && fresh.datasetId && fresh.datasetId !== clock.datasetId && (fresh.generation || 0) > 0) {
        throw Object.assign(new Error('远端数据集与本机不一致，请检查是否连错目录'), { code: 'CORRUPT' });
      }
      const base = fresh || remoteManifest || this._emptyManifest(clock);
      return {
        ...this._emptyManifest(clock),
        ...base,
        datasetId: base.datasetId || clock.datasetId,
        updatedAt: Date.now(),
        operationFiles: [
          ...(base.operationFiles || []).filter((file) => file.path !== path),
          fileEntry
        ],
        knownDevices: this._upsertKnownDevice(base.knownDevices, clock.deviceId)
      };
    }, { verify: (manifest) => (manifest?.operationFiles || []).some((file) => file.path === path) });
    if (!res.ok) {
      return { success: false, error: res.error, status: res.status || SyncStatus.UNKNOWN };
    }
    await SyncOutbox.markUploaded(pending.map((op) => op.operationId));
    await this._markFilesApplied([path]);
    await this._setMeta(MANIFEST_CACHE_KEY, { manifest: res.manifest, etag: res.etag });
    return { success: true, manifest: res.manifest, etag: res.etag };
  }

  /**
   * 能力探测（24 小时缓存，按服务器地址区分；测试连接会刷新缓存）
   * @param {WebdavClient} client
   * @param {string} serverUrl
   */
  static async _probeWithCache(client, serverUrl) {
    const cached = await this._getMeta(PROBE_CACHE_KEY);
    if (cached?.serverUrl === serverUrl && cached.probe?.ok && Date.now() - (Number(cached.at) || 0) < PROBE_CACHE_TTL_MS) {
      return cached.probe;
    }
    let lastNetworkError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const probe = await client.probeCapability();
        if (probe.ok) await this._setMeta(PROBE_CACHE_KEY, { serverUrl, at: Date.now(), probe });
        return probe;
      } catch (err) {
        lastNetworkError = err;
      }
    }
    throw lastNetworkError;
  }

  static async _recordOwnUpload(fileEntry) {
    const list = (await this._getMeta(OWN_UPLOADS_KEY))?.files || [];
    await this._setMeta(OWN_UPLOADS_KEY, {
      files: [...list.filter((file) => file.path !== fileEntry.path), fileEntry]
    });
  }

  /**
   * 补登记：本机已上传、未被快照覆盖、却不在最新清单里的批次（无条件写入服务器上的并发覆盖），重新写回清单。
   * 同时剔除已被快照 watermark 覆盖的登记，保持集合有界。
   * @param {WebdavClient} client
   * @param {object} manifest
   */
  static async _healOwnUploads(client, manifest) {
    const clock = await SyncOutbox.getClock();
    const mark = Number(manifest?.snapshotWatermarks?.[clock.deviceId]) || 0;
    const list = ((await this._getMeta(OWN_UPLOADS_KEY))?.files || [])
      .filter((file) => file.deviceId === clock.deviceId && Number(file.end) > mark);
    await this._setMeta(OWN_UPLOADS_KEY, { files: list });
    const referenced = new Set((manifest.operationFiles || []).map((file) => file.path));
    const missing = list.filter((file) => !referenced.has(file.path));
    if (missing.length === 0) return {};
    // 文件本身也可能没写进去（上传中断），只补登记远端确实存在的
    const existing = [];
    for (const file of missing) {
      const res = await client.head(file.path).catch(() => ({ status: 0 }));
      if (res.status > 0 && res.status < 400) existing.push(file);
    }
    if (existing.length === 0) return {};
    console.warn(`[SyncEngine] 发现 ${existing.length} 个本机批次未登记在远端清单中（可能被并发覆盖），正在补登记`);
    const paths = existing.map((file) => file.path);
    const res = await this._updateManifest(client, (fresh) => {
      if (!fresh) return null;
      const freshMark = Number(fresh.snapshotWatermarks?.[clock.deviceId]) || 0;
      const have = new Set((fresh.operationFiles || []).map((file) => file.path));
      const add = existing.filter((file) => !have.has(file.path) && Number(file.end) > freshMark);
      if (add.length === 0) return null;
      return { ...fresh, operationFiles: [...(fresh.operationFiles || []), ...add], updatedAt: Date.now() };
    }, { verify: (m) => paths.every((path) => (m?.operationFiles || []).some((file) => file.path === path)) });
    return res.ok && res.manifest ? { manifest: res.manifest, etag: res.etag } : {};
  }

  /**
   * 盘点远端占用（只读）
   * @returns {Promise<object>}
   */
  static async getRemoteUsage() {
    const creds = await WebdavCredentials.get();
    if (!creds.serverUrl) return { success: false, error: '未配置 WebDAV' };
    const client = this._client(creds);
    const loaded = await this._loadManifest(client);
    if (loaded.corrupt || !loaded.manifest) {
      return { success: false, error: loaded.error || '远端没有清单，无法判断哪些文件仍被引用' };
    }
    try {
      const usage = await RemoteGarbageCollector.inventory(client, loaded.manifest, {
        protect: await this._protectedPaths()
      });
      const lastGc = await this._getMeta(REMOTE_GC_KEY);
      return {
        success: true,
        generation: loaded.manifest.generation || 0,
        totalFiles: usage.totalFiles,
        totalBytes: usage.totalBytes,
        byDir: usage.byDir,
        garbageFiles: usage.garbage.length,
        garbageBytes: usage.garbageBytes,
        skippedRecent: usage.skippedRecent,
        lastCleanupAt: Number(lastGc?.lastRunAt || lastGc?.at) || 0
      };
    } catch (err) {
      return { success: false, error: `服务器不支持列出目录（PROPFIND）：${err.message}` };
    }
  }

  /**
   * 清理远端未被清单引用的文件（快照、批次、设备文件与探测残留）。
   * 单次最多执行约 40 秒，结果中的 remaining 大于 0 时需再次调用。
   * @param {{ confirm?: boolean }} [options]
   */
  static async cleanRemote({ confirm } = {}) {
    if (confirm !== true) return { success: false, error: '需显式确认' };
    if (this._running) return { success: false, error: '同步正在进行，请稍后再试' };
    this._running = true;
    try {
      const creds = await WebdavCredentials.get();
      if (!creds.serverUrl) return { success: false, error: '未配置 WebDAV' };
      const result = await this._collectRemote(this._client(creds), MANUAL_GC_BUDGET_MS);
      return result ? { success: true, ...result } : { success: false, error: '远端没有清单，拒绝清理' };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      this._running = false;
    }
  }

  /** 本机仍可能补登记的批次，回收时不得删除 */
  static async _protectedPaths() {
    return new Set(((await this._getMeta(OWN_UPLOADS_KEY))?.files || []).map((file) => file.path));
  }

  /**
   * 以最新清单为准执行一次回收；没有清单时拒绝（无法判断引用关系）
   * @param {WebdavClient} client
   * @param {number} [budgetMs]
   * @returns {Promise<{ deleted: number, freedBytes: number, failed: number, remaining: number, remainingBytes: number, scannedFiles: number, totalBytes: number } | null>}
   */
  static async _collectRemote(client, budgetMs = Infinity) {
    const startedAt = Date.now();
    const loaded = await this._loadManifest(client);
    if (loaded.corrupt || !loaded.manifest) return null;
    const usage = await RemoteGarbageCollector.inventory(client, loaded.manifest, {
      protect: await this._protectedPaths()
    });
    const result = await RemoteGarbageCollector.collect(client, usage.garbage, { deadline: startedAt + budgetMs });
    const summary = { ...result, scannedFiles: usage.totalFiles, totalBytes: usage.totalBytes };
    // 没删完：时间记为 0，下次同步继续回收
    await this._setMeta(REMOTE_GC_KEY, { at: result.remaining > 0 ? 0 : Date.now(), lastRunAt: Date.now(), ...summary });
    if (result.deleted > 0 || result.failed > 0) {
      console.info(
        `[SyncEngine] 远端回收：扫描 ${usage.totalFiles} 个文件（${formatBytes(usage.totalBytes)}），`
        + `删除 ${result.deleted} 个（${formatBytes(result.freedBytes)}），失败 ${result.failed} 个`
        + (result.remaining > 0 ? `，剩余 ${result.remaining} 个待下次继续` : '')
      );
    }
    return summary;
  }

  static async _maybeCollectRemote(client) {
    const last = await this._getMeta(REMOTE_GC_KEY);
    if (Date.now() - (Number(last?.at) || 0) < REMOTE_GC_INTERVAL_MS) return null;
    try {
      return await this._collectRemote(client, AUTO_GC_BUDGET_MS);
    } catch (err) {
      // 不支持 PROPFIND 的服务器：记下时间，避免每次同步都重试
      await this._setMeta(REMOTE_GC_KEY, { at: Date.now(), error: err.message });
      throw err;
    }
  }

  static _upsertKnownDevice(list, deviceId) {
    const devices = Array.isArray(list) ? [...list] : [];
    const idx = devices.findIndex((item) => item.deviceId === deviceId);
    const row = { deviceId, lastSeenAt: Date.now(), retired: false };
    if (idx >= 0) devices[idx] = { ...devices[idx], ...row, retired: false };
    else devices.push(row);
    return devices;
  }

  static async _pullAndApply(client, remote) {
    const clock = await SyncOutbox.getClock();
    if (remote.missing || !remote.manifest) {
      return { success: true, manifest: this._emptyManifest(clock), etag: remote.etag || '' };
    }
    const manifest = remote.manifest;
    if (manifest.datasetId && clock.datasetId && manifest.datasetId !== clock.datasetId && (manifest.generation || 0) > 0) {
      // 本机尚未产生过远端数据：采用远端 datasetId（新设备配对）
      const localPending = await SyncOutbox.listPending();
      if (localPending.length === 0) {
        await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readwrite', async (tx) => {
          const store = tx.objectStore(IDBStores.SYNC_META);
          const record = await IndexedDBManager.requestToPromise(store.get(SYNC_CLOCK_KEY));
          if (record?.value) {
            record.value.datasetId = manifest.datasetId;
            store.put({ key: SYNC_CLOCK_KEY, value: record.value, updatedAt: Date.now() });
          }
        });
      } else {
        return { success: false, error: '远端数据集与本机不一致', status: SyncStatus.CORRUPT };
      }
    }

    const replay = async (watermarks) => {
      const { operations, paths } = await this._downloadOperations(client, manifest);
      const pending = watermarks ? SyncSnapshot.filterAfterWatermark(operations, watermarks) : operations;
      const result = await IndexedDBManager.withWriteLock(async () => await SyncMerge.applyOperations(pending));
      await this._markFilesApplied(paths, manifest);
      return { success: true, manifest, etag: remote.etag, downloadedFiles: paths.length, ...result };
    };

    if (manifest.snapshotId && manifest.snapshotSha256) {
      // 本机已应用当前快照：不必每次同步都把整份快照（可达数 MB）重新下载一遍，
      // 网盘 WebDAV 普遍限流，这是同步被拒的主要诱因之一
      const appliedBefore = (await this._getMeta(STATUS_KEY))?.appliedSnapshotId;
      if (appliedBefore === manifest.snapshotId) {
        return await replay(manifest.snapshotWatermarks || {});
      }
      const snapPath = `snapshots/${manifest.snapshotId}.json`;
      const snapRes = await client.get(snapPath);
      this._throwIfUnreadable(snapRes, snapPath);
      let payload = null;
      let appliedSnapshotId = manifest.snapshotId;
      let watermarks = manifest.snapshotWatermarks || {};
      let currentUsable = false;
      if (snapRes.status < 400) {
        const digest = await sha256Hex(snapRes.body);
        if (digest === manifest.snapshotSha256) {
          try {
            payload = JSON.parse(snapRes.body);
            currentUsable = true;
            await SyncSnapshot.cacheLocal(manifest.snapshotId, payload, digest);
          } catch {
            currentUsable = false;
          }
        }
      }
      if (!currentUsable) {
        payload = await this.fallbackToPreviousSnapshot(client, manifest.previousSnapshotId);
        if (!payload) {
          if (snapRes.status >= 400) {
            if (manifest.previousSnapshotId) {
              return { success: false, error: '当前快照缺失，请回退上一代或从零重建', status: SyncStatus.CORRUPT };
            }
            return { success: false, error: '快照文件缺失', status: SyncStatus.CORRUPT };
          }
          return { success: false, error: '快照摘要不匹配', status: SyncStatus.CORRUPT };
        }
        appliedSnapshotId = manifest.previousSnapshotId;
        watermarks = payload.watermarks || {};
      } else {
        watermarks = manifest.snapshotWatermarks || payload.watermarks || {};
      }
      const localStatus = await this._getMeta(STATUS_KEY);
      const already = localStatus?.appliedSnapshotId === (appliedSnapshotId || payload.snapshotId);
      if (!already) {
        // 已有本地数据的设备采用合并模式（保护尚未同步的本地实体，如新设备离线期间创建的组）；
        // 空库新设备走整体替换
        const merge = await this._hasLocalSyncData();
        await IndexedDBManager.withWriteLock(async () => {
          await SyncSnapshot.applyPayload(payload, { merge });
        });
        // 整体替换后本地状态只等于快照，此前应用过的批次需按 watermark 重新补放
        if (!merge) await this.resetAppliedFiles();
        await this._setStatus(SyncStatus.PENDING, currentUsable ? '已应用远端快照' : '已回退上一份快照', {
          appliedSnapshotId
        });
      }
      return await replay(watermarks);
    }
    return await replay(null);
  }

  /**
   * 本地是否已有可同步实体（决定快照应用采用合并还是整体替换）
   */
  static async _hasLocalSyncData() {
    try {
      return await IndexedDBManager.runTransaction(
        [IDBStores.PAGES, IDBStores.STASH_GROUPS],
        'readonly',
        async (tx) => {
          const pages = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).count());
          const groups = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).count());
          return (Number(pages) || 0) > 0 || (Number(groups) || 0) > 0;
        }
      );
    } catch {
      return false;
    }
  }

  /**
   * 下载清单中尚未应用过的批次
   * @returns {Promise<{ operations: object[], paths: string[] }>}
   */
  static async _downloadOperations(client, manifest) {
    const applied = new Set((await this._getMeta(APPLIED_FILES_KEY))?.paths || []);
    const files = (Array.isArray(manifest.operationFiles) ? manifest.operationFiles : [])
      .filter((file) => !applied.has(file.path));
    const operations = [];
    const paths = [];
    for (const file of files) {
      paths.push(file.path);
      const res = await client.get(file.path);
      this._throwIfUnreadable(res, file.path);
      if (res.status >= 400) {
        throw Object.assign(new Error(`批次文件缺失：${file.path}`), { code: 'CORRUPT' });
      }
      if (file.sha256) {
        const digest = await sha256Hex(res.body);
        if (digest !== file.sha256) {
          throw Object.assign(new Error(`批次摘要不匹配：${file.path}`), { code: 'CORRUPT' });
        }
      }
      const lines = String(res.body || '').split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          operations.push(JSON.parse(line));
        } catch {
          // 跳过脏行
        }
      }
    }
    operations.sort((a, b) => {
      if (a.deviceId === b.deviceId) return (a.sequence || 0) - (b.sequence || 0);
      return String(a.deviceId).localeCompare(String(b.deviceId));
    });
    return { operations, paths };
  }

  /**
   * 本地状态被快照整体替换后调用：此前应用过的批次需按 watermark 重新补放
   */
  static async resetAppliedFiles() {
    await this._setMeta(APPLIED_FILES_KEY, { paths: [] });
  }

  /**
   * 登记已应用的批次；传入清单时顺带剔除清单已不再引用（已被压缩）的路径，保持集合有界
   * @param {string[]} paths
   * @param {object} [manifest]
   */
  static async _markFilesApplied(paths, manifest = null) {
    const current = new Set((await this._getMeta(APPLIED_FILES_KEY))?.paths || []);
    for (const path of paths || []) current.add(path);
    let next = [...current];
    if (manifest && Array.isArray(manifest.operationFiles)) {
      const referenced = new Set(manifest.operationFiles.map((file) => file.path));
      next = next.filter((path) => referenced.has(path));
    }
    await this._setMeta(APPLIED_FILES_KEY, { paths: next });
  }

  static async _maybeSnapshot(client, manifest, etag) {
    const clock = await SyncOutbox.getClock();
    const files = manifest?.operationFiles || [];
    // 只能用快照自身的生成时间：manifest.updatedAt 每次上传批次都会刷新，按它计龄 7 天条件永远不满足
    const lastSnap = Number(manifest?.snapshotCreatedAt) || 0;
    const needByAge = Date.now() - lastSnap >= SNAPSHOT_MIN_AGE_MS && files.length > 0;
    // 只统计当前快照尚未覆盖的操作：按批次总数计时，压缩一旦受阻（或刚超过阈值）
    // 之后每一次同步都会再上传一份全量快照，远端与本地缓存随之无限膨胀
    const needByCount = this._countOps(this._filesAfterWatermark(files, manifest?.snapshotWatermarks)) >= SNAPSHOT_MIN_OPS;
    if (!needByAge && !needByCount && (manifest?.generation || 0) === 0 && files.length > 0) {
      // 首次同步：生成 generation 1 基线，便于新设备配对
    } else if (!needByAge && !needByCount) {
      return { manifest, etag };
    }

    const payload = await SyncSnapshot.buildPayload();
    payload.watermarks = {
      ...(manifest.snapshotWatermarks || {}),
      [clock.deviceId]: clock.sequence
    };
    const generation = (Number(manifest.generation) || 0) + 1;
    // 文件名必须唯一：多台设备可能基于同一份清单同时生成"下一代"，同名 PUT 会互相覆盖，
    // 使清单记录的摘要与文件内容不符。代号仅作排序提示，真正的代数以清单 generation 为准。
    const snapshotId = SyncOutbox.randomId(`gen-${String(generation).padStart(4, '0')}`);
    const { body, sha256 } = await SyncSnapshot.serialize(payload);
    if (body.length > REMOTE_HARD_QUOTA_BYTES) {
      await this._setStatus(SyncStatus.UNKNOWN, '远端体积超过硬上限，请先压缩或清理');
      return { manifest, etag };
    }
    const putSnap = await client.put(`snapshots/${snapshotId}.json`, body);
    if (![200, 201, 204].includes(putSnap.status)) {
      return { manifest, etag };
    }
    await SyncSnapshot.cacheLocal(snapshotId, payload, sha256);
    // generation 基于 fresh 远端清单递增；watermarks 必须取自快照载荷本身
    // （快照内容只覆盖到构建时刻的本地状态，更大 watermark 会漏放其他设备的新操作）
    const res = await this._updateManifest(client, (fresh) => {
      if (!fresh) return null;
      return {
        ...fresh,
        generation: (Number(fresh.generation) || 0) + 1,
        previousSnapshotId: fresh.snapshotId || '',
        snapshotId,
        snapshotSha256: sha256,
        snapshotWatermarks: payload.watermarks,
        snapshotCreatedAt: Date.now(),
        updatedAt: Date.now()
      };
    });
    if (!res.ok || res.aborted || !res.manifest) {
      return { manifest, etag };
    }
    // 本机已包含该快照基线（构建自当前本地状态）：
    // 记录 appliedSnapshotId，避免下次同步重放快照把本地状态"倒回"基线
    await this._patchStatusMeta({ appliedSnapshotId: snapshotId });
    if (body.length > REMOTE_SOFT_QUOTA_BYTES) {
      await this._setStatus(SyncStatus.SYNCED, '远端体积已超过软上限，建议尽快压缩');
    }
    const compacted = await this._compactIfPossible(client, res.manifest, res.etag);
    // 新快照生成后旧快照即成垃圾：下次同步立即回收，不等 24 小时
    await this._setMeta(REMOTE_GC_KEY, { at: 0 });
    return { manifest: compacted.manifest || res.manifest, etag: compacted.etag || res.etag };
  }

  static _countOps(files) {
    return files.reduce((sum, file) => sum + Math.max(0, (Number(file.end) || 0) - (Number(file.start) || 0) + 1), 0);
  }

  /**
   * 当前快照 watermark 之后仍需补放的批次
   * @param {object[]} files
   * @param {Record<string, number> | undefined} watermarks
   */
  static _filesAfterWatermark(files, watermarks) {
    const marks = watermarks && typeof watermarks === 'object' ? watermarks : {};
    return (files || []).filter((file) => Number(file.end) > (Number(marks[file.deviceId]) || 0));
  }

  /**
   * 压缩：删除已被当前快照 watermark 覆盖的批次。
   * 快照自带回收期内的墓碑，落后设备会先应用快照再补放剩余批次，因此不必等待墓碑过期或其他设备确认。
   */
  static async _compactIfPossible(client, manifest, etag) {
    const watermarks = manifest.snapshotWatermarks || {};
    const covered = (manifest.operationFiles || []).filter((file) => {
      const mark = Number(watermarks[file.deviceId]) || 0;
      return Number(file.end) <= mark;
    });
    if (covered.length === 0) return { manifest, etag };
    // 压缩判定同样基于 fresh 清单：其他设备可能已追加新批次或推进 watermark
    const res = await this._updateManifest(client, (fresh) => {
      if (!fresh) return null;
      const freshWatermarks = fresh.snapshotWatermarks || {};
      const freshCovered = (fresh.operationFiles || []).filter((file) => {
        const mark = Number(freshWatermarks[file.deviceId]) || 0;
        return Number(file.end) <= mark;
      });
      if (freshCovered.length === 0) return null;
      return {
        ...fresh,
        operationFiles: (fresh.operationFiles || []).filter((file) => !freshCovered.some((c) => c.path === file.path)),
        updatedAt: Date.now()
      };
    });
    if (!res.ok || res.aborted || !res.manifest) return { manifest, etag };
    // 仅删除最终清单已不再引用的批次文件，避免误删其他设备并发写入的新批次
    for (const file of covered) {
      const stillReferenced = (res.manifest.operationFiles || []).some((f) => f.path === file.path);
      if (!stillReferenced) {
        await client.delete(file.path).catch(() => {});
      }
    }
    return { manifest: res.manifest, etag: res.etag };
  }

  /**
   * 写设备确认文件：序号与代数都没变化时跳过（每次同步省一次 PUT）；
   * 回收会删除未被清单引用的设备文件，所以首次与清单代数变化时一定会写
   */
  static async _ackDevice(client, manifest) {
    const clock = await SyncOutbox.getClock();
    const ack = { confirmedSequence: clock.sequence, generation: manifest?.generation || 0 };
    const last = await this._getMeta(ACK_CACHE_KEY);
    if (last?.deviceId === clock.deviceId
      && last.confirmedSequence === ack.confirmedSequence
      && last.generation === ack.generation) {
      return;
    }
    const body = JSON.stringify({ deviceId: clock.deviceId, ...ack, updatedAt: Date.now() });
    const res = await client.put(`devices/${clock.deviceId}.json`, body);
    if ([200, 201, 204].includes(res.status)) {
      await this._setMeta(ACK_CACHE_KEY, { deviceId: clock.deviceId, ...ack });
    }
  }

  static async _retireStaleDevices(client, manifest, etag) {
    const now = Date.now();
    // 绝大多数同步没有到期设备：用本次同步已有的清单先判断，避免每次多读一次远端清单
    const anyStale = (manifest?.knownDevices || [])
      .some((d) => !d.retired && now - (Number(d.lastSeenAt) || 0) >= DEVICE_RETIRE_AFTER_MS);
    if (!anyStale) return;
    await this._updateManifest(client, (fresh) => {
      if (!fresh) return null;
      let changed = false;
      const known = (fresh.knownDevices || []).map((d) => {
        if (d.retired) return d;
        if (now - (Number(d.lastSeenAt) || 0) >= DEVICE_RETIRE_AFTER_MS) {
          changed = true;
          return { ...d, retired: true, retiredAt: now };
        }
        return d;
      });
      if (!changed) return null;
      return { ...fresh, knownDevices: known, updatedAt: now };
    });
  }

  /**
   * 当前快照不可用时加载上一份：先查本地 SNAPSHOTS，再 GET 远端 previousSnapshotId。
   * 清单只有当前代 sha256，上一份仅校验 JSON 可解析（本地命中时顺带比对已缓存摘要）。
   * @param {{ get: Function }} client
   * @param {string} previousSnapshotId
   * @returns {Promise<object | null>}
   */
  static async fallbackToPreviousSnapshot(client, previousSnapshotId) {
    if (!previousSnapshotId) return null;
    const local = await SyncSnapshot.getLocal(previousSnapshotId);
    if (local?.payload && typeof local.payload === 'object') return local.payload;
    const res = await client.get(`snapshots/${previousSnapshotId}.json`);
    this._throwIfUnreadable(res, `snapshots/${previousSnapshotId}.json`);
    if (res.status >= 400) return null;
    try {
      const payload = JSON.parse(res.body);
      const digest = await sha256Hex(res.body);
      await SyncSnapshot.cacheLocal(previousSnapshotId, payload, digest);
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * 供 UI 展示损坏恢复入口所需的最小信息
   * @returns {Promise<{ status: string, message: string, previousSnapshotId: string, hasLocalSnapshot: boolean, localSnapshotId: string }>}
   */
  static async getRecoveryInfo() {
    const [status, cached, locals] = await Promise.all([
      this._getMeta(STATUS_KEY),
      this._getMeta(MANIFEST_CACHE_KEY),
      SyncSnapshot.listLocal().catch(() => [])
    ]);
    const latest = Array.isArray(locals) && locals[0] ? locals[0] : null;
    return {
      status: status?.status || SyncStatus.IDLE,
      message: status?.message || '',
      previousSnapshotId: cached?.manifest?.previousSnapshotId || '',
      hasLocalSnapshot: Boolean(latest?.snapshotId),
      localSnapshotId: latest?.snapshotId || ''
    };
  }

  /**
   * 危险：从零重建——用本地已缓存的最新快照整体替换可同步实体；
   * 本地没有则尝试拉取远端 previousSnapshotId。不会新建远端数据集，也不会改写清单。
   * @param {{ confirm?: boolean }} [options]
   */
  static async rebuildFromScratch({ confirm } = {}) {
    if (confirm !== true) return { success: false, error: '需显式确认' };

    const locals = await SyncSnapshot.listLocal().catch(() => []);
    const localSnap = Array.isArray(locals) ? locals.find((item) => item?.payload && typeof item.payload === 'object') : null;
    if (localSnap) {
      await IndexedDBManager.withWriteLock(async () => {
        await SyncSnapshot.applyPayload(localSnap.payload, { merge: false });
      });
      await this.resetAppliedFiles();
      await this._setStatus(SyncStatus.IDLE, '已从本地快照恢复', {
        appliedSnapshotId: localSnap.snapshotId
      });
      return { success: true, source: 'local-snapshot' };
    }

    const creds = await WebdavCredentials.get();
    if (creds.serverUrl) {
      const client = this._client(creds);
      const remote = await this._loadManifest(client);
      const previousId = remote.manifest?.previousSnapshotId || '';
      const payload = await this.fallbackToPreviousSnapshot(client, previousId);
      if (payload) {
        await IndexedDBManager.withWriteLock(async () => {
          await SyncSnapshot.applyPayload(payload, { merge: false });
        });
        await this.resetAppliedFiles();
        await this._setStatus(SyncStatus.IDLE, '已从远端上一份快照恢复', {
          appliedSnapshotId: previousId
        });
        return { success: true, source: 'remote-previous' };
      }
    }

    return { success: false, error: '没有可用的上一份快照，请改用本地 JSON 备份恢复' };
  }

  static async listDevices() {
    const cached = await this._getMeta(MANIFEST_CACHE_KEY);
    const clock = await SyncOutbox.getClock();
    const known = cached?.manifest?.knownDevices || [];
    return known.map((d) => ({
      ...d,
      isSelf: d.deviceId === clock?.deviceId
    }));
  }

  static async retireDevice(deviceId) {
    const creds = await WebdavCredentials.get();
    if (!creds.serverUrl) return { success: false, error: '未配置 WebDAV' };
    const client = this._client(creds);
    const res = await this._updateManifest(client, (fresh) => {
      if (!fresh) return null;
      const known = (fresh.knownDevices || []).map((d) => (
        d.deviceId === deviceId ? { ...d, retired: true, retiredAt: Date.now() } : d
      ));
      return { ...fresh, knownDevices: known, updatedAt: Date.now() };
    });
    if (!res.ok) return { success: false, error: res.error || '清单条件写入冲突' };
    if (res.aborted || !res.manifest) return { success: false, error: '远端尚无清单' };
    await this._setMeta(MANIFEST_CACHE_KEY, { manifest: res.manifest, etag: res.etag });
    return { success: true };
  }
}
