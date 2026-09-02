# 阶段一：本地 IndexedDB 主库、仓储与迁移

> 配套总览见 [00-overview.md](./00-overview.md)。本阶段是当前**唯一建议立即实施**的部分。

## 1. 目标

- 用 IndexedDB 取代 `chrome.storage.local` 中存放的完整数组（收纳组、备份等）；
- 以对象仓储替代"整读 → 改 → 整写"模式，支持索引、分页、去重；
- 数据模型升级为"页面实体 + 收纳记录"两层，为后续同步（阶段二）打下语义基础；
- 迁移过程幂等、可中断恢复、失败可降级回旧存储。

## 2. 本地数据库设计

### 2.1 对象仓储（stores）

| 名称 | 主键 | 索引 | 用途 |
| --- | --- | --- | --- |
| `pages` | `pageId` (URL 指纹) | `url`, `domain`, `updatedAt` | 同一 URL 的页面实体（标题、最后访问、来源） |
| `stashGroups` | `groupId` | `createdAt`, `name`, `starRank_createdAt_groupId` | 收纳组；含派生字段 `itemCount` / `starRank` / `nextPosition`（仅本地查询用，不进入同步冲突字段） |
| `stashEntries` | `entryId` | `groupId`, `pageId`, `createdAt`, `groupId_position_entryId` | 组内条目，指向 `pages`；组内真分页走 `groupId + position + entryId` 复合索引游标 |
| `settings` | `key` | — | 本地数据修订 7 起承载用户配置、域名跳转规则与自动备份 |
| `activityStats` | `key` | — | 本地数据修订 7 起承载标签页活跃度快照 |
| `deviceEvents` | `eventId` | `deviceId`, `sequence` | 本地操作事件（阶段二复用） |

> **ADR-3 决议（M2 落地）**：`bb_auto_backups` 迁入 IndexedDB `settings` 仓储（仍为快照数组，受 `autoBackupLimits` 约束）。阶段二快照体系上线前不引入独立 `snapshots` 仓储；旧 `chrome.storage.local` 快照保留 30 天后清理。

### 2.2 迁移管理器（幂等、可恢复）

在现有 `migration.js` 的本地数据修订 0→4 基础上扩展 `LOCAL_DATA_SCHEMA_REVISION`：

- **可重入**：每次迁移块以 `if (currentVersion < N)` 包裹，且写入新版本号后提交；
- **失败降级**：任意一步抛错则回滚已写的新版本号、保留旧数据，下次启动重试；
- **30 天并行保留**：旧 `chrome.storage.local` 数据在迁移成功后保留 30 天再清理，期间可一键回退。

## 3. MV3 关键约束（必须处理）

原始计划未覆盖以下 MV3 坑，本阶段必须解决：

1. **Service Worker 休眠**：IndexedDB 连接不可长驻，需连接管理（每次操作 open，或用可惰性重建的连接池）；
2. **多入口并发**：Service Worker 与选项页都可能写库，需跨上下文的串行队列（不再依赖单进程 Promise 链）；
3. **启动就绪**：所有读库路径须 `await` 数据库打开完成，迁移逻辑随启动统一编排；
4. **大事务中断**：避免单次大事务被 SW 休眠打断，分批写入。

## 4. 实施切片（强烈建议）

- **M1（垂直切片）**：仅迁移 `stashGroups` + `stashEntries` + `pages`。保留旧 `chrome.storage.local` 路径作为回退，手工验证收纳/恢复流程。
- **M2（全量，本地数据修订 7）**：迁移 `settings` / 链接规则 / 活动统计 / 备份；内容脚本改为通过 `GET_PAGE_LINK_CONTEXT` 向后台索取最小必要字段，禁止直读存储。

## 5. 验收标准

- 现有 `critical-flows.test.js`、`rules-engine.test.js`、`stash-settings.test.js` 在阶段一完成后全绿（见 `04-testing-verification.md`）；
- 收纳 1 万条 URL 时，单组加载与搜索不再整数组加载。选项页首屏只读取 `GET_STASH_STATS`（总数）与 `GET_STASH_GROUP_SUMMARIES`（摘要，含派生 `itemCount`，不扫描条目仓储），超长组展开再按 `GET_STASH_GROUP_PAGE` 以数据库游标补页，搜索按 `SEARCH_STASH` 游标分页；组卡片与条目继续在主列内虚拟窗口化。
  - **口径区分**：DOM 虚拟窗口只见得着界面这层；存储层的真分页由 `stashEntries` 的 `groupId + position + entryId` 复合索引与 `stashGroups` 的派生字段保障，摘要读取不加载 `stashEntries` 全表，搜索不再 `pages.getAll()`。
- 迁移中断（强制退出）后重启可继续，不丢数据；
- 写入并发（SW + 选项页同时操作）不出现覆盖或死锁。

## 6. 真分页、派生字段与活跃度分记录（本地数据修订 9~10 / IndexedDB 修订 11）

摘要、组内分页与搜索此前存在"接口分页、实现整读"的偏差，本轮一并纠正：

- **索引**：`IndexedDB` 结构修订升至 11，新增 `stashGroups.starRank_createdAt_groupId` 与 `stashEntries.groupId_position_entryId`。已有对象仓储补索引必须在 `onupgradeneeded` 的 versionchange 事务中按 `indexNames` 判断后创建，不能只在新建仓储分支里 `createIndex`。
- **派生字段**：`stashGroups` 增加 `itemCount`（组内有效条目数）、`starRank`（星标排序键，布尔不能作为索引键）、`nextPosition`（追加时的下一个位置）。它们属于**本地查询缓存**：不写 field revisions、不参与 WebDAV 冲突字段，由本地写入、导入、删除、同步 merge、快照应用与迁移回填共同维护。
- **读取路径**：`listGroupSummariesPage` 只扫描组记录并按游标分页；`getGroupPage` 用复合索引游标只物化请求页，同时兼容旧 `offset`；`searchEntries` 用 `pages` 主键游标边扫边匹配，命中后再经 `pageId` 索引联查现存条目，不再 `pages.getAll()`，也避免孤儿页面占满 limit 导致漏结果。
- **迁移**：本地数据修订 8 → 9 由 `MigrationManager.backfillGroupDerivedFields()` 回填派生字段（持写锁、幂等、失败停在 8 并于下次启动重试）。
- **活跃度分记录（修订 10）**：`activityStats` 不再使用单一聚合键整对象重写；每个 `pageId` 一条记录。`TabActivityTracker` 只持久化本次激活的 page；`StorageAdapter.get/set(ACTIVITY_STATS)` 对外仍兼容聚合对象读写；快照线协议继续使用 `activityStats` 对象形状，应用时拆成 page 记录。
- **导出分块**：`READ_EXPORT_CHUNK` 按组/条目游标生成 JSON 或 OneTab 文本，不先构造完整 `stashGroups` 数组；选项页与 AI 客户端边收边写。

## 7. 本地数据修订 6 修复迁移（2026-08-29 补充）

`LOCAL_DATA_SCHEMA_REVISION = 6`：修复两类历史异常数据（见 `MigrationManager.repairIndexedEntries`）：

1. **双前缀重复条目**：历史恢复备份/撤销删除会把已含组前缀的 `tab.id` 再次拼接为
   `groupId::groupId::tab_item_x`，导致幂等 upsert 失效、恢复后组内标签翻倍。
   修复后 `importGroups` 恢复前剥离全部重复前缀；本地数据修订 6 迁移清理存量双前缀条目；
2. **孤儿条目**：历史版本创建组跨 3 个事务写入，中断会留下无组记录的收纳条目并永久污染
   去重判定。修复后 `createGroup` 改为单事务原子写入三层记录，去重判定联表校验组存在，
   本地数据修订 6 迁移清理存量孤儿条目。

## 7. 本地数据修订 7 全量迁移（2026-08-29 补充）

`LOCAL_DATA_SCHEMA_REVISION = 7`：阶段一 M2 将配置、链接规则、自动备份与活动统计迁入 IndexedDB。

- **settings 仓储**：`bb_user_config` / `bb_link_rules` / `bb_auto_backups`
- **activityStats 仓储**：`bb_activity_stats`
- **门控**：`StorageAdapter.get/set` 仅在 `schema ≥ 7` 且未 `bb_idb_optout` 时路由到 IndexedDB；读失败回退旧 chrome.storage 快照，写失败显式返回 false 不降级
- **幂等**：主库已有对应 key 则跳过拷贝，中断重跑不会用旧快照覆盖主库新写入
- **内容脚本**：不再直读 `chrome.storage.local`，通过 `GET_PAGE_LINK_CONTEXT` 向后台索取最小必要跳转上下文
- **30 天保留**：旧配置/规则/备份/活跃度快照与收纳数组同样保留 30 天后清理；一键回退会把主库配置一并导回 chrome.storage

## 8. 本地数据修订 8 同步元数据（2026-08-30 补充，阶段二 M3）

`LOCAL_DATA_SCHEMA_REVISION = 8`、`INDEXED_DB_SCHEMA_REVISION = 10`：为 WebDAV 云端同步与当前本地主库结构准备元数据。两者是独立技术修订，不是统一 API 版本。

- **新增仓储**：`syncMeta`（本机时钟：deviceId / sequence / lamport / datasetId）、`outbox`（未上传不可变操作，与实体写入同事务追加）、`operationLogs`（本地 + 远端操作留档）、`tombstones`（删除墓碑，30 天回收期内阻止旧副本复活）、`conflicts`（字段级冲突候选）、`snapshots`（快照元数据，兑现 ADR-3 解除）。
- **实体同步字段**：pages / stashGroups / stashEntries 回填 `updatedAt` / `revision` / `originDeviceId` / `fieldRevs`（仅补缺失，幂等）。
- **活跃度 pageId 化**：`bb_activity_stats` 由 `{ [tabId]: ... }` 转为 `{ [pageId]: { url, lastActivated, activationTimestamps } }`；无法映射 URL 的旧 tabId 记录直接丢弃（tabId 本就易失且禁止跨设备同步）。运行时仍以 `tabId → pageId` 投影供 `FrequencyRule` 评估，消费方接口不变。
- **outbox 同事务约束**：收纳/配置/规则/活跃度的写入路径在同一 IndexedDB 事务内追加 outbox 操作与 operationLog，实体与操作要么同时生效要么同时回滚；大组仍按 500 条分批。
- **凭据排除**：`bb_webdav_credentials` 只存 settings 仓储，被排除在 outbox、快照载荷与全量导出 JSON 之外；`bb_auto_backups` 同样不进入同步。
- **门控**：`SyncOutbox.isActive()` 仅在本地数据修订 `schema ≥ 8` 且未 `bb_idb_optout` 时记录操作；修订 5–7 的老数据路径与测试基线不受影响。
