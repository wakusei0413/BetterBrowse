/**
 * @file sync-engine.js
 * @description WebDAV 推/拉/合并/清单条件更新/快照压缩与设备退役
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { WebdavCredentials } from './credentials.js';
import { WebdavClient } from './webdav-client.js';
import { SyncOutbox } from './outbox.js';
import { SyncMerge } from './merge.js';
import { SyncSnapshot } from './snapshot.js';
import { sha256Hex } from './crypto-util.js';
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

export class SyncEngine {
  /** 测试可注入的 fetch */
  static fetchImpl = null;

  static _running = false;

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
        await this._setStatus(SyncStatus.CAPABILITY_MISSING, probe.reason || '服务器能力不足');
        return { success: false, error: probe.reason, status: SyncStatus.CAPABILITY_MISSING };
      }
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
      const status = /认证/.test(err.message) ? SyncStatus.AUTH_FAILED : SyncStatus.UNKNOWN;
      await this._setStatus(status, err.message);
      return { success: false, error: err.message, status };
    }
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
   * 执行一次完整同步
   * @param {{ manual?: boolean }} [options]
   */
  static async run(options = {}) {
    if (this._running) return { success: false, error: '同步正在进行' };
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
      let probe;
      let lastNetworkError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          probe = await client.probeCapability();
          lastNetworkError = null;
          break;
        } catch (err) {
          lastNetworkError = err;
        }
      }
      if (lastNetworkError) throw lastNetworkError;
      if (!probe.ok) {
        await this._setStatus(SyncStatus.CAPABILITY_MISSING, probe.reason || '服务器能力不足');
        return { success: false, error: probe.reason, status: SyncStatus.CAPABILITY_MISSING };
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

      const leftover = await SyncOutbox.listPending();
      const status = leftover.length > 0 ? SyncStatus.PENDING : SyncStatus.SYNCED;
      await this._setStatus(status, compatNote, {
        lastSyncAt: Date.now(),
        generation: finalManifest?.generation || 0
      });
      await this._setMeta(MANIFEST_CACHE_KEY, { manifest: finalManifest, etag: finalEtag });
      return { success: true, status, pendingCount: leftover.length };
    } catch (err) {
      const status = /认证/.test(err.message || '') ? SyncStatus.AUTH_FAILED : SyncStatus.UNKNOWN;
      await this._setStatus(status, err.message || '未知错误');
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
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('WebDAV 认证失败'), { code: 'AUTH_FAILED' });
    }
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
   * @param {{ maxAttempts?: number }} [options]
   * @returns {Promise<{ ok: boolean, aborted?: boolean, manifest?: object | null, etag?: string, error?: string, status?: string }>}
   */
  static async _updateManifest(client, buildNext, { maxAttempts = 3 } = {}) {
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
        return { ok: true, manifest: next, etag: put.etag };
      }
      if (put.status === 401 || put.status === 403) {
        return { ok: false, error: 'WebDAV 认证失败', status: SyncStatus.AUTH_FAILED };
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
    const put = await client.put(path, body, { contentType: 'application/x-ndjson' });
    if (![200, 201, 204, 409].includes(put.status)) {
      if (put.status === 401 || put.status === 403) {
        return { success: false, error: 'WebDAV 认证失败', status: SyncStatus.AUTH_FAILED };
      }
      return { success: false, error: `上传批次失败（HTTP ${put.status}）`, status: SyncStatus.UNKNOWN };
    }

    // 清单必须合并进"当前最新"的远端清单：批次上传期间其他设备可能已写入
    // 新批次或新设备记录，基于运行开始时的缓存覆盖会造成静默丢数据
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
          { deviceId: clock.deviceId, start, end, batchId, path, sha256 }
        ],
        knownDevices: this._upsertKnownDevice(base.knownDevices, clock.deviceId)
      };
    });
    if (!res.ok) {
      return { success: false, error: res.error, status: res.status || SyncStatus.UNKNOWN };
    }
    await SyncOutbox.markUploaded(pending.map((op) => op.operationId));
    await this._setMeta(MANIFEST_CACHE_KEY, { manifest: res.manifest, etag: res.etag });
    return { success: true, manifest: res.manifest, etag: res.etag };
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

    if (manifest.snapshotId && manifest.snapshotSha256) {
      const snapPath = `snapshots/${manifest.snapshotId}.json`;
      const snapRes = await client.get(snapPath);
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
        await this._setStatus(SyncStatus.PENDING, currentUsable ? '已应用远端快照' : '已回退上一份快照', {
          appliedSnapshotId
        });
      }
      const ops = await this._downloadOperations(client, manifest);
      const replay = SyncSnapshot.filterAfterWatermark(ops, watermarks);
      await IndexedDBManager.withWriteLock(async () => {
        await SyncMerge.applyOperations(replay, { originIsCloudTentative: true });
      });
    } else {
      const ops = await this._downloadOperations(client, manifest);
      await IndexedDBManager.withWriteLock(async () => {
        await SyncMerge.applyOperations(ops, { originIsCloudTentative: true });
      });
    }
    return { success: true, manifest, etag: remote.etag };
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

  static async _downloadOperations(client, manifest) {
    const files = Array.isArray(manifest.operationFiles) ? manifest.operationFiles : [];
    const operations = [];
    for (const file of files) {
      const res = await client.get(file.path);
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
    return operations.sort((a, b) => {
      if (a.deviceId === b.deviceId) return (a.sequence || 0) - (b.sequence || 0);
      return String(a.deviceId).localeCompare(String(b.deviceId));
    });
  }

  static async _maybeSnapshot(client, manifest, etag) {
    const clock = await SyncOutbox.getClock();
    const files = manifest?.operationFiles || [];
    const lastSnap = Number(manifest?.updatedAt) || 0;
    const needByAge = Date.now() - lastSnap >= SNAPSHOT_MIN_AGE_MS && files.length > 0;
    const needByCount = files.length >= 1 && this._countOps(files) >= SNAPSHOT_MIN_OPS;
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
    const snapshotId = `gen-${String(generation).padStart(4, '0')}`;
    const { body, sha256 } = await SyncSnapshot.serialize(payload);
    if (body.length > REMOTE_HARD_QUOTA_BYTES) {
      await this._setStatus(SyncStatus.UNKNOWN, '远端体积超过硬上限，请先压缩或清理');
      return { manifest, etag };
    }
    const putSnap = await client.put(`snapshots/${snapshotId}.json`, body);
    if (![200, 201, 204, 409].includes(putSnap.status)) {
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
    const compacted = await this._compactIfPossible(client, res.manifest, res.etag, payload);
    return { manifest: compacted.manifest || res.manifest, etag: compacted.etag || res.etag };
  }

  static _countOps(files) {
    return files.reduce((sum, file) => sum + Math.max(0, (Number(file.end) || 0) - (Number(file.start) || 0) + 1), 0);
  }

  static async _compactIfPossible(client, manifest, etag, snapshotPayload = null) {
    const watermarks = manifest.snapshotWatermarks || {};
    const active = (manifest.knownDevices || []).filter((d) => !d.retired);
    if (active.length === 0) return { manifest, etag };
    // 快照内仍有未过回收期的墓碑时不允许压缩，防止离线旧副本复活
    const liveTombstones = (snapshotPayload?.tombstones || []).filter((t) => Number(t.expiresAt) > Date.now());
    if (liveTombstones.length > 0) return { manifest, etag };
    const acks = await this._loadDeviceAcks(client, active.map((d) => d.deviceId));
    const allCaughtUp = active.every((d) => (Number(acks[d.deviceId]) || 0) >= (Number(watermarks[d.deviceId]) || 0));
    if (!allCaughtUp) return { manifest, etag };
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

  static async _loadDeviceAcks(client, deviceIds) {
    const acks = {};
    for (const id of deviceIds) {
      const res = await client.get(`devices/${id}.json`);
      if (res.status >= 400) {
        acks[id] = 0;
        continue;
      }
      try {
        const parsed = JSON.parse(res.body || '{}');
        acks[id] = Number(parsed.confirmedSequence) || 0;
      } catch {
        acks[id] = 0;
      }
    }
    return acks;
  }

  static async _ackDevice(client, manifest) {
    const clock = await SyncOutbox.getClock();
    const body = JSON.stringify({
      deviceId: clock.deviceId,
      confirmedSequence: clock.sequence,
      generation: manifest?.generation || 0,
      updatedAt: Date.now()
    });
    await client.put(`devices/${clock.deviceId}.json`, body);
  }

  static async _retireStaleDevices(client, manifest, etag) {
    const now = Date.now();
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
