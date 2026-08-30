# BetterBrowse AI 桥接协议参考

> 架构与安全模型的权威冻结稿见仓库 `docs/03-ai-skill-bridge.md`；本文面向客户端实现与排障。

## 1. 组件与发现

```
Agent CLI（本目录 scripts/bb-bridge-client.js）
  ↕ TCP 127.0.0.1:<port> + NDJSON + 一次性令牌
本机宿主（BetterBrowse/native-host/bb_native_host.js，由 Chrome 按需拉起）
  ↕ Native Messaging stdio 帧（4 字节小端长度 + UTF-8 JSON）
扩展 Service Worker（AIBridgeManager → 共享 action 处理映射）
```

自发现文件（宿主进程写入、退出时删除）：

| 平台 | 路径 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\BetterBrowse\bridge.json` |
| macOS/Linux | `$XDG_STATE_HOME/better-browse/bridge.json`（缺省 `~/.local/state/better-browse/bridge.json`） |

内容：`{"port":..., "token":"<64hex>", "pid":..., "extensionId":"...", "startedAt":...}`。

## 2. TCP 会话

1. 连接后首行发送握手 `{"proto":1,"token":"<token>"}`；
2. 宿主回 `{"proto":1,"ok":true,"extensionId":"...","host":"com.betterbrowse.bridge"}` 或 `{"ok":false,"error":"..."}` 后断开；
3. 之后每行一条请求 `{"id":"<uuid>","action":"<ActionType>","payload":{...}}`；
4. 每行一条响应 `{"id":"...","success":true,"data":...}` 或 `{"id":"...","success":false,"error":"<中文原因>"}`；
5. 同一时刻宿主只服务一个 Agent 连接；请求**串行**转发扩展（在途仅一条）。

## 3. 分块信封

任一方向、任一传输层，逻辑消息超过 **200000 字符**时按信封切分，两端透明重组：

```json
{"v":1, "id":"<消息id>", "chunk":{"i":0,"n":3}, "part":"<完整 JSON 的字符串片段>"}
```

- 客户端 → 宿主：分块信封整行发送（每行一个 chunk），切分的是完整 `{id, action, payload}` 请求 JSON，`id` 即请求 `id`；
- 宿主重组后必须得到带 `action` 的请求才能入队转发；只切 `payload` 会导致路由失败。
- 宿主 → 客户端：按 `id` 拼齐 `part` 后 `JSON.parse` 得到完整响应。

## 4. 扩展侧治理（请求被拒的常见原因）

| 现象 | 原因 |
| --- | --- |
| `不支持的动作: XXX` | 动作不在共享处理映射（以 `capabilities` 返回为准） |
| `动作 XXX 为不可逆操作，需在 payload 中显式携带 confirm: true` | 确认位缺失 |
| `payload 超出上限` | 单请求超过 8MB 文本 |
| `响应包含受限凭据字段，已拦截` | 凭据出口复查触发（凭据只写不可读） |
| `token 校验失败` | bridge.json 与宿主进程不匹配（宿主重启过），重读文件重连 |

## 5. 状态与排障

- 扩展状态动作：`call GET_AI_BRIDGE_STATUS` → `{armed, state, extensionId, lastError, audit[...]}`；
  `state` 取值：`disabled` / `connecting` / `connected` / `reconnecting` / `host_missing` / `error` / `unsupported`。
- `host_missing`：宿主未注册。执行 `deno task ai-host-install --ext-id=<ID>` 并重载扩展。
- bridge.json 存在但连接被拒：宿主进程已退出（浏览器关闭），重载扩展触发重新拉起。
- 扩展侧日志：`chrome://extensions` → BetterBrowse → Service Worker 控制台；宿主日志在 stderr（`native-host` 启动的终端或 Chrome 宿主日志）。

## 6. 扩展指引

- 新增动作：在 `BetterBrowse/src/background/action-handlers.js` 挂载 handler → 在 `src/core/ai/ai-capabilities.js` 的 `AI_ACTION_DOCS` 补参数文档（parity 测试会校验覆盖）→ `deno task bundle && deno task verify`。
- 改动 `src/constants/` 下常量后必须重新打包 content-bundle，否则 `verify` 失败。
- 客户端便利命令不足时，直接使用 `call <ACTION> '<payload>'`——所有 capability 动作均可经 `call` 调用。
