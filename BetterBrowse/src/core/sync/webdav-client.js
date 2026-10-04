/**
 * @file webdav-client.js
 * @description HTTPS WebDAV 客户端（GET / PUT / HEAD / MKCOL / DELETE / PROPFIND，条件写入与 ETag 能力探测）
 * @encoding UTF-8
 */

import { CAPABILITY_PROBE_NAME, SYNC_ROOT_DIR } from './sync-constants.js';

/**
 * @typedef {object} WebdavResponse
 * @property {number} status
 * @property {string} body
 * @property {string} etag
 */

/**
 * 认证类失败的说明：带上状态码与服务器返回的简短原因。
 * 401 是账号或密码错误；403 多为权限不足或网盘限流（如 123 云盘返回 {"code":1010}），不一定是密码问题，
 * 措辞上必须区分，否则用户会反复重填密码。
 * @param {{ status: number, body?: string }} res
 * @returns {string}
 */
export function describeAuthFailure(res) {
  const status = Number(res?.status) || 0;
  const detail = String(res?.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const head = status === 403
    ? 'WebDAV 服务器拒绝请求（HTTP 403，可能是网盘限流或权限不足，稍后会自动重试）'
    : `WebDAV 认证失败（HTTP ${status}，请检查账号与密码）`;
  return `${head}${detail ? `：${detail}` : ''}`;
}

/** 单次 WebDAV 请求超时（大快照上传留足余量） */
const WEBDAV_REQUEST_TIMEOUT_MS = 60000;

export class WebdavClient {
  /**
   * @param {{ serverUrl: string, username?: string, password?: string, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    this.serverUrl = String(options?.serverUrl || '').replace(/\/+$/, '');
    this.username = options?.username || '';
    this.password = options?.password || '';
    this.fetchImpl = options?.fetchImpl || globalThis.fetch.bind(globalThis);
  }

  /**
   * 规范化远端相对路径
   * @param {string} relPath
   * @returns {string}
   */
  resolve(relPath) {
    const trimmed = String(relPath || '').replace(/^\/+/, '');
    const root = this.serverUrl.endsWith(`/${SYNC_ROOT_DIR}`) || this.serverUrl.endsWith(SYNC_ROOT_DIR)
      ? this.serverUrl
      : `${this.serverUrl}/${SYNC_ROOT_DIR}`;
    return trimmed ? `${root}/${trimmed}` : root;
  }

  /**
   * @returns {Record<string, string>}
   */
  _authHeaders() {
    if (!this.username && !this.password) return {};
    // btoa 只接受 Latin-1：中文用户名或密码需先按 UTF-8 编码，否则每次同步都直接抛错
    const bytes = new TextEncoder().encode(`${this.username}:${this.password}`);
    const token = btoa(String.fromCharCode(...bytes));
    return { Authorization: `Basic ${token}` };
  }

  /**
   * 发起 WebDAV 请求
   * @param {string} method
   * @param {string} relPath
   * @param {{ body?: string, ifMatch?: string, ifNoneMatch?: string, contentType?: string, depth?: string }} [options]
   * @returns {Promise<WebdavResponse>}
   */
  async request(method, relPath, options = {}) {
    if (!this.serverUrl || !/^https:\/\//i.test(this.serverUrl)) {
      throw new Error('WebDAV 地址必须使用 HTTPS');
    }
    const headers = {
      ...this._authHeaders()
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType || 'application/json; charset=utf-8';
    }
    if (options.ifMatch) headers['If-Match'] = options.ifMatch;
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
    if (options.depth !== undefined) headers.Depth = options.depth;

    let response;
    try {
      response = await this.fetchImpl(this.resolve(relPath), {
        method,
        headers,
        body: options.body,
        // 服务器挂起时不得让同步引擎永久处于运行中（_running 不释放，后续同步全部被跳过）
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(WEBDAV_REQUEST_TIMEOUT_MS) : undefined
      });
    } catch (err) {
      const detail = err?.message || String(err);
      throw new Error(`WebDAV ${method} ${relPath} 请求失败：${detail}`);
    }
    const body = await response.text();
    const etag = response.headers.get('ETag') || response.headers.get('etag') || '';
    return {
      status: response.status,
      body,
      etag
    };
  }

  /**
   * @param {string} relPath
   */
  async get(relPath) {
    return await this.request('GET', relPath);
  }

  /**
   * @param {string} relPath
   */
  async head(relPath) {
    return await this.request('HEAD', relPath);
  }

  /**
   * @param {string} relPath
   * @param {string} body
   * @param {{ ifMatch?: string, ifNoneMatch?: string, contentType?: string }} [options]
   */
  async put(relPath, body, options = {}) {
    return await this.request('PUT', relPath, { ...options, body });
  }

  /**
   * @param {string} relPath
   */
  async mkcol(relPath) {
    return await this.request('MKCOL', relPath);
  }

  /**
   * @param {string} relPath
   */
  async delete(relPath) {
    return await this.request('DELETE', relPath);
  }

  /**
   * 列出远端目录的直接子项（PROPFIND Depth: 1），含大小与是否为目录
   * Service Worker 无 DOMParser，按 response 元素做宽松正则提取；不支持或失败时抛错，由调用方降级
   * @param {string} relDir
   * @returns {Promise<Array<{ name: string, size: number, isDir: boolean }>>}
   */
  async listDetailed(relDir) {
    const dir = String(relDir || '').replace(/^\/+|\/+$/g, '');
    const res = await this.request('PROPFIND', dir ? `${dir}/` : '', { depth: '1' });
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`列出远端目录失败（HTTP ${res.status}）`);
    }
    const selfPath = (() => {
      try {
        return decodeURIComponent(new URL(this.resolve(dir)).pathname).replace(/\/+$/, '');
      } catch {
        return '';
      }
    })();
    const items = [];
    const blocks = String(res.body || '').match(/<(?:[a-z0-9_-]+:)?response[\s>][\s\S]*?<\/(?:[a-z0-9_-]+:)?response>/gi) || [];
    for (const block of blocks) {
      const hrefMatch = /<(?:[a-z0-9_-]+:)?href>([^<]+)<\/(?:[a-z0-9_-]+:)?href>/i.exec(block);
      if (!hrefMatch) continue;
      let href = hrefMatch[1].trim();
      try {
        href = decodeURIComponent(href);
      } catch {
        // 保留原始 href
      }
      const isDir = href.endsWith('/') || /<(?:[a-z0-9_-]+:)?collection\s*\/?>/i.test(block);
      // href 可能是绝对 URL 或绝对路径；目录自身（Depth: 1 的 response 之一）不算子项
      const hrefPath = href.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '');
      if (selfPath && hrefPath === selfPath) continue;
      const name = hrefPath.split('/').pop();
      if (!name) continue;
      const sizeMatch = /<(?:[a-z0-9_-]+:)?getcontentlength>\s*(\d+)\s*</i.exec(block);
      items.push({ name, size: sizeMatch ? Number(sizeMatch[1]) : 0, isDir });
    }
    return items;
  }

  /**
   * 列出远端目录下的直接子文件名
   * @param {string} relDir
   * @returns {Promise<string[]>}
   */
  async list(relDir) {
    return (await this.listDetailed(relDir)).filter((item) => !item.isDir).map((item) => item.name);
  }

  /**
   * 确保 BetterBrowse 根目录及子目录存在（已存在视为成功）
   */
  async ensureDirectories() {
    const dirs = ['', 'snapshots', 'operations', 'devices'];
    for (const dir of dirs) {
      const res = await this.mkcol(dir);
      if (![201, 204, 405, 409, 301, 200].includes(res.status) && res.status >= 400) {
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(describeAuthFailure(res)), { code: 'AUTH_FAILED', status: res.status });
        }
        throw Object.assign(new Error(`创建远端目录失败（HTTP ${res.status}）`), { status: res.status });
      }
    }
  }

  /**
   * 探测服务器是否支持 ETag 与 If-Match 条件写入
   * 认证或写入失败视为不可用；仅缺失条件写入能力时进入兼容模式
   * （引擎将以"读取最新-合并-写入"方式更新清单，而非条件写入）
   * @returns {Promise<{ ok: boolean, etagSupport?: 'full' | 'partial', reason?: string }>}
   */
  async probeCapability() {
    await this.ensureDirectories();
    const probePath = CAPABILITY_PROBE_NAME;
    const first = await this.put(probePath, JSON.stringify({ probe: true, at: Date.now() }), {
      contentType: 'application/json'
    });
    if (first.status === 401 || first.status === 403) {
      return { ok: false, reason: describeAuthFailure(first), httpStatus: first.status };
    }
    if (first.status >= 400 && first.status !== 409) {
      return { ok: false, reason: `写入探测文件失败（HTTP ${first.status}）` };
    }
    const head = first.etag ? first : await this.head(probePath);
    const hasEtag = Boolean(head.etag);
    const mismatch = await this.put(probePath, JSON.stringify({ probe: false }), {
      ifMatch: '"bb-invalid-etag-probe"',
      contentType: 'application/json'
    });
    await this.delete(probePath).catch(() => {});
    if (hasEtag && mismatch.status === 412) {
      return { ok: true, etagSupport: 'full' };
    }
    const reason = !hasEtag
      ? '服务器未返回 ETag'
      : `错误 If-Match 未返回 412（实际 HTTP ${mismatch.status}）`;
    return { ok: true, etagSupport: 'partial', reason };
  }
}
