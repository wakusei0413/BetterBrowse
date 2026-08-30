# Better Browse - AI Agent 协同开发与架构指南 (AGENTS.md)

本文档专为后续参与本项目维护、重构与功能迭代的 **AI Agent（以及人类开发者）** 提供系统性的项目全景说明、底层架构设计、技术约束、规则扩展规范与开发防坑指南。

---

## 📌 1. 项目概览与硬性约束

- **项目名称**：Better Browse（智能浏览增强插件）
- **规范标准**：Chrome Extensions **Manifest V3**
- **当前版本**：`Milestone 2`
- **开发运行时与工具链**：**纯 JavaScript (原生 ESM) + Deno 2.x 原生驱动**（彻底告别 Node.js/npm 体系）
- **零构建与所见即所得原则**（⚠️ **核心开发手感**）：
  - 源码直接在 `src/` 中以纯原生 JavaScript 编写（`.js`、`.html`、`.css`）。
  - **无需 `dist/` 编译产物中间层**，在 `src/` 中修改代码后切到 Chrome 浏览器刷新扩展即可**立即生效**。
  - Chrome 扩展直接加载包含 `manifest.json` 与 `src/` 的项目主目录。
- **语言与编码**（⚠️ **必须严格遵守，绝对不可违背**）：
  1. **全量简体中文**：所有源代码注释、JSDoc 函数说明、UI 界面展示文本、错误提示及文档，**一律使用标准的简体中文**。
  2. **UTF-8 编码**：所有文件必须采用无 BOM 的标准 **UTF-8** 编码，杜绝任何平台乱码。
- **设计风格**：**现代简约扁平化（Flat Minimalist）**，包含三段式滑动拉杆（左: 当前标签 / 中: 自动模式 / 右: 新标签页），与 Chrome 原生 UI 深度融合，去除厚重的视觉噪音，自适应深色（Dark）/ 浅色（Light）模式。

---

## 🏗️ 2. 系统分层架构与模块全景

项目推行 **“高内聚、低耦合、面向接口、原生 ESM 模块化、零构建心智负担”** 的分层设计：

```
BetterBrowse/
├── .gitignore                     # Git 忽略配置
├── deno.json                      # 根工作区 Deno 配置文件 (任务代理)
│
├── skills/                        # AI Agent 技能库（阶段三：better-browse 技能 + 桥接 CLI 客户端）
│   └── better-browse/
│       ├── SKILL.md               # 技能入口（快速开始、安全规则、CDP 回退）
│       ├── scripts/
│       │   └── bb-bridge-client.js # Agent 命令行客户端 (NDJSON + 令牌握手 + 分块重组)
│       └── references/
│           └── protocol.md        # 线协议与排障参考
│
└── BetterBrowse/
    ├── deno.json                  # Deno 任务与 JSR 标准库依赖配置
    ├── manifest.json              # Chrome Manifest V3 清单配置
    │
    ├── native-host/               # AI 桥接本机宿主 (阶段三 M4, 由 Chrome Native Messaging 按需拉起)
    │   ├── bb_native_host.js     # 宿主主程序 (stdio 帧 ↔ 127.0.0.1 令牌侧信道、SW 保活 ping、串行转发)
    │   ├── run-host.cmd / run-host.sh # 平台启动包装 (Chrome 拉起入口)
    │   ├── install.js            # 安装器 (Windows 注册表 / macOS、Linux 目录, deno task ai-host-install)
    │   └── uninstall.js          # 卸载器 (deno task ai-host-uninstall)
    │
    ├── scripts/                   # Deno 原生驱动的辅助与校验工具 (纯 JS)
    │   ├── build-content.js      # 内容脚本单文件打包器 (生成自包含 content-bundle.js)
    │   ├── generate-icons.js     # 矢量光栅化治愈系猫耳高清图标生成器 (16~512px)
    │   └── verify-code.js        # 静态规范、UTF-8 编码与全量文件完整性校验器
    │
    ├── src/                       # 🎯 纯原生 JavaScript 源码 (Chrome 扩展直接加载)
    │   ├── constants/             # 全局常量契约层
    │   │   ├── action-types.js   # 跨端通信 ActionTypes 契约
    │   │   ├── config.js         # 默认配置、优先级定义与业务常量
    │   │   └── storage-keys.js   # Storage 键名命名空间
    │   │
    │   ├── core/                  # 核心业务领域层 (纯 JS 逻辑，无 DOM 强依赖)
    │   │   ├── bus/
    │   │   │   └── message-bus.js    # 统一跨端消息通讯总线 (强类型、安全错误处理)
    │   │   ├── storage/
    │   │   │   ├── storage-adapter.js# Chrome Storage 统一适配器 (local/sync, 变化监听, 默认值合并)
    │   │   │   ├── indexed-db.js    # IndexedDB 本地主库连接管理器 (惰性重建、跨上下文写锁、分批事务)
    │   │   │   └── migration.js      # 数据架构版本迁移器 (幂等、失败降级、30 天保留与一键回退)
    │   │   ├── link/
    │   │   │   ├── link-matcher.js   # 域名匹配算法 (精确域名 > 通配符 > 全局后备)
    │   │   │   └── link-service.js   # 链接跳转规则增删改查业务服务
    │   │   ├── rules/                # 智能收纳规则引擎 (责任链 + 策略模式)
    │   │   │   ├── base-rule.js      # 规则抽象基类
    │   │   │   ├── audible-rule.js   # P0 媒体播放保护规则
    │   │   │   ├── form-guard-rule.js# P0 表单输入保护规则
    │   │   │   ├── recent-active-rule.js # P1 最近访问保护规则
    │   │   │   ├── frequency-rule.js # P2 高频访问保护规则 (Top 20%)
    │   │   │   ├── pinned-rule.js    # P3 固定标签保护规则
    │   │   │   └── rule-engine.js    # 规则编排与全量标签评估器
    │   │   ├── stash/                # 标签页收纳与持久化仓储
    │   │   │   ├── stash-service.js  # 收纳与恢复服务主调度
    │   │   │   ├── local-stash-repo.js # 收纳仓储门面 (IndexedDB 主库优先, chrome.storage 兜底)
    │   │   │   ├── indexed-stash-repo.js # IndexedDB 仓储实现 (页面实体+收纳记录两层模型、索引去重、分页检索)
    │   │   │   └── onetab-converter.js # OneTab 双向数据转换器 (支持纯文本/内部 JSON 互导)
    │   │   │
    │   │   ├── ai/                   # AI 桥接能力层 (阶段三 M4, 协议见 docs/03-ai-skill-bridge.md)
    │   │   │   └── ai-capabilities.js # 能力自描述常量 (动作文档目录、确认位白名单、清单构建器)
    │   │
    │   │   └── sync/                 # WebDAV 云端同步 (阶段二 M3, 协议见 docs/02-webdav-sync.md)
    │   │       ├── sync-constants.js # 协议常量 (远端路径、状态机、配额阈值)
    │   │       ├── webdav-client.js  # HTTPS WebDAV 客户端 (GET/PUT/HEAD/MKCOL, ETag 能力探测)
    │   │       ├── credentials.js    # 凭据本地仓储 (永不进入同步/快照/导出)
    │   │       ├── outbox.js         # 本地不可变操作 outbox (与实体写入同事务追加)
    │   │       ├── merge.js          # 字段级合并、墓碑与冲突记录
    │   │       ├── snapshot.js       # generation 快照生成/应用 (watermark 重放)
    │   │       ├── sync-engine.js    # 推/拉/合并/清单条件更新/压缩与设备退役
    │   │       ├── device-events.js  # 跨设备可见、仅来源设备执行的倒计时/收纳事件
    │   │       └── account-config-sync.js # 浏览器账号偏好镜像 (chrome.storage.sync，不含收纳列表)
    │   │
    │   ├── background/            # 后台生命周期与调度 (Service Worker 原生 ESM)
    │   │   ├── activity-tracker.js   # 标签页激活时间与滑动窗口频次统计 (v8 起按 pageId 持久化)
    │   │   ├── threshold-monitor.js  # 标签页数量阈值监控与冷却防打扰
    │   │   ├── pinned-tab-guard.js   # 首位常驻收纳箱守护与防误关保护
    │   │   ├── sync-scheduler.js     # 云端同步调度 (防抖/启动/定时/手动)
    │   │   ├── action-handlers.js    # 共享 action 处理映射 (人类 UI 消息与 AI 桥接指令同一处理路径)
    │   │   ├── ai-bridge.js          # AI 桥接管理器 (Native Messaging 通道、确认位、凭据出口复查、审计)
    │   │   └── service-worker.js     # 后台总入口 (装配模块、监听事件)
    │   │
    │   ├── content/               # 网页端内容脚本 (双层世界防御体系)
    │   │   ├── main-world-bridge.js  # 主页面世界 (Main World) 脚本，拦截 SPA 框架路由
    │   │   ├── link-interceptor.js   # 隔离世界 (Isolated World) 拦截器
    │   │   ├── form-detector.js      # 表单焦点与未保存输入探测器
    │   │   ├── countdown-banner.js   # 倒计时悬浮卡片 (Shadow DOM 样式彻底隔离)
    │   │   ├── content-bundle.js     # 网页注入自包含单文件产物
    │   │   └── index.js              # 内容脚本源码入口
    │   │
    │   ├── popup/                 # 弹出控制台 (极简扁平化 UI)
    │   │   ├── popup.html
    │   │   ├── popup.css
    │   │   └── popup.js
    │   │
    │   ├── options/               # 选项与收纳管理中心仪表盘 (组件化设计)
    │   │   ├── options.html
    │   │   ├── options.css
    │   │   └── options.js
    │   │
    │   └── icons/                 # 高清图标资源 (16/32/48/128/256/512)
    │
    └── tests/                     # Deno.test 原生自动化集成测试套件
        ├── helpers/
        │   └── fake-indexeddb.js  # 测试专用内存版 IndexedDB 模拟器 (宏任务事件派发、事务中止回滚)
        ├── critical-flows.test.js # 核心收纳恢复流程与 URL 容错导入测试
        ├── indexed-db-stash.test.js # IndexedDB 主库仓储、迁移幂等、回退与并发写库测试
        ├── webdav-sync.test.js    # WebDAV 同步协议、字段合并、墓碑与凭据隔离测试
        ├── account-config-sync.test.js # 浏览器账号偏好镜像、配额跳过与凭据隔离测试
        ├── ai-bridge.test.js      # AI 桥接人机能力对等 (parity)、确认位、凭据出口与审计测试
        ├── stash-item-ops.test.js # 收纳条目增强读写 (组内追加/编辑/检索分页/备份管理) 测试
        ├── rules-engine.test.js   # P0~P3 智能规则多级优先级测试
        ├── stash-settings.test.js # 收纳箱精细化设置与存储迁移测试
        └── threshold-monitor.test.js # 阈值监控与冷却防打扰测试
```

---

## 🔄 3. 关键工作流与底层交互机制

### 3.1 智能链接跳转控制流 (含 SPA 拦截与预渲染)

```
[用户在网页点击超链接 / 鼠标悬浮]
  │
  ├── 悬浮阶段 (Hover) ──► 触发 Speculation Rules 预渲染与 Prefetch 预加载
  │
  ▼
【主页面世界 (Main World)】(main-world-bridge.js)
  │
  ├── 1. 捕获阶段拦截左键点击，查找目标超链接 (支持 tr.topic-list-item / a.title)
  ├── 2. 若模式为 'new'：
  │      - 执行 event.preventDefault() 与 event.stopImmediatePropagation() 
  │        (彻底切断 Discourse / Vue Router / React 的 SPA 原地路由劫持)
  │      - 派发 CustomEvent('__BETTER_BROWSE_OPEN_NEW_TAB__', { detail: { url } })
  │
  ▼
【隔离世界 (Isolated World)】(link-interceptor.js)
  │
  └── 3. 捕获 CustomEvent，通过 MessageBus.sendToBackground(ActionTypes.OPEN_TAB_BACKGROUND)
  │
  ▼
【后台服务 (Service Worker)】(service-worker.js)
  │
  └── 4. 提取 sender.tab 信息：
         - 设置 index: sender.tab.index + 1 (紧邻在原标签页右侧打开)
         - 设置 openerTabId: sender.tab.id (建立父子关联，关闭后自动切回原标签页)
         - 调用 chrome.tabs.create() 创建并激活新标签页
```

### 3.2 智能标签页收纳规则判定流 (P0 ~ P3)

```
[触发收纳 (手动点击 或 超过阈值自动提醒)]
  │
  ▼
【规则编排引擎】(RuleEngine.evaluateTabs)
  │
  ├── P0: AudibleRule ───────► tab.audible === true? ──────────────► [保留]
  ├── P0: FormGuardRule ─────► 内容脚本检测 input/textarea 编辑中? ──► [保留]
  ├── P1: RecentActiveRule ──► tab.active || 最近 5 分钟激活过? ───► [保留]
  ├── P2: FrequencyRule ─────► 1小时内激活频次处于前 20%? ─────────► [保留]
  ├── P3: PinnedRule ────────► tab.pinned === true? ───────────────► [保留]
  │
  └── 其余所有闲置标签页 ──────────────────────────────────────────► [归档进收纳组 & 安全关闭]
```

### 3.2.1 阶梯式降级收纳机制 (Tiered Escalation Stash)

当达到标签阈值触发自动收纳时，若一轮标准规则评估后标签数量**仍未降到阈值以下**，则启动阶梯式降级：

```
[智能收纳触发] (StashService.executeSmartStash)
  │
  ▼
【第 0 级】标准规则评估 (P0~P3 全部生效)
  │   收纳后可计数标签 < 阈值? ──► 完成 ✅
  │
  ▼ 未达标，进入下一级
【第 1 级】软性保护降级：
  │   - "最近访问"窗口缩短 (如 5 分钟 → 4 分 59 秒 → 4 分 58 秒…)
  │   - "高频访问"百分比下调 (20% → 15% → 10% → 5% → 0%)
  │   - "高频访问"最低激活次数上调 (2 → 3 → 4 …)
  │   收纳后可计数标签 < 阈值? ──► 完成 ✅
  │
  ▼ 逐级放宽直至 maxTiers 层
【终极兜底】(ultimateFallback)
  │   仅保留硬性保护 (播放媒体 / 表单输入 / 前台激活 / 固定标签 / 系统页面)
  │   其余标签按"重要度评分"从低到高强制回收，直至降到阈值以下
  │
  ▼ 若硬性保护数量本身已超出目标剩余数
【放弃】返回明确提示，绝不误关任何受保护标签页
```

**核心概念：**
- **硬性保护**（永不降级）：系统/插件自身页面、正在播放媒体（P0）、正在输入表单（P0）、前台激活标签、固定标签（P3）。
- **软性保护**（随阶梯逐级放宽）：最近访问（P1，窗口逐级缩短）、高频访问（P2，百分比下调 + 最低激活次数上调）。
- **达标口径**：与阈值监控完全一致（`filterCountableTabs` 可计数标签），收纳后 `可计数数量 < 阈值` 即为达标。
- 配置项位于 `DefaultConfig.tieredStash`（`enabled` / `maxTiers` / `tierStepSeconds` / `ultimateFallback` / `targetSafetyMargin`）。

### 3.3 数据导入与 URL 容错清洗机制

```
[导入 OneTab 纯文本 / IndexedDB 导出 / JSON 备份]
  │
  ▼
【智能解析与清洗器】(OneTabConverter & LocalStashRepository)
  │
  ├── 1. 危险伪协议过滤 (javascript:, data:text/html, vbscript:) ──► [安全剔除]
  ├── 2. 缺省协议自动补齐 (github.com -> https://github.com) ─────► [自动修复]
  ├── 3. 多协议支持 (http, https, chrome, edge, file, about...) ──► [全面兼容]
  ├── 4. 单项异常容错 ─────────────────────────────────────────────► [跳过脏项，保障其余 100% 成功导入]
  │
  ▼
【安全持久化写入】(StorageAdapter)
```

### 3.4 本地存储架构：IndexedDB 主库 + chrome.storage 兜底 (v5 起)

> 完整设计决策见 `docs/00-overview.md` 与 `docs/01-local-indexeddb.md`（存储架构改革分册）。

#### 3.4.1 两层数据模型（对象仓储）

| 仓储 | 主键 | 索引 | 用途 |
| --- | --- | --- | --- |
| `pages` | `pageId`（URL 指纹） | `url`, `domain`, `updatedAt` | 同一 URL 的页面实体（标题、图标、最后访问） |
| `stashGroups` | `groupId` | `createdAt`, `name` | 收纳组 |
| `stashEntries` | `entryId`（`groupId::tabId` 命名空间隔离） | `groupId`, `pageId`, `createdAt` | 组内条目，指向 `pages` |
| `settings` | `key` | — | v7 起承载用户配置、域名跳转规则与自动备份 |
| `activityStats` | `key` | — | v7 起承载标签页活跃度快照 |
| `deviceEvents` | `eventId` | `deviceId`, `sequence` | 本地操作事件（阶段二跨设备同步复用） |

#### 3.4.2 门面与降级机制 (LocalStashRepository)

```
[业务调用] (StashService / 选项页 / 右键菜单)
  │
  ▼
【LocalStashRepository 门面】(local-stash-repo.js)
  │
  ├── 读操作：IndexedDB 异常时自动降级读取旧存储快照（30 天保留期内）
  ├── 写操作：失败显式返回错误，绝不降级写旧存储（杜绝双数据源分叉与漏关标签）
  │
  ├── 版本 ≥ 5 且未回退 ──► IndexedStashRepository (indexed-stash-repo.js, 主库实现)
  └── 否则（不支持/迁移中/已回退）──► chrome.storage.local 数组旧路径 (legacy 实现)
```

- **版本门控**：收纳组在 `bb_schema_version >= 5` 后以 IndexedDB 为权威数据源；配置/规则/备份/活跃度在 `>= 7` 后同样走主库。版本切换在迁移写锁内原子完成。
- **变更通知**：IndexedDB 模式下收纳数据不经过 chrome.storage，门面每次写成功后更新 `bb_stash_revision` 修订号，选项页监听该键实现 0 刷新即时呈现。配置与规则变更通过 `NOTIFY_CONFIG_UPDATED` / `NOTIFY_RULE_UPDATED` 广播，内容脚本禁止直读存储。
- **旧数据保留**：迁移成功后旧 chrome.storage 快照保留 30 天再清理，期间可调用 `MigrationManager.rollbackFromIndexedDB()` 一键回退（设置 `bb_idb_optout` 后固定使用旧存储，同时导回收纳组与配置）。

#### 3.4.3 MV3 关键约束的处理方式 (IndexedDBManager)

1. **Service Worker 休眠**：连接缓存 `onclose` 后自动置空，下次操作惰性重建（`open()` 幂等重试）；
2. **多入口并发**：Service Worker 与选项页通过 `Web Locks API`（`bb-idb-write`）跨上下文串行化"读-改-写"，不可用时降级进程内队列；**写锁只在门面与迁移两处顶层获取，严禁嵌套**；
3. **启动就绪**：所有读写路径先 `await` 数据库打开；迁移随 onInstalled / onStartup / SW 冷启动幂等重试；
4. **大事务中断**：写入按 500 条/批分事务提交；创建组时组记录最后写入，中断不产生"半可见"组；
5. **迁移幂等**：entryId/pageId/groupId 全部由源数据主键推导，中断重跑为幂等 upsert，完整性校验失败则版本停在 v4 下次重试。

### 3.5 AI 桥接控制流 (阶段三 M4：人机能力对等)

```
[本机 AI Agent] (skills/better-browse/scripts/bb-bridge-client.js)
  │  读 bridge.json (端口+一次性令牌) → TCP 127.0.0.1 握手 → NDJSON {id, action, payload}
  ▼
【本机宿主】(native-host/bb_native_host.js，Chrome 经 Native Messaging 按需拉起，非常驻)
  │  每 25s 内部 ping 保活 MV3 SW；请求串行转发；大消息 512KB 级自动分块
  ▼
【扩展 AIBridgeManager】(src/background/ai-bridge.js)
  │  尺寸/确认位校验 → 凭据出口复查 → 审计 (bb_ai_audit_log, 环形 100 条) → 串行路由
  ▼
【共享 action 处理映射】(src/background/action-handlers.js)
  │  与 MessageBus（人类 popup/options/右键菜单）复用同一份 handler 与收尾广播
  ▼
【现有服务层】(LocalStashRepository / StashService / StorageAdapter / LinkService / SyncEngine …)
```

- **能力对等保障**：`GET_AI_CAPABILITIES` 自描述清单直接枚举共享映射的真实键集，`tests/ai-bridge.test.js` 的 parity 断言强制"人类 UI 使用的动作 ⊆ AI 能力清单"。
- **安全边界**：桥接总开关 `aiBridge.enabled` 默认关闭（选项页「AI 桥接」Tab）；WebDAV 凭据只写不可读；不可逆操作必须 `confirm: true`（不受 UI"删除二次确认"设置影响）。
- **生命周期**：SW 冷启动 `init()` → 开关开启时 `connectNative`；宿主缺失状态 `host_missing` 指数退避重连 + 每分钟看门狗闹钟兜底；Chrome 退出（stdin EOF）宿主自动清理 bridge.json。

---

## 🚀 4. AI Agent 扩展开发指南（零侵入式加 Feature）

### 4.1 如何新增一条智能收纳保留规则？

1. 在 `src/core/rules/` 目录下新建规则文件，继承 `BaseRule`：
   ```javascript
   import { BaseRule } from './base-rule.js';
   import { RulePriorities } from '../../constants/config.js';

   export class CustomWorkspaceRule extends BaseRule {
     constructor() {
       super({
         id: 'customWorkspace',
         name: '特定工作区保护',
         priority: RulePriorities.P1, // 指定优先级 P0-P3
         description: '保护特定工作区域名下的标签页不被自动收纳'
       });
     }

     async evaluate({ tab, config }) {
       if (tab.url?.includes('my-work-domain.com')) {
         return {
           retain: true,
           reason: '属于重点工作区页面',
           matchedRuleId: this.id
         };
       }
       return { retain: false };
     }
   }
   ```
2. 在 [src/core/rules/rule-engine.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/core/rules/rule-engine.js) 构造器的有序规则数组中加入实例：
   ```javascript
   this.rules = [
     new AudibleRule(),
     new FormGuardRule(),
     new RecentActiveRule(),
     new FrequencyRule(),
     new PinnedRule(),
     new CustomWorkspaceRule()
   ];
   ```
3. 在 [src/constants/config.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/constants/config.js) 的 `DefaultConfig.rulesEnabled` 中增加对应开关，并在设置面板挂载 UI。
4. **原有规则代码完全无需任何变动**。

> **⚠️ 软性规则与阶梯降级**：新增规则时需明确其保护属性——
> - **硬性规则**（如 `AudibleRule`、`FormGuardRule`、`PinnedRule` 及前台激活分支）：在阶梯降级与终极兜底阶段**始终生效**，无需任何特殊处理；
> - **软性规则**（如 `RecentActiveRule`、`FrequencyRule`）：其 `evaluate({ ..., tierContext })` 必须读取 `tierContext` 以支持逐级放宽，并在 `tierContext?.hardCoreOnly === true`（终极兜底）时返回 `{ retain: false }`；
> - 阶梯参数由 `RuleEngine.buildTierContext(config, tierLevel, tierSettings)` 统一计算，无需在规则内自行推导。

---

### 4.2 如何进行数据存储架构平滑升级？

1. 当修改了存储数据结构或追加了字段时，将 `src/constants/config.js` 中的 `CURRENT_SCHEMA_VERSION` 递增（例如从 `7` 改为 `8`）。
2. 在 [src/core/storage/migration.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/core/storage/migration.js) 中编写针对性的版本迁移逻辑：
   ```javascript
   if (currentVersion < 6) {
     // 执行从 v5 到 v6 的数据结构转换与补充字段写入
   }
   ```
3. 扩展启动时会自动运行迁移，保障老用户无感升级。

> **⚠️ 迁移硬性规范**（v5 IndexedDB 迁移确立的模式，新增版本必须沿用）：
> - **可重入**：迁移块的写入必须幂等（主键由源数据推导），中断重跑不得产生重复或丢失；
> - **失败降级**：迁移块失败时 `targetVersion` 不得推进，旧数据完整保留，下次启动自动重试；
> - **原子切换**：涉及"数据源切换"的迁移（如 v5）必须整体包裹在 `IndexedDBManager.withWriteLock` 临界区内；
> - **兼容验证**：修改迁移后必须运行 `deno task test`，IndexedDB 相关迁移需在 `tests/indexed-db-stash.test.js` 补充幂等与中断重试用例。

---

## 🛠️ 5. Deno 原生指令集

本项目完全由 **Deno 原生驱动**，无需安装 Node.js：

```bash
# 1. 运行全套自动化测试 (Deno 原生测试)
deno task test

# 2. 运行静态规范、UTF-8 编码与文件完整性校验 (必须全部 PASS)
deno task verify

# 3. 重新打包内容脚本 (修改 src/content/ 源码后执行)
deno task bundle

# 4. 生成全尺寸抗锯齿高清图标 (16px ~ 512px)
deno task icons

# 5. 安装 / 卸载 AI 桥接本机宿主 (阶段三；扩展 ID 在选项页「AI 桥接」Tab 复制)
deno task ai-host-install --ext-id=<扩展ID>          # 可选 --browser=edge
deno task ai-host-uninstall
```

---

## ⚠️ 6. Agent 开发避坑指南（Gotchas）

1. **零构建所见即所得**：
   - 源码即为运行代码。修改 `src/` 中的 JS、HTML、CSS 后，在 Chrome 扩展管理界面点击刷新即可直接生效。
2. **SPA 框架与单页面路由拦截**：
   - 任何涉及阻止单页跳转的行为，必须在 `src/content/main-world-bridge.js` 的**主世界捕获阶段**完成，绝对不能只在隔离世界（Isolated World）里调用 `event.stopPropagation()`，否则无法阻止页面的 Ember/Vue/React 路由。
3. **内容脚本更新**：
   - 浏览器内容脚本加载的是 `src/content/content-bundle.js`，修改了 `src/content/` 内部拆分源码后，**执行 `deno task bundle` 即可一键合并**。
   - `content-bundle.js` 内联了 `constants/` 下的常量（StorageKeys、CURRENT_SCHEMA_VERSION 等），**修改常量后同样必须重新打包**，否则 `deno task verify` 会因产物不一致而失败。
4. **IndexedDB 与旧存储双数据源**：
   - 收纳数据自 v5 起、配置/规则/备份/活跃度自 v7 起以 IndexedDB 为主库，**任何新功能严禁绕过 `LocalStashRepository` / `StorageAdapter` 门面直接读写 `bb_stash_groups`、`bb_user_config` 或 IndexedDB**；
   - 内容脚本不得访问 `chrome.storage.local` 或 IndexedDB，必须通过 `GET_PAGE_LINK_CONTEXT` 等消息向后台索取最小必要字段；
   - 门面写方法的后端决策发生在写锁临界区内，改动门面时**不得把 `_getBackend()` 决策移出锁外**，否则会引入"决策后版本翻转"竞态导致漏写；
   - `IndexedStashRepository` 的写方法自身**不持锁**（调用方持锁），直接调用必须自行包裹 `IndexedDBManager.withWriteLock`，且**严禁嵌套获取写锁**（死锁）；
   - 需要 UI 实时感知 IndexedDB 数据变化时，监听 `bb_stash_revision` 修订号（门面写成功后自动广播），不要依赖 `chrome.storage.onChanged` 的 `bb_stash_groups`。
5. **编码要求**：
   - 任何新增文件必须以 **UTF-8** 格式保存，且代码注释与文本使用**简体中文**。
6. **WebDAV 云端同步（阶段二 M3，协议见 docs/02-webdav-sync.md）**：
   - **outbox 同事务**：实体写入与 outbox / operationLogs / clock 更新必须在**同一个** `runTransaction` 事务内（`SyncOutbox.enqueueInTx`），拆开会出现"实体已写而操作丢失"的分叉；大组仍按 500 条分批，每批实体与操作同事务提交；
   - **严禁嵌套写锁**：`DeviceEventLog.append` 自行获取写锁，**不得**在已持锁的临界区内调用（倒计时回调、消息处理器均在锁外调用）；
   - **凭据排除**：`bb_webdav_credentials` 与 `bb_auto_backups` 被排除在 outbox、快照载荷与全量导出 JSON 之外，新增可同步键时必须维护 `StorageAdapter._shouldEnqueue` 与 `SyncSnapshot.buildPayload` 的排除表；
   - **tabId 禁令**：`tabId` / `windowId` 绝不进入 outbox、快照或任何跨设备实体；跨设备身份只有 `pageId` / `groupId` / `entryId` / `eventId`；
   - **能力探测前置**：探测仅拒绝认证失败与写入失败；缺失 ETag / If-Match 的服务器进入**兼容模式**（如 123 云盘 WebDAV），清单更新必须经 `SyncEngine._updateManifest` 统一通道「读取最新远端清单 → 在最新内容上合并 → 条件写入 → 412 重试」，**严禁**基于运行开始时的缓存清单直接覆盖远端（会吞掉其他设备的并发写入）；
   - **远端不可变**：批次与快照文件唯一命名不可变，清单更新必须携带当前 ETag 的 `If-Match`，412 视为条件写入冲突而非覆盖理由。
   - **浏览器账号偏好镜像**：`chrome.storage.sync` 只允许写入 `bb_account_config`（阈值 / 规则开关 / 收纳箱设置 / WebDAV 地址）。**严禁**把收纳组、页面、条目、`bb_link_rules`、凭据、自动备份或 `fieldRevs` 写入 sync；`chrome.storage.sync` 缺失时直接跳过，**禁止**回退到 `chrome.storage.local`。
7. **AI 桥接（阶段三 M4，协议见 docs/03-ai-skill-bridge.md）**：
   - **同一处理路径**：人类 UI 消息与 AI 桥接指令共用 `action-handlers.js` 的同一份映射。**新增动作时**：在该映射挂 handler → 同步在 `src/core/ai/ai-capabilities.js` 的 `AI_ACTION_DOCS` 补参数文档 → 若属人类 UI 功能则更新 `tests/ai-bridge.test.js` 的 `HUMAN_UI_ACTIONS`（parity 断言强制"人类有的 AI 必有"，漏文档会直接挂测试）；
   - **确认位红线**：新增不可逆动作时必须加入 `AI_CONFIRM_REQUIRED_ACTIONS`（AI 调用需 `payload.confirm === true`，不受 UI"删除二次确认"设置影响，恒定要求）；
   - **凭据出口复查**：任何新接口的响应都不得包含 `bb_webdav_credentials` 内容或 `password` 字段（`AIBridgeManager._guardResponse` 序列化后复查，命中即拦截）；凭据类动作的审计摘要不得记录内容（`_buildAuditSummary` 白名单字段机制）；
   - **AI 请求串行**：桥接请求经 `AIBridgeManager` 队列串行派发（`sender=null`），handler 内**严禁**假设消息来自标签页或要求 `sender.tab` 存在；
   - **配置联动**：`aiBridge.enabled` 为设备本地偏好，**严禁**加入 `SYNC_CONFIG_NESTED_KEYS` 或 `AccountConfigSync.slice` 白名单；开关变化经 `UPDATE_CONFIG`/`RESET_CONFIG` handler 内的 `aiBridge.onConfigUpdated()` 钩子即时生效；
   - **宿主协议**：`native-host/bb_native_host.js` 的 stdout 是 Native Messaging 协议通道，**任何日志必须走 stderr**；改动线协议（分块、握手、bridge.json 字段）必须同步更新 `docs/03-ai-skill-bridge.md`、`skills/better-browse/references/protocol.md` 与客户端；
   - **启动包装必须纯 ASCII**：cmd.exe 按 ANSI 代码页解析批处理，UTF-8 中文注释会把行解析成乱码命令导致宿主秒退（"Native host has exited"）；中文文档写在 `bb_native_host.js` 文件头；
   - **扩展来源参数不是最后一个**：新版 Chrome 给宿主追加 `--parent-window=<句柄>` 等参数，宿主必须**扫描全部启动参数**寻找 `chrome-extension://<ID>/`，不能只看末位参数；
   - **启动器不依赖 PATH**：Chrome 是长驻进程，其子进程环境可能滞后于当前 shell（装完 deno 未重启 Chrome 时 `deno` 解析失败）；安装器把 `Deno.execPath()` 绝对路径烘焙进生成的启动器；
   - **分块重组后必须回填 reqId**：大响应分块传输时，信封 `id` 承载 reqId，重组后的正文本身不含它——宿主与客户端两侧重组完成后都必须回填，否则响应匹配不上在途请求被静默丢弃、串行转发器永久卡死；
   - **宿主健壮性三件套**：stdin EOF 退出时必须关闭 TCP 监听器（否则僵尸进程）；在途请求 120 秒超时自动放行（响应丢失不能卡死队列）；90 秒无 pong 活性看门狗自动退出；
   - **SW 定时器可能冻结**：经 Native Messaging 唤醒并保活的 Service Worker 存在 setTimeout 回调不触发的 Chrome 异常类行为——扩展侧与宿主侧的一切健壮性超时都不能只依赖 setTimeout（宿主侧看门狗闹钟 + 队列强制重置兜底），`AIBridgeManager._onWatchdog` 检测队列连续停滞会强制重置；
   - **审计绝不阻塞响应**：`_appendAudit` 为发射后不管（内部串行队列防丢条目），await 审计会在存储层挂起时饿死响应与整个请求队列；
   - **IDB 自愈**：`MigrationManager.repairMissingObjectStores` 在启动时重建"有库无表"的残留库并从旧存储回填；`DB_VERSION` 只能单调递增（IndexedDB 拒绝低版本号打开），裸抬高版本号不建表会制造出需要 DB_VERSION 再提升才能修复的空库。
