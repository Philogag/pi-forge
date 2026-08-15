## Why

pi TUI 有 `/reload` 命令（等价于 SDK 的 `AgentSession.reload()`），用于在修改
settings.json、扩展、skills、prompts、themes 或上下文文件后立即重载 agent 运行时，
无需新建会话。pi-forge 目前没有对应能力：用户改了配置后，要么新建会话，要么
等待会话自然重建，活跃会话始终带着启动时的旧配置运行。需要一个 REST 端点暴露
这一重载能力，并在 UI 中提供入口（Settings → General 的 Restart 按钮）。

## What Changes

- **新增** `POST /api/v1/config/reload` 端点：对所有活跃会话调用 SDK 的
  `session.reload()`（pi 原生 reload 语义）——重读 `settings.json`、重置
  API provider/auth、重载 resource loader（extensions、skills、prompts、themes、
  上下文文件）、重建工具注册表。`_customTools`（MCP 桥接工具、ask/todo/process、
  orchestration 工具）在 SDK 重建时保留，工具 allowlist 重新生效。
- **新增** `POST /api/v1/sessions/:id/reload` 端点：仅重载指定活跃会话的
  agent 运行时（与全局端点相同的 pi 原生 reload 语义）；会话不存在 → 404，
  外部活跃会话（pi TUI 独占）→ 拒绝。
- **新增** UI 入口：Settings → General 增加 "Restart" 按钮（调用全局端点），
  ChatView 工具栏增加会话级 Reload 按钮（调用单会话端点），均带确认与
  进行中/成功/失败反馈。
- **明确不在范围**：不重读 `mcp.json`（MCP 配置在保存时已通过
  `mcp/manager.reloadGlobal()` 即时生效，不属于 pi 原生 reload 语义）；不重启
  pi-forge 服务器进程（单容器部署，重载会话运行时即可达到目的）。

## Capabilities

### New Capabilities

- `config-reload`: 通过 REST 端点重载 agent 运行时（pi 原生 reload 语义）：
  全局端点重载所有活跃会话、单会话端点重载指定会话；UI 提供 Settings →
  General 的 Restart 按钮与会话工具栏的 Reload 按钮入口。

### Modified Capabilities

<!-- 无既有 capability 的 REQUIREMENTS 发生变化。 -->

## Impact

- `packages/server/src/routes/config.ts`：新增 `POST /api/v1/config/reload` 路由
  （config 路由面，注册方式不变）。
- `packages/server/src/session-registry.ts`：新增重载会话的注册表函数（单会话
  核心 `reloadSession(sessionId)` 与遍历调用的 `reloadAllLiveSessions()`，均带
  超时保护并汇总失败）。
- `packages/server/src/routes/control.ts`：新增 `POST /api/v1/sessions/:id/reload`
  路由（会话级控制面，复用 `requireLiveOrRejectExternal` 的 404/外部会话处理）。
- `packages/client/src/lib/api-client/index.ts`：新增 `reloadConfig()` API 调用。
- `packages/client/src/components/SettingsPanel.tsx`：`GeneralTab` 增加 Restart
  按钮（带确认 + 状态反馈）。
- `packages/client/src/components/ChatView.tsx`：会话工具栏增加 Reload 按钮
  （带确认 + 状态反馈）。
- SDK 依赖：`AgentSession.reload()`（已有能力，无需升级）。
