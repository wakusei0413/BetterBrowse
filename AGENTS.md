# Better Browse - AI Agent 协同开发与架构指南 (AGENTS.md)

本文档专为后续参与本项目维护、重构与功能迭代的 **AI Agent（以及人类开发者）** 提供系统性的项目全景说明、底层架构设计、技术约束、规则扩展规范与开发防坑指南。

---

## 📌 1. 项目概览与硬性约束

- **项目名称**：Better Browse（智能浏览增强插件）
- **规范标准**：Chrome Extensions **Manifest V3**
- **当前版本**：`Milestone 1`
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
└── BetterBrowse/
    ├── deno.json                  # Deno 任务与 JSR 标准库依赖配置
    ├── manifest.json              # Chrome Manifest V3 清单配置
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
    │   │   │   └── migration.js      # 数据架构版本迁移器 (保障 Schema 升级向后兼容)
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
    │   │   └── stash/                # 标签页收纳与持久化仓储
    │   │       ├── stash-service.js  # 收纳与恢复服务主调度
    │   │       ├── local-stash-repo.js # 本地独立收纳仓储 (CRUD、去重、智能 URL 容错清洗)
    │   │       └── onetab-converter.js # OneTab 双向数据转换器 (支持纯文本/内部 JSON 互导)
    │   │
    │   ├── background/            # 后台生命周期与调度 (Service Worker 原生 ESM)
    │   │   ├── activity-tracker.js   # 标签页激活时间与 1 小时滑动窗口频次统计
    │   │   ├── threshold-monitor.js  # 标签页数量阈值监控与冷却防打扰
    │   │   ├── pinned-tab-guard.js   # 首位常驻收纳箱守护与防误关保护
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
        ├── critical-flows.test.js # 核心收纳恢复流程与 URL 容错导入测试
        ├── rules-engine.test.js   # P0~P3 智能规则多级优先级测试
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
2. 在 [src/core/rules/rule-engine.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/core/rules/rule-engine.js) 中实例化并注册：
   ```javascript
   this.registerRule(new CustomWorkspaceRule());
   ```
3. 在 [src/constants/config.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/constants/config.js) 的 `DefaultConfig.rulesEnabled` 中增加对应开关，并在设置面板挂载 UI。
4. **原有规则代码完全无需任何变动**。

> **⚠️ 软性规则与阶梯降级**：新增规则时需明确其保护属性——
> - **硬性规则**（如 `AudibleRule`、`FormGuardRule`、`PinnedRule` 及前台激活分支）：在阶梯降级与终极兜底阶段**始终生效**，无需任何特殊处理；
> - **软性规则**（如 `RecentActiveRule`、`FrequencyRule`）：其 `evaluate({ ..., tierContext })` 必须读取 `tierContext` 以支持逐级放宽，并在 `tierContext?.hardCoreOnly === true`（终极兜底）时返回 `{ retain: false }`；
> - 阶梯参数由 `RuleEngine.buildTierContext(config, tierLevel, tierSettings)` 统一计算，无需在规则内自行推导。

---

### 4.2 如何进行数据存储架构平滑升级？

1. 当修改了存储数据结构或追加了字段时，将 `src/constants/config.js` 中的 `CURRENT_SCHEMA_VERSION` 递增（例如从 `1` 改为 `2`）。
2. 在 [src/core/storage/migration.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/BetterBrowse/src/core/storage/migration.js) 中编写针对性的版本迁移逻辑：
   ```javascript
   if (currentVersion < 2) {
     // 执行从 v1 到 v2 的数据结构转换与补充字段写入
   }
   ```
3. 扩展启动时会自动运行迁移，保障老用户无感升级。

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
```

---

## ⚠️ 6. Agent 开发避坑指南（Gotchas）

1. **零构建所见即所得**：
   - 源码即为运行代码。修改 `src/` 中的 JS、HTML、CSS 后，在 Chrome 扩展管理界面点击刷新即可直接生效。
2. **SPA 框架与单页面路由拦截**：
   - 任何涉及阻止单页跳转的行为，必须在 `src/content/main-world-bridge.js` 的**主世界捕获阶段**完成，绝对不能只在隔离世界（Isolated World）里调用 `event.stopPropagation()`，否则无法阻止页面的 Ember/Vue/React 路由。
3. **内容脚本更新**：
   - 浏览器内容脚本加载的是 `src/content/content-bundle.js`，修改了 `src/content/` 内部拆分源码后，**执行 `deno task bundle` 即可一键合并**。
4. **编码要求**：
   - 任何新增文件必须以 **UTF-8** 格式保存，且代码注释与文本使用**简体中文**。
