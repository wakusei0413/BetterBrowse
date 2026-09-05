# 测试与运行验证基线

> 配套总览见 [00-overview.md](./00-overview.md)。本文件记录当前可执行的验证基线；具体测试数量以当次命令输出为准。

## 1. 当前环境

- 扩展开发与主测试套件需要 Deno 2.x，项目不依赖 Node.js/npm。
- BetterBrowse Skill 唯一客户端需要 Python 3.9+，仅使用标准库。
- 根目录执行 `deno task test` 覆盖 Deno 测试、由 Deno 驱动的宿主—Python 客户端端到端链路，以及通过 `tests/python-client.test.js` 驱动的 Python unittest；`deno task verify` 会先做静态校验再跑同一套测试，因此 Python 单元测试已纳入门禁，无需再单独手工跑才能合入。
- 静态门禁包含 UTF-8、Manifest、内容脚本产物、动作契约、版本号护栏，以及 Python 文件存在性、UTF-8、无缓存语法检查和客户端 API 版本非硬编码检查。

## 2. 测试清单

- `critical-flows.test.js`：核心收纳/恢复流程、URL 容错导入；
- `rules-engine.test.js`：P0~P3 规则优先级；
- `stash-settings.test.js`：设置读写兼容；
- `indexed-db-stash.test.js`：IndexedDB CRUD、去重、分页、迁移幂等与并发写库；
- `webdav-sync.test.js` / `webdav-two-device.test.js`：ETag、412、批次、快照、墓碑、设备退役与双设备传播；
- `ai-bridge.test.js`：AI 能力对等、确认位、凭据出口与审计；
- `api-version.test.js`：扩展、宿主与 Python 客户端的 API 版本唯一事实源约束；
- `bridge-client-e2e.test.js`：真实本机宿主与 Python 客户端的普通请求、分块响应和退出清理；
- `python-client.test.js`：由 Deno 调用 `python -B -m unittest discover -s tests/python`，把 Python 客户端单元测试纳入 `deno task test`；
- `tests/python/test_betterbrowse_client.py`：客户端诊断、参数、文件/标准输入、批处理、分页、分块与错误语义（由上一文件驱动，不再作为独立合入门禁）；
- `action-contract.test.js`：动作映射、AI 文档、内容白名单、人类 UI 对等；
- 其余测试覆盖鉴权、日志、URL 判定、规则与阈值契约。

## 3. 常用验证命令

```bash
# 全套自动化测试
deno task test

# 静态规范、UTF-8、文件完整性、内容产物、动作、版本号与 Python 客户端护栏
deno task verify

# 指定 Deno 测试文件或按名称过滤（含 Python 客户端门禁用例）
deno test -A tests/indexed-db-stash.test.js
deno test -A tests/python-client.test.js
deno test -A tests/ --filter "WebDAV"

# 内容脚本重新打包与过期检查
deno task bundle
deno task bundle:check

# 仅在跨组件 API 契约发生不兼容变化时执行
deno task api-version-bump
```

> 上例中的 `bundle:check` 应使用 ASCII 命令 `deno task bundle:check`；若复制到终端，请勿把 `denо`（西里尔字母）当作命令。

## 4. 验收门槛

- 任何改动合入前，`deno task test` 与 `deno task verify` 必须全绿（后者会再跑前者，因此已覆盖 Python unittest）；
- 修改 Python 客户端后走同一套门禁即可，无需再手工跑 unittest；禁止提交 `__pycache__` 或 `.pyc` 文件；可通过 `PYTHON` 指定解释器路径；
- 修改 `src/content/` 或其依赖的常量后，必须执行 `deno task bundle`，再刷新 Chrome 扩展；
- 测试全绿不等于真实 Chrome、Service Worker 休眠、Native Messaging 宿主和真实 WebDAV 服务器已验收，发布前仍需按对应运行手册做浏览器级检查。
