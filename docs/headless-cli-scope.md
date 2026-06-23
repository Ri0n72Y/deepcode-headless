# Headless CLI Parity Scope

This document records the current scope rule for the local HTTP server.

## Rule

Implement backend support for features that already exist in the CLI/TUI. Do not add backend-only product features that the CLI/TUI does not expose.

The server is an API surface for the existing DeepCode runtime. It is not a separate management backend.

## Included

The headless server should support these CLI/TUI equivalents:

- `/skills`: list skills.
- `/model`: read and update model, thinking mode, and reasoning effort.
- `/new`: start a fresh conversation.
- `/init`: submit the init command.
- `/resume`: show session list.
- `/continue`: continue active conversation or resume one if empty.
- `/undo`: list undo targets and restore conversation/code.
- `/mcp`: show MCP status and tools.
- `/exit`: close the server.
- Process display: expose active session processes.
- Bash timeout adjustment: expose active bash timeout adjustment.
- Permission replies: allow, deny-and-continue, deny-and-stop.
- Image input: support the same user prompt image path/data flow needed by the UI.

## Excluded

Do not implement these unless the CLI/TUI grows matching capabilities:

- Prompt queue.
- Multi-session concurrent execution.
- MCP server management, restart, enable/disable, or config editor.
- Provider profile management.
- API key or base URL write APIs.
- Full settings management API.
- Single-process termination API.
- Backend `/raw` display state.

## Raw display mode

The CLI has `/raw` because terminal rendering needs display modes. The headless server should send structured messages with enough information for the frontend to choose its own display mode.

The frontend owns:

- reasoning collapse/expand state
- tool detail collapse/expand state
- raw scrollback rendering
- visible/hidden message display policy

The backend does not expose raw display state. `/raw` may appear as an unimplemented CLI slash-command stub
because the CLI has a `/raw` command, but frontend clients must not depend on `GET /raw` or `POST /raw`.
Raw, normal, and lite display choices are owned by the frontend.

## Model scope

`GET /model` should return:

- current model config
- readonly provider info
- available model options derived from CLI model capability data
- available reasoning efforts
- thinking mode options

`POST /model` should update only:

- `model`
- `thinkingEnabled`
- `reasoningEffort`

It should not write provider, API key, or base URL settings.

## Process scope

The TUI exposes running process status and active bash timeout adjustment. The server therefore exposes:

- `GET /processes`
- `POST /processes/timeout`

The server does not expose a single-process termination API. Use `POST /interrupt` for the active turn.

## HTTP status code contract

The server normalizes failed `{ ok: false }` payloads to HTTP error status codes when the route would otherwise return a success status.

Use:

- `200`: synchronous success
- `202`: async prompt accepted
- `400`: invalid request body or parameter
- `401`: unauthorized
- `404`: resource not found
- `409`: runtime state conflict, such as busy, no active session, pending permission mismatch, or no adjustable process timeout
- `500`: unexpected internal error

Examples:

```json
{
  "ok": false,
  "error": "DeepCode is busy",
  "requestId": "..."
}
```

Should return `409`.

```json
{
  "ok": false,
  "error": "messageId is required"
}
```

Should return `400`.

```json
{
  "ok": false,
  "error": "Session not found"
}
```

Should return `404`.

## Deferred validation

These checks are intentionally deferred until the backend feature set is closed:

- `npm run typecheck`
- `npm run build`
- route contract tests
- SSE event contract tests
- image normalization tests
- model update tests
- undo restore tests
- process timeout tests
- `/exit`, SIGTERM, and long-turn lifecycle tests

Deferred does not mean passed. Final backend acceptance requires these checks to pass.
