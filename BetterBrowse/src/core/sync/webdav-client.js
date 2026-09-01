/**
 * @file webdav-client.js
 * @description HTTPS WebDAV 客户端（GET / PUT / HEAD / MKCOL / DELETE，条件写入与 ETag 能力探测）
 * @encoding UTF-8
 */

import { CAPABILITY_PROBE_NAME, SYNC_ROOT_DIR } from './sync-constants.js';

/**
 * @typedef {object} WebdavResponse
 * @property {number} status
 * @property {string} body
 * @property {string} etag
 */

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
    const token = btoa(`${this.username}:${this.password}`);
    return { Authorization: `Basic ${token}` };
  }

  /**
   * 发起 WebDAV 请求
   * @param {string} method
   * @param {string} relPath
   * @param {{ body?: string, ifMatch?: string, ifNoneMatch?: string, contentType?: string }} [options]
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

    let response;
    try {
      response = await this.fetchImpl(this.resolve(relPath), {
        method,
        headers,
        body: options.body
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
   * 确保 BetterBrowse 根目录及子目录存在（已存在视为成功）
   */
  async ensureDirectories() {
    const dirs = ['', 'snapshots', 'operations', 'devices'];
    for (const dir of dirs) {
      const res = await this.mkcol(dir);
      if (![201, 204, 405, 409, 301, 200].includes(res.status) && res.status >= 400) {
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error('WebDAV 认证失败'), { code: 'AUTH_FAILED', status: res.status });
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
      return { ok: false, reason: '认证失败' };
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
