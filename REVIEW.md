# Better Browse 全库代码审查报告

> 审查日期：2026-08-26
> 审查工具：`code-reviewer` skill（安装于 `~/.dsh/skills/code-reviewer/SKILL.md`）
> 审查方式：7 路并行深度审查（核心/链接规则/收纳/后台/内容/UI/脚本测试）+ 全部 critical/high 发现逐行人工复核 + `deno` 实证验证
> 代码库：53 个文件、约 12,000 行（Chrome 扩展 MV3，纯原生 JavaScript ESM + Deno 2.x，零构建）
> 审查范围：`BetterBrowse/` 全部源码、脚本、测试、清单与配置

---

## 🔴 高危问题（必须修复，均经原文验证）

### 1. 「重置配置」功能必然崩溃 — `ReferenceError: StorageKeys is not defined`
`src/background/service-worker.js:259` 的 `RESET_CONFIG` 处理器使用了 `StorageKeys.USER_CONFIG`，但整个 `src/background/` 目录 grep 不到任何 `StorageKeys` 的导入（仅此一处引用）。用户点击重置时 handler 抛 ReferenceError（被 MessageBus catch 后返回失败），重置功能 100% 失效。

```js
[ActionTypes.RESET_CONFIG]: async () => {
  const res = await StorageAdapter.set(StorageKeys.USER_CONFIG, DefaultConfig);  // ← 未导入
```

**建议**：在文件顶部 `import { StorageKeys } from '../constants/storage-keys.js'`，并补充 RESET_CONFIG 自动化测试。

### 2. options 页「收纳规则配置」三个设置项 +「高频访问」开关全部失效（键名错位）
`src/options/options.js:1475-1478/1515-1533` 读写 `recentActiveThresholdMinutes` / `autoStashCountdownSeconds` / `notifyOnThreshold`，而后台消费的是 `recentActiveMinutes`（`recent-active-rule.js:35`）、`countdownSeconds`（`threshold-monitor.js:158`）、`autoThresholdNotify`（`threshold-monitor.js:144/174`）。

- 结果：用户修改「最近访问窗口」「倒计时秒数」「桌面通知」后**写入的键无人读取**，重开页面读不到，设置静默回退默认值。
- 同样，「高频访问」开关写的是 `rulesEnabled.frequency`（`options.js:1524`），而 `frequency-rule.js:21` 读的是 `rulesEnabled.highFrequency` —— **该开关永远无效**（默认配置无 `frequency` 键 → checkbox 状态与真实规则行为脱节）。

**建议**：统一键名至后台实际消费的配置键（`recentActiveMinutes` / `countdownSeconds` / `autoThresholdNotify` / `rulesEnabled.highFrequency`），以 `DefaultConfig` 为唯一键名来源。

### 3. options 页「域名跳转规则」整个组件是死代码（用了不存在的 ActionTypes 常量）
`options.js` 调用 `ActionTypes.CLEAR_DOMAIN_RULES / REMOVE_DOMAIN_RULE / GET_DOMAIN_RULES / SET_DOMAIN_RULE`（1591/1602/1613/1625/1654 行），但这些常量在 `action-types.js` 中**根本不存在**（契约里只有 `SET_LINK_RULE` 等）。发送 `action: undefined` → 后台 `if (!message.action) return false` → MessageBus 兜底 `resolve(response || {success:true})` → **界面弹「已成功添加/删除」但什么都没发生**。

加上 `extractDomain` 拒绝裸域名（只接受 `http(s)://` 或 `//` 开头，`link-matcher.js:19-24`），而占位符承诺「输入 github.com（自动清洗协议与路径）」—— 该板块双重不可用。

**建议**：补全 `ActionTypes`（`SET_DOMAIN_RULE` 等 4 个动作）并在后台注册处理器；`handleAddRule` 先归一化补全 `https://` 再交给 `extractDomain`，或改写占位符文案。

### 4. `content-bundle.js` 与源码分叉（双真值，最危险）
- `src/content/content-bundle.js:132-164`：含已从源码删除的整套 `stashSettings`，且 `CURRENT_SCHEMA_VERSION = 3`；
- `src/constants/config.js`（源码）：无 `stashSettings`，`CURRENT_SCHEMA_VERSION = 1`。

浏览器隔离世界加载的是 **bundle 的旧/富配置**，而后台 SW 加载源码 `config.js` 的新/瘦配置 —— 前后台默认配置与 schema 版本不一致。说明改 `config.js` 后未执行 `deno task bundle`。`scripts/verify-code.js` 对产物只查 UTF-8/完整性，**无「产物与源码一致」校验**，此类分叉无人拦截。

**建议**：① 立即执行 `deno task bundle` 重新生成产物；② 在 `verify-code.js` 中加入「产物可由当前源码推导一致」的构建校验（对源码去除 import/export 后逐字对比），在 `deno task verify` 中失败即阻断。

### 5. `deno task test` / `deno task verify` 门禁红灯（实测）
```
15 passed | 2 failed
✗ DefaultConfig: 默认配置包含完整的收纳箱设置            (tests/stash-settings.test.js:62)
✗ MigrationManager: 从历史 v1 迁移至当前版本平滑补齐 stashSettings 默认值 (tests/stash-settings.test.js:77)
```
测试期望 `DefaultConfig.stashSettings` 与 schema v3（`assertEquals(store[SCHEMA_VERSION], 3)`），实现只有 v1 —— 测试与实现漂移，`deno task verify` 退出码 1。

**建议**：让实现与测试对齐（在 `config.js` 补全 `stashSettings` 默认值并将 `CURRENT_SCHEMA_VERSION` 提升至 3，且 `migration.js` 补 v1→v3 迁移逻辑），或回退测试 —— 二选一，不能两边不一致。

### 6. 「收纳箱 14 项精细化设置」是无消费者的功能
`options.js` 的 `StashSettingsComponent` 会写入 `config.stashSettings`（14 项：restoreBehavior / allowDuplicates / autoOpenStashTab / showTabCountBadge / autoBackupEnabled …），但 **`src/core/` 与 `src/background/` 没有任何代码读取 `stashSettings`**（grep 仅命中 options / bundle / tests）。全部 14 项设置：写入、可显示、但**零生效** —— 属于半途开发/回退残留。

**建议**：确定取舍 —— 完整实现消费逻辑（stash 恢复行为、重复收纳、Badge 计数、自动备份等），或明确移除该功能面。

---

## 🟠 中危问题（应修复，均验证过原文）

| # | 位置 | 问题 |
|---|---|---|
| 7 | `service-worker.js:109-131` + `link-interceptor.js:59-74` | `OPEN_TAB_BACKGROUND` 对 URL 零校验（仅判空）。MAIN World 与页面共享 JS 上下文，**任何页面脚本可伪造 `__BETTER_BROWSE_OPEN_NEW_TAB__` CustomEvent** 驱动扩展开任意标签（含非 http/https 协议），且任意模式下都会响应 |
| 8 | `stash-service.js:217-229` | `executeSmartStash` 不校验 `createGroup` 返回值（对比 `executeAllTabsStash:150-153` 有校验）—— 存储写入失败仍继续 `chrome.tabs.remove` 关闭所有标签 → **数据永久丢失** |
| 9 | `threshold-monitor.js:183-196` | 倒计时依赖 SW 内 `setInterval`；MV3 下 SW 约 30s 空闲即终止，倒计时/冷却/`remainingSeconds` 全为内存态 → 倒计时永远到不了 0、`lastActionTime` 丢失导致防打扰失效（建议 `chrome.alarms` + `storage.session` 持久化） |
| 10 | `threshold-monitor.js:188-194` + `countdown-banner.js:389-394` | 前台 Banner 与后台两条独立 `setInterval` 各自在归零时触发一次收纳，**同一轮倒计时可能连续执行两次 `executeStash`**（`clearCountdownUI` 只广播 HIDE，不停前台计时器） |
| 11 | `pinned-tab-guard.js:21-23, 96-107` | 窗口关闭全量收纳依赖内存 `tabsByWindow` 快照；构造时 `syncAllTabs()` 未 await，SW 重启后快照为空 → 关窗时**静默跳过收纳**（核心功能失效无报错） |
| 12 | `form-guard-rule.js:37` + `message-bus.js:44-66` | `sendToTab` 无超时；页面繁忙不响应时 Promise 永不 resolve → 串行规则评估**无限阻塞**；且 P0 规则异常倾向放行收纳（`rule-engine.js:102`），可能误关带未保存内容的页面 |
| 13 | `rule-engine.js:87` + `frequency-rule.js:33-48` | 每 tab 串行 await 全链（N 次 IPC）；FrequencyRule 每个 tab 都重算全量 countMap 并排序 → 近似 O(N² log N) |
| 14 | `onetab-converter.js:107`、`options.js:926` | 无 favicon 时默认拼接 `https://www.google.com/s2/favicons?domain=…` —— 把用户**全部收藏域名泄露给 Google**，且无隐私开关 |
| 15 | `link-matcher.js:38-55`、`main-world-bridge.js:52-68` | 协议过滤是**黑名单**（缺 `vbscript:`、`chrome:`、`about:`、`file:`、`view-source:`，内嵌控制字符可绕过 `startsWith`），且 MAIN World 与 LinkMatcher 两份副本已各自演化 |
| 16 | `local-stash-repo.js:65-69 等` | 所有 CRUD 均为「读-改-写」非原子，并发（popup + SW）会丢更新；`updateGroup:83` 对 `updates` 无字段白名单（可覆写 id/tabs） |
| 17 | `popup.js:181` + `service-worker.js` | `GET_COUNTDOWN_STATUS` 有定义但**后台无处理器** → popup 永远显示不了实时倒计时（注释明确「支持实时倒计时感知」） |
| 18 | `main-world-bridge.js:171-178` | `window.open` 劫持在 CURRENT 模式下返回 `window`（当前窗口）而非新窗口代理，语义错误，且忽略 target/features 可能破坏站点弹窗/登录流程 |
| 19 | `storage-adapter.js:117-123` | `USER_CONFIG` 若被显式存为 `null`，`storedConfig.rulesEnabled` 直接 TypeError（`{}` 默认值只在键缺失时生效）；`migration.js:18-20` 版本号**大于**当前版本（降级场景）会被当作正向迁移并覆写 schema 为 1 |

---

## 🟡 低危/改进项（摘选）

- **monitor 语义**：通知文案「超过阈值」但逻辑是 `>= threshold` 即触发（`threshold-monitor.js:116/335`）
- **无效 UI 反馈**：`flashSaveIndicator` 切换 `.visible` 类，但 `options.css` 无 `.autosave-badge.visible` 规则（grep 仅 `.autosave-badge`）→ 保存闪烁无任何视觉变化，且徽标默认常显「已自动保存」
- **popup/options alt**：`"BetterBrowse Logo"` 英文，违反「全量简体中文」规范（`popup.html:14`、`options.html:14`）
- **JSDoc 嵌套**：`local-stash-repo.js:138-141` 两个未闭合 `/**` 块嵌套
- **manifest**：`web_accessible_resources` 冗余暴露 `main-world-bridge.js`（静态注入不需要）；未声明 `minimum_chrome_version: 111`（`world: MAIN` 需 Chrome 111+）；`notifications / activeTab / scripting / contextMenus` 权限按需收敛
- **build-content.js:47-49**：import/export 剥离正则脆弱（遇 `export default` 会产出非法 `default class`），且产物一致性无校验
- **deno.json:3-6**：所有任务 `-A` 全权限；`deno lint` 实测 **108 个问题（34 个可自动修复）**
- **重复逻辑**：`service-worker.js` `onOpenOptions` 与 `OPEN_OPTIONS_PAGE` 几乎逐字重复；`context-menu-manager` 与 `pinned-tab-guard` 的标签过滤逻辑重复
- **设计细节**：
  - `rel="noopener noreferrer"` 追加后不还原（`link-interceptor.js:242-260`，与「无损还原」注释矛盾）
  - options 时间树跨月自然周生成重复 `node_week_<key>` id（`options.js:165` 附近）
  - `||` 回退使 0 值配置失效（`frequency-rule.js` 多处）
  - 恢复组串行逐标签 `tabs.create`（`stash-service.js:259`），大批量恢复较慢
  - `restoreFullBackupJSON` 对 config/linkRules 无 schema 白名单
  - `OnetabConverter.autoParse` if/else 链空数组遮蔽后续字段
  - `addChangeListener` 无去重、`getStorageArea` sync 静默回退 local
  - `form-detector.js` 每次调用全文档三组选择器扫描；`link-interceptor.js` 全量 mouseover + MutationObserver 全子树扫描开销较大

---

## ✅ 值得肯定的地方

- 分层架构清晰（core 纯逻辑 / background / content 双层世界 / UI），规则引擎责任链 + 策略模式扩展性良好
- URL 清洗具备 trim + 8192 上限 + 伪协议黑名单 + 协议补齐 + 白名单（`sanitizeImportUrl` / `sanitizeUrl`），导入侧安全防御扎实
- 中文注释与 UTF-8 无 BOM 合规良好；错误路径普遍有 catch + 中文提示
- `main-world-bridge.js` 使用捕获阶段 + `stopImmediatePropagation` 方案正确解决 SPA 路由劫持问题（架构层面正确）
- 测试覆盖了核心收纳/恢复/容错导入/阈值冷却等关键链路（15 个用例通过，但 2 个失效）

---

## 📋 修复优先级建议

1. **立即**：#1（补 import StorageKeys）、#5（对齐 stashSettings/schema v3 或改测试）、#4（`deno task bundle` + verify 增加产物一致性校验）
2. **高**：#2 / #3（统一配置键名与 ActionTypes 契约 —— 建议以「后台实际消费的键」为唯一真值，并把 ActionTypes 缺漏的 4 个域名规则动作补上）、#6（stashSettings 无消费方，确定取舍）
3. **中**：#7 / #8（URL 协议白名单 + 收纳写入失败中止关闭）、#9 / #10 / #11（MV3 生命周期改造：alarms + storage.session 持久化 + 单一权威倒计时）
4. **其余**：按 #12-#19 → 低危清单顺序排期；每项修复后补对应单测（目前 `link-matcher` / `rule-engine` / `frequency-rule` 无单元测试，是主要覆盖盲区）

---

*本报告由 code-reviewer skill 驱动生成；所有 🔴/🟠 级条目均已对照原文逐行复核，证据片段与文件行号一致。*
