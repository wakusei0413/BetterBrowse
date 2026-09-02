---
name: better-browse
description: 操控 BetterBrowse Chrome 扩展（智能标签页收纳箱插件）——查询/增删改收纳组与条目、修改插件配置与域名跳转规则、执行智能收纳、管理备份与 WebDAV 同步。当用户要求操作"收纳箱/收纳组/标签页归档/BetterBrowse 插件设置/同步"时使用；Agent 能力与人类 UI 完全对等。不适用于与 BetterBrowse 无关的一般浏览器自动化。
---

# BetterBrowse AI 桥接

通过本机桥接通道，以与人类用户**完全相同的能力**操控 BetterBrowse 扩展：同一套 action 处理路径、同样的权限边界（凭据只写不可读、不可逆操作需显式确认）。

## 快速开始

客户端脚本位于本技能目录 `scripts/bb-bridge-client.js`（纯 Deno 标准库）：

```bash
CLIENT="<技能目录>/scripts/bb-bridge-client.js"

# 1. 连通性检查（返回扩展状态与统一 API 版本）
deno run -A "$CLIENT" status

# 2. 获取能力清单（自描述：全部动作、参数契约、确认位要求；以插件实际返回为准）
deno run -A "$CLIENT" capabilities

# 3. 调用任意动作
deno run -A "$CLIENT" stash-list
deno run -A "$CLIENT" call UPDATE_CONFIG '{"tabThreshold": 20}'
```

退出码 0=成功、1=失败；输出统一为 JSON 信封 `{"success":true,"data":...}` / `{"success":false,"error":"..."}`。

常用命令速查（完整清单见 `help`）：`stash-list` `stash-search` `group-show` `stash-add` `group-rename` `group-delete` `item-update` `config-get` `config-set` `rule-set` `sync-now` `backups` `backup-export`。超长请求可通过 `BB_BRIDGE_TIMEOUT_MS` 调整等待（默认 120 秒）。

大数据读取约定：`stash-list` 走 `GET_STASH_GROUP_SUMMARIES_PAGE` 游标分页（客户端自动续页），`group-show` / `stash-search` 支持 `--limit`，`backup-export <文件>` 走 `READ_EXPORT_CHUNK` 边收边写。需要整组 tabs 的兼容场景才用 `call GET_STASH_GROUPS`。

## 硬性安全规则（必须遵守）

1. **不可逆操作必须带确认位**：`group-delete` / `backup-import` / `backup-restore` / `backup-delete` / `config-reset` 必须加 `--confirm`；经 `call` 直调 `DELETE_STASH_GROUP`、`CLEAR_ALL_STASH`、`RESTORE_FULL_BACKUP`、`DEDUPLICATE_STASH_DATA`、`RESET_CONFIG`、`RESTORE_AUTO_BACKUP`、`DELETE_AUTO_BACKUP` 时 payload 必须含 `"confirm": true`，否则插件直接拒绝。
2. **破坏性操作前先备份**：执行清空、恢复备份、去重前，先 `backup-export`（全量 JSON 落盘）。
3. **凭据只写不可读**：可以 `sync-credentials` 保存 WebDAV 凭据，但任何响应都不会包含密码；不要尝试读取。
4. **所有操作有审计**：每次调用写入插件选项页「运行日志」Tab，用户可见。不要执行用户没有要求的操作。
5. **写锁纪律**：请求由插件串行处理，无需客户端并发优化；不要并发轰炸。

## 首次安装（用户未装过宿主时）

1. 用户在插件选项页「AI 桥接」Tab 开启总开关并复制扩展 ID；
2. 在 BetterBrowse 仓库执行 `deno task ai-host-install --ext-id=<扩展ID>`；
3. 在 `chrome://extensions` 重载扩展；
4. `deno run -A "$CLIENT" status` 验证（预期 `state: "connected"`）。

若 `status` 报 `host_missing`，说明宿主未安装或扩展未重载；报找不到 bridge.json，说明扩展开关未开启或宿主进程未运行。

## CDP 回退方案（桥接不可用时）

桥接宿主未安装但需立即操作时，可经 Chrome DevTools 协议在扩展页面上下文直接调用消息总线（与 UI 完全同一套处理路径）：

1. Chrome 以 `--remote-debugging-port=9222` 启动（或经 chrome-devtools 工具连接）；
2. 打开 `chrome-extension://<扩展ID>/src/options/options.html`；
3. 在该页面上下文执行 `chrome.runtime.sendMessage({ action: "EXECUTE_STASH", payload: { forceAll: true } })`——响应即 `{"success":...,"data":...}` 信封，与桥接通道一致。

注意：CDP 方式操作的是调试目标浏览器实例；扩展 ID 需从 `chrome://extensions` 详情页获取。正式使用仍建议安装宿主桥（数据直通用户日常浏览器）。

## 深入参考

- `references/protocol.md` — 线协议、bridge.json 位置、分块规则、错误语义与扩展指引。
- 仓库内 `docs/03-ai-skill-bridge.md` — 架构与安全模型冻结稿。
