# DeepCode Server API

English · [中文](./server-api.md)

This document is the frontend integration contract for the local DeepCode HTTP/SSE server. It merges and replaces the old `docs/headless-api.md`, `docs/headless-cli-scope.md`, and `docs/skills/deepcode-headless-frontend/SKILL.md`.

## Positioning

The server is a runtime entrypoint at the same layer as the CLI and VSCode companion. It depends on `@vegamo/deepcode-core`, not on `@vegamo/deepcode-cli`, Ink, or CLI UI components. Frontend, Tauri, VSCode, and other clients should integrate through HTTP action requests and SSE state events.

The preferred entrypoint is `deepcode-server`. `deepcode-headless-server` may remain as a compatibility alias; new integrations should not use `deepcode --server` as the main entrypoint.

## Start

```bash
deepcode-server --port 8787
```

Common flags:

- `--host 127.0.0.1`: bind address; local-only by default.
- `--port 8787`: bind port.
- `--project-root <path>`: project root; desktop clients should not assume the process `cwd` is the project root.
- `--no-auth`: trusted local development only.
- `--unsafe-bind`: allow non-local binds such as `0.0.0.0`.

Token auth is enabled by default. stdout prints a line similar to:

```text
deepcode server listening on http://127.0.0.1:8787 token=<token>
```

The token may be passed with any of:

- `?token=<token>`
- `x-deepcode-token: <token>`
- `Authorization: Bearer <token>`

## Frontend boot flow

1. Start `deepcode-server` as a child process.
2. Read the token from stdout.
3. Open `GET /events?token=<token>`.
4. Call `POST /ready` to initialize state.
5. Treat SSE as the UI state source of truth; HTTP only submits user actions.

Browser `EventSource` cannot set custom headers, so the SSE connection usually uses the query token.

## Scope

The server exposes existing DeepCode runtime / CLI-TUI capabilities. It is not a separate management backend. For slash command meanings, see [README “Slash Commands & Keyboard Shortcuts”](../README-en.md#slash-commands--keyboard-shortcuts).

The server does not provide:

- prompt queueing
- multi-session concurrent execution
- provider / API key / base URL write APIs; see [configuration.md](./configuration.md)
- MCP restart, enable, disable, config editing, or logs APIs; see [mcp.md](./mcp.md)
- full settings management APIs
- single-process kill APIs
- backend raw display state
- WebSocket transport

`/raw` is a CLI display mode. Frontends should own reasoning, tool detail, and raw scrollback display state.

## Responses and errors

JSON route bodies are limited to 2 MiB. Empty bodies are treated as `{}`.

Always check the business `ok` field; do not infer success from HTTP `200` alone.

| Status | Meaning |
| --- | --- |
| `200` | Synchronous success |
| `202` | Prompt accepted; streaming continues through SSE |
| `400` | Invalid body, parameter, or selection |
| `401` | Missing or invalid token |
| `404` | Missing route or resource |
| `409` | Runtime state conflict, such as busy, no active session, or permission mismatch |
| `413` | JSON body too large |
| `500` | Unexpected internal error |

Error response shape:

```json
{ "ok": false, "error": "message" }
```

## SSE events

Events use a common envelope: `type`, `sequence`, `timestamp`, and optional `requestId`. Use `sequence` for ordering and `requestId` to group one prompt turn.

Core events:

- `connected`
- `initializeEmpty`
- `loadSession`
- `showSessionsList`
- `skillsList`
- `userMessage`
- `loading`
- `appendMessage`
- `sessionStatus`
- `permissionRequest`
- `llmStreamProgress`
- `mcpStatus`
- `processStdout`
- `modelConfig`
- `openFile`
- `openFileFailed`
- `shutdown`
- `error`

## HTTP routes

| Route | Description |
| --- | --- |
| `GET /health` | Health check and project root. |
| `GET /version` | Server version. |
| `GET /events` | SSE event stream. |
| `GET\|POST /ready` | Initialize UI state and emit initial events. |
| `GET /commands` | Server-supported command route metadata. |
| `POST /prompt` | Submit user prompt; success returns `202`, model output streams through SSE. |
| `POST /interrupt` | Interrupt the current agent turn. |
| `GET /sessions` | Session list. |
| `POST /select-session` | Select a session and emit `loadSession`. |
| `POST /sessions/rename` | Rename a session; `name` is accepted as an alias for `summary`. |
| `POST /sessions/delete` | Delete a session. |
| `GET\|POST /back-to-list` | Return to session-list view. |
| `GET /skills`, `GET\|POST /request-skills` | Return and emit the skills list; see [README Skills](../README-en.md#skills). |
| `GET /model` | Read current model, thinking, reasoning effort, and readonly provider info. |
| `POST /model` | Update only `model`, `thinkingEnabled`, and `reasoningEffort`. |
| `GET /mcp` | Return MCP status; no MCP management API is provided. |
| `GET /processes` | Active session process state. |
| `POST /processes/timeout` | Adjust active Bash timeout with `deltaMs`. |
| `GET /permissions/pending` | Current pending permission request. |
| `POST /permissions/reply` | Reply to permission: `allow`, `deny-and-continue`, or `deny-and-stop`; see [permission.md](./permission.md). |
| `GET /undo` | Undo targets for the active session. |
| `POST /undo/restore` | Restore conversation and/or code. |
| `POST /undo/restore-code` | Restore code only. |
| `POST /undo/restore-conversation` | Restore conversation only. |
| `POST /open-file` | Validate an in-project path and request opening it locally. |
| `POST /exit` | Emit `shutdown` and close the server. |

## Prompt and images

`POST /prompt` may include:

- `text`
- `skills`
- `imageUrls`
- `images`
- `permissions`
- `alwaysAllows`

Images may be data URLs, remote `http/https` image URLs, `{ dataUrl }`, `{ url }`, `{ filePath }`, or `{ path }`. Local image paths must stay inside `projectRoot`. Supported local extensions are `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp`, up to 10 MiB.

Browser `blob:` URLs cannot be read by the server. Frontends should convert them to data URLs first.

## Frontend constraints

- Treat SSE as canonical UI state; HTTP responses only confirm action acceptance.
- When `/prompt` returns busy, do not queue or resend the request.
- When a permission request arrives, pause the current turn UI and answer through `/permissions/reply`.
- `openFileFailed` is a recoverable UI notification, not a process-fatal error.
- Desktop clients should call `/exit` only for a server process they own.

## Negative routes

These capabilities are intentionally not implemented; clients must not depend on them:

- `/prompt-queue`
- `/queue`
- `/provider`
- `/providers`
- `/mcp/restart`
- `/mcp/enable`
- `/mcp/disable`
- `/mcp/logs`
- `/processes/kill`
- backend `/raw` state

## Minimum acceptance

- `deepcode-server --help`
- `deepcode-server --port <port>`
- default auth: `/health` without token returns `401`, with token returns `200`
- `/events` emits `connected`
- `/ready` emits initial state
- `/model`, `/sessions`, `/skills`, and `/mcp` basic routes work
- invalid JSON returns `400`
- body too large returns `413`
- `/exit` closes the local server

Real provider prompt, deep permission paths, undo restore, long-turn interrupt, cross-platform open-file, and lifecycle signals still need separate smoke coverage.