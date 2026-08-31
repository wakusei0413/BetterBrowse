# 测试与运行验证基线

> 配套总览见 [00-overview.md](./00-overview.md)。本文件是阶段一实施的**前置条件（M0）**。

## 1. 当前问题

原始计划第 7 节自述："当前环境中 `deno` 命令不可用，现有测试基线尚未执行。" 这是一个硬性红旗——**在测试跑不起来的状态下改动 `StorageAdapter` 与仓储层，现有三套测试（`critical-flows`、`rules-engine`、`stash-settings`）将全部失效，回归风险极高。**

## 2. 必须先行的工作（M0）

1. 修复 Deno 运行环境，使 `deno task test` 可正常启动；
2. 确认现有测试基线**全部 PASS**（作为阶段一改动前的"地面真相"）；
3. 修复 `deno task verify`（静态规范、UTF-8、文件完整性）确保可重复执行；
4. 记录环境修复步骤到 `README.md`，避免后续环境再次丢失。

## 3. 阶段一迁移后的测试清单

- [x] `critical-flows.test.js`：核心收纳/恢复流程、URL 容错导入仍通过；
- [x] `rules-engine.test.js`：P0~P3 规则优先级不受影响（`chrome.storage.local` 配置路径仍可工作）；
- [x] `stash-settings.test.js`：设置读写兼容；
- [x] **新增**：IndexedDB 仓储 CRUD、去重、分页查询测试（`indexed-db-stash.test.js`）；
- [x] **新增**：迁移幂等测试（中断重启后无重复/丢失）；
- [x] **新增**：SW + 选项页并发写库无覆盖/死锁（模拟多入口）；
- [x] **新增（本地数据修订 7 / M2）**：配置/规则/备份/活跃度迁入 IndexedDB、失败停在修订 6、30 天清理、一键回退导回配置。
- [x] **新增（本地数据修订 8 / M3，2026-08-30）**：WebDAV 同步协议测试（`webdav-sync.test.js`）——ETag 能力探测与 412、批次上传幂等、清单条件写冲突、快照基线与 watermark 重放、字段级冲突双方保留、墓碑阻止复活、90 天设备退役、活跃度 pageId 合并、凭据不出现在快照/导出；
- [x] **新增（M3）**：双设备端到端（`webdav-two-device.test.js`）——两套独立本地库共用同一远端：新设备配对不清本机数据、双向传播（改名 / 新组）、删除传播、连错数据集报损坏而非静默切换。

## 4. 验证命令（沿用现有 Deno 指令集）

```bash
deno task test     # 全套自动化测试
deno task verify   # 静态规范 + UTF-8 + 文件完整性
deno task api-version-bump # 仅在跨组件 API 契约发生不兼容变化时执行
deno task bundle   # 内容脚本打包（存储改动不影响，但改动 content 时仍需）
```

## 5. 验收门槛

- 阶段一任何改动**合入前**，上述现有三套测试必须全绿；
- 新增的 IndexedDB/迁移/并发测试一并加入 `deno task test`，成为长期回归基线。
