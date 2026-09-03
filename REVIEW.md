# ⚠️ 历史审查快照

> 本文档是 **2026-09-01 的历史审查快照，不代表当前状态**。当前维护入口以 `AGENTS.md` 与 `docs/` 下的设计、测试和运行手册为准。
>
> 截至 2026-09-03，以下历史高优先级问题已在代码中核实修复：closed Shadow DOM 倒计时卡片、倒计时确认 nonce、popup 生命周期端口来源校验、组快照 URL 清洗。本文其余结论仍保留作历史记录，不能直接作为发布前诊断。

# BetterBrowse 诊断报告

审查日期：2026-09-01  
范围：`BetterBrowse/src`、`scripts`、`native-host`、仓库根目录 `tests/`、扩展配置、文档、`skills/better-browse`  
工作树现状：消息来源鉴权已落地；测试目录从 `BetterBrowse/tests` 挪到仓库根 `tests/`；选项页大改版；右键增加「收纳当前标签分组」；30 天回收站 UI/action 已撤，墓碑写入仍留给 WebDAV。  
本报告只诊断，不改业务代码。过度工程项是候选清理，不能直接删。

## 当前判断

上一份报告里的 H-1（内容脚本把整套后台 action 暴露出去）在 `onMessage` 这条路上已经补上了。`MessageBus.registerListener` 会走 `isActionAuthorized`，内容脚本只剩 5 个白名单动作，未知来源一律拒绝。选项页带着 `sender.tab` 打开时仍判为 `internal`，这条回归也有测试。

普通网页主世界本来就不能直接 `chrome.runtime.sendMessage`。鉴权防的是：隔离世界内容脚本、以后若出现消息转发漏洞、以及 `externally_connectable`。网页真正够得着的，是内容脚本主动接出去的桥——倒计时按钮、主世界自定义事件、新标签模式下的点击拦截。这些还没按同样标准收口。

## 一、已证实问题

### 高：倒计时卡片用了 open Shadow DOM，网页可以替用户点「立即收纳 / 取消」

**位置**

- [`BetterBrowse/src/content/countdown-banner.js:61`](BetterBrowse/src/content/countdown-banner.js#L61)
- [`BetterBrowse/src/content/countdown-banner.js:349-365`](BetterBrowse/src/content/countdown-banner.js#L349-L365)
- [`BetterBrowse/src/background/action-handlers.js:208-215`](BetterBrowse/src/background/action-handlers.js#L208-L215)
- [`BetterBrowse/src/core/security/message-authorizer.js:25-31`](BetterBrowse/src/core/security/message-authorizer.js#L25-L31)

**证据**

Host 挂在 `document.body` 上，`attachShadow({ mode: 'open' })`。隔离世界把 click 绑在 `#btnStashNow` / `#btnCancel` 上。`CONFIRM_AUTO_STASH` / `CANCEL_AUTO_STASH` 在内容脚本白名单里，后台只看倒计时是否进行中，不区分是不是用户点的扩展 UI。阈值倒计时会广播到所有 http(s) 标签。

**复现**

标签数过阈值、倒计时出现后，在任意 http 页的控制台：

```js
document.querySelector('better-browse-countdown-root')
  .shadowRoot.getElementById('btnStashNow').click();
```

闲置标签会被收纳并关闭。点 `btnCancel` 则进入冷却，自动收纳被压住。

**影响**

恶意页可以在倒计时期间静默收纳/关标签，或反复取消自动收纳。不依赖 AI 桥接。

**修复**

`attachShadow({ mode: 'closed' })`。不要把 Host 暴露成页面能 `querySelector` 到的自定义标签（或给随机名）。后台可再加一次性 nonce，只有当前 banner 实例能带上。`HTMLElement.click()` 在 Chrome 里 `isTrusted` 为 true，单靠 `isTrusted` 挡不住。

---

### 高：主世界自定义事件在 AUTO 模式下仍能开标签

**位置**

- [`BetterBrowse/src/content/link-interceptor.js:85-113`](BetterBrowse/src/content/link-interceptor.js#L85-L113)
- [`BetterBrowse/src/content/main-world-bridge.js:145-156`](BetterBrowse/src/content/main-world-bridge.js#L145-L156)
- [`BetterBrowse/src/background/action-handlers.js:151-183`](BetterBrowse/src/background/action-handlers.js#L151-L183)

**证据**

主世界只在模式为 `new` 时派发 `__BETTER_BROWSE_OPEN_NEW_TAB__`。隔离世界的监听没有再查 `getEffectiveMode()`。`navigator.userActivation.isActive` 在一次真实点击后会保持一段时间，不是「仅同步调用栈」。窗口是 10 秒 10 次。内容脚本 `all_frames: true`，第三方 iframe 同样能发。后台只校验 `http:` / `https:`，没有速率限制，也不看当前模式。

**复现**

任意模式（含自动）下，用户点一下页面后：

```js
document.addEventListener('click', () => {
  for (let i = 0; i < 10; i++) {
    window.dispatchEvent(new CustomEvent('__BETTER_BROWSE_OPEN_NEW_TAB__', {
      detail: { url: 'https://example.com/' + i }
    }));
  }
}, { once: true });
```

扩展会用 `tabs.create` 打开标签，绕过页面弹窗拦截。

**修复**

隔离世界只在 `getEffectiveMode() === 'new'` 时处理该事件。把速率限制收到「每次手势 1 次」。后台也可以按 `sender.tab` 再限流。

---

### 中：新标签模式下，隔离世界点击路径没有速率限制

**位置**

- [`BetterBrowse/src/content/link-interceptor.js:208-215`](BetterBrowse/src/content/link-interceptor.js#L208-L215)
- [`BetterBrowse/src/content/link-interceptor.js:383-403`](BetterBrowse/src/content/link-interceptor.js#L383-L403)

**证据**

捕获阶段监听 `click`。模式为 `new` 时直接 `OPEN_TAB_BACKGROUND`，不走 `shouldAllowOpenEvent()`，也不看 `userActivation`。`a.click()` 会进这条路径。

**复现**

把当前站设成「新标签页打开」后：

```js
for (let i = 0; i < 50; i++) {
  const a = document.createElement('a');
  a.href = 'https://example.com/' + i;
  document.body.appendChild(a);
  a.click();
}
```

**修复**

和自定义事件共用同一套手势 + 速率门。合成点击直接丢掉。

---

### 中：弹窗生命周期端口绕过了消息鉴权

**位置**

- [`BetterBrowse/src/background/service-worker.js:153-162`](BetterBrowse/src/background/service-worker.js#L153-L162)
- [`BetterBrowse/src/popup/popup.js:25`](BetterBrowse/src/popup/popup.js#L25)

**证据**

任意 `chrome.runtime.connect({ name: 'popup-lifecycle' })` 在 800ms 内断开，就会 `EXECUTE_STASH({ forceAll: true })`。这条走 `onConnect`，不经过 `isActionAuthorized`。内容脚本有 `connect()`。当前 `content-bundle.js` 没有调用它，普通网页主世界也调不了；但和 H-1 的威胁模型不一致——隔离世界一旦能跑代码，就能全窗口收纳。

**修复**

只接受 popup：`port.sender.url` 必须是本扩展 `popup.html`。带 `sender.tab` 的内容脚本来源直接忽略。

---

### 中：组快照恢复不清洗 URL

**位置**

- [`BetterBrowse/src/core/stash/local-stash-repo.js:974-991`](BetterBrowse/src/core/stash/local-stash-repo.js#L974-L991)
- [`BetterBrowse/src/core/stash/indexed-stash-repo.js:1187-1193`](BetterBrowse/src/core/stash/indexed-stash-repo.js#L1187-L1193)
- [`BetterBrowse/src/background/action-handlers.js:387-388`](BetterBrowse/src/background/action-handlers.js#L387-L388)
- [`BetterBrowse/src/core/ai/ai-capabilities.js:26-36`](BetterBrowse/src/core/ai/ai-capabilities.js#L26-L36)

**证据**

`addTabItemToGroup` / 导入走 `OneTabConverter.sanitizeUrl`。`restoreGroupSnapshot` 把 `snapshotGroup.tabs` 原样交给 `importGroups`，只要求 `tab.url` 非空。选项页 5 秒撤销走这条；AI 的 `RESTORE_STASH_GROUP_DATA` 也走这条，且不在 `AI_CONFIRM_REQUIRED_ACTIONS` 里。选项页左键恢复会 `preventDefault`，中键/「在新标签打开」仍可能碰到未清洗协议。

**修复**

恢复前走 `_normalizeImportedGroups`。AI 这条补确认位。

---

### 低：`verify-code.js` 没把鉴权模块列入清单

**位置**

- [`BetterBrowse/scripts/verify-code.js:12-70`](BetterBrowse/scripts/verify-code.js#L12-L70)

**证据**

`allJsFiles` 有 bus / AI / sync / background / content，没有 `src/core/security/message-authorizer.js`。文件缺失或带 BOM 时，`deno task verify` 不会红。

**修复**

加进清单。

---

### 低：关于页读了一个不存在的 DOM 节点

**位置**

- [`BetterBrowse/src/options/options.js:3322`](BetterBrowse/src/options/options.js#L3322)
- [`BetterBrowse/src/options/options.js:3352-3361`](BetterBrowse/src/options/options.js#L3352-L3361)

**证据**

`document.getElementById('aboutPlatformInfo')`，`options.html` 里没有这个 id。UA 嗅探永远不显示。

**修复**

删这段，或补节点。现在是死代码。

## 二、过度工程（只谈复杂度）

标签：`delete` 删掉，`shrink` 合并，`native` 用平台已有能力，`yagni` 当前没有第二处需求。

本次工作树已经砍掉一批旧死代码（`countGroups`、`getMultiple`、回收站 action 等），下面只列现在还在的。

- `BetterBrowse/src/options/options.js:60`：`native`：`CustomSelectEnhancer` 加对应 CSS，把原生 `<select>` 重做成自定义浮层。留 `.form-select`。这是产品观感选择，不是缺陷；要瘦身时这一项最肥。
- `BetterBrowse/src/options/options.js:1732` 与 `:2545`：`shrink`：两份相同的 `escapeHTML`，抽一个模块函数。
- `BetterBrowse/src/options/options.js:2177` 与 `:2340`：`shrink`：两份相同的 `flashSaveIndicator`。
- `BetterBrowse/src/options/options.html:1108`：`yagni`：禁用的「官网（筹备中）」按钮，没有 URL。
- `BetterBrowse/src/options/options.css:41`：`delete`：`--danger-hover` 定义了，没有 `var(--danger-hover)`。
- `BetterBrowse/src/popup/popup.css:305`：`delete`：`.stash-desc` 在 html/js 里没有对应 class。
- `BetterBrowse/src/popup/popup.css:41`：`delete`：`--radius-full`、`--shadow-xs` 只定义没用。
- `BetterBrowse/src/background/context-menu-manager.js:208` 与 `stash-service.js`：`shrink`：Chrome 标签分组颜色表重复，抽一个常量。

明确能删的死代码大约 80 行。如果连自定义下拉也换回原生 select，还能再砍大约 350 行。不要和安全修复混在同一个提交里。

`GET_PAGE_LINK_CONTEXT` 会把整份域名规则表发给内容脚本。`LinkMatcher.resolveEffectiveMode` 需要 www / 父域匹配，所以不能只回当前精确域名；最多改成只回当前 host 相关的几条。内容脚本隔离世界拿得到，页面默认拿不到。不当成缺陷。

## 三、不要因为「代码多」就删的部分

- IndexedDB 读失败回退旧存储、写失败不回退
- 写锁、惰性重建、缺表自愈、迁移幂等
- 实体与 outbox 同事务；WebDAV ETag / If-Match / 无 ETag 兼容模式
- 墓碑、watermark、操作去重（回收站 UI 撤了，同步墓碑还在）
- Native Messaging 分块、reqId 回填、超时、看门狗
- AI 确认位、凭据出口复查、人机对等测试
- MAIN / 隔离世界分层；表单保护；固定标签守护
- `classifySender` 只看 `sender.url`、不要求 `!sender.tab`（选项页在标签里打开）
- `tests/helpers/fake-indexeddb.js`

## 四、验证

已跑：

- `deno task test`：`117 passed`，`0 failed`（含 `tests/message-authorizer.test.js` 10 条）
- `deno task verify`：静态规范通过，随后测试同样 117 绿

现有测试覆盖鉴权函数和 H-1 回归，没有覆盖：open Shadow 被页面点击、自定义事件在 AUTO 下开标签、`popup-lifecycle` 来自内容脚本、`restoreGroupSnapshot` 写入危险协议。测试全绿排除不了上面几条。

未在真实 Chrome 里点一遍倒计时和链接拦截；报告里的复现步骤是按源码推的。

## 五、建议顺序

1. 倒计时改 closed shadow，并挡页面合成点击。
2. 自定义事件只在 `new` 模式处理；两条开标签路径共用速率限制。
3. `popup-lifecycle` 校验 `sender.url`。
4. 组快照恢复走 URL 清洗；AI 恢复补确认位。
5. `verify-code.js` 补上 `message-authorizer.js`。
6. 再删死 CSS、重复 helper、空的关于页字段。自定义下拉单独决定留不留。

**过度工程项（不含自定义下拉）：`net: -80 lines possible.`**  
**若连自定义下拉一起砍：`net: -430 lines possible.`**
