# BetterBrowse 存储架构改革 — 总览与范围决策

> 本文档是存储架构改革的入口，其他分册见：
> - [01-local-indexeddb.md](./01-local-indexeddb.md) — 阶段一：本地 IndexedDB 主库与迁移（**已完成**）
> - [02-webdav-sync.md](./02-webdav-sync.md) — 阶段二：WebDAV 云端同步（**M3 已实施**）
> - [03-ai-skill-bridge.md](./03-ai-skill-bridge.md) — 阶段三：AI Skill 桥接（**已实施：Native Messaging 本机桥，人机能力对等**）
> - [04-testing-verification.md](./04-testing-verification.md) — 测试与运行验证基线

## 1. 背景

现有架构以 `chrome.storage.local` 保存完整数组为核心（`StorageAdapter` 为简单 key-value 门面，`LocalStashRepository` 每次"整读 → 改 → 整写"）。其问题：

- 配额有限（约 10MB），收纳组 + 自动备份无法规模化；
- 无索引、无分页，列表/搜索需整数组加载（阶段一主库已提供组内分页与检索；选项页时间线改走组摘要 `GET_STASH_GROUP_SUMMARIES` + `GET_STASH_GROUP_PAGE`，不再为渲染 join 全部 pages）；
- 并发仅靠单进程串行 Promise 队列，多入口（Service Worker + 选项页）下不稳固；
- 无法表达"页面实体 / 收纳记录"等需要关系查询的模型。

正确的演进方向是引入 IndexedDB 作为本地主库，并逐步引入可选的跨设备同步与 AI 管理能力。

## 2. 范围决策（关键取舍）

原始计划（见 git 历史中的 `storage-architecture-plan.md`）一次性提出了本地库、WebDAV 同步、AI Skill 三阶段。经评估，其技术选型专业、防坑点覆盖充分，但**规模与当前项目阶段严重失衡**。本分册确立如下范围：

| 阶段 | 内容 | 决策 | 理由 |
| --- | --- | --- | --- |
| 阶段一 | 本地 IndexedDB 主库 + 仓储 + 迁移 | **立即实施** | 纯收益、风险可控，解决真实痛点 |
| 阶段二 | WebDAV 跨设备同步 | **延后，需补齐协议设计后评审** | 工程量巨大，先验证真实需求 |
| 阶段三 | AI Skill 桥接 | **已实施（M4）：Native Messaging 本机桥 + 能力对等接口** | 放弃常驻 Python 服务与原始 TCP 端口；改为 Chrome 托管按需拉起宿主 + 回环令牌侧信道，安全面可控 |

### 2.1 仍坚持的硬约束（跨所有阶段通用）

这些约束在原始计划中判断正确，全部保留：

- 本地数据库采用 IndexedDB，作为所有业务模块的唯一入口；
- 没有云端时，以本地 IndexedDB 为中心，完整离线运行；
- WebDAV 保存不可变操作日志和周期快照，绝不直接上传数据库文件；
- 顺序以 `deviceId + sequence + operationId` 为依据，时间戳仅用于展示与辅助排序；
- 冲突采用字段级合并，同字段冲突不静默覆盖，写入冲突记录；
- 同一 URL 使用"页面实体 + 收纳记录"两层模型；
- 删除是全局删除，使用墓碑同步，墓碑在 30 天回收期内阻止离线旧副本复活；
- 凭据属于本地库管理范围，不进入同步对象、不暴露给 AI 接口；
- 内容脚本不得直接访问 `chrome.storage.local` 或 IndexedDB，必须由后台计算最小必要字段后通过消息返回（与现状一致）。

## 3. 实施顺序与里程碑

1. **M0（前置）**：修复 Deno 运行环境，使现有 `critical-flows / rules-engine / stash-settings` 测试基线全绿（详见 `04-testing-verification.md`）。
2. **M1（阶段一·垂直切片）**：仅迁移收纳组数据到 IndexedDB + 仓储接口，手工验证，不动配置/链接规则/活动统计。
3. **M2（阶段一·全量）**：迁移配置、链接规则、活动统计、备份，移除对 `chrome.storage.local` 数组的依赖。
4. **M3（阶段二）**：WebDAV 云端同步协议已冻结（见 `02-webdav-sync.md`，含 ADR-4）并于 2026-08-30 起实施。
5. **M4（阶段三）**：AI 桥接以 Native Messaging 方案实施（协议见 `03-ai-skill-bridge.md`），人类 UI 与 AI Agent 共享同一 action 处理映射，能力对等由 parity 测试强制。

## 4. 决策记录（ADR）

- **ADR-1（部分失效）**：阶段三曾默认延后，不进入 M1/M2 的工作范围；阶段二（M3）协议冻结后已启动实施。
- **ADR-2**：任何阶段一改动上线前，现有测试基线必须全绿（不允许在测试跑不起来的状态下改动 `StorageAdapter`/仓储层）。
- **ADR-3（M2 已决议）**：`bb_auto_backups` 迁入 IndexedDB `settings` 仓储，仍为受配额约束的本地快照数组；阶段二快照体系上线前不引入独立 `snapshots` 仓储（该限制已随 M3 兑现解除）。
- **ADR-4（M3 已决议，见 02 分册）**：远端废弃 generation 级可追加 `batch.jsonl`，改用每设备每批次唯一命名的不可变 ndjson；不建远端 `tombstones/`、`conflicts/` 目录。
- **ADR-5（M4 已决议，见 03 分册）**：AI 桥接放弃常驻 Python 服务与本地 HTTP 端口方案，改用 **Chrome Native Messaging 按需拉起宿主 + 127.0.0.1 令牌侧信道**；AI 与人类共享同一 action 处理映射（`action-handlers.js`），凭据只写不可读，不可逆操作强制确认位，能力对等由 `tests/ai-bridge.test.js` 的 parity 断言守护。
