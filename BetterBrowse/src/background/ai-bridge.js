/**
 * @file ai-bridge.js
 * @description AI 桥接管理器（阶段三：本机 AI Agent 经 Native Messaging 与人类能力对等操控插件）
 *
 * 架构（docs/03-ai-skill-bridge.md）：
 * - 扩展按需 connectNative 拉起本机宿主（com.betterbrowse.bridge），宿主再经 127.0.0.1 + 令牌
 *   侧信道服务本机 Agent；宿主非常驻，Chrome 退出即结束。
 * - AI 请求复用与人类 UI 完全相同的 action 处理映射（action-handlers.js），并叠加：
 *   确认位强制（镜像 UI 确认弹窗）、凭据出口复查（只写不可读）、尺寸/串行限制、审计日志。
 * - 宿主每 25s 发送内部 ping 作为 MV3 Service Worker 保活信号；断开后指数退避重连 +
 *   周期看门狗闹钟兜底。
 * @encoding UTF-8
 */

import { StorageKeys } from '../constants/storage-keys.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import {
  AI_BRIDGE_PROTO,
  NATIVE_HOST_NAME,
  AI_CONFIRM_REQUIRED_ACTIONS
} from '../core/ai/ai-capabilities.js';

/** 看门狗闹钟名（SW 冷启动 / 重连兜底） */
const WATCHDOG_ALARM = 'bb_ai_bridge_watchdog';
/** 分块阈值（JS 字符数；中文按 UTF-8 最坏 ~3 字节/字符，确保单帧 < 1MB Chrome 限制） */
const CHUNK_CHARS = 200000;
/** 单请求 payload 字符数上限（约 8MB 文本） */
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;
/** 审计日志环形上限 */
const AUDIT_LIMIT = 100;
/** 重连退避序列（毫秒） */
const RECONNECT_DELAYS_MS = [5000, 15000, 60000, 300000];
/** 单请求处理超时（毫秒）：串行队列中任何 handler 挂起都不能阻塞后续请求 */
const REQUEST_TIMEOUT_MS = 60000;
/** 审计中允许记录的 payload 字段（白名单，绝不记录自由文本与凭据） */
const AUDIT_SAFE_FIELDS = ['groupId', 'itemId', 'keyword', 'domain', 'createdAt', 'limit', 'offset'];

export class AIBridgeManager {
  constructor() {
    /** 共享 action 处理映射（由 service-worker 注入，与人类 UI 同一实例） */
    this._handlers = null;
    /** Native Messaging 端口 */
    this._port = null;
    /** 总开关（aiBridge.enabled 镜像） */
    this._armed = false;
    /** 连接状态：disabled | connecting | connected | reconnecting | host_missing | error | unsupported */
    this._state = 'disabled';
    /** 请求串行队列（避免并发写锁竞争） */
    this._queue = Promise.resolve();
    /** 分块重组缓存：id -> { parts: string[], received: number, total: number } */
    this._reassembly = new Map();
    /** 重连退避计数 */
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._lastConnectedAt = 0;
    this._lastDisconnectedAt = 0;
    this._lastError = '';
    this._alarmBound = (alarm) => {
      if (alarm?.name === WATCHDOG_ALARM) this._onWatchdog();
    };
    // ⚠️ MV3 事件监听必须在首个事件循环轮次内同步注册：本构造器于模块顶层同步执行，
    // 看门狗闹钟是 SW 休眠后重连循环的唯一自动唤醒路径，异步注册会导致 Chrome
    // 在 SW 挂起期间认为"无监听者"而跳过唤醒，重连就此永久停摆。
    // 闹钟创建同样同步执行（幂等覆盖）：即便下方 init() 的配置读取因 IndexedDB 异常挂起，
    // 看门狗依然按分钟自愈重连；未启用开关时处理器直接返回，开销可忽略。
    try {
      chrome.alarms.onAlarm.addListener(this._alarmBound);
      chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
    } catch {
      // 测试环境可能无闹钟 API
    }
  }

  /**
   * 初始化桥接（SW 冷启动 / onStartup / onInstalled 后调用）
   * @param {Record<string, (payload: any, sender?: any) => Promise<any>>} handlers - 共享处理映射
   */
  async init(handlers) {
    this._handlers = handlers || {};
    if (typeof chrome === 'undefined' || !chrome.runtime?.connectNative) {
      this._state = 'unsupported';
      return;
    }
    const config = await StorageAdapter.getUserConfig();
    this._armed = config?.aiBridge?.enabled === true;
    if (this._armed) {
      this._connect();
      this._ensureWatchdog();
    } else {
      this._state = 'disabled';
    }
  }

  /**
   * 配置变更回调（UPDATE_CONFIG / RESET_CONFIG 后触发）
   * @param {any} config - 合并后的用户配置
   */
  onConfigUpdated(config) {
    const enabled = config?.aiBridge?.enabled === true;
    if (enabled === this._armed) return;
    this._armed = enabled;
    if (enabled) {
      this._connect();
      this._ensureWatchdog();
    } else {
      this._shutdown('开关已关闭');
      this._state = 'disabled';
    }
  }

  /**
   * 获取桥接状态摘要（GET_AI_BRIDGE_STATUS 响应体，选项页「AI 桥接」Tab 共用）
   * @returns {object}
   */
  getStatusSummary() {
    return {
      armed: this._armed,
      state: this._state,
      protocol: AI_BRIDGE_PROTO,
      nativeHostName: NATIVE_HOST_NAME,
      extensionId: (typeof chrome !== 'undefined' && chrome.runtime?.id) || '',
      pendingRequests: Math.max(0, this._pendingCount || 0),
      reconnectAttempt: this._reconnectAttempt,
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectedAt: this._lastDisconnectedAt,
      lastError: this._lastError
    };
  }

  // ============================================================
  // 通道生命周期
  // ============================================================

  /** 按需拉起本机宿主（幂等） */
  _connect() {
    if (this._port) return;
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      this._state = 'host_missing';
      this._lastError = err?.message || '无法连接本机宿主';
      this._scheduleReconnect();
      return;
    }
    this._port = port;
    this._state = 'connecting';
    port.onMessage.addListener((msg) => this._handleNativeMessage(msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      this._port = null;
      this._reassembly.clear();
      this._lastDisconnectedAt = Date.now();
      this._lastError = err;
      this._scheduleReconnect();
    });
    // 通知宿主桥接通道就绪（宿主据此确认扩展身份并生成侧信道令牌）
    try {
      port.postMessage({ internal: 'hello', proto: AI_BRIDGE_PROTO });
    } catch {
      // 发送失败交由 onDisconnect 重连路径处理
    }
  }

  /** 断开调度：按指数退避重连，并标记宿主缺失 */
  _scheduleReconnect() {
    const missing = /not found|not registered|未注册|不存在/i.test(this._lastError || '');
    this._state = missing ? 'host_missing' : 'reconnecting';
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt++;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._armed) this._connect();
    }, delay);
  }

  /** 看门狗：SW 冷启动 / 定时器丢失后兜底重连（清退避定时器立即尝试，并自愈闹钟） */
  _ensureWatchdog() {
    try {
      chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
    } catch {
      // 无闹钟环境仅依赖退避定时器
    }
  }

  _onWatchdog() {
    // 看门狗完全自治：每分钟自行重读开关（不依赖 init/onConfigUpdated 的执行时序），
    // 即便模块初始化因 IndexedDB 异常挂起，重连循环依然独立运转
    return (async () => {
      try {
        const config = await StorageAdapter.getUserConfig();
        this._armed = config?.aiBridge?.enabled === true;
      } catch {
        // 配置读取失败时沿用上次开关状态
      }
      if (!this._armed) return;
      this._ensureWatchdog();
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (!this._port) {
        this._connect();
      }
      if (this._state === 'connected') {
        this._reconnectAttempt = 0;
      }
      // 队列卡死自愈：Chrome 在经 Native Messaging 唤醒的 SW 中可能冻结 setTimeout，
      // 单请求超时（setTimeout）失效时串行队列会永久阻塞。连续两个看门狗周期仍在处理
      // 同一批请求，则强制重置队列（挂起请求由各 Agent 客户端的超时自行兜底）。
      if ((this._pendingCount || 0) > 0) {
        if (this._queueBusySeen) {
          console.warn('[AIBridge] 检测到请求队列停滞，已强制重置（挂起请求将被丢弃）');
          this._queue = Promise.resolve();
          this._pendingCount = 0;
          this._queueBusySeen = false;
        } else {
          this._queueBusySeen = true;
        }
      } else {
        this._queueBusySeen = false;
      }
    })();
  }

  /** 主动关闭通道并清理（开关关闭时） */
  _shutdown(reason) {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempt = 0;
    try {
      chrome.alarms.clear(WATCHDOG_ALARM);
    } catch {
      // 忽略清理异常
    }
    if (this._port) {
      try {
        this._port.disconnect();
      } catch {
        // 忽略重复断开
      }
      this._port = null;
    }
    this._reassembly.clear();
    this._lastError = reason || '';
  }

  // ============================================================
  // 原生消息处理（内部控制消息 + 分块重组 + 请求分发）
  // ============================================================

  /**
   * 处理宿主消息：内部 ping/ready 与业务请求（含分块重组）
   * @param {any} msg
   */
  _handleNativeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // 内部控制消息：宿主保活 ping / 就绪通知（不走 action 管道，不计审计）
    if (msg.internal) {
      if (msg.internal === 'ping') {
        this._postDirect({ internal: 'pong' });
      } else if (msg.internal === 'ready') {
        this._state = 'connected';
        this._reconnectAttempt = 0;
        this._lastConnectedAt = Date.now();
        this._lastError = '';
      }
      return;
    }

    // 分块消息重组（>分块阈值的大 payload，线协议见 docs/03 §3.2）
    if (msg.chunk && typeof msg.part === 'string') {
      const id = String(msg.id || '');
      if (!id) return;
      let entry = this._reassembly.get(id);
      if (!entry) {
        entry = { parts: new Array(msg.chunk.n || 0).fill(''), received: 0, total: msg.chunk.n || 0 };
        this._reassembly.set(id, entry);
      }
      const index = msg.chunk.i || 0;
      if (index >= 0 && index < entry.total && !entry.parts[index]) {
        entry.parts[index] = msg.part;
        entry.received++;
      }
      if (entry.total > 0 && entry.received >= entry.total) {
        this._reassembly.delete(id);
        try {
          const full = JSON.parse(entry.parts.join(''));
          this._handleNativeMessage(full);
        } catch {
          // 分块重组失败：无法定位 reqId，仅记录状态
          this._lastError = '分块消息重组失败';
        }
      }
      return;
    }

    // 业务请求：{ reqId, action, payload }
    if (msg.reqId && typeof msg.action === 'string') {
      this._enqueueRequest(String(msg.reqId), msg.action, msg.payload);
    }
  }

  /** 直发原始消息（绕过分块，仅限内部控制消息） */
  _postDirect(obj) {
    try {
      this._port?.postMessage(obj);
    } catch (err) {
      console.error(`[AIBridge] postMessage 失败:`, err?.message || err);
    }
  }

  /**
   * 请求入队（串行处理，避免并发写锁竞争）
   */
  _enqueueRequest(reqId, action, payload) {
    this._pendingCount = (this._pendingCount || 0) + 1;
    this._queue = this._queue
      .then(() => this._processRequest(reqId, action, payload))
      .finally(() => {
        this._pendingCount = Math.max(0, (this._pendingCount || 1) - 1);
      });
  }

  /**
   * 处理单条 AI 请求：校验 → 路由共享 handler → 凭据出口复查 → 审计 → 回传
   * @param {string} reqId
   * @param {string} action
   * @param {any} payload
   */
  async _processRequest(reqId, action, payload) {
    console.info(`[AIBridge] 开始处理请求: ${action}`);
    try {
      // 1. 动作必须存在于共享映射（人类 UI 与 AI 同一集合）
      const handler = this._handlers[action];
      if (typeof handler !== 'function') {
        throw new Error(`不支持的动作: ${action}`);
      }

      // 2. 尺寸限制
      let payloadText = '';
      try {
        payloadText = JSON.stringify(payload || {});
      } catch {
        throw new Error('payload 无法序列化');
      }
      if (payloadText.length > MAX_PAYLOAD_CHARS) {
        throw new Error(`payload 超出上限（${MAX_PAYLOAD_CHARS} 字符）`);
      }

      // 3. 确认位强制（镜像人类 UI 不可逆操作确认弹窗；不受设置项影响）
      if (AI_CONFIRM_REQUIRED_ACTIONS.has(action) && payload?.confirm !== true) {
        throw new Error(`动作 ${action} 为不可逆操作，需在 payload 中显式携带 confirm: true`);
      }

      // 4. 路由共享处理映射（sender 为 null：AI 请求无来源标签页）
      // 单请求超时保护：串行队列中任何 handler 挂起都只损失本请求，绝不卡死后续排队请求
      const data = await Promise.race([
        handler(payload || {}, null),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`处理超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒未完成，已跳过）`)), REQUEST_TIMEOUT_MS);
          // 计时器仅用于竞速，超时后 handler 仍在后台运行（无法取消），此处不做额外清理
          timer.unref?.();
        })
      ]);

      const response = { success: true, data };

      // 5. 凭据出口复查（双保险：数据层本就不返回凭据，此处拦截序列化泄露）
      this._guardResponse(response);

      // 6. 审计写入必须发射后不管：审计走 chrome.storage，一旦存储层挂起，
      //    await 审计会把响应永远挡在后面（本响应与队列中全部后续请求一起饿死）
      this._appendAudit(action, payload, true).catch(() => {});
      console.info(`[AIBridge] 请求完成并发送响应: ${action}`);
      this._sendResponse(reqId, response);
    } catch (err) {
      const message = err?.message || '内部处理异常';
      // 失败审计同样不阻塞响应（见上）
      this._appendAudit(action, payload, false, message).catch(() => {});
      this._sendResponse(reqId, { success: false, error: message });
    }
  }

  /**
   * 凭据出口复查：响应中不得包含凭据键名或 password 字段
   * @param {object} response
   */
  _guardResponse(response) {
    let text = '';
    try {
      text = JSON.stringify(response);
    } catch {
      throw new Error('响应序列化失败');
    }
    if (text.includes('bb_webdav_credentials') || /"password"\s*:/.test(text)) {
      throw new Error('响应包含受限凭据字段，已拦截（凭据只写不可读）');
    }
  }

  /**
   * 回传响应（超限自动分块，线协议见 docs/03 §3.2）
   * @param {string} reqId
   * @param {object} response
   */
  _sendResponse(reqId, response) {
    if (!this._port) {
      console.warn('[AIBridge] 端口已断开，丢弃响应:', reqId);
      return;
    }
    let text;
    try {
      text = JSON.stringify(response);
    } catch (err) {
      console.error('[AIBridge] 响应序列化失败:', err?.message || err);
      text = JSON.stringify({ success: false, error: '响应序列化失败' });
    }
    console.info(`[AIBridge] 发送响应: reqId=${reqId} 长度=${text.length}`);
    if (text.length <= CHUNK_CHARS) {
      this._postDirect({ reqId, ...response });
      return;
    }
    const total = Math.ceil(text.length / CHUNK_CHARS);
    for (let i = 0; i < total; i++) {
      this._postDirect({
        v: AI_BRIDGE_PROTO,
        id: reqId,
        chunk: { i, n: total },
        part: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
      });
    }
  }

  // ============================================================
  // 审计日志（环形 100 条；仅本地 chrome.storage，不入同步 / 导出）
  // ============================================================

  /**
   * 追加一条审计记录（对外发射后不管：绝不阻塞响应；
   * 内部经串行队列执行读-改-写，避免并发审计相互覆盖丢条目）
   * @param {string} action
   * @param {any} payload
   * @param {boolean} ok
   * @param {string} [error]
   * @returns {Promise<void>}
   */
  _appendAudit(action, payload, ok, error = '') {
    this._auditQueue = (this._auditQueue || Promise.resolve())
      .then(() => this._writeAudit(action, payload, ok, error))
      .catch(() => {
        // 单条审计失败不影响后续审计与主流程
      });
    return this._auditQueue;
  }

  /**
   * 实际写入一条审计记录（调用方必须经 _appendAudit 串行队列）
   * @param {string} action
   * @param {any} payload
   * @param {boolean} ok
   * @param {string} [error]
   */
  async _writeAudit(action, payload, ok, error = '') {
    const summary = this._buildAuditSummary(action, payload);
    const log = (await StorageAdapter.get(StorageKeys.AI_AUDIT_LOG, [])) || [];
    log.unshift({
      ts: Date.now(),
      action,
      summary,
      ok,
      ...(ok ? {} : { error: String(error).slice(0, 200) })
    });
    await StorageAdapter.set(StorageKeys.AI_AUDIT_LOG, log.slice(0, AUDIT_LIMIT));
  }

  /**
   * 构建审计摘要（白名单字段；凭据类动作内容永不记录）
   * @param {string} action
   * @param {any} payload
   * @returns {string}
   */
  _buildAuditSummary(action, payload) {
    if (action === 'SAVE_WEBDAV_CREDENTIALS') return '保存 WebDAV 凭据（内容不记录）';
    const parts = [];
    for (const field of AUDIT_SAFE_FIELDS) {
      if (payload && payload[field] !== undefined) {
        parts.push(`${field}=${String(payload[field]).slice(0, 80)}`);
      }
    }
    if (action === 'UPDATE_CONFIG' && payload && typeof payload === 'object') {
      parts.push(`keys=${Object.keys(payload).slice(0, 8).join(',')}`);
    }
    return parts.join(' ') || '-';
  }
}
