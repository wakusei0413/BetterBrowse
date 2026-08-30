/**
 * @file bb-bridge-client.js
 * @description BetterBrowse AI 桥接客户端（Agent 经本机宿主对等操控插件的命令行入口）
 *
 * 用法：
 *   deno run -A bb-bridge-client.js status
 *   deno run -A bb-bridge-client.js capabilities
 *   deno run -A bb-bridge-client.js call <ACTION> '<payload JSON>'
 *   deno run -A bb-bridge-client.js stash-list
 *   deno run -A bb-bridge-client.js stash-search <keyword>
 *   deno run -A bb-bridge-client.js group-show <groupId> [--offset=0] [--limit=50]
 *   deno run -A bb-bridge-client.js stash-add <groupId> <url> [title]
 *   deno run -A bb-bridge-client.js group-rename <groupId> <title>
 *   deno run -A bb-bridge-client.js group-delete <groupId> [--force] --confirm
 *   deno run -A bb-bridge-client.js item-update <groupId> <itemId> '<updates JSON>'
 *   deno run -A bb-bridge-client.js config-get | config-set '<partial JSON>'
 *   deno run -A bb-bridge-client.js rule-set <domain> <auto|current|new>
 *   deno run -A bb-bridge-client.js sync-now
 *   deno run -A bb-bridge-client.js eval-tabs
 *   deno run -A bb-bridge-client.js backups
 *   deno run -A bb-bridge-client.js backup-restore <createdAt> --confirm
 *   deno run -A bb-bridge-client.js backup-delete <createdAt> --confirm
 *   deno run -A bb-bridge-client.js backup-export [输出文件]
 *
 * 输出统一为 JSON 信封 {"success":true,"data":...} / {"success":false,"error":"..."}，
 * 退出码 0=成功、1=失败，便于 Agent 判定。
 * 自发现文件 bridge.json 由宿主进程写入（协议见 references/protocol.md）。
 *
 * ⚠️ 会话实现约束：Deno 的 conn.readable 流一旦被取消（for-await 提前退出）会关闭底层
 * socket，因此整个会话必须使用单一常驻读取循环，握手与请求响应共用同一条流。
 * @encoding UTF-8
 */

import { join } from 'jsr:@std/path@^1.0.8';

const PROTOCOL_VERSION = 1;
const CHUNK_CHARS = 200000;
const DEFAULT_TIMEOUT_MS = Number(Deno.env.get('BB_BRIDGE_TIMEOUT_MS') || 120000);
const HANDSHAKE_TIMEOUT_MS = 10000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 自发现文件路径（与本机宿主 bb_native_host.js 保持一致） */
function bridgeFilePath() {
  const home = Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '.';
  if (Deno.build.os === 'windows') {
    return join(Deno.env.get('LOCALAPPDATA') || join(home, 'AppData', 'Local'), 'BetterBrowse', 'bridge.json');
  }
  return join(Deno.env.get('XDG_STATE_HOME') || join(home, '.local', 'state'), 'better-browse', 'bridge.json');
}

/** 命令行输出（统一 JSON 信封） */
function emit(envelope) {
  console.log(JSON.stringify(envelope, null, 2));
  Deno.exit(envelope?.success === false ? 1 : 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 会话（连接 + 令牌握手 + 常驻读取循环）
// ============================================================

/**
 * 建立与宿主的会话：读 bridge.json → TCP → 握手 → 启动常驻读取循环
 * @returns {Promise<{ conn: Deno.Conn, hello: any, waiter: ((r: any) => void) | null, closed: boolean }>}
 */
async function connectSession() {
  let info;
  try {
    info = JSON.parse(await Deno.readTextFile(bridgeFilePath()));
  } catch {
    emit({
      success: false,
      error: `未找到桥接自发现文件 ${bridgeFilePath()}。请确认：① 插件选项页「AI 桥接」开关已开启；② 已执行 deno task ai-host-install 安装宿主且扩展已重载。`
    });
  }

  let conn;
  try {
    conn = await Deno.connect({ transport: 'tcp', hostname: '127.0.0.1', port: info.port });
  } catch {
    emit({ success: false, error: `无法连接宿主侧信道 127.0.0.1:${info.port}（宿主可能已退出，请在浏览器重载扩展后重试）` });
  }

  await conn.write(encoder.encode(JSON.stringify({ proto: PROTOCOL_VERSION, token: info.token }) + '\n'));

  const session = { conn, hello: null, waiter: null, closed: false };
  let resolveHello;
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });

  // 常驻读取循环：握手响应与业务响应共用同一条流，绝不提前取消（见文件头约束）
  (async () => {
    const buf = new Uint8Array(65536);
    let buffer = '';
    const reassembly = new Map();
    try {
      while (!session.closed) {
        const n = await conn.read(buf);
        if (n === null) break;
        buffer += decoder.decode(buf.subarray(0, n));
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          // 首条消息为握手响应
          if (!session.hello) {
            session.hello = message;
            resolveHello(message);
            continue;
          }
          // 分块响应重组（信封 {v,id,chunk:{i,n},part}，part 依次拼接为完整响应 JSON）
          if (message?.chunk && typeof message.part === 'string') {
            const id = String(message.id || '');
            if (!id) continue;
            let entry = reassembly.get(id);
            if (!entry) {
              entry = { parts: new Array(message.chunk.n || 0).fill(''), received: 0, total: message.chunk.n || 0 };
              reassembly.set(id, entry);
            }
            const idx = message.chunk.i || 0;
            if (idx >= 0 && idx < entry.total && !entry.parts[idx]) {
              entry.parts[idx] = message.part;
              entry.received++;
            }
            if (entry.total > 0 && entry.received >= entry.total) {
              reassembly.delete(id);
              try {
                // 关键：回填信封 id 到重组正文（分块正文本身不含 id，缺失会导致分发失败）
                const parsed = JSON.parse(entry.parts.join(''));
                if (parsed && typeof parsed === 'object' && parsed.id === undefined) parsed.id = id;
                dispatch(session, parsed);
              } catch {
                // 重组后的响应解析失败，等待超时兜底
              }
            }
            continue;
          }
          dispatch(session, message);
        }
      }
    } catch {
      // 连接异常：走关闭路径兜底
    }
    session.closed = true;
    resolveHello(session.hello || { ok: false, error: '连接已关闭（宿主可能已退出）' });
    if (session.waiter) {
      session.waiter({ success: false, error: '宿主连接在等待响应时关闭' });
      session.waiter = null;
    }
  })();

  const hello = await Promise.race([helloPromise, sleep(HANDSHAKE_TIMEOUT_MS).then(() => null)]);
  if (!hello || !hello.ok) {
    session.closed = true;
    try { conn.close(); } catch { /* 忽略 */ }
    emit({ success: false, error: hello?.error || '握手超时：宿主未在时限内响应令牌校验' });
  }
  return session;
}

/** 将完整响应分发给等待中的请求 */
function dispatch(session, message) {
  if (!session.waiter) return;
  const resolve = session.waiter;
  session.waiter = null;
  const { id: _ignored, ...body } = message;
  resolve(body);
}

/**
 * 发送请求并等待响应（超时保护；大 payload 自动分块）
 * @param {ReturnType<typeof connectSession>} session
 * @param {string} action
 * @param {any} payload
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
async function request(session, action, payload = null) {
  const id = crypto.randomUUID();
  const timeout = setTimeout(() => {
    session.closed = true;
    try { session.conn.close(); } catch { /* 忽略 */ }
  }, DEFAULT_TIMEOUT_MS);

  try {
    const envelope = { id, action, payload };
    const text = JSON.stringify(envelope);
    if (text.length > CHUNK_CHARS) {
      const total = Math.ceil(text.length / CHUNK_CHARS);
      for (let i = 0; i < total; i++) {
        await session.conn.write(encoder.encode(JSON.stringify({
          v: PROTOCOL_VERSION,
          id,
          chunk: { i, n: total },
          part: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
        }) + '\n'));
      }
    } else {
      await session.conn.write(encoder.encode(JSON.stringify(envelope) + '\n'));
    }
  } catch {
    clearTimeout(timeout);
    return { success: false, error: '发送请求失败（宿主连接已断开，请在浏览器重载扩展后重试）' };
  }

  const response = await new Promise((resolve) => {
    session.waiter = resolve;
  });
  clearTimeout(timeout);
  return response;
}

// ============================================================
// 便利命令 → (action, payload) 映射
// ============================================================

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (match) flags[match[1]] = match[2] === undefined ? true : match[2];
    else positional.push(arg);
  }
  return { positional, flags };
}

/**
 * 构建命令对应的 action 与 payload
 * @param {string} command
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} flags
 * @returns {{ action: string, payload: any, outputFile?: string } | null}
 */
function buildRequest(command, positional, flags) {
  const json = (text, what) => {
    try {
      return JSON.parse(text || '{}');
    } catch {
      emit({ success: false, error: `${what} 不是合法 JSON` });
    }
  };
  switch (command) {
    case 'status': return { action: 'GET_AI_BRIDGE_STATUS', payload: null };
    case 'capabilities': return { action: 'GET_AI_CAPABILITIES', payload: null };
    case 'call': {
      if (!positional[0]) emit({ success: false, error: 'call 需要一个 ACTION 参数' });
      return { action: positional[0], payload: positional[1] ? json(positional[1], 'payload') : null };
    }
    case 'stash-list': return { action: 'GET_STASH_GROUPS', payload: null };
    case 'stash-search':
      return { action: 'SEARCH_STASH', payload: { keyword: positional[0] || '', limit: Number(flags.limit) || 100 } };
    case 'group-show':
      return {
        action: 'GET_STASH_GROUP_PAGE',
        payload: {
          groupId: positional[0],
          offset: Number(flags.offset) || 0,
          limit: Number(flags.limit) || 50
        }
      };
    case 'stash-add':
      return {
        action: 'ADD_STASH_ITEM',
        payload: { groupId: positional[0], item: { url: positional[1], title: positional[2] || '' } }
      };
    case 'group-rename':
      return { action: 'UPDATE_STASH_GROUP', payload: { groupId: positional[0], updates: { title: positional[1] || '' } } };
    case 'group-star':
      return { action: 'UPDATE_STASH_GROUP', payload: { groupId: positional[0], updates: { starred: flags.off !== true } } };
    case 'group-lock':
      return { action: 'UPDATE_STASH_GROUP', payload: { groupId: positional[0], updates: { locked: flags.off !== true } } };
    case 'group-delete':
      return { action: 'DELETE_STASH_GROUP', payload: { groupId: positional[0], force: flags.force === true, confirm: flags.confirm === true } };
    case 'stash-remove':
      return { action: 'DELETE_STASH_ITEM', payload: { groupId: positional[0], itemId: positional[1] } };
    case 'item-update':
      return { action: 'UPDATE_STASH_ITEM', payload: { groupId: positional[0], itemId: positional[1], updates: json(positional[2], 'updates') } };
    case 'group-restore':
      return { action: 'RESTORE_STASH_GROUP', payload: { groupId: positional[0] } };
    case 'item-restore':
      return { action: 'RESTORE_STASH_ITEM', payload: { groupId: positional[0], itemId: positional[1] } };
    case 'stash-import':
      return { action: 'IMPORT_STASH_DATA', payload: { jsonString: positional[0] || '' } };
    case 'stash-export': return { action: 'EXPORT_STASH_DATA', payload: null };
    case 'backup-export': return { action: 'EXPORT_FULL_BACKUP', payload: null, outputFile: positional[0] };
    case 'backup-import':
      return { action: 'RESTORE_FULL_BACKUP', payload: { jsonString: positional[0] || '', confirm: flags.confirm === true } };
    case 'backups': return { action: 'LIST_AUTO_BACKUPS', payload: null };
    case 'backup-restore':
      return { action: 'RESTORE_AUTO_BACKUP', payload: { createdAt: Number(positional[0]), confirm: flags.confirm === true } };
    case 'backup-delete':
      return { action: 'DELETE_AUTO_BACKUP', payload: { createdAt: Number(positional[0]), confirm: flags.confirm === true } };
    case 'config-get': return { action: 'GET_CONFIG', payload: null };
    case 'config-set': return { action: 'UPDATE_CONFIG', payload: json(positional[0], '配置增量') };
    case 'config-reset': return { action: 'RESET_CONFIG', payload: { confirm: flags.confirm === true } };
    case 'rule-set':
      return { action: 'SET_DOMAIN_RULE', payload: { domain: positional[0], mode: positional[1] || 'auto' } };
    case 'rule-remove':
      return { action: 'REMOVE_DOMAIN_RULE', payload: { domain: positional[0] } };
    case 'rules-get': return { action: 'GET_DOMAIN_RULES', payload: null };
    case 'sync-now': return { action: 'RUN_SYNC_NOW', payload: null };
    case 'sync-status': return { action: 'GET_SYNC_STATUS', payload: null };
    case 'sync-credentials':
      return { action: 'SAVE_WEBDAV_CREDENTIALS', payload: json(positional[0], '凭据 JSON') };
    case 'eval-tabs': return { action: 'EVALUATE_TABS', payload: null };
    case 'tab-count': return { action: 'GET_TAB_COUNT_INFO', payload: null };
    default: return null;
  }
}

const HELP_TEXT = `BetterBrowse AI 桥接客户端

用法：deno run -A bb-bridge-client.js <命令> [参数]

会话与能力：
  status                          桥接连接状态与 AI 操作审计
  capabilities                    全部可用动作清单（自描述，随插件版本更新）
  call <ACTION> '<payload JSON>'  调用任意动作（见 capabilities）
  help                            显示本帮助

收纳数据：
  stash-list                      列出全部收纳组
  stash-search <关键字> [--limit=N] 全局检索条目
  group-show <groupId> [--offset=N] [--limit=N]   分页读取组内条目
  stash-add <groupId> <url> [标题]                向组内添加条目
  stash-remove <groupId> <itemId>                 删除条目
  item-update <groupId> <itemId> '<updates JSON>' 编辑条目（title/url/pinned/archived）
  group-rename <groupId> <标题>                   重命名组
  group-star <groupId> [--off]                    星标/取消星标
  group-lock <groupId> [--off]                    锁定/解锁
  group-restore <groupId>                         恢复整组标签页
  item-restore <groupId> <itemId>                 恢复单条目
  group-delete <groupId> [--force] --confirm      删除组（锁定组需 --force）
  stash-import '<文本/JSON>'                      导入数据
  stash-export                                    导出收纳 JSON

备份：
  backup-export [输出文件]                        导出全量备份（破坏性操作前建议先执行）
  backup-import '<备份 JSON>' --confirm           恢复全量备份
  backups                                         列出自动备份摘要
  backup-restore <createdAt> --confirm            恢复自动备份
  backup-delete <createdAt> --confirm             删除自动备份

配置与规则：
  config-get / config-set '<partial JSON>' / config-reset --confirm
  rules-get / rule-set <域名> <auto|current|new> / rule-remove <域名>

同步与状态：
  sync-status / sync-now / sync-credentials '<凭据 JSON>'
  eval-tabs / tab-count

安全提示：不可逆操作必须显式携带 --confirm（等价人类 UI 的确认弹窗）；
WebDAV 凭据只写不可读；所有 AI 操作都会记录在选项页「AI 桥接」审计列表。`;

// ============================================================
// 入口
// ============================================================

const [command = 'help', ...rest] = Deno.args;
if (command === 'help' || command === '--help') {
  console.log(HELP_TEXT);
  Deno.exit(0);
}

const { positional, flags } = parseCliArgs(rest);
const built = buildRequest(command, positional, flags);
if (!built) {
  emit({ success: false, error: `未知命令: ${command}（运行 help 查看用法）` });
}

const session = await connectSession();
const response = await request(session, built.action, built.payload);
session.closed = true;
try { session.conn.close(); } catch { /* 忽略 */ }

// 导出类命令支持落盘
if (built.outputFile && response?.success && typeof response.data === 'string') {
  await Deno.writeTextFile(built.outputFile, response.data);
  emit({ success: true, data: { outputFile: built.outputFile, bytes: response.data.length } });
}

emit(response);
