# BetterBrowse 存储架构改革计划

## 1. 目标与已确定决策

BetterBrowse 将从“以 `chrome.storage.local` 保存完整数组”为核心，升级为“本地数据库统一管理、可选 WebDAV 云端中心同步、Skill 通过本机 Python 服务接入”的架构。

已确定的产品决策：

- 本地数据库采用 IndexedDB，作为所有业务模块的唯一入口。
- 没有 WebDAV 时，以本地 IndexedDB 为中心，完整离线运行。
- 配置 WebDAV 后，本地数据库自动上传、拉取和合并；WebDAV 是跨设备共享历史的中心，但业务模块仍只访问本地数据库。
- WebDAV 保存不可变操作日志和周期快照，不直接把 SQLite 文件或单个巨大 JSON 当作数据库文件。
- 每批操作使用唯一命名文件写入云端，并通过清单和 ETag/条件写入避免并发覆盖。
- 操作顺序使用 `deviceId + sequence + operationId`；时间戳只用于展示和辅助排序，不能作为唯一顺序依据。
- 冲突采用字段级合并；同一字段冲突不静默覆盖，写入冲突记录。
- 同一个 URL 使用“页面实体 + 收纳记录”两层模型；页面标签和收纳记录标签都保留。
- 删除是全局删除，使用墓碑同步，并进入 30 天回收站。
- 快照压缩前要求已知设备确认；连续 90 天未同步的设备自动退役，用户可以手动提前退役。
- AI 允许完全管理，但批量写入必须原子提交；保留操作日志，暂不要求自动撤销。
- AI Skill 由用户额外安装一次，调用系统 Python；不使用 MCP。
- 三个平台都要支持，首版 Python 依赖系统环境，不打包 Python 运行时。
- Skill 启动本机 Python 服务；扩展通过仅监听 `127.0.0.1` 的随机端口和高强度令牌与其通信。
- WebDAV 连接凭据属于本地数据库管理范围，但不上传到 WebDAV、不进入共享操作日志、不暴露给 AI 查询接口。
- 同步除连接凭据外的全部持久状态，包括活动频次、倒计时等；设备运行事件全局可见，但由来源设备执行，不直接驱动其他设备的标签操作。
- 同步采用“变更防抖上传 + 启动/网络恢复/定时拉取 + 手动立即同步”。
- WebDAV 不满足 ETag 和条件写入能力时，拒绝启用自动同步，不降级为无条件覆盖。
- 交付分三阶段：本地 IndexedDB 与迁移；WebDAV 同步；三端 Skill 与本机桥接。

## 2. 本地 IndexedDB 主库

### 2.1 数据库与对象仓储

新增独立的 IndexedDB 数据库版本，不与现有 `CURRENT_SCHEMA_VERSION` 混用。对象仓储至少包括：

- `pages`：规范化 URL 对应的页面实体、标题、长期标签、AI 摘要和更新时间。
- `stashGroups`：收纳组属性、标题、锁定、星标、归档状态和更新时间。
- `stashEntries`：某次收纳记录，关联页面和收纳组，保存当时标题、上下文标签、收纳时间和来源设备。
- `settings`：用户设置和域名跳转规则等长期配置。
- `activityStats`：标签活跃频次与最近活动记录。
- `deviceEvents`：倒计时、阈值通知等跨设备可见但带来源设备的事件。
- `syncMeta`：`deviceId`、本地 sequence、远端 generation、ETag、最后同步时间、连接状态和设备确认状态。
- `outbox`：本地尚未上传的不可变操作批次。
- `operationLogs`：本地和 AI 操作审计记录。
- `tombstones`：全局删除墓碑和过期时间。
- `conflicts`：字段级冲突及其双方候选值。
- `snapshots`：本地快照元数据和恢复点。

所有可同步实体带 `id`、`createdAt`、`updatedAt`、`revision`、`originDeviceId`。URL 需要保存规范化值和稳定指纹；不能把 `tabId`、`windowId` 当作跨设备实体 ID。

### 2.2 事务与仓储边界

`StorageAdapter` 改为门面，不再让业务模块直接读写完整数组。新增按实体、分页和查询设计的仓储接口，例如：

```js
await PageRepository.findByUrl(url);
await StashGroupRepository.list({ offset, limit, query });
await StashEntryRepository.listByGroup(groupId);
await OperationRepository.appendBatch(batch);
await SyncRepository.getPendingOutbox();
```

创建、更新、删除、生成 outbox 和写入操作日志必须在同一个 IndexedDB 事务中完成。现有写入队列继续保留，避免多个 UI、后台事件和 AI 请求互相覆盖。

### 2.3 运行状态与共享状态

本地库可以保存全部持久状态，但跨设备应用必须区分逻辑数据和 Chrome 实例状态：

- 页面、收纳组、收纳记录、标签、设置、域名规则和活动统计可同步。
- 倒计时和阈值事件可同步为全局事件，但带 `originDeviceId`，只有来源设备执行确认、取消或收纳动作。
- 当前 Chrome `tabId`、`windowId`、当前窗口布局等不能直接作为跨设备命令目标。
- WebDAV 凭据只保存在本地库，不进入同步对象。

## 3. 从 `chrome.storage` 迁移

### 3.1 迁移流程

迁移必须幂等、可中断恢复且不破坏旧数据：

1. 读取旧的 `bb_user_config`、`bb_link_rules`、`bb_stash_groups`、`bb_auto_backups` 和活动状态。
2. 清洗并转换为 IndexedDB 实体、收纳记录、页面实体、操作日志和快照元数据。
3. 在一个或多个受控事务中写入 IndexedDB，并生成数据摘要。
4. 校验记录数、关键字段、URL 指纹和快照摘要。
5. 写入迁移完成标记和源版本号。
6. 迁移成功后旧 `chrome.storage.local` 数据只读保留 30 天。
7. IndexedDB 正常运行且至少生成一次有效快照后，才允许自动清理旧副本。

迁移失败必须继续使用旧存储作为降级路径，不能清空旧数据，也不能写入“已完成”标记。重复启动迁移不得生成重复页面、收纳记录或操作日志。

### 3.2 兼容边界

现有业务模块先通过兼容版 `StorageAdapter` 访问仓储；不要让 `LocalStashRepository`、链接规则服务、选项页和内容脚本各自实现迁移逻辑。旧导入/导出 JSON 继续支持，但导入后必须进入 IndexedDB，并生成正常的 outbox 操作。

内容脚本不得再直接读取 `chrome.storage.local`。链接规则由后台从本地数据库计算有效结果，通过消息返回最小必要字段。

## 4. WebDAV 云端中心同步

### 4.1 远端目录模型

建议目录结构：

```text
betterbrowse/
  manifest.json
  snapshots/<generation>.json
  operations/<deviceId>/<sequenceStart>-<sequenceEnd>-<batchId>.ndjson
  devices/<deviceId>.json
  conflicts/<conflictId>.json
```

每个操作批次文件不可变、唯一命名、可重复上传；清单只索引已知设备、快照基线、generation 和文件列表。任何清单更新都使用 ETag 和 `If-Match`。

远端状态至少包含：

```js
{
  formatVersion,
  datasetId,
  generation,
  snapshotId,
  updatedAt,
  knownDevices,
  operationFiles,
  tombstoneWatermark
}
```

### 4.2 同步流程

1. 从本地 outbox 生成不可变批次文件。
2. 上传批次文件；重复响应视为幂等成功。
3. 拉取远端清单和新批次。
4. 在本地事务中按 `operationId` 去重并应用操作。
5. 对字段级冲突生成 `conflicts` 记录，不静默丢弃任一方。
6. 使用 ETag 条件更新清单；失败时重新拉取、合并并重试。
7. 更新本地 `syncMeta` 和设备确认状态。
8. 按防抖、启动、网络恢复、定时和手动触发执行。

同步状态必须区分：已同步、离线待上传、认证失败、服务器能力不足、条件写入冲突、数据损坏和未知错误。

### 4.3 合并规则

- 新增的页面、收纳组、收纳记录和标签尽量并存。
- 同一实体的不同字段分别按操作版本合并。
- 同一字段的并发修改保留冲突记录；当前业务策略对设置类冲突可采用云端值，但必须保留被舍弃值和来源信息。
- 删除通过墓碑传播，30 天内阻止离线旧副本复活。
- 设备连续 90 天未同步后自动退役；退役设备回归时从最新快照重新配对。
- 生成新快照后，只有已确认设备都达到该基线，且墓碑已过回收期，才清理旧日志。

## 5. AI Skill 与本机 Python 服务

### 5.1 Skill 形态

用户安装一个 BetterBrowse Skill。Skill 内提供 Python CLI、诊断命令、协议版本和安装说明；Python 运行时依赖系统环境，必须检测最低版本、解释器路径和可用权限。

Skill 不直接打开 IndexedDB，也不直接修改 WebDAV 数据。所有读写都经过本机服务和扩展后台。

### 5.2 本机服务与 IPC

Skill 按需启动 Python 本机服务：

- 只监听 `127.0.0.1`。
- 使用随机端口和安装时生成的高强度令牌。
- 连接信息文件只保存在本机，并限制文件权限。
- 令牌不进入 WebDAV、同步日志、快照或 AI 返回结果。
- 扩展 Service Worker 通过明确的 localhost 权限和请求协议连接服务。
- 请求必须包含协议版本、请求 ID、操作类型和超时；禁止任意代码执行。

需要在三平台分别验证 Python 可用性、端口占用、服务崩溃恢复、权限文件和卸载清理行为。

### 5.3 AI 数据与操作协议

读取接口支持收纳组、页面实体、收纳记录、标签、规则、统计和冲突查询；敏感凭据、IPC 令牌和内部数据库实现细节不得返回。

写入接口采用声明式原子批次：

```js
{
  protocolVersion,
  requestId,
  operations: [
    { type: 'renameGroup', groupId, title },
    { type: 'addTag', pageId, tag },
    { type: 'moveEntry', entryId, groupId },
    { type: 'archiveGroup', groupId }
  ]
}
```

扩展必须先完整校验批次，再在一个 IndexedDB 事务中执行；任一项失败则全部回滚。每批写入 `operationLogs`，记录操作者、时间、目标、操作类型、输入摘要、结果和错误。

## 6. 三阶段交付

### 阶段一：IndexedDB 主库与迁移

- 建立数据库、对象仓储、事务边界和统一 `StorageAdapter`。
- 迁移现有配置、链接规则、收纳组、备份和活动统计。
- 改造选项页、后台、弹窗和内容脚本，移除直接读取 `chrome.storage.local` 的业务路径。
- 保留旧存储 30 天回滚窗口。

验收：旧数据完整迁移；重复启动不重复；收纳、恢复、搜索、规则跳转和导入导出行为不变；迁移失败可降级。

### 阶段二：WebDAV 同步

- 实现凭据本地保存、连接测试、ETag 能力校验、批次文件上传、清单更新、拉取、合并、冲突记录、墓碑、快照和设备退役。
- 加入自动触发、手动同步、离线 outbox 和状态展示。
- 用两个独立浏览器配置或测试设备验证并发变更、重复上传、删除传播和长期离线回归。

验收：任何条件写入冲突都不会静默覆盖；新增内容双方都保留；删除不会被离线副本复活；服务器能力不足时同步不会启用。

### 阶段三：三端 Skill 与 AI 管理

- 发布 Skill、Python CLI、本机服务和三平台安装/诊断脚本。
- 实现读取、原子批次写入、日志记录、错误分类和扩展连接恢复。
- 验证无 WebDAV 时本地 AI 仍可工作；配置 WebDAV 后 AI 仍只通过本地数据库入口工作。

验收：Skill 可以查询和整理本地数据；批次不会留下半完成状态；非法请求、错误令牌、越权字段和服务崩溃均被拒绝或明确报告。

## 7. 测试与运行验证

必须新增或补齐：

- IndexedDB CRUD、分页、索引、事务原子性和并发写入测试。
- 旧存储迁移、重复迁移、中途失败、校验不一致和回滚测试。
- WebDAV ETag、条件写入冲突、重复批次、离线 outbox、快照压缩、墓碑和设备退役测试。
- 页面实体与收纳记录、双层标签、同字段冲突和设置云端优先测试。
- AI 批次全成功/全回滚、协议校验、日志记录和权限边界测试。
- 三平台 Python 诊断、IPC 认证、端口占用、服务重启和权限测试。
- 浏览器实测 Service Worker 休眠、扩展重载、选项页刷新、内容脚本规则缓存和真实收纳恢复流程。

当前环境中 `deno` 命令不可用，现有测试基线尚未执行；实现阶段必须先恢复 Deno 运行环境，再运行 `deno task test`、`deno task verify` 和内容脚本一致性校验。

## 8. 明确不做的事情

- 不把 WebDAV 上的 SQLite 文件作为共享数据库文件。
- 不使用无条件覆盖远端清单的同步实现。
- 不把连接凭据上传到 WebDAV、日志、快照或 AI 接口。
- 不让内容脚本直接访问 IndexedDB 或 `chrome.storage.local`。
- 不把 Chrome 的 `tabId`、`windowId` 当作跨设备同步实体 ID。
- 第一阶段不引入 SQLite WASM、OPFS 或外部数据库服务。
- 当前不把业务数据端到端加密作为主改造目标；网络传输仍必须使用 HTTPS。
