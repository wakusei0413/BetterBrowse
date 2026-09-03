# 后台动作契约维护清单

新增或调整后台动作时，必须确认：

1. `src/constants/action-types.js` 增加动作常量；
2. `src/background/action-handlers.js` 增加共享 handler；
3. `src/core/ai/ai-capabilities.js` 增加 `AI_ACTION_DOCS` 参数文档；不可逆动作加入 `AI_CONFIRM_REQUIRED_ACTIONS`；
4. 若内容脚本调用，更新 `src/core/security/message-authorizer.js` 的 `CONTENT_ALLOWED_ACTIONS`；
5. 若人类 UI 调用，更新 `tests/ai-bridge.test.js` 的 `HUMAN_UI_ACTIONS`。

`deno task verify` 现在会自动检查 handler、AI 文档、确认位、内容白名单和人类 UI 对等关系，具体是否属于不可逆语义仍需人工判断。
