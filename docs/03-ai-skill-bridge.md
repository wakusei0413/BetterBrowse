# 阶段三：AI Skill 桥接（Native Messaging 本机桥）

> 配套总览见 [00-overview.md](./00-overview.md)。本阶段目标：**让 AI Agent 拥有与人类用户完全对等的插件操控能力**——人类经弹窗、选项页、右键菜单能做的每一个操作，Agent 都能等价调用；并额外提供少量增强读写（条目增改、检索分页、自动备份管理）。
>
> 本文档为协议与安全边界冻结稿，实现以本文件为准。

## 1. 设计原则

1. **代码级对等**：AI 请求与 UI 消息走**同一条处理路径**（共享同一张 action 处理映射表），新增人类功能自动对 AI 可用；并以自动 parity 测试强制"人类有的 AI 必有"。
2. **凭据红线**：WebDAV 凭据与人类权限一致——只写不读。任何 AI 可读响应中不得出现凭据字段（双保险：数据层本就不返回 + 桥接层出口复查）。
3. **确认位镜像 UI 确认弹窗**：不可逆操作必须携带 `confirm: true`，否则明确拒绝。
4. **非常驻**：本机宿主由 Chrome 经 Native Messaging **按需拉起**，Chrome 关闭即退出；不存在用户需要管理的常驻服务。
5. **默认关闭**：桥接总开关默认关闭，用户在选项页显式开启一次。

## 2. 总体架构

```
[AI Agent 终端（ZCode / Codex / 任意可执行命令的 Agent）]
  │  deno run bb-bridge-client.js <命令>            skills/better-browse/scripts/
  ▼
[本机宿主 native-host/bb_native_host.js]           ← Chrome 经 Native Messaging 按需拉起
  │  ① stdio：4 字节小端长度前缀 + UTF-8 JSON（Chrome Native Messaging 协议）
  │  ② TCP 侧信道：127.0.0.1 随机回环端口 + 一次性 32 字节令牌
  │  ③ 自发现文件：bridge.json（端口/令牌/进程号，随宿主进程生灭）
  ▼
[扩展 Service Worker：AIBridgeManager (src/background/ai-bridge.js)]
  │  握手 → 尺寸/频率限制 → 确认位校验 → 凭据出口复查 → 审计 → 路由
  ▼
[共享 action 处理映射 createActionHandlers(deps) (src/background/action-handlers.js)]
  │  与 MessageBus（人类 UI）完全同一套 handler，含 NOTIFY 广播与角标刷新收尾
  ▼
[现有服务层：LocalStashRepository / StashService / StorageAdapter / LinkService / SyncEngine …]
```

### 2.1 信任链与威胁模型

| 威胁 | 防线 |
| --- | --- |
| 其他扩展/网页发起指令 | 无 `externally_connectable`、无 `onMessageExternal`；唯一入口是扩展自己拉起的 Native Messaging 通道 |
| 未注册宿主冒充 | 宿主 manifest `allowed_origins` 锁定扩展 ID；宿主脚本校验 Chrome 注入的 `--origin` 启动参数 |
| 本机其他用户 | 侧信道仅绑定 127.0.0.1；令牌文件写入当前用户私有目录 |
| 本机同用户恶意进程 | **不在防御范围**（同用户进程本就拥有用户的全部数据权限），与人类权限一致 |
| AI 越权读凭据 | 凭据永不进入响应（见 §5.2）；桥接层出口复查兜底 |
| AI 误操作不可逆破坏 | 确认位强制（§5.1）+ Skill 指引"破坏性操作前先全量导出备份" |
| AI 操作不透明 | 每次调用写审计日志，选项页「AI 桥接」Tab 可见最近 100 条 |

## 3. 线协议（冻结稿）

### 3.1 双层传输

- **扩展 ↔ 宿主**：Chrome Native Messaging，stdio 4 字节小端长度前缀帧 + UTF-8 JSON。宿主→扩展单帧上限 1MB（Chrome 限制），扩展→宿主单帧上限 4MB（自限）。
- **Agent ↔ 宿主**：TCP 连接 `127.0.0.1:<port>`，NDJSON（每行一个 JSON）。

### 3.2 统一分块信封

任一方向、任一传输层上，逻辑消息超过 **200000 字符**时自动分块，信封统一为：

```json
{"apiVersion":1, "id":"<消息id>", "chunk":{"i":0,"n":3}, "part":"<完整 JSON 的字符串片段>"}
```

接收方按 `id` 拼齐 `part` 后 `JSON.parse` 得到完整消息。分块对上层透明。

- 客户端 → 宿主：切分的是完整请求信封 `{id, action, payload}`，重组后直接得到可路由的请求；
- 宿主 → 扩展：切分的是 `{reqId, action, payload}` 或响应对象；
- 未超过阈值的消息保持原形状（请求 `{id, action, payload}` / Native Messaging 帧），**没有**额外包装。接收端仅为兼容旧组件读取历史 `v` 字段。

> ⚠️ **实现红线（本机宿主与客户端两侧均适用）**：分块帧的信封 `id` 承载业务消息的 `reqId`，
> 而重组还原出的正文本身**不含** `reqId`/`id`——重组完成后必须把信封 `id` 回填进正文对象，
> 否则响应无法匹配在途请求而被静默丢弃，串行转发器随之永久卡死。

### 3.3 TCP 侧信道会话流程

1. Agent 读取自发现文件 `bridge.json`：`{"port":52341,"token":"<64hex>","pid":1234,"extensionId":"<32位id>","apiVersion":1,"startedAt":...}`。
   - Windows 路径：`%LOCALAPPDATA%\BetterBrowse\bridge.json`
   - macOS/Linux 路径：`$XDG_STATE_HOME/better-browse/bridge.json`（缺省 `~/.local/state/better-browse/bridge.json`）
2. Agent 连接 TCP 后首行发送握手：`{"apiVersion":1,"token":"<token>"}`。
3. 宿主校验令牌与 API 编号，成功回 `{"apiVersion":1,"ok":true,"extensionId":"...","host":"com.betterbrowse.bridge"}`；编号不一致时返回本地和对端值并断开。接收端仅为兼容旧组件读取历史 `proto` 字段。
4. 之后每行一条请求：`{"id":"<uuid>","action":"<ActionType>","payload":{...}}`；
   每行一条响应：`{"id":"<uuid>","success":true,"data":...}` 或 `{"id":"<uuid>","success":false,"error":"<中文错误>"}`。
5. 宿主同时只服务一个 Agent 连接（排队语义），请求**串行**转发扩展，避免写锁竞争。

### 3.4 内部控制消息（不走 action 管道）

- 宿主维护定时器（25s）负责在途请求超时与队列自身健康检查；**只有存在在途请求时才向扩展发 `{"internal":"ping"}`**，扩展回 `{"internal":"pong"}`。空闲时不再周期唤醒 MV3 Service Worker。
- 扩展连接成功即发 `{"internal":"hello","apiVersion":1}`，宿主校验后回 `{"internal":"ready","apiVersion":1,"compatible":true}`。

## 4. 生命周期

| 场景 | 行为 |
| --- | --- |
| 开关开启 / SW 冷启动 / onStartup / onInstalled | `AIBridgeManager.init()` → `chrome.runtime.connectNative('com.betterbrowse.bridge')` |
| 宿主未安装 | `connectNative` 回调报错 → 状态置 `host_missing`，指数退避重试（5s→15s→60s→5min 封顶） |
| 宿主已连 | 仅在有在途请求时 ping；开放中的 Native Messaging 端口本身即延长 SW 生命周期，无需空闲心跳 |
| Chrome 退出 | stdio EOF → 宿主自行退出并删除 `bridge.json` |
| 开关关闭 | 主动断开 native 端口、宿主退出、`bridge.json` 清除；Agent 请求全部被拒 |

## 5. 安全与治理（扩展侧 AIBridgeManager）

### 5.1 确认位白名单（`payload.confirm !== true` 时拒绝）

`DELETE_STASH_GROUP`（force 删锁定组）、`CLEAR_ALL_STASH`、`RESTORE_FULL_BACKUP`、`DEDUPLICATE_STASH_DATA`、`RESET_CONFIG`、`RESTORE_AUTO_BACKUP`、`DELETE_AUTO_BACKUP`、`RESTORE_STASH_GROUP_DATA`、`CLEAR_RUNTIME_LOGS`、`REBUILD_SYNC_FROM_SCRATCH`。

### 5.2 凭据出口复查

响应序列化为字符串后复查：不得包含 `bb_webdav_credentials` 键名与 `password` 字段值；`GET_SYNC_STATUS` 本就只返回 `hasPassword` 布尔。`SAVE_WEBDAV_CREDENTIALS` 允许（与人一致：可写不可读）。

### 5.3 审计日志

每次 AI 调用写入统一本地运行日志（`context: ai-bridge`、`category: audit`），可在选项页「运行日志」Tab 查询；旧键 `bb_ai_audit_log` 仅用于一次性迁移后清空。运行日志不进入 outbox / 快照 / 导出。

### 5.4 限制

单请求 payload ≤ 8MB；请求串行处理；内部消息（ping/hello）不计审计。

## 6. 能力清单与对等映射

完整 action 清单见 `src/constants/action-types.js`；**运行时以 `GET_AI_CAPABILITIES` 响应为准**。响应同时返回软件发布版本 `softwareVersion` 与内部契约编号 `apiVersion`，两者独立；本地数据、IndexedDB、WebDAV、账号配置与备份仅在 `internalRevisions` 中作为诊断修订号返回。人类入口 ↔ action 对应关系：

| 人类入口 | ActionType（AI 同样可调） |
| --- | --- |
| 弹窗三段拉杆 / 域名规则页 | `SET_LINK_RULE` `GET_DOMAIN_RULES` `SET_DOMAIN_RULE` `REMOVE_DOMAIN_RULE` `CLEAR_DOMAIN_RULES` `GET/SET_GLOBAL_LINK_RULE` |
| 弹窗/收纳页「立即收纳」 | `EXECUTE_STASH`（`{forceAll:true}`）`EVALUATE_TABS` |
| 收纳箱 Tab 组操作 | `GET_STASH_GROUPS` `GET_STASH_GROUP_SUMMARIES` `UPDATE_STASH_GROUP` `RESTORE_STASH_GROUP` `RESTORE_STASH_ITEM` `RESTORE_STASH_GROUP_DATA` `DELETE_STASH_GROUP` `DELETE_STASH_ITEM` `CLEAR_ALL_STASH` `DEDUPLICATE_STASH_DATA` |
| 收纳箱搜索/分块浏览（AI 增强） | `SEARCH_STASH` `GET_STASH_GROUP_PAGE` `ADD_STASH_ITEM` `UPDATE_STASH_ITEM` |
| 备份 Tab 导入导出 | `EXPORT_FULL_BACKUP` `RESTORE_FULL_BACKUP` `IMPORT_THIRD_PARTY_DATA` `IMPORT_STASH_DATA` `EXPORT_STASH_DATA` `EXPORT_ONETAB_TEXT`（AI 增强：`LIST/RESTORE/DELETE_AUTO_BACKUP`） |
| 收纳设置 / 规则 Tab | `GET_CONFIG` `UPDATE_CONFIG` `RESET_CONFIG` `GET_TAB_ACTIVITY_STATS` |
| 弹窗/右键菜单 | `OPEN_PINNED_STASH_TAB` `OPEN_OPTIONS_PAGE` `GET_TAB_COUNT_INFO` `GET_COUNTDOWN_STATUS` `CANCEL_AUTO_STASH` `CONFIRM_AUTO_STASH` `OPEN_TAB_BACKGROUND` `OPEN_ONE_TAB` |
| WebDAV 同步 Tab | `GET_SYNC_STATUS` `SAVE_WEBDAV_CREDENTIALS` `TEST_WEBDAV_CONNECTION` `RUN_SYNC_NOW` `LIST_SYNC_CONFLICTS` `RESOLVE_SYNC_CONFLICT` `LIST_SYNC_DEVICES` `RETIRE_SYNC_DEVICE` `GET_SYNC_RECOVERY_INFO` `FALLBACK_PREVIOUS_SNAPSHOT` `REBUILD_SYNC_FROM_SCRATCH` |
| 桥自身与运行日志 | `GET_AI_CAPABILITIES` `GET_AI_BRIDGE_STATUS` `QUERY_RUNTIME_LOGS` `CLEAR_RUNTIME_LOGS` |

## 7. 交付物清单

| 层 | 路径 | 说明 |
| --- | --- | --- |
| 扩展 | `src/background/action-handlers.js` | 共享 handler 映射（自 service-worker 抽取） |
| 扩展 | `src/background/ai-bridge.js` | AIBridgeManager：通道生命周期 + 安全治理 |
| 扩展 | `src/core/ai/ai-capabilities.js` | 能力自描述常量 |
| 扩展 | 选项页「AI 桥接」与「运行日志」Tab | 软件版本 / API 版本 / 开关 / 状态 / 扩展 ID / 审计查询 |
| 宿主 | `native-host/bb_native_host.js` + `run-host.cmd|.sh` | Deno 宿主（纯标准库） |
| 宿主 | `native-host/install.js` / `uninstall.js` | 三平台注册（Windows 注册表 / macOS、Linux 目录）+ `deno task ai-host-install|uninstall` |
| Skill | `skills/better-browse/` | `SKILL.md` + `scripts/bb-bridge-client.js` + `references/protocol.md` |

## 8. 安装与配对（一次）

1. 选项页「AI 桥接」Tab 开启总开关，复制扩展 ID。
2. `deno task ai-host-install -- --ext-id=<扩展ID>`（Windows 写 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.betterbrowse.bridge`，可选 `--browser edge`；macOS/Linux 写对应 `NativeMessagingHosts` 目录）。
3. 重载扩展 → 状态变"宿主已连接"，`bridge.json` 出现 → Agent 即可 `bb-bridge-client.js status` 验证。

## 9. 测试与验收

- `tests/ai-bridge.test.js`：令牌/握手、确认位拒绝、凭据出口复查、尺寸限制、审计写入、**parity 断言**（人类 UI 使用的 action 全集 ⊆ 能力清单）。
- `tests/stash-item-ops.test.js`：条目增改的幂等、持锁、修订号广播、outbox 同事务。
- 端到端：安装宿主 → 启用 → Agent 列组/建组/改配置/触发同步 → 选项页经 `bb_stash_revision` 0 刷新呈现且审计可见；关闭开关后请求被拒。
- `deno task verify` 全绿（含 content-bundle 一致性与 UTF-8 校验）。
