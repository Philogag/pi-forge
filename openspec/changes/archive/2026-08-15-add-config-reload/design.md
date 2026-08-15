## Context

- SDK 已提供 pi 原生 reload：`AgentSession.reload()`（`dist/core/agent-session.js:2052`）依次执行
  `settingsManager.reload()`（重读 settings.json）、队列模式同步、`resetApiProviders()`（重读
  auth/providers）、`resourceLoader.reload()`（extensions、skills、prompts、themes、上下文文件）、
  `_buildRuntime()`（重建 extension runner 与工具注册表）。`_buildRuntime` 内
  `_refreshToolRegistry` 会保留 `this._customTools`（pi-forge 注入的 MCP 桥接工具、
  ask/todo/process、orchestration 工具）并重新应用 allowlist。
- reload 期间 SDK 发出 `session_shutdown(reason: "reload")` 与 `session_start(reason: "reload")`；
  pi-forge 的 `makeSubscribeHandler`（`packages/server/src/session-registry.ts:485`）按事件类型
  分发、未知类型静默忽略（符合 AGENTS.md 约定 12）。`bindWebExtensionContext` 的绑定在 runner
  重建后依然有效（SDK 在执行时读取 `this._extensionRunner`）。
- pi-forge 约束：路由不得直接 import `AgentSession`（约定 3），所有会话操作走
  `session-registry.ts`；活跃会话由 `listSessions()` 枚举（`LiveSession.session` 即 SDK
  AgentSession）。MCP 是 pi-forge 自有层，保存时已通过 `mcp/manager.reloadGlobal()` 即时生效
  （routes/mcp.ts:235/345/376），不属于 pi 原生 reload 语义。
- 现有超时防护模式：`routes/control.ts` 的 `withTimeout`/`TimeoutError`（30s，setModel 防挂起）；
  `session-registry.rebuildAgentSessionForTools` 用 5s `Promise.race` 兜底 abort。

## Goals / Non-Goals

**Goals:**
- 一个端点为所有活跃会话触发 SDK 原生 reload（非重建会话对象）。
- 一个端点（会话级）为指定活跃会话触发同样的 SDK 原生 reload。
- 单会话失败隔离：一个会话 reload 失败不影响其余会话。
- Settings → General 提供带确认与状态反馈的 Restart 按钮；ChatView 工具栏提供会话级 Reload 按钮（同样带确认与状态反馈）。

**Non-Goals:**
- 不重读 `mcp.json`（MCP 保存时已即时生效）。
- 不重启 pi-forge 进程、不做进程级 supervisor 集成。

## Decisions

1. **路由位置：`POST /api/v1/config/reload`，加入 `routes/config.ts`** — 与既有
   `/config/*` 路由同面，注册方式不变（插件在 `index.ts` 注册）；默认私有（需认证）。
   备选：放 `routes/control.ts`（被否 — 该面以 `:id` 会话级控制为主，reload 是配置/运行时级）。

2. **注册表函数 `reloadAllLiveSessions()`（session-registry.ts）** — 遍历 `listSessions()`，
   对每个 `live.session` 调 `session.reload()`；每个会话用 `Promise.race` 包 30s 超时
   （对齐 setModel 的挂起防御），失败捕获为 `{ sessionId, error }`。返回
   `{ reloaded, failures }`。路由只调该函数，不 import AgentSession。
   备选：路由内联（被否 — 违反约定 3）；复用 `rebuildAgentSessionForTools`（被否 — 它是
   dispose+重建整个 AgentSession 的重型路径，且不重读 settings/providers，语义不同于
   pi 原生 reload；原生 reload 原地完成、更轻且为正确语义）。

3. **响应契约** — 部分成功：`200 { reloaded, failures: [{ sessionId, error }] }`；
   无活跃会话：`200 { reloaded: 0, failures: [] }`；全部会话失败（failures 非空且
   reloaded === 0）：`500 { error: "agent_error", message }`（对齐约定 14：SDK 崩溃 → 500）。
   用 `failures.length` 区分"无会话"与"全失败"两种 0 情况。

4. **进行中会话立即中断，不等待** — SDK reload 自身发出 session_shutdown 并作废旧 runner，
   进行中的 run 随之终止。端点不做 `waitForIdle()`，语义与 pi TUI `/reload`（即时执行）
   一致；UI 确认框会明确警告用户。备选：先 waitForIdle（被否 — 无界延迟与复杂度，且按钮
   为用户主动触发、确认框已提示）。

5. **客户端 `reloadConfig()`（api-client/index.ts）** — `request("/api/v1/config/reload",
   vReloadResult, { method: "POST" })`，validator 校验 `{ reloaded: number, failures: [...] }`。
   所有浏览器 HTTP 走 api-client（约定 11）。

6. **UI：GeneralTab（SettingsPanel.tsx）新增 Restart 区块** — 位于 Version 区块之后；带确认
   提示（警告将中断进行中的 agent 运行）；请求期间按钮进入 pending 并禁用；完成后内联展示
   成功/失败消息（成功：`Restarted N session(s)`；`reloaded === 0` 时提示"没有活跃会话，
   更改将在新会话生效"）。GeneralTab 目前无 `onError` prop，用组件内局部状态承载
   pending/error/success。

7. **无浏览器刷新、无 store 变更** — reload 是服务端会话内重载，SSE 连接与客户端状态不受影响；
   session_shutdown/start 事件经既有 subscribe handler 泛化处理。

8. **会话级路由：`POST /api/v1/sessions/:id/reload`，加入 `routes/control.ts`** — 与
   `/sessions/:id/model`、`/sessions/:id/thinking-level` 同属会话级控制面；复用
   `requireLiveOrRejectExternal`（不存在 → 404 session_not_found；外部活跃会话 → 拒绝）。
   备选：放 routes/config.ts（被否 — 该面承载 `/config/*` 配置读写，会话级路径属于 control 面）。

9. **注册表函数：`reloadSession(sessionId)`（单会话核心）+ `reloadAllLiveSessions()` 委托复用** —
   单会话核心对 `live.session.reload()` 包 30s 超时并归一错误；全局函数遍历 `listSessions()`
   逐会话调用同一核心（与决策 2 同构）。避免两处重复实现。

10. **单会话响应契约** — 成功：`200 { sessionId, reloaded: true }`；会话非 live：
    `404 { error: "session_not_found" }`；外部活跃会话：复用 `requireLiveOrRejectExternal`
    的既有拒绝语义（非 200 + 错误码）；reload 抛错：`500 { error: "agent_error", message }`
    （对齐约定 14）。

11. **会话级 UI：ChatView 工具栏 Reload 按钮（右侧按钮组，Export/Tree/Orch 同排）** —
    点击弹确认（警告将中断该会话进行中的 run，与 General 的 Restart 一致）；请求期间
    pending 并禁用；内联成功/失败反馈；404 时提示"会话已不在活跃"。调用 api-client 的
    `reloadSession(sessionId)`。

## Risks / Trade-offs

- [外部活跃会话（pi TUI 独占）无法 reload] → 端点按 `requireLiveOrRejectExternal` 语义拒绝；
  ChatView 只渲染服务端托管的会话，正常路径不会触发。
- [进行中 run 被 reload 中断] → 确认框明示警告；已流式输出的内容仍保留在聊天中；路由描述
  文档化该行为。
- [SDK reload 挂起] → 每会话 30s 超时（`Promise.race`），失败进入 `failures` 而非阻塞请求。
- [新加的 MCP 服务器不会在 reload 后出现（customTools 在会话创建时固化）] → 接受：与 pi
  原生 reload 范围一致；MCP 保存时已即时重载，新会话自动拾取。
- [无活跃会话时端点"看起来没做事"] → UI 明确提示"没有活跃会话"；配置本就在下次会话创建时生效。

## Migration Plan

- 服务端与客户端同仓同发（一个 PR）；无配置/数据迁移。部署：`npm run build` 后重启 pi-forge。
  回滚：还原该提交。
