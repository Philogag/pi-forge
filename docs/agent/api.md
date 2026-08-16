# Agent Notes: API and SSE

Read this when changing REST routes, OpenAPI schemas, auth visibility, SSE serialization, or browser stream handling.

## Programmatic API

All routes are under `/api/v1/`. The same routes used by the browser UI are usable
by any HTTP client. Interactive docs are at `/api/docs` (Swagger UI). The raw
OpenAPI JSON spec is at `/api/docs/json`.

Authentication for programmatic clients: set `API_KEY` in the environment and
include it as `Authorization: Bearer <key>` on every request.

### Minimal curl workflow

```bash
BASE=http://localhost:3000
KEY=your-api-key

# 1. List projects
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/projects

# 2. Create a session under a project
SESSION=$(curl -s -X POST $BASE/api/v1/sessions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>"}' | jq -r '.sessionId')

# 3. Send a prompt (fire and forget — response comes via SSE)
curl -s -X POST $BASE/api/v1/sessions/$SESSION/prompt \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Write a test suite for the auth module"}'

# 4. Stream the response (ctrl+c when done)
curl -N -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/stream

# 5. Abort if needed
curl -X POST $BASE/api/v1/sessions/$SESSION/abort \
  -H "Authorization: Bearer $KEY"
```

### SSE event stream format

Each SSE message is a single `data:` line followed by two newlines:
```
data: {"type":"agent_start","sessionId":"..."}

data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}

data: {"type":"agent_end","sessionId":"..."}

```

Clients should parse `event.type` and handle each type. See `docs/sse-events.md`
for the full event catalogue with example payloads. Unknown event types should be
silently ignored — new types may be added in future versions.

### OpenAPI spec

Every route has JSON Schema on its request body and response. `@fastify/swagger`
collects these automatically — do not maintain a separate spec file. When adding a
new route, always include:
- `schema.description` — one plain English sentence
- `schema.body` — for POST/PUT routes
- `schema.response` — at minimum `{ 200: {...}, 400: {...} }`
- `schema.tags` — one of: `sessions`, `projects`, `config`, `files`, `git`, `auth`

The preHandler auth hook is applied globally. The `/api/v1/health` and
`/api/v1/auth/*` routes are explicitly excluded from the auth hook and marked
with `security: []` in their schema to reflect this in the spec.

---

## Plugin Configs

Pi extensions can register configuration-form metadata for their own config
file by emitting `pi-extension-settings:register` (the contract used by
`@juanibiapina/pi-extension-settings`) at load time; pi-forge captures these
declarations at startup and merges them with manual registrations from
`packages/server/src/extensions-settings-compat/index.ts` (for plugins that don't emit the event).
The merged registry drives a generated settings form in the browser
(Settings → Extensions → gear icon on a package card) and a raw-JSON editor.

| Endpoint | Description |
|---|---|
| `GET /api/v1/config/plugin-configs` | List all declarations; each item has `package`, `label`, `description?`, `file` (relative to `PI_CONFIG_DIR`), `source` (`extension-event`\|`compat`), `fields`, `exists`, `values` (current file values). Top-level `ready` (capture finished) and `errors` (capture diagnostics). A missing or invalid file still returns the declaration (`exists: false` or empty values) — the list never fails wholesale. |
| `GET /api/v1/config/plugin-configs/:package` | Single declaration summary; unknown package → 404 `not_found`. |
| `PUT /api/v1/config/plugin-configs/:package` | Save. Body is `{ values: { path: value } }` (partial field update — unknown keys in the target file are preserved) or `{ raw: "…" }` (atomic whole-file replace after JSON validation; may contain keys outside the declaration). `values` and `raw` are mutually exclusive → 400. Field values for `settings-extensions.json` are string-coerced to match pi's `getSetting` semantics. Errors: 400 `validation_failed`/`invalid_json`, 403 `traversal`, 404 `not_found`, 500 `agent_error`. |
| `POST /api/v1/config/plugin-configs/reload` | Fire-and-forget registry refresh (re-runs extension capture in the background). Poll the GET list until `ready: true` to observe the result. |

All file writes are atomic (`tmp` + `rename`); traversal outside `PI_CONFIG_DIR`
is rejected with 403 before any read/write. The full endpoint contract lives in
the OpenAPI spec at `/api/docs/json`.

---

## SSE Event Types

The following `AgentSessionEvent` types are forwarded to browser clients.
All others are filtered out in `sse-bridge.ts`.

| Type | When | UI action |
|---|---|---|
| `snapshot` | On SSE connect | Hydrate full message list |
| `agent_start` | Agent begins processing | Show thinking spinner |
| `agent_end` | Agent finishes | Hide spinner, enable input, refresh git status |
| `turn_start` | LLM call begins | (internal, track for context inspector) |
| `turn_end` | LLM call ends | (internal) |
| `message_start` | New assistant message begins | Create message bubble |
| `message_update` | Token delta or content update | Append to streaming message |
| `message_end` | Assistant message complete | Finalize message |
| `tool_execution_start` | Tool begins | Show tool badge |
| `tool_execution_update` | Tool streaming output | Update tool output |
| `tool_execution_end` | Tool complete | Finalize tool block |
| `tool_call` | Tool invoked (pre-execution) | (can be used for permission UI) |
| `tool_result` | Tool result received | Render result block |
| `queue_update` | Steer/followUp queue changed | Show queued message badges |
| `compaction_start` | Context compaction begins | Show compaction banner |
| `compaction_end` | Compaction complete | Hide banner |
| `auto_retry_start` | Auto-retry triggered | Show retry indicator + countdown |
| `auto_retry_end` | Retry finished | Hide retry indicator |

---

## Error Handling Patterns

**Route handlers:**
- Session not found → 404 `{ error: "session_not_found" }`
- Path outside project root → 403 `{ error: "path_not_allowed" }`
- Validation failure → 400 (Fastify schema validation handles this automatically)
- SDK error (agent crash, LLM error) → 500 `{ error: "agent_error", message }`
- Git command failure → 200 with `{ success: false, error: string }` — git errors
  are user-visible events, not server errors

**Never:**
- Throw unhandled errors in route handlers — always catch and return structured responses
- Return raw `stderr` from git or bash commands to the client — sanitize first
- Return stack traces to the client in production

**SSE errors:**
If the SSE connection drops, the client auto-reconnects with exponential backoff
(implemented in `sse-client.ts`). On reconnect, the snapshot event re-hydrates
state. No special server handling needed for dropped SSE connections — the server
simply removes the client from the `LiveSession.clients` Set on the `close` event.

---
