# 测试与运行验证基线

> 最后核实日期：2026-09-03。配套总览见 [00-overview.md](./00-overview.md)。本文件记录当前可执行的验证基线。

## 1. 当前环境

- Deno `2.9.5` 可用，项目不依赖 Node.js/npm。
- 根目录执行 `deno task test`：当前 **144 个测试全部通过**。
- 扩展静态门禁包含 UTF-8、Manifest、内容脚本产物、动作契约与版本号护栏。

## 2. 测试清单

- `critical-flows.test.js`：核心收纳/恢复流程、URL 容错导入；
- `rules-engine.test.js`：P0~P3 规则优先级；
- `stash-settings.test.js`：设置读写兼容；
- `indexed-db-stash.test.js`：IndexedDB CRUD、去重、分页、迁移幂等与并发写库；
- `webdav-sync.test.js` / `webdav-two-device.test.js`：ETag、412、批次、快照、墓碑、设备退役与双设备传播；
- `ai-bridge.test.js`：AI 能力对等、确认位、凭据出口与审计；
- `action-contract.test.js`：动作映射、AI 文档、内容白名单、人类 UI 对等；
- 其余测试覆盖鉴权、日志、URL 判定、规则、阈值与 API 版本契约。

## 3. 常用验证命令

```bash
# 全套自动化测试
deno task test

# 静态规范、UTF-8、文件完整性、内容产物、动作与版本号护栏
deno task verify

# 指定测试文件或按名称过滤
deno test -A tests/indexed-db-stash.test.js
deno test -A tests/ --filter "WebDAV"

# 内容脚本重新打包与过期检查
deno task bundle
deno task bundle:check

# 仅在跨组件 API 契约发生不兼容变化时执行
deno task api-version-bump
```

> 上例中的 `bundle:check` 应使用 ASCII 命令 `deno task bundle:check`；若复制到终端，请勿把 `denо`（西里尔字母）当作命令。

## 4. 验收门槛

- 任何改动合入前，`deno task test` 与 `deno task verify` 必须全绿；
- 修改 `src/content/` 或其依赖的常量后，必须执行 `deno task bundle`，再刷新 Chrome 扩展；
- 测试全绿不等于真实 Chrome、Service Worker 休眠、Native Messaging 宿主和真实 WebDAV 服务器已验收，发布前仍需按对应运行手册做浏览器级检查。
