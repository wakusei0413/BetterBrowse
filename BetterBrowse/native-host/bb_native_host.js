/**
 * @file bb_native_host.js
 * @description BetterBrowse AI 桥接本机宿主（Chrome Native Messaging ↔ 本机 Agent TCP 侧信道）
 *
 * 运行方式：由 Chrome 经 Native Messaging 按需拉起（非常驻服务），Chrome 退出（stdin EOF）即结束。
 *   deno run -A --quiet bb_native_host.js chrome-extension://<扩展ID>/
 *
 * 职责（协议冻结稿见 docs/03-ai-skill-bridge.md）：
 * 1. stdio 4 字节小端长度前缀 + UTF-8 JSON 帧与扩展双向收发；
 * 2. 监听 127.0.0.1 随机回环端口，生成一次性 32 字节令牌写入自发现文件 bridge.json，
 *   Agent 连接后凭令牌握手，之后按 NDJSON 收发请求/响应；
 * 3. 每 25 秒向扩展发送内部 ping（MV3 Service Worker 保活信号）；
 * 4. 请求串行转发（同一时刻只有一条在途请求，避免扩展侧写锁竞争）；
 * 5. 大消息自动分块（200000 字符，统一信封 {apiVersion,id,chunk:{i,n},part}，对两端透明重组）。
 *
 * ⚠️ stdout 是 Native Messaging 协议通道，任何日志一律走 stderr（console.error）。
 * ⚠️ run-host.cmd 启动包装必须保持纯 ASCII：cmd.exe 以 ANSI 代码页解析批处理，
 *    UTF-8 中文注释在 GBK 系统上会把行解析成乱码命令，导致宿主无法启动。
 * @encoding UTF-8
 */

import { join } from 'jsr:@std/path@^1.0.8';
import { API_VERSION, apiVersionMismatchMessage, readApiVersion } from '../src/constants/api-version.js';

const HOST_NAME = 'com.betterbrowse.bridge';
const KEEPALIVE_PING_MS = 25000;
/** 活性看门狗：连续 90 秒未收到扩展 pong（宿主被异常遗留时）自动退出并清理 */
const LIVENESS_TIMEOUT_MS = 90000;
/** 在途请求超时：超时未收到扩展响应则丢弃并放行后续请求 */
const INFLIGHT_TIMEOUT_MS = 120000;
/** 分块阈值（JS 字符数；中文按 UTF-8 最坏 ~3 字节/字符，确保单帧 < 1MB Chrome 限制） */
const CHUNK_CHARS = 200000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 调试日志文件句柄（懒创建） */
let debugLogFile = null;

/** 输出日志（仅 stderr，绝不污染 stdout 协议通道；同步落盘一份便于排障） */
function log(...args) {
  console.error(`[bb-host]`, ...args);
  try {
    if (!debugLogFile) {
      const stateDir = Deno.build.os === 'windows'
        ? join(Deno.env.get('LOCALAPPDATA') || '', 'BetterBrowse')
        : join(Deno.env.get('XDG_STATE_HOME') || join(Deno.env.get('HOME') || '', '.local', 'state'), 'better-browse');
      debugLogFile = Deno.openSync(join(stateDir, 'host-debug.log'), { append: true, create: true });
    }
    debugLogFile.writeSync(encoder.encode(`${new Date().toISOString()} ${args.join(' ')}\n`));
  } catch {
    // 日志失败不影响主流程
  }
}

// ============================================================
// Native Messaging 帧读写（4 字节小端长度前缀 + UTF-8 JSON）
// ============================================================

/**
 * 从异步可读流按帧解析 JSON 消息
 * @param {ReadableStream<Uint8Array>} stream
 */
async function* readNativeFrames(stream) {
  let buffer = new Uint8Array(0);
  for await (const chunk of stream) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;

    while (buffer.length >= 4) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(0, true);
      if (length === 0 || length > 64 * 1024 * 1024) {
        throw new Error(`非法帧长度: ${length}`);
      }
      if (buffer.length < 4 + length) break;
      const payload = decoder.decode(buffer.subarray(4, 4 + length));
      buffer = buffer.slice(4 + length);
      try {
        yield JSON.parse(payload);
      } catch (err) {
        log('帧 JSON 解析失败，已跳过:', err?.message || err);
      }
    }
  }
}

/**
 * 写出一帧 Native Messaging 消息
 * @param {unknown} obj
 */
async function writeNativeFrame(obj) {
  const payload = encoder.encode(JSON.stringify(obj));
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  await Deno.stdout.write(frame);
}

/**
 * 将完整 JSON 文本按统一分块信封切分
 * @param {string} text
 * @param {string} id
 * @returns {object[]}
 */
function chunkFrames(text, id) {
  const total = Math.ceil(text.length / CHUNK_CHARS);
  const frames = [];
  for (let i = 0; i < total; i++) {
    frames.push({
      apiVersion: API_VERSION,
      id,
      chunk: { i, n: total },
      part: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
    });
  }
  return frames;
}

/**
 * 向扩展发送消息（超过分块阈值自动分块，接收方按 id 重组）
 * @param {unknown} obj
 */
async function sendToExtension(obj) {
  const text = JSON.stringify(obj);
  if (text.length <= CHUNK_CHARS) {
    await writeNativeFrame(obj);
    return;
  }
  const id = typeof obj?.reqId === 'string' ? obj.reqId : `host_${Date.now()}`;
  for (const frame of chunkFrames(text, id)) {
    await writeNativeFrame(frame);
  }
}

// ============================================================
// 自发现文件（bridge.json：端口 / 令牌 / 进程号，随宿主进程生灭）
// ============================================================

/**
 * 解析扩展 ID（校验 Chrome 32 位 a-p 字母格式）
 * @param {string} origin - Chrome 注入的启动参数，如 chrome-extension://abcdef.../
 * @returns {string | null}
 */
function parseExtensionId(origin) {
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(String(origin || '').trim());
  return match ? match[1] : null;
}

/**
 * 自发现文件所在目录
 * @returns {string}
 */
function stateDirPath() {
  const home = Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '.';
  if (Deno.build.os === 'windows') {
    return join(Deno.env.get('LOCALAPPDATA') || join(home, 'AppData', 'Local'), 'BetterBrowse');
  }
  return join(Deno.env.get('XDG_STATE_HOME') || join(home, '.local', 'state'), 'better-browse');
}

/**
 * 写入自发现文件
 * @param {{ port: number, token: string, pid: number, extensionId: string, apiVersion: number, startedAt: number }} info
 */
async function writeBridgeFile(info) {
  const dir = stateDirPath();
  await Deno.mkdir(dir, { recursive: true });
  const file = join(dir, 'bridge.json');
  await Deno.writeTextFile(file, JSON.stringify(info, null, 2));
  try {
    await Deno.chmod(file, 0o600);
  } catch {
    // Windows 文件权限由用户目录 ACL 兜底
  }
}

/** 删除自发现文件（进程退出清理） */
async function removeBridgeFile() {
  try {
    await Deno.remove(join(stateDirPath(), 'bridge.json'));
  } catch {
    // 文件不存在视为已清理
  }
}

/** 生成 64 位十六进制随机令牌 */
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 恒定时间字符串比较（防令牌时序探测）
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================
// Agent TCP 侧信道（NDJSON；握手 → 串行请求转发）
// ============================================================

class BridgeHost {
  constructor(extensionId) {
    this.extensionId = extensionId;
    this.token = generateToken();
    /** Agent 请求队列（串行转发扩展） */
    this.pending = [];
    /** 当前在途请求（串行通道仅一条） */
    this.inflight = null;
    /** 分块重组缓存：id -> { parts, received, total }（扩展响应与 Agent 请求共用） */
    this.reassembly = new Map();
    this.agentSocket = null;
    /** 扩展 API 兼容状态：null=尚未握手，true=可转发，false=明确不兼容 */
    this.extensionApiCompatible = null;
    this.closed = false;
    /** 最近一次收到扩展 pong 的时刻（活性判定基准） */
    this.lastPongAt = Date.now();
  }

  /** 启动宿主：TCP 监听 → 写 bridge.json → 进入原生消息主循环 */
  async start() {
    const listener = Deno.listen({ transport: 'tcp', hostname: '127.0.0.1', port: 0 });
    this.listener = listener;
    const port = (listener.addr).port;
    await writeBridgeFile({
      port,
      token: this.token,
      pid: Deno.pid,
      extensionId: this.extensionId,
      apiVersion: API_VERSION,
      startedAt: Date.now()
    });
    log(`桥接宿主已启动：扩展 ${this.extensionId}，侧信道 127.0.0.1:${port}`);

    this.acceptLoop(listener);
    this.pingTimer = setInterval(async () => {
      // 活性看门狗：扩展侧已消亡但 stdin 管道未正常关闭时，自动退出并清理痕迹
      if (Date.now() - this.lastPongAt > LIVENESS_TIMEOUT_MS) {
        log(`超过 ${Math.round(LIVENESS_TIMEOUT_MS / 1000)} 秒未收到扩展响应，宿主自动退出`);
        await this.shutdown();
        Deno.exit(0);
      }
      // 在途请求超时：响应丢失（如分块帧被丢弃）时释放串行转发器，绝不永久卡死
      const now = Date.now();
      if (this.inflight && now - this.inflight.forwardedAt > INFLIGHT_TIMEOUT_MS) {
        const timed = this.inflight;
        log(`在途请求超时: reqId=${timed.id}，已丢弃并放行后续请求`);
        this.inflight = null;
        this.writeAgentLine(timed.conn, { id: timed.id, success: false, error: '扩展响应超时丢失，请重试' }).catch(() => {});
      }
      this.drainQueue();
      try {
        await writeNativeFrame({ internal: 'ping' });
      } catch {
        // 写失败交由主循环 EOF 退出
      }
    }, KEEPALIVE_PING_MS);

    try {
      for await (const message of readNativeFrames(Deno.stdin.readable)) {
        await this.handleExtensionMessage(message);
      }
      log('stdin 已关闭（浏览器或扩展断开），宿主退出');
    } catch (err) {
      log('原生消息主循环异常:', err?.message || err);
    } finally {
      await this.shutdown();
    }
  }

  /** 退出清理：停 ping、关监听与 socket、删 bridge.json */
  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.listener?.close();
    } catch {
      // 忽略重复关闭
    }
    try {
      this.agentSocket?.close();
    } catch {
      // 忽略重复关闭
    }
    await removeBridgeFile();
  }

  /**
   * 接受 Agent 连接（同一时刻仅服务一个连接；新连接直接顶替旧连接，避免僵尸会话阻塞）
   * @param {Deno.Listener} listener
   */
  async acceptLoop(listener) {
    try {
      for await (const conn of listener) {
        if (this.agentSocket) {
          // 已有 Agent 会话：顶替策略——关闭旧会话（其挂起请求以连接关闭兜底失败），接纳新会话
          log('新 Agent 接入，顶替旧会话');
          try {
            this.agentSocket.close();
          } catch {
            // 忽略重复关闭
          }
          this.agentSocket = null;
        }
        this.agentSocket = conn;
        log('Agent 已连接');
        this.agentSession(conn).catch((err) => log('Agent 会话异常:', err?.message || err));
      }
    } catch (err) {
      if (!this.closed) log('TCP 监听异常:', err?.message || err);
    }
  }

  /**
   * 单个 Agent 会话：令牌握手 + NDJSON 请求循环
   * @param {Deno.Conn} conn
   */
  async agentSession(conn) {
    let authenticated = false;
    let lineBuffer = '';
    try {
      for await (const chunk of conn.readable) {
        lineBuffer += decoder.decode(chunk);
        let newlineIndex;
        while ((newlineIndex = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, newlineIndex).trim();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          let message;
          try {
            message = JSON.parse(line);
          } catch {
            await this.writeAgentLine(conn, { ok: false, error: 'JSON 解析失败' });
            continue;
          }

          if (!authenticated) {
            // 首行握手：{"apiVersion":1,"token":"..."}；兼容读取历史 proto 字段
            const peerApiVersion = readApiVersion(message) ?? 1;
            if (peerApiVersion !== API_VERSION) {
              await this.writeAgentLine(conn, {
                ok: false,
                apiVersion: API_VERSION,
                peerApiVersion,
                error: apiVersionMismatchMessage(peerApiVersion)
              });
              log(`Agent ${apiVersionMismatchMessage(peerApiVersion)}，断开连接`);
              conn.close();
              this.agentSocket = null;
              return;
            }
            if (timingSafeEqual(String(message?.token || ''), this.token)) {
              authenticated = true;
              await this.writeAgentLine(conn, {
                apiVersion: API_VERSION,
                ok: true,
                extensionId: this.extensionId,
                host: HOST_NAME
              });
            } else {
              await this.writeAgentLine(conn, { ok: false, error: '令牌校验失败' });
              log('令牌校验失败，断开 Agent');
              conn.close();
              this.agentSocket = null;
              return;
            }
            continue;
          }

          // Agent → 宿主分块重组：信封切分的是完整 {id,action,payload} 请求 JSON
          if (authenticated && message?.chunk && typeof message.part === 'string') {
            const peerApiVersion = readApiVersion(message) ?? 1;
            if (peerApiVersion !== API_VERSION) {
              await this.writeAgentLine(conn, {
                id: String(message.id || ''),
                success: false,
                error: apiVersionMismatchMessage(peerApiVersion)
              });
              continue;
            }
            const assembled = this.assembleChunk(message);
            if (!assembled) continue;
            message = assembled;
          }

          // 业务请求：{ id, action, payload }
          if (authenticated && message && typeof message.action === 'string' && typeof message.id === 'string') {
            log(`agent 请求入队: id=${message.id} action=${message.action}`);
            this.pending.push({ conn, id: message.id, action: message.action, payload: message.payload ?? null });
            this.drainQueue();
          } else {
            await this.writeAgentLine(conn, { id: message?.id || '', success: false, error: '请求缺少 id 或 action' });
          }
        }
      }
    } finally {
      if (this.agentSocket === conn) this.agentSocket = null;
      try {
        conn.close();
      } catch {
        // 忽略重复关闭
      }
      // 清理该会话遗留的挂起请求，避免队列积压阻塞后续转发
      this.pending = this.pending.filter((entry) => entry.conn !== conn);
      log('Agent 会话结束');
    }
  }

  /**
   * 按统一信封重组分块；未齐返回 null，齐则 JSON.parse 正文
   * @param {any} message
   * @returns {any | null}
   */
  assembleChunk(message) {
    const id = String(message.id || '');
    if (!id) return null;
    let entry = this.reassembly.get(id);
    if (!entry) {
      entry = { parts: new Array(message.chunk.n || 0).fill(''), received: 0, total: message.chunk.n || 0 };
      this.reassembly.set(id, entry);
      log(`开始重组分块: id=${id} 总块数=${entry.total}`);
    }
    const index = message.chunk.i || 0;
    if (index >= 0 && index < entry.total && !entry.parts[index]) {
      entry.parts[index] = message.part;
      entry.received++;
    }
    if (!(entry.total > 0 && entry.received >= entry.total)) return null;
    this.reassembly.delete(id);
    return JSON.parse(entry.parts.join(''));
  }

  /**
   * 写一行 JSON 给 Agent（超长自动按分块信封切分）
   * @param {Deno.Conn} conn
   * @param {unknown} obj
   */
  async writeAgentLine(conn, obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      text = JSON.stringify({ success: false, error: '响应序列化失败' });
    }
    if (text.length <= CHUNK_CHARS) {
      await conn.write(encoder.encode(text + '\n'));
      return;
    }
    const id = typeof obj?.id === 'string' ? obj.id : `resp_${Date.now()}`;
    for (const frame of chunkFrames(text, id)) {
      await conn.write(encoder.encode(JSON.stringify(frame) + '\n'));
    }
  }

  /** 串行派发：无在途请求时把队首转发给扩展 */
  drainQueue() {
    if (this.inflight || this.pending.length === 0) return;
    if (this.extensionApiCompatible === null) return;
    if (this.extensionApiCompatible === false) {
      const rejected = this.pending.shift();
      this.writeAgentLine(rejected.conn, {
        id: rejected.id,
        success: false,
        error: '扩展与本机宿主的 API 版本不兼容，请重载扩展并重新安装宿主'
      }).catch(() => {});
      this.drainQueue();
      return;
    }
    const next = this.pending.shift();
    this.inflight = { id: next.id, conn: next.conn, forwardedAt: Date.now() };
    log(`转发扩展: id=${next.id} action=${next.action}`);
    sendToExtension({ reqId: next.id, action: next.action, payload: next.payload }).catch((err) => {
      log(`转发扩展失败: id=${next.id} ${err?.message || err}`);
      this.inflight = null;
      this.writeAgentLine(next.conn, { id: next.id, success: false, error: '转发扩展失败（通道已断开）' }).catch(() => {});
    });
  }

  /**
   * 处理扩展消息：内部 pong / 分块重组 / 业务响应
   * @param {any} message
   */
  async handleExtensionMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.internal === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }
    if (message.internal === 'hello') {
      // 扩展身份已由 Chrome 按 allowed_origins 校验；兼容读取历史 proto 字段
      const peerApiVersion = readApiVersion(message) ?? 1;
      this.lastPongAt = Date.now();
      if (peerApiVersion !== API_VERSION) {
        this.extensionApiCompatible = false;
        await writeNativeFrame({
          internal: 'ready',
          apiVersion: API_VERSION,
          peerApiVersion,
          compatible: false,
          error: apiVersionMismatchMessage(peerApiVersion),
          extensionId: this.extensionId
        });
        log(`扩展 ${apiVersionMismatchMessage(peerApiVersion)}`);
        this.drainQueue();
        return;
      }
      this.extensionApiCompatible = true;
      await writeNativeFrame({ internal: 'ready', apiVersion: API_VERSION, compatible: true, extensionId: this.extensionId });
      this.drainQueue();
      return;
    }

    // 分块重组（扩展 → 宿主方向）
    if (message.chunk && typeof message.part === 'string') {
      const peerApiVersion = readApiVersion(message) ?? 1;
      if (peerApiVersion !== API_VERSION) {
        log(apiVersionMismatchMessage(peerApiVersion));
        return;
      }
      let full;
      try {
        full = this.assembleChunk(message);
      } catch (err) {
        const id = String(message.id || '');
        log(`分块重组失败: ${err?.message || err}`);
        if (this.inflight?.id === id) {
          const meta = this.inflight;
          this.inflight = null;
          this.writeAgentLine(meta.conn, { id, success: false, error: '响应分块重组失败，请重试' }).catch(() => {});
        }
        this.drainQueue();
        return;
      }
      if (!full) return;
      if (full && typeof full === 'object' && full.reqId === undefined) full.reqId = String(message.id || '');
      await this.handleExtensionMessage(full);
      return;
    }

    // 业务响应：{ reqId, success, data | error }
    if (typeof message.reqId === 'string' && this.inflight?.id === message.reqId) {
      const meta = this.inflight;
      this.inflight = null;
      const { reqId, ...body } = message;
      log(`收到扩展响应: reqId=${reqId} success=${body.success}`);
      try {
        await this.writeAgentLine(meta.conn, { id: reqId, ...body });
      } catch (err) {
        log(`写回 Agent 失败: ${err?.message || err}`);
      }
      this.drainQueue();
    } else if (typeof message.reqId === 'string') {
      log(`收到未匹配的扩展响应: reqId=${message.reqId}（在途=${this.inflight ? 1 : 0}）`);
    }
  }
}

// ============================================================
// 入口
// ============================================================

async function main() {
  // Chrome 会追加额外启动参数（新版 Windows 上包括 --parent-window=<句柄>），
  // 扩展来源不保证是最后一个参数：必须扫描全部参数寻找 chrome-extension:// 前缀
  const origin = Deno.args.find((arg) => /^chrome-extension:\/\/[a-p]{32}\/?$/.test(arg)) || '';
  const extensionId = parseExtensionId(origin);
  if (!extensionId) {
    log(`启动参数缺少合法扩展来源（收到: "${Deno.args.join(' ')}"）。本程序由 Chrome 经 Native Messaging 拉起，请勿手动运行。`);
    // 仍以 0 退出，避免 Chrome 侧反复重启
    return;
  }

  const host = new BridgeHost(extensionId);
  // 进程被终止时尽力清理 bridge.json（SIGTERM 监听在 Windows 不可用，需容错）
  try {
    Deno.addSignalListener('SIGTERM', () => host.shutdown());
  } catch {
    // 平台不支持信号监听时依赖 stdin EOF 路径清理
  }
  globalThis.addEventListener('unload', () => {
    host.shutdown();
  });
  await host.start();
}

await main();
