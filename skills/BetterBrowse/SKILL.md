---
name: BetterBrowse
description: 操控 BetterBrowse Chrome 扩展（智能标签页收纳箱插件）——查询/增删改收纳组与条目、修改插件配置与域名跳转规则、执行智能收纳、管理备份与 WebDAV 同步。当用户要求操作“收纳箱/收纳组/标签页归档/BetterBrowse 插件设置/同步”时使用；Agent 能力与人类 UI 完全对等。不适用于与 BetterBrowse 无关的一般浏览器自动化。
---

# BetterBrowse AI 桥接

通过本机桥接通道，以与人类用户**完全相同的能力**操控 BetterBrowse 扩展：同一套 action 处理路径、同样的权限边界（凭据只写不可读、不可逆操作需显式确认）。

## 先按用户意图选择操作

1. **先诊断是否可用**：首次使用、连接异常或用户提到宿主问题时，先运行 `doctor`。
2. **只读查询**：查看状态、能力、收纳组、配置、规则或同步状态时，优先使用对应便利命令。
3. **单次修改**：用户明确要求写入时，使用便利命令；便利命令未覆盖再使用 `call`。
4. **大段 JSON 或文本**：不要把长内容直接塞进 shell 参数，使用 `--file` 或 `--stdin`。
5. **多步操作**：使用 `batch --file` 在一个连接中按顺序执行；任一步失败即停止。
6. **破坏性操作**：先导出备份，再执行带 `--confirm` 的操作；不得替用户推断确认意图。

## 快速开始

唯一客户端位于本技能目录 `scripts/betterbrowse_client.py`，需要 **Python 3.9 或更高版本**，仅使用 Python 标准库：

```bash
CLIENT="<技能目录>/scripts/betterbrowse_client.py"

# 1. 首先诊断 Python、bridge.json、宿主端口、握手和 API 版本
python "$CLIENT" doctor

# 2. 查看连接状态或运行时能力清单
python "$CLIENT" status
python "$CLIENT" capabilities

# 3. 只读查询与单次修改
python "$CLIENT" stash-list
python "$CLIENT" config-get
python "$CLIENT" config-set '{"tabThreshold":20}'
```

Windows 若 `python` 未指向 Python 3.9+，可使用 `py -3`；仓库测试与静态门禁可通过 `PYTHON` 环境变量指定解释器路径。退出码 0 表示成功，1 表示传输失败或业务失败；输出统一为 JSON 信封 `{"success":true,"data":...}` / `{"success":false,"code":"...","error":"..."}`。

常用命令速查（完整清单运行 `python "$CLIENT" help`）：`doctor` `status` `capabilities` `stash-list` `stash-search` `group-show` `stash-add` `group-rename` `group-delete` `item-update` `config-get` `config-set` `rule-set` `sync-status` `sync-now` `backups` `backup-export`。超长请求可通过 `BB_BRIDGE_TIMEOUT_MS` 调整等待时间（默认 120 秒）。

## 文件、标准输入与批处理

`call`、导入、配置和凭据命令均可从 UTF-8 文件或标准输入读取内容；`--file` 与 `--stdin` 不能同时使用。

```bash
# 从文件读取任意 action 的 payload
python "$CLIENT" call UPDATE_CONFIG --file config-patch.json

# 从标准输入读取 JSON，避免 shell 引号问题
printf '%s' '{"tabThreshold":20}' | python "$CLIENT" config-set --stdin

# 导入大备份
python "$CLIENT" backup-import --file betterbrowse-backup.json --confirm

# 在同一会话中串行执行多条 action
python "$CLIENT" batch --file operations.json
```

`operations.json` 顶层必须是非空数组：

```json
[
  {"action":"GET_CONFIG","payload":null},
  {"action":"GET_DOMAIN_RULES","payload":null}
]
```

大数据读取约定：`stash-list` 走 `GET_STASH_GROUP_SUMMARIES_PAGE` 游标分页并自动续页；`group-show` / `stash-search` 支持 `--limit`；`backup-export --output <文件>` 走 `READ_EXPORT_CHUNK` 边收边写。只有确实需要完整组和全部条目时才使用 `call GET_STASH_GROUPS`。

## 硬性安全规则（必须遵守）

1. **不可逆操作必须带确认位**：`group-delete` / `backup-import` / `backup-restore` / `backup-delete` / `config-reset` 必须加 `--confirm`；经 `call` 直调 `DELETE_STASH_GROUP`、`CLEAR_ALL_STASH`、`RESTORE_FULL_BACKUP`、`DEDUPLICATE_STASH_DATA`、`RESET_CONFIG`、`RESTORE_AUTO_BACKUP`、`DELETE_AUTO_BACKUP`、`RESTORE_STASH_GROUP_DATA`、`CLEAR_RUNTIME_LOGS`、`REBUILD_SYNC_FROM_SCRATCH` 时 payload 必须含 `"confirm": true`。运行时以 `capabilities` 返回的 `confirmRequired` 为唯一事实源，缺少确认位时插件会直接拒绝。
2. **破坏性操作前先备份**：执行清空、恢复备份、去重前，先运行 `python "$CLIENT" backup-export --output <文件>`。
3. **凭据只写不可读**：可以用 `sync-credentials` 保存 WebDAV 凭据，但任何响应都不会包含密码；不要尝试读取。
4. **所有操作有审计**：每次调用写入插件选项页「运行日志」Tab，用户可见。不要执行用户没有要求的操作。
5. **写锁纪律**：请求由插件串行处理，无需客户端并发优化；不要并发轰炸。

## 首次安装

1. 确认本机有 Python 3.9+；
2. 用户在插件选项页「AI 桥接」Tab 开启总开关并复制扩展 ID；
3. 在 BetterBrowse 仓库执行 `deno task ai-host-install --ext-id=<扩展ID>`；
4. 在 `chrome://extensions` 重载扩展；
5. 运行 `python "$CLIENT" doctor`，再运行 `python "$CLIENT" status`，预期状态为 `connected`。

若 `doctor` 报 `BRIDGE_FILE_NOT_FOUND`，通常是扩展开关未开启或宿主未运行；若状态为 `host_missing`，重新安装宿主并重载扩展；若报告 API 版本不兼容，按错误中的本地与对端编号排查，不要在客户端硬编码版本。

## 只读 CDP 回退

桥接不可用但只需紧急读取状态时，可在 Chrome DevTools 协议连接到**扩展页面上下文**，调用只读 action：

1. Chrome 以 `--remote-debugging-port=9222` 启动（或经 chrome-devtools 工具连接）；
2. 打开 `chrome-extension://<扩展ID>/src/options/options.html`；
3. 在该页面上下文执行：

```javascript
await chrome.runtime.sendMessage({
  action: 'GET_AI_BRIDGE_STATUS',
  payload: null
});
```

也可只读调用 `GET_CONFIG`、`GET_STASH_GROUP_SUMMARIES_PAGE` 等查询动作。**CDP 回退仅用于读取和诊断，不得执行修改、删除、恢复、同步或收纳动作。**它操作的是调试目标浏览器实例；正式写操作仍应恢复本机桥接后通过 Python 客户端执行。

## 深入参考

- `references/protocol.md` — 线协议、bridge.json 位置、分块规则、错误语义与扩展指引。
- 仓库内 `docs/03-ai-skill-bridge.md` — 架构与安全模型冻结稿。
