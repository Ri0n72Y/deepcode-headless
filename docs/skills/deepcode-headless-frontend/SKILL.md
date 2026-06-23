---
name: deepcode-headless-frontend
description: Guidance for implementing or reviewing a frontend or Tauri client for the standalone DeepCode local HTTP/SSE server package. Covers HTTP plus SSE integration, session synchronization, prompt submission, permissions UI, model config, undo restore, image attachments, open-file behavior, and lifecycle handling.
---

# DeepCode Headless Frontend Integration

Use this skill when working on a frontend client for the standalone `@vegamo/deepcode-server` package.

New integrations should start the `deepcode-server` binary. Do not start the interactive `deepcode` CLI with `--server`, and do not add a server dependency back into the CLI package.

The frontend should treat the local server as a stateful agent runtime. Use HTTP for actions and SSE for state updates. Do not drive the terminal UI through a pseudo terminal.

## Core architecture

1. Start `deepcode-server` as a local child process.
2. Read the printed auth token from stdout when auth is enabled.
3. Open `EventSource` against `/events?token=<token>`.
4. Call HTTP routes for user actions.
5. Update UI state from SSE events.

HTTP plus SSE is the default transport. Add WebSocket only after a concrete product need proves it is required.

## Start commands

Preferred command:

`deepcode-server --port 8787`

Compatibility alias:

`deepcode-headless-server --port 8787`

Do not use:

`deepcode --server`

## Scope rule

Support CLI/TUI features exposed by the headless server. Treat the headless server as an API surface for the existing runtime, not as a separate management backend.

Expected exclusions:

- prompt queueing
- multi-session concurrent execution
- MCP administration routes
- provider profile write routes
- backend raw display state
- single-process termination route

## Boot flow

1. Start `deepcode-server --port 8787`.
2. Parse the stdout auth token.
3. Connect to `GET /events?token=<token>`.
4. Call `POST /ready` with the token header.
5. Render initial state from `initializeEmpty`, `loadSession`, `skillsList`, and `modelConfig`.

Also test `--no-auth` mode, but do not treat it as a substitute for the default auth smoke test.

## Action routes

Use these routes from the client:

- `POST /prompt`
- `POST /interrupt`
- `POST /select-session`
- `POST /sessions/rename`
- `POST /sessions/delete`
- `GET|POST /request-skills`
- `GET|POST /back-to-list`
- `GET /model`
- `POST /model`
- `GET /processes`
- `POST /processes/timeout`
- `GET /undo`
- `POST /undo/restore`
- `POST /undo/restore-code`
- `POST /undo/restore-conversation`
- `GET /permissions/pending`
- `POST /permissions/reply`
- `POST /open-file`
- `POST /exit`

## HTTP errors

Read both HTTP status and JSON payload. A failed payload uses `{ ok: false, error: string }`.

Expected statuses:

- `400`: invalid body or parameter
- `401`: auth failure
- `404`: missing route or resource
- `409`: runtime state conflict, such as busy or no active session
- `500`: unexpected internal error

When `/prompt` returns busy, keep the current turn UI and do not enqueue a second backend request.

## SSE events

Handle these events as canonical state changes:

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

Use `sequence` for ordering and `requestId` to group events from one prompt turn.

## Prompt submission

`POST /prompt` returns quickly with `202` and a request id when accepted. The assistant turn continues through SSE. The UI should not wait for the fetch call as if it were the full assistant response.

The request body may include text, skills, and image URLs.

If the server returns busy, keep the user draft and avoid duplicate sends.

## Image attachments

Preferred frontend behavior:

- Convert pasted browser blobs to data URLs before sending them.
- Send remote images only when the chosen model/provider can use them.
- Send local project images as project-relative paths when using Tauri or a file picker.

The server supports `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp` project-local files up to 10 MiB.

## Permissions UI

When a `permissionRequest` event arrives, pause the turn UI and present allow/deny controls. Send the decision through `POST /permissions/reply`.

Supported modes:

- allow
- deny-and-continue
- deny-and-stop

## Model config

`GET /model` is safe to call during boot. `POST /model` may update only model, thinking mode, and reasoning effort. The frontend must not expose provider, API key, or base URL editing through this server API.

## Open file

Use `POST /open-file` with a project-relative path and optional line number. Treat `openFileFailed` as a recoverable UI notification.

## Lifecycle

Use `POST /interrupt` to stop the active turn. Use `POST /exit` only when closing the local server process that the frontend owns.
