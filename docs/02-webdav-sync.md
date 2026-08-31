# 阶段二：WebDAV 云端同步（M3 可执行协议）

> 配套总览见 [00-overview.md](./00-overview.md)。阶段一（本地 IndexedDB 主库）已完成。本文是 **M3 冻结协议**：远端布局、快照衔接、非原子恢复、字段合并与日志治理均已给出确定性规则，实现必须按本文执行。

## 1. 设计目标

- 跨设备双向同步持久状态；离线时以本地 IndexedDB 为唯一业务入口；
- 远端只保存**不可变操作批次**与**周期快照**，绝不上传数据库文件或把单个巨大 JSON 当共享库；
- 顺序以 `deviceId + sequence + operationId` 为准，时间戳仅用于展示与辅助排序；
- 字段级合并；同字段冲突不静默覆盖，写入本地冲突记录供用户裁决；
- 删除走墓碑 + 30 天回收站；连续 90 天未同步的设备自动退役（可手动提前）；
- WebDAV 凭据只保存在本地库，不进入同步对象、快照、导出 JSON 或 AI 接口；
- 服务器认证 / 写入失败时拒绝同步；缺失 ETag / 条件写入时进入**兼容模式**
  （清单更新强制「读取最新-合并-写入」），绝不盲目覆盖远端清单；
- 传输必须 HTTPS；本阶段不做业务数据端到端加密。

### 1.1 同步范围

| 同步 | 不同步 |
| --- | --- |
| 页面实体、收纳组、收纳条目 | WebDAV 凭据 |
| 用户配置、域名跳转规则 | `bb_auto_backups`、schema / optout / revision |
| 按 **pageId** 的活跃度 | Chrome `tabId` / `windowId` / 窗口布局 |
| `deviceEvents`（带 `originDeviceId`） | `chrome.storage.session` 倒计时运行时 |

浏览器账号（`chrome.storage.sync`）**不是** WebDAV 的替代通道，见第 9 节。它只镜像偏好，不同步上表中的收纳实体。

活跃度不得以 `tabId` 作为跨设备主键。运行时仍可用 `tabId → pageId` 投影给 `FrequencyRule`。

`deviceEvents` 全局可见，**只有 `originDeviceId` 等于本机**时才执行确认、取消或收纳；其它设备仅在「云端同步」页只读展示。

本地 JSON 备份恢复视为本机写入并进入 outbox，再同步；**不得**用云端快照覆盖这次恢复。本地自动快照只做本机灾难恢复，从不上传；与云端冲突时以操作日志为准。

## 2. 远端目录（ADR-4）

> **ADR-4**：废弃 generation 级可追加 `batch.jsonl`。追加同一文件无法与「不可变唯一命名 + ETag 幂等」共存。采用每设备、每批次唯一命名的 ndjson。

```
/BetterBrowse/
  manifest.json
  snapshots/<generation>.json
  operations/<deviceId>/<sequenceStart>-<sequenceEnd>-<batchId>.ndjson
  devices/<deviceId>.json
```

不建远端 `tombstones/`、`conflicts/`：墓碑写入操作日志并进入快照载荷；冲突只留在本地 `conflicts` 仓储，用户裁决后写成新操作再上传。

### 2.1 `manifest.json`

```js
{
  formatVersion: 1,
  datasetId,              // 首次初始化生成，防止串库
  generation,             // 正整数，当前快照世代
  snapshotId,             // 对应 snapshots/<generation>.json
  snapshotSha256,
  snapshotWatermarks: { [deviceId]: maxSequence },
  previousSnapshotId,
  updatedAt,
  knownDevices: [{ deviceId, lastSeenAt, retired }],
  operationFiles: [{ deviceId, start, end, batchId, path, sha256 }],
  tombstoneWatermark
}
```

批次文件不可变、唯一命名；重复 PUT 视为幂等成功。清单更新必须携带当前 ETag 的 `If-Match`。

### 2.2 操作记录

```js
{
  operationId,            // 全局唯一，本机生成后永不改
  deviceId,
  sequence,               // 该设备严格递增
  lamport,                // max(已见 lamport) + 1
  entityType,             // page | stashGroup | stashEntry | settings | linkRules | activity | deviceEvent
  entityId,
  op,                     // upsert | patch | delete
  fields,
  fieldRevs: { [field]: { lamport, deviceId, operationId } },
  createdAt
}
```

## 3. 快照与日志衔接（原 3.1）

- 快照是某 generation 的**全量基线**（全部可同步实体 + 未过期墓碑），并写入 `snapshotWatermarks`。
- 应用快照后，**只重放** `(deviceId, sequence) > watermark[deviceId]` 的操作；禁止重放快照已覆盖的批次。
- 推进 generation：距上一次快照 ≥ 7 天，**或**未压缩操作 ≥ 200 条，且本机已完整 PUT 快照文件后再用 `If-Match` 更新清单。
- 快照损坏 / 缺失：校验 `snapshotSha256` 失败则回退 `previousSnapshotId`；再失败则状态为「数据损坏」，**不**从零重建，除非用户在界面点「危险：从零重建」。
- 新设备 / 退役回归：应用最新快照 → 重放 watermark 之后的操作 → 本机多出来的实体作为新 outbox 操作上传（配对合并）。`deviceId` 保持不变，`sequence` 从 `max(本地, watermark) + 1` 续写。

## 4. 云端非原子更新（原 3.2）

上传顺序固定：

1. PUT 不可变批次（不需要 If-Match；200 / 201 / 204 / 409 均视为成功）；
2. PUT 快照文件（文件名含 generation，写完后本地记录 sha256）；
3. `If-Match` PUT `manifest.json`（必须带 `snapshotSha256` 与 `operationFiles`）；
4. PUT `devices/<deviceId>.json` 确认本机已应用序列。

**清单更新统一走「读取最新 → 合并 → 条件写入 → 412 重试」通道**：写入前必须重新 GET
`manifest.json`，在**最新**远端内容上合并变更，禁止基于运行开始时的缓存清单直接覆盖
（否则会吞掉批次上传期间其他设备的并发写入）。412 时整循环重试（默认 3 次）。

中断语义：

- 步骤 1–2 完成而 3 未完成：远端留下孤儿文件，清单仍指向旧 generation，**安全**；下次由上传方按本地 outbox / 快照缓存补传。
- 清单已更新但文件缺失：检测为「数据损坏」。若本机是上传方则重传该文件；否则停止应用并展示错误，**绝不**推进本地 generation。

### 兼容模式（不支持条件写入的服务器）

能力探测仅拒绝认证失败与写入失败；对"能读能写但不支持条件写入"的服务器
（如 123 云盘 WebDAV：返回 ETag 但忽略 `If-Match`，或完全不返回 ETag），进入**兼容模式**：

- 清单更新仍强制「读取最新 → 合并 → 写入」，只是不再携带条件头；
- 并发保护弱于 ETag 模式：两台设备在极小窗口内同时写清单时可能丢失后写方条目
  （批次文件本身不可变且唯一命名，不会损坏，重新同步即可补上）；
- 测试连接提示「兼容模式」及原因，状态栏持续展示兼容说明；
- **严禁**进一步降级为"盲目覆盖远端清单"（既不读取也不合并）。

## 5. 字段级合并（原 3.3）

- 顺序主键：`deviceId + sequence + operationId`；`lamport = max(已见) + 1`；墙钟只用于展示。
- 新实体（不同 id）并存。
- 不同字段独立按 `fieldRevs` 合并。
- 同字段：`incoming.lamport > local` 则采纳；`incoming.lamport < local` 则忽略；**lamport 相等且 deviceId 不同** → 写入 `conflicts`，双方候选都保留。暂定展示值用 `(lamport, deviceId)` 字典序，保证多机暂定视图一致。
- 「设置类采用云端值」的确定性含义：两机都离线改设置时，**先成功 `If-Match` 写入清单的那一侧**是已上云值，作为暂定值；后拉取的一侧生成冲突记录，丢弃值与来源一并保存，用户可在冲突列表改判。不是「后拉的叫云端」。
- 删除 = `op: 'delete'` + 本地墓碑，`expiresAt = now + 30d`；回收期内拒绝复活同 id。
- 活跃度按 `pageId`：`lastActivated` 取 max，时间戳取并集后再按 `frequencyHistoryMinutes` 裁窗。
- `deviceEvent` 视为不可变新实体，不做字段冲突。

## 6. 日志治理（原 3.4）

- 软上限约 50MB 时警告；约 100MB 时拒绝再传新快照，直到压缩成功。
- 压缩条件：新快照已进清单，**且**所有未退役设备的确认序列 ≥ 该快照 watermark，**且**快照内墓碑均已过 30 天回收期 → 删除被 watermark 覆盖的 `operations/` 文件。
- 连续 90 天未同步 → 自动退役（可手动提前）。退役后不再阻塞压缩。
- 退役回归：丢弃已压缩的旧日志；从最新快照重新配对。

## 7. 触发、状态与隐私

触发：本地变更防抖 3 秒上传；启动 / 网络恢复 / 每 15 分钟定时拉取；选项页「立即同步」。

状态枚举：已同步 / 离线待上传 / 认证失败 / 服务器能力不足 / 条件写入冲突 / 数据损坏 / 未知错误。

UI 必须显式提示：**「URL 列表将上传到你的 WebDAV」**。凭据、连接测试、ETag 探测、冲突裁决、设备退役放在独立「云端同步」标签页。

## 8. 本地数据修订 8

- 本地数据架构修订 `LOCAL_DATA_SCHEMA_REVISION = 8`；IndexedDB 结构修订 `INDEXED_DB_SCHEMA_REVISION = 10`。这两个数字只描述内部持久化兼容边界，不是统一 API 版本。
- 新增仓储：`syncMeta`、`outbox`、`operationLogs`、`tombstones`、`conflicts`、`snapshots`（兑现 ADR-3：阶段二才引入独立快照仓储）。
- 已有 `deviceEvents` 开始写入。
- 可同步实体补 `updatedAt`、`revision`、`originDeviceId`、`fieldRevs`。
- 凭据键 `bb_webdav_credentials` 仅存 IndexedDB `settings`，列入导出 / 快照 / outbox **排除表**。
- 迁移失败不推进本地数据修订；迁移保持幂等可重入。

## 9. 浏览器账号偏好同步（非 WebDAV）

这是同品牌、已登录浏览器账号设备之间的**偏好快路径**，不替代收纳列表同步。

| 写入 `chrome.storage.sync`（键 `bb_account_config`） | 不写入 |
| --- | --- |
| 阈值 / 倒计时 / 冷却等标量 | 收纳组、页面、条目、活跃度、设备事件 |
| `rulesEnabled` / `globalLinkRule` / `stashSettings` / `tieredStash` / `autoBackupLimits` | `bb_link_rules` 域名跳转表 |
| `webdavSync.enabled` / `autoSync` / `serverUrl` | 用户名、密码、`bb_webdav_credentials` |
| `accountConfigSync.enabled` | `fieldRevs`、自动备份、schema / 写锁标记 |

约束：

- 权威数据仍是 IndexedDB。账号通道失败不影响本机读写。
- 单键序列化超过 **8000** 字节则跳过写入（Chrome `QUOTA_BYTES_PER_ITEM` 为 8192）。
- `chrome.storage.sync` 缺失时直接跳过，**禁止**回退到 `chrome.storage.local`。
- 账号通道整份快照 + `updatedAt`，最后写入获胜。WebDAV 仍做字段级合并；两边都开时，WebDAV 修复合并后把结果重新镜像到账号通道。
- Chrome 与 Edge 账号互不相通：跨浏览器仍只靠 WebDAV。
- 内容脚本不得读取 `chrome.storage.sync`。
