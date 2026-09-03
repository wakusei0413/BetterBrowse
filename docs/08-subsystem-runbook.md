# AI 桥接与 WebDAV 子系统运维手册

这两套能力都有独立进程、协议和持久化边界。修改前先看本手册、`docs/02-webdav-sync.md`、`docs/03-ai-skill-bridge.md`，不要把它们当成普通 UI 开关。

## AI 桥接排障

1. **显示“宿主缺失”**：确认已执行 `deno task ai-host-install --ext-id=<扩展ID>`，检查 Native Messaging 注册项/清单路径。
2. **宿主秒退**：确认 `run-host.cmd` 只有 ASCII；中文说明只能放在 `bb_native_host.js`。查看宿主 stderr，Native host 的 stdout 只能是协议帧。
3. **安装后仍找不到 deno**：重启 Chrome；安装器应把 `Deno.execPath()` 绝对路径写入启动包装，不能依赖长驻 Chrome 的旧 PATH。
4. **连接但请求卡住**：检查 `bridge.json` 的端口、一次性令牌和 `apiVersion`；大响应要确认分块重组后仍回填 reqId。
5. **“Native host has exited”**：检查 stdin EOF 清理、宿主 stderr、90 秒 pong 看门狗和 120 秒在途超时；Service Worker 的 setTimeout 不能作为唯一保活依据。

## WebDAV 排障

1. **同步卡住**：先看运行日志和当前状态，再检查凭据、HTTPS 地址、能力探测与服务器写权限。
2. **报 412**：这是条件写入冲突，不是覆盖理由；必须重新读取最新清单、合并后再用最新 ETag 重试。
3. **兼容模式**：服务器缺少 ETag/If-Match 时应进入兼容模式，但仍使用不可变批次文件，不能拿启动时缓存清单覆盖远端。
4. **怀疑另一台设备数据被吞**：停止继续写入，保留远端文件，核对设备目录、generation、outbox 和快照；确认没有把 `tabId`/`windowId` 写入跨设备实体。
5. **凭据泄露检查**：`bb_webdav_credentials`、密码、自动备份不得出现在 outbox、快照、导出或 AI 响应中。

## 改动前检查清单

- 改线协议：同时更新扩展、Native Host、桥接客户端和 `docs/03-ai-skill-bridge.md` / `skills/better-browse/references/protocol.md`。
- 改同步实体：先确认实体写入与 outbox/操作日志/时钟在同一事务；大批量仍按 500 条分批。
- 改写锁：`DeviceEventLog.append` 自持锁，不能在已持锁临界区调用；禁止嵌套 `withWriteLock`。
- 改账号镜像：`chrome.storage.sync` 只允许 `bb_account_config`，缺失时跳过，不回退 local。
- 改 Service Worker 超时：必须考虑闹钟或看门狗兜底，不能只加 `setTimeout`。

## 核实附录（2026-09-03）

| 约束 | 代码核实结论 |
|---|---|
| 宿主扫描全部启动参数 | ✅ `native-host/bb_native_host.js` 扫描 argv 查找扩展来源 |
| stdout 仅协议、日志走 stderr | ✅ 宿主日志使用 stderr |
| 25 秒 ping、90 秒 pong 看门狗、120 秒请求超时 | ✅ 宿主与扩展侧均有对应保护；Service Worker 另有闹钟兜底 |
| stdin EOF 关闭 TCP 监听器 | ✅ 宿主退出清理路径包含监听器关闭 |
| 分块重组回填 reqId | ✅ 宿主与 `bb-bridge-client.js` 均回填 |
| 安装器烘焙 Deno 绝对路径 | ✅ `install.js` 使用 `Deno.execPath()` |
| 启动包装纯 ASCII | ✅ `run-host.cmd` / `run-host.sh` 未放中文注释 |
| outbox 与实体同事务 | ✅ `SyncOutbox.enqueueInTx` 由同步事务调用 |
| `DeviceEventLog.append` 自持锁 | ✅ 调用方必须在锁外调用 |
| 凭据、自动备份排除同步载荷 | ✅ 排除表覆盖凭据与自动备份 |
| 跨设备实体不含 tabId/windowId | ✅ 同步实体身份使用 pageId/groupId/entryId/eventId |
| 清单更新读最新、合并、条件写入、412 重试 | ✅ 统一经 `SyncEngine._updateManifest` |
| sync 缺失时不回退 local | ✅ `account-config-sync.js` 直接跳过 |
