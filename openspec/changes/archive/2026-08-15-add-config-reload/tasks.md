## 1. 服务端：注册表 reload 函数

- [x] 1.1 在 `packages/server/src/session-registry.ts` 新增单会话核心 `reloadSession(sessionId)`：对 `live.session` 调用 SDK `session.reload()`，用 `Promise.race` 包 30s 超时（对齐 `routes/control.ts` setModel 的挂起防御模式），失败归一为 `{ sessionId, error }`；`reloadAllLiveSessions()` 遍历 `listSessions()` 委托同一核心，返回 `{ reloaded, failures }`
- [x] 1.2 补充函数注释：说明语义等价 pi 原生 reload（重读 settings/providers、重载 resource loader、重建工具注册表，customTools 保留），进行中的 run 会被 session_shutdown 中断；单会话核心被全局函数复用

## 2. 服务端：REST 端点

- [x] 2.1 在 `packages/server/src/routes/config.ts` 新增 `POST /api/v1/config/reload`：调用 `reloadAllLiveSessions()`；返回 `200 { reloaded, failures }`；无活跃会话时 `200 { reloaded: 0, failures: [] }`；全部会话失败（failures 非空且 reloaded === 0）时 `500 { error: "agent_error", message }`
- [x] 2.2 在路由 schema 中写 OpenAPI description（tags: ["config"]），文档化：等价 pi 原生 reload、进行中 run 会被中断、不重读 mcp.json
- [x] 2.3 运行 `npm run check`（tsc + eslint + prettier）确认服务端改动通过
- [x] 2.4 在 `packages/server/src/routes/control.ts` 新增 `POST /api/v1/sessions/:id/reload`：复用 `requireLiveOrRejectExternal`（不存在 → 404 `session_not_found`；外部活跃会话 → 拒绝），调用 `reloadSession(id)`；成功返回 `200 { sessionId, reloaded: true }`，reload 抛错返回 `500 { error: "agent_error", message }`；OpenAPI description 文档化会话级语义

## 3. 客户端：API 调用

- [x] 3.1 在 `packages/client/src/lib/api-client/index.ts` 新增 `reloadConfig()`：`request("/api/v1/config/reload", vReloadResult, { method: "POST" })`，validator 校验 `{ reloaded: number, failures: [{ sessionId, error }] }`
- [x] 3.2 新增 `reloadSession(sessionId)`：`request("/api/v1/sessions/:id/reload", vSessionReloadResult, { method: "POST" })`，validator 校验 `{ sessionId, reloaded: true }`；复用会话路径编码模式（如 `/sessions/${encodeURIComponent(id)}/model`）

## 4. 客户端：Settings → General Restart 按钮

- [x] 4.1 在 `packages/client/src/components/SettingsPanel.tsx` 的 `GeneralTab` 新增 Restart 区块（Version 区块之后）：Restart 按钮 + 确认提示（警告将中断进行中的 agent 运行）
- [x] 4.2 点击后调用 `reloadConfig()`；请求期间按钮 pending 并禁用；完成后内联展示成功消息（`Restarted N session(s)`，`reloaded === 0` 时提示"没有活跃会话"）或错误消息，面板保持打开可重试
- [x] 4.3 运行 `npm run check` 确认客户端改动通过
- [x] 4.4 在 `packages/client/src/components/ChatView.tsx` 工具栏右侧按钮组（Export/Tree/Orch 同排）新增 Reload 图标按钮：点击弹确认（警告将中断该会话进行中的 agent 运行）；请求期间按钮 pending 并禁用；完成后内联展示成功消息或错误消息（404 时提示"会话已不在活跃"）

## 5. 集成测试

- [x] 5.1 在 `tests/test-config.ts` 新增 reload 用例：无活跃会话时 `POST /api/v1/config/reload` 返回 `200 { reloaded: 0, failures: [] }`；存在活跃会话时返回 `reloaded >= 1` 且端点不报错
- [x] 5.2 在 `tests/test-config.ts`（或 `tests/test-api.ts`）新增单会话 reload 用例：未知会话 id → 404 `session_not_found`；活跃会话 → 200 `{ reloaded: true }`
- [x] 5.3 运行 `scripts/run-tests.sh --only config` 确认通过
