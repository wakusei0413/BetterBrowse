/**
 * @file remote-gc.js
 * @description 远端占用统计与垃圾回收：以最新清单的引用关系为唯一判据，删除不再被引用的快照、批次与设备文件
 * @encoding UTF-8
 */

/** 未被引用但刚写入不久的文件不删：可能是其他设备已 PUT、尚未写入清单的在途文件 */
export const REMOTE_GC_GRACE_MS = 15 * 60 * 1000;

/** 自动回收最小间隔 */
export const REMOTE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 由本扩展管理的子目录（根目录下其他目录与文件一律不碰，避免误删用户自己的数据） */
const MANAGED_DIRS = ['snapshots', 'operations', 'devices'];

/** 根目录下允许回收的遗留文件（能力探测文件可能因中断残留） */
const ROOT_GARBAGE = /^\.bb-capability-probe/;

/**
 * 从随机标识中提取生成时间（SyncOutbox.randomId 格式：prefix_<base36 毫秒>_<随机>）
 * @param {string} name
 * @returns {number} 毫秒时间戳；无法识别返回 0
 */
export function embeddedTimestamp(name) {
  const match = /_([0-9a-z]{7,9})_[0-9a-z]+(?:\.[a-z]+)?$/i.exec(String(name || ''));
  if (!match) return 0;
  const ts = parseInt(match[1], 36);
  // 合理范围：2020 年之后、当前时间一天之后之前
  return ts > 1577836800000 && ts < Date.now() + 86400000 ? ts : 0;
}

/**
 * 清单引用的远端相对路径集合
 * @param {object} manifest
 * @returns {Set<string>}
 */
export function referencedPaths(manifest) {
  const refs = new Set(['manifest.json']);
  if (manifest?.snapshotId) refs.add(`snapshots/${manifest.snapshotId}.json`);
  if (manifest?.previousSnapshotId) refs.add(`snapshots/${manifest.previousSnapshotId}.json`);
  for (const file of manifest?.operationFiles || []) {
    if (file?.path) refs.add(file.path);
  }
  for (const device of manifest?.knownDevices || []) {
    if (device?.deviceId) refs.add(`devices/${device.deviceId}.json`);
  }
  return refs;
}

export class RemoteGarbageCollector {
  /**
   * 盘点远端：按目录统计文件数与体积，并列出可回收文件
   * @param {import('./webdav-client.js').WebdavClient} client
   * @param {object} manifest - 刚读取的最新远端清单
   * @param {{ protect?: Set<string>, now?: number }} [options]
   * @returns {Promise<{ totalFiles: number, totalBytes: number, byDir: Record<string, { files: number, bytes: number }>, garbage: Array<{ path: string, size: number }>, garbageBytes: number, skippedRecent: number }>}
   */
  static async inventory(client, manifest, { protect = new Set(), now = Date.now() } = {}) {
    const refs = referencedPaths(manifest);
    const byDir = {};
    const garbage = [];
    let totalFiles = 0;
    let totalBytes = 0;
    let skippedRecent = 0;

    const consider = (path, size, bucket) => {
      totalFiles += 1;
      totalBytes += size;
      byDir[bucket] = byDir[bucket] || { files: 0, bytes: 0 };
      byDir[bucket].files += 1;
      byDir[bucket].bytes += size;
      if (refs.has(path) || protect.has(path)) return;
      const ts = embeddedTimestamp(path.split('/').pop());
      if (ts && now - ts < REMOTE_GC_GRACE_MS) {
        skippedRecent += 1;
        return;
      }
      garbage.push({ path, size });
    };

    const root = await client.listDetailed('');
    for (const item of root) {
      if (item.isDir) continue;
      if (item.name === 'manifest.json') consider('manifest.json', item.size, 'root');
      else if (ROOT_GARBAGE.test(item.name)) consider(item.name, item.size, 'root');
    }
    for (const dir of MANAGED_DIRS) {
      let children;
      try {
        children = await client.listDetailed(dir);
      } catch {
        continue; // 目录不存在
      }
      for (const child of children) {
        if (!child.isDir) {
          consider(`${dir}/${child.name}`, child.size, dir);
          continue;
        }
        // operations/<deviceId>/ 下才是批次文件
        if (dir !== 'operations') continue;
        const files = await client.listDetailed(`${dir}/${child.name}`).catch(() => []);
        for (const file of files) {
          if (!file.isDir) consider(`${dir}/${child.name}/${file.name}`, file.size, dir);
        }
      }
    }

    return {
      totalFiles,
      totalBytes,
      byDir,
      garbage,
      garbageBytes: garbage.reduce((sum, item) => sum + item.size, 0),
      skippedRecent
    };
  }

  /**
   * 删除盘点出的可回收文件
   * @param {import('./webdav-client.js').WebdavClient} client
   * @param {Array<{ path: string, size: number }>} garbage
   * @param {{ deadline?: number }} [options] - 到达截止时间即停止，剩余数量随结果返回，由调用方续跑
   * @returns {Promise<{ deleted: number, freedBytes: number, failed: number, remaining: number, remainingBytes: number }>}
   */
  static async collect(client, garbage, { deadline = Infinity } = {}) {
    let deleted = 0;
    let freedBytes = 0;
    let failed = 0;
    const list = garbage || [];
    let index = 0;
    for (; index < list.length; index += 1) {
      if (Date.now() >= deadline) break;
      const item = list[index];
      try {
        const res = await client.delete(item.path);
        if (res.status < 400 || res.status === 404) {
          deleted += 1;
          freedBytes += item.size;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    const rest = list.slice(index);
    return {
      deleted,
      freedBytes,
      failed,
      remaining: rest.length,
      remainingBytes: rest.reduce((sum, item) => sum + item.size, 0)
    };
  }
}
