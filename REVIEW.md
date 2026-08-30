# Better Browse 全库过度工程化审查报告

> 审查日期：2026-08-30  
> 审查方式：8 个 Agent 并行逐区审查，主 Agent 交叉核验引用关系并合并去重  
> 审查范围：当前工作树中的源码、界面、脚本、测试、本机宿主与 Better Browse Skill，约 2.66 万行  
> 审查目标：死代码、复制粘贴、单实现抽象、过度防御、手写平台能力和不必要的并发模型  
> 审查边界：不把必要的 MV3 生命周期、数据一致性、安全和同步协议防护当作冗余  
> 代码改动：审查项已全部落地（含范围外大请求分块信封修复）；`deno task verify` 通过，`90 passed | 0 failed`

## 结论

本次审查得到 55 条高置信简化项，保守可减少约 353 行源码；生成的 `content-bundle.js` 还可额外缩小约 26 行，但作为构建产物不重复计入源码收益。

整体没有需要推倒重写的“屎山”。主要问题集中在：

- 无调用者的便捷接口和遗留样式；
- 两份完全相同的 URL 清洗和动作处理实现；
- 为固定规则集合保留动态插件式注册 API；
- 为严格串行、单请求通道使用 `Map` 建模并发；
- 在静态必有 DOM 和构造器必有对象上重复做存在性防御；
- 测试手工复制生产动作清单，形成第二真值。

## 存储与仓储

- `BetterBrowse/src/core/stash/local-stash-repo.js:903`: **shrink**：`sanitizeImportUrl` 与 `OneTabConverter.sanitizeUrl` 完全重复。直接复用后者。预计 `-44` 行。
- `BetterBrowse/src/core/stash/indexed-stash-repo.js:153`: **delete**：`countGroups` 没有生产或测试调用者。迁移继续直接使用事务 `count()`。预计 `-7` 行。
- `BetterBrowse/src/core/stash/indexed-stash-repo.js:216`: **delete**：`_upsertPages` 没有调用者，实际写入路径需要不同的 outbox 和事务语义。删除。预计 `-24` 行。
- `BetterBrowse/src/core/storage/storage-adapter.js:353`: **delete**：`getMultiple` 没有调用者，而且绕过统一超时包装。保留 `get`。预计 `-29` 行。
- `BetterBrowse/src/core/storage/storage-adapter.js:384`: **delete**：`setMultiple` 没有调用者，只是无事务语义的 `Promise.all` 包装。保留 `set`。预计 `-11` 行。

本区保守收益：`-115` 行。

## 选项页

- `BetterBrowse/src/options/options.js:790`: **delete**：`filterBanner` 只赋值、从未读取。删除缓存字段。预计 `-1` 行。
- `BetterBrowse/src/options/options.js:1270`: **delete**：`scrollToGroup()` 全仓无调用，所属类也未导出。删除方法。预计 `-30` 行。
- `BetterBrowse/src/options/options.js:858`: **shrink**：`timelineScrollbar` 和方法都由构造器保证存在。直接调用 `syncScrollProgress`。预计 `-2` 行。
- `BetterBrowse/src/options/options.js:885`: **shrink**：同一对象的第二处重复 `typeof` 和可选链防御。直接调用。预计 `-2` 行。
- `BetterBrowse/src/options/options.css:786`: **delete**：`.dropdown-item-danger` 及 hover 规则无引用。删除。预计 `-8` 行。
- `BetterBrowse/src/options/options.css:1649`: **delete**：`.mode-badge` 及三个变体无引用，当前域名规则使用 `select`。删除。预计 `-10` 行。
- `BetterBrowse/src/options/options.css:19`: **delete**：`--bg-card-hover`、`--accent-subtle`、`--border-active`、`--radius-xl` 无读取点。删除双主题声明。预计 `-8` 行。

本区保守收益：`-61` 行。

## 弹窗

- `BetterBrowse/src/popup/popup.css:16`: **delete**：`--bg-active` 无读取点。预计 `-2` 行。
- `BetterBrowse/src/popup/popup.css:27`: **delete**：`--accent-light`、`--accent-glow` 无读取点。预计 `-4` 行。
- `BetterBrowse/src/popup/popup.css:32`: **delete**：`--border-light`、`--border-active` 无读取点。预计 `-4` 行。
- `BetterBrowse/src/popup/popup.css:37`: **delete**：`--warning-color` 无读取点，警告状态实际使用 `--danger-color`。预计 `-2` 行。
- `BetterBrowse/src/popup/popup.css:47`: **delete**：四个未使用的圆角和阴影变量。预计 `-8` 行。
- `BetterBrowse/src/popup/popup.html:26`: **delete**：`cardLinkMode` id 没有 JS、CSS 或跨文件引用。删除属性。预计 `-1` 行。
- `BetterBrowse/src/popup/popup.js:298`: **delete**：静态必有的 `btnExecuteStashText` 被重复判空。直接设置 `textContent`。预计 `-4` 行。
- `BetterBrowse/src/popup/popup.js:96`: **shrink**：已缓存 `segmentedItems` 后又执行 `querySelector`。直接索引缓存。预计 `-1` 行。

本区保守收益：`-26` 行。原始分区估算为 `-30` 行，最终总数采用逐项保守值。

## 工具与测试

- `BetterBrowse/scripts/build-content.js:6`: **native**：使用 Node 文件和路径兼容 API，并创建未使用的 `__filename`。改用 `@std/path` 和 `Deno.readTextFile`、`Deno.writeTextFile`。预计 `-4` 行。
- `BetterBrowse/scripts/verify-code.js:7`: **native**：同样的 Node 兼容层。改用 Deno 原生文件 API。预计 `-4` 行。
- `BetterBrowse/scripts/build-content.js:61`: **yagni**：为工程当前未使用的再导出语法保留两条剥离分支。删除。预计 `-4` 行。
- `BetterBrowse/scripts/generate-icons.js:8`: **native**：单次 `ensureDir` 调用可改为 `Deno.mkdir(path, { recursive: true })`。预计 `-1` 行。
- `BetterBrowse/tests/helpers/fake-indexeddb.js:10`: **yagni**：Deno 2.x 下 `structuredClone` 的 JSON 回退没有第二运行时，而且语义并不等价。直接调用原生函数。预计 `-3` 行。
- `BetterBrowse/tests/ai-bridge.test.js:109`: **shrink**：`OTHER_SHARED_ACTIONS` 手工镜像生产 handler 键集。直接遍历 `Object.keys(handlers)`，保留独立的 `HUMAN_UI_ACTIONS`。预计 `-26` 行。
- `BetterBrowse/tests/indexed-db-stash.test.js:67` 与 `BetterBrowse/tests/regression-fixes.test.js:64`: **shrink**：两处完全重复的 `countStoreRecords`。移入现有测试 helper。预计 `-5` 行。

本区保守收益：`-47` 行。

## 后台与规则

- `BetterBrowse/src/core/rules/rule-engine.js:33`: **yagni**：固定五条内置规则却保留动态注册、注销、去重和重新排序 API。构造器直接赋值有序数组。预计 `-20` 行。
- `BetterBrowse/src/background/action-handlers.js:49`: **shrink**：`SET_LINK_RULE` 与 `SET_DOMAIN_RULE` 实现完全重复。让两个动作键映射到同一 handler。预计 `-5` 行。
- `BetterBrowse/src/background/action-handlers.js:388`: **shrink**：`OPEN_PINNED_STASH_TAB` 与 `OPEN_ONE_TAB` 实现完全相同。共享函数，保留兼容动作名。预计 `-5` 行。
- `BetterBrowse/src/background/context-menu-manager.js:124` 与 `BetterBrowse/src/background/pinned-tab-guard.js:177`: **shrink**：重复手写特殊页面排除条件。统一复用 `isExcludedFromTabCounting`。预计 `-10` 行。
- `BetterBrowse/src/background/activity-tracker.js:102`: **delete**：关闭标签只改变内存中的 tabId 投影，却把未改变的 `pageStats` 再写一遍。删除该次写入。预计 `-1` 行。
- `BetterBrowse/src/constants/config.js:18`: **delete**：`RulePriorities.DEFAULT` 全仓无消费者。删除。预计 `-1` 行。

本区保守收益：`-42` 行。

## AI 桥接

- `BetterBrowse/native-host/bb_native_host.js:435`: **delete**：`hello_ack` 没有生产者，实际握手为 `hello -> ready`。删除死分支。预计 `-4` 行。
- `BetterBrowse/native-host/bb_native_host.js:405`: **shrink**：严格串行队列却用 `Map` 表示多条在途请求。改为单个 `inflight` 槽位。预计 `-6` 行。
- `skills/better-browse/scripts/bb-bridge-client.js:91`: **yagni**：单次 CLI 只发送一个请求，却维护 `pending Map`。改为单个等待槽位。预计 `-5` 行。
- `BetterBrowse/native-host/bb_native_host.js:106`: **shrink**：Native Messaging 与 TCP 输出重复相同的分块循环。抽取一个宿主内部 `writeChunked` helper。预计 `-7` 行。
- `skills/better-browse/scripts/bb-bridge-client.js:169`: **delete**：`session.extensionId` 写入后从未读取。删除字段和赋值。预计 `-2` 行。

本区保守收益：`-24` 行。

## WebDAV 同步

- `BetterBrowse/src/core/sync/sync-constants.js:29`: **delete**：`SyncStatusLabels` 无消费者，选项页另有实际文案。删除导出。预计 `-10` 行。
- `BetterBrowse/src/core/sync/snapshot.js:8`: **delete**：未使用的 `StorageAdapter` 导入。预计 `-1` 行。
- `BetterBrowse/src/core/sync/merge.js:86`: **delete**：`appliedIds` 只写不读。删除集合及写入。预计 `-2` 行。
- `BetterBrowse/src/core/sync/merge.js:371`: **yagni**：`tentativeIncoming` 兼容别名无调用者。只保留 `originIsCloudTentative`。预计 `-1` 行。
- `BetterBrowse/src/core/sync/account-config-sync.js:98`: **delete**：白名单切片后再次删除不可能存在的凭据字段。删除重复清洗。预计 `-6` 行。
- `BetterBrowse/src/core/sync/account-config-sync.js:304`: **delete**：`_applyIncoming` 的 `_updatedAt` 参数从未读取。删除参数。预计 `-1` 行。
- `BetterBrowse/src/core/sync/webdav-client.js:14`: **delete**：`WebdavResponse.headers` 没有消费者。删除 typedef 和返回字段。预计 `-2` 行。
- `BetterBrowse/src/core/sync/outbox.js:119`: **delete**：`uploaded` 从未写为真，过滤恒成立，而 `markUploaded` 直接删除记录。删除字段、过滤和对应 IndexedDB 索引。预计 `-2` 行。
- `BetterBrowse/src/core/sync/sync-engine.js:175`: **delete**：`probeCapability` 已创建目录，`run` 紧接着重复执行。删除第二次调用。预计 `-1` 行。
- `BetterBrowse/src/core/sync/sync-engine.js:295`: **delete**：`_updateManifest.lastStatus` 只赋值，不参与结果或错误判断。删除。预计 `-2` 行。

本区保守收益：`-28` 行。

## 内容脚本

- `BetterBrowse/scripts/build-content.js:37`: **delete**：内容脚本源码没有使用 `StorageKeys`，却无条件打入 bundle。移除构建输入。源码预计 `-1` 行，生成产物另缩小约 26 行但不重复计入源码收益。
- `BetterBrowse/src/content/main-world-bridge.js:149`: **native**：`stopImmediatePropagation()` 已包含 `stopPropagation()` 的效果。删除两处重复调用。预计 `-2` 行。
- `BetterBrowse/src/content/link-interceptor.js:388`: **native**：三处同样的重复传播阻断。保留 `preventDefault()` 和 `stopImmediatePropagation()`。预计 `-3` 行。
- `BetterBrowse/src/content/main-world-bridge.js:164`: **shrink**：`anchor.target` 重复读取已经标准化的 `targetAttr`。删除第二次判断。预计 `-1` 行。
- `BetterBrowse/src/content/link-interceptor.js:411`: **shrink**：`anchor.target` 与前面的 `currentTarget` 判断重复。预计 `-1` 行。
- `BetterBrowse/src/content/countdown-banner.js:61`: **delete**：host 尚未挂载，随后 `cssText` 完整覆盖 `style.all`。删除前置赋值。预计 `-1` 行。
- `BetterBrowse/src/content/countdown-banner.js:321`: **native**：内联 `width: 100%` 与 `.progress-bar` CSS 重复。删除内联初始值。预计 `-1` 行。

本区源码收益：`-10` 行；若按构建清单本身计入则为 `-11` 行。生成 bundle 体积另减少约 26 行，不计入总源码收益。

## 不应删除的必要防御

下列机制看起来复杂，但都在承担明确的正确性、安全或平台生命周期责任，不属于过度工程化：

- IndexedDB 主库读取失败时回退旧存储，但写入失败绝不回退，避免双数据源分叉；
- 写锁内选择后端、跨上下文写锁、连接惰性重建、打开超时与事务错误传播；
- 迁移幂等、失败停版、完整性校验、缺表自愈、30 天旧快照保留和一键回退；
- 页面、收纳组、条目、outbox、时钟和操作日志的同事务提交；
- WebDAV 读取最新清单后合并、ETag/If-Match、412 重试及无 ETag 兼容模式；
- 字段级版本、Lamport 顺序、墓碑 TTL、watermark 重放、操作去重、摘要和数据集身份校验；
- Native Messaging 四字节帧、双边分块重组、reqId 回填、120 秒请求超时、90 秒看门狗和 stdin EOF 清理；
- AI 操作确认位、payload 大小限制、凭据出口复查、异步审计及动作能力对等测试；
- MAIN world 与隔离世界分别进行 URL、DOM 和事件校验；两层边界不能合并；
- 捕获阶段 `preventDefault()` 与 `stopImmediatePropagation()`，用于阻止 React、Vue、Discourse 等 SPA 路由抢先处理；
- 表单保护的 fail-closed、标签关闭竞态容错、阈值状态的 alarms/session 恢复和固定标签守护；
- `fake-indexeddb.js` 整体测试设施，在项目零 npm、纯 Deno 约束下没有可直接替代的原生实现。

## 范围外正确性风险

审查过程中发现一项不属于过度工程化、但应进入普通缺陷审查的问题：

`skills/better-browse/scripts/bb-bridge-client.js:197` 对大请求只分块序列化 `payload`，没有分块完整的 `{ action, payload }` 请求信封。宿主重组后可能只得到 payload，无法取得 action 并正确路由。与此同时，`docs/03-ai-skill-bridge.md` 中的分块尺寸和信封描述与实现也存在差异。

建议单独补充“大请求经 CLI -> 宿主 -> 扩展”的端到端测试，再统一客户端、宿主和协议文档。该问题不计入 `-353` 行的 ponytail 净减结果。

## 建议实施顺序

1. 删除无调用者接口、未使用导入、死 CSS 和只写不读字段。这批改动风险最低，约 `150` 行。
2. 合并 URL 清洗、动作别名 handler、特殊页面谓词和重复测试 helper。这批改动可消除第二真值，约 `75` 行。
3. 简化规则注册 API、宿主 inflight 和 CLI pending 模型。这批改动会改变内部结构，应分别补充或保留行为测试。
4. 清理 WebDAV 同步中的恒真状态和重复清洗，同时确保所有同步定向测试继续通过。
5. 单独修复大 payload 分块信封问题，不要把协议修复和本报告中的纯删减混为一个提交。

## 验证结果

- `deno task test`：`90 passed | 0 failed`（含动作别名共用 handler 断言）；
- `deno task verify`：通过，包括 UTF-8、文件完整性、内容 bundle 一致性和全套测试；
- 审查所列 55 项简化与范围外大请求分块信封问题均已落地。

## 净收益

`net: -353 lines possible.` 审查项已落地；`content-bundle.js` 因移除 `StorageKeys` 输入额外缩小。
