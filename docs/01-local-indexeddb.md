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
| `stashGroups` | `groupId` | `createdAt`, `name` | 收纳组 |
| `stashEntries` | `entryId` | `groupId`, `pageId`, `createdAt` | 组内条目，指向 `pages` |
| `settings` | `key` | — | 配置项（保留 `chrome.storage.local` 写入以兼容现有逻辑） |
| `activityStats` | `key` | — | 活动统计（保留 `chrome.storage.local` 写入以兼容现有逻辑） |
| `deviceEvents` | `eventId` | `deviceId`, `sequence` | 本地操作事件（阶段二复用） |

> 注：根据 `00-overview.md` 的 ADR-3，`bb_auto_backups` 的去留延后评审，阶段一暂不迁入新模型。

### 2.2 迁移管理器（幂等、可恢复）

在现有 `migration.js` 的 v0→v4 基础上扩展 `CURRENT_SCHEMA_VERSION`：

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
- **M2（全量）**：迁移 `settings` / 链接规则 / 活动统计 / 备份，移除数组依赖。

## 5. 验收标准

- 现有 `critical-flows.test.js`、`rules-engine.test.js`、`stash-settings.test.js` 在阶段一完成后全绿（见 `04-testing-verification.md`）；
- 收纳 1 万条 URL 时，单组加载与搜索不再整数组加载；
- 迁移中断（强制退出）后重启可继续，不丢数据；
- 写入并发（SW + 选项页同时操作）不出现覆盖或死锁。
