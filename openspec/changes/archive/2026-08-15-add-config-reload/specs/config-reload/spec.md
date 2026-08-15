## Purpose

提供与 pi 原生 reload 等价的能力：通过 REST 端点重载所有活跃会话的 agent 运行时，
并在 Settings → General 界面提供 Restart 按钮入口，让用户修改配置后无需新建会话即可生效。

## ADDED Requirements

### Requirement: Config reload endpoint
The system SHALL expose `POST /api/v1/config/reload`, which reloads the agent
runtime of every live session with pi native reload semantics: `settings.json` is
re-read, API providers and credentials are refreshed, the resource loader is
reloaded (extensions, skills, prompts, themes, and context files), and the tool
registry is rebuilt. Custom tools supplied at session creation (MCP-bridged
tools, ask/todo/process tools, orchestration tools) SHALL be preserved across
the reload. A session that is mid-run SHALL have its in-flight agent run aborted
as part of the reload.

#### Scenario: Reload with live sessions
- **WHEN** a client sends `POST /api/v1/config/reload` while one or more sessions are live
- **THEN** every live session reloads its agent runtime using pi native reload semantics
- **AND** the response is `200` with `{ "reloaded": N, "failures": [] }` where N is the number of live sessions

#### Scenario: No live sessions
- **WHEN** a client sends `POST /api/v1/config/reload` and no session is live
- **THEN** the response is `200` with `{ "reloaded": 0, "failures": [] }`

#### Scenario: Per-session reload failure
- **WHEN** a session's reload fails but at least one other session reloads successfully
- **THEN** the response is `200` with `reloaded` counting the successful sessions
- **AND** `failures` contains one entry per failed session, each with the session id and an error message

#### Scenario: Every session fails to reload
- **WHEN** reload fails for every live session
- **THEN** the response is `500` with `{ "error": "agent_error", "message": ... }`

### Requirement: Per-session reload endpoint
The system SHALL expose `POST /api/v1/sessions/:id/reload`, which reloads the
agent runtime of the specified live session with the same pi native reload
semantics as the config reload endpoint (`settings.json` re-read, API providers
and credentials refreshed, resource loader reloaded, tool registry rebuilt,
custom tools preserved, in-flight run aborted). A request for a session that is
not live SHALL be answered with `404`. A request for a session that is
externally active (owned by another client such as the pi TUI) SHALL be
rejected. A reload failure SHALL be answered with `500` `agent_error`.

#### Scenario: Reload a live session
- **WHEN** a client sends `POST /api/v1/sessions/:id/reload` for a live session
- **THEN** that session's agent runtime is reloaded with pi native reload semantics
- **AND** the response is `200` with `{ "sessionId": ..., "reloaded": true }`

#### Scenario: Unknown session
- **WHEN** a client sends `POST /api/v1/sessions/:id/reload` for a session that is not live
- **THEN** the response is `404` with `{ "error": "session_not_found" }`

#### Scenario: Externally active session
- **WHEN** a client sends `POST /api/v1/sessions/:id/reload` for an externally active session
- **THEN** the request is rejected (non-200) with an error identifying the external session

#### Scenario: Reload fails
- **WHEN** the session's reload throws
- **THEN** the response is `500` with `{ "error": "agent_error", "message": ... }`

### Requirement: Settings General restart button
The Settings → General pane SHALL provide a "Restart" button that triggers the
config reload endpoint. The button SHALL require an explicit confirmation before
sending the request, SHALL show a pending state while the request is in flight,
and SHALL surface a success or error message afterwards.

#### Scenario: Trigger reload from the UI
- **WHEN** the user clicks Restart in Settings → General and confirms the prompt
- **THEN** the client sends `POST /api/v1/config/reload`
- **AND** the button shows a pending state until the request completes
- **AND** on success the UI shows a message with the number of sessions reloaded (or notes that no session was active)

### Requirement: Session toolbar reload action
The ChatView toolbar SHALL provide a per-session reload action for the currently
viewed session. The action SHALL require an explicit confirmation before sending
the request, SHALL show a pending state while the request is in flight, and
SHALL surface a success or error message afterwards.

#### Scenario: Reload the current session from the toolbar
- **WHEN** the user clicks Reload in the ChatView toolbar and confirms the prompt
- **THEN** the client sends `POST /api/v1/sessions/:id/reload` for the current session
- **AND** the button shows a pending state until the request completes
- **AND** on success the UI shows a success message for the reloaded session

#### Scenario: Per-session reload fails from the UI
- **WHEN** the reload request fails (HTTP error, including `500` `agent_error`)
- **THEN** the UI shows an error message
- **AND** the chat view remains usable so the user can retry

#### Scenario: Unknown session from the UI
- **WHEN** the reload request returns `404` `session_not_found` (session no longer live)
- **THEN** the UI shows an error message explaining the session is no longer active
