---
name: deepcode-headless-frontend
description: Guidance for implementing or reviewing a frontend or Tauri client for the DeepCode local HTTP server. Covers HTTP plus SSE integration, session synchronization, prompt submission, permissions UI, model config, undo restore, image attachments, open-file behavior, and lifecycle handling.
---

# DeepCode Headless Frontend Integration

Use this skill when working on a frontend client for `deepcode --server`.

The frontend should treat the local server as a stateful agent runtime. Use HTTP for actions and SSE for state updates. Do not drive the terminal UI through a pseudo terminal.

## Core architecture

1. Start `deepcode --server` as a local child process.
2. Read `token=<token>` from stdout.
3. Open `EventSource` against `/events?token=<token>`.
4. Call HTTP routes for user actions.
5. Update UI state from SSE events.

HTTP plus SSE is the default transport. Add WebSocket only after a concrete product need proves it is required.

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

1. Start `deepcode --server --port 8787`.
2. Parse the stdout token.
3. Connect to `GET /events?token=<token>`.
4. Call `POST /ready`.
5. Render initial state from `initializeEmpty`, `loadSession`, `skillsList`, and `modelConfig`.

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

Never send browser blob URLs to the backend; they are scoped to the renderer process.

## Permissions UI

When `permissionRequest` arrives, show a compact permission form with the requested operation, scopes, and actions for allow once, always allow scope, deny and continue, and deny and stop.

Submit decisions to `POST /permissions/reply`. Render the next state from `sessionStatus`, `permissionRequest`, and subsequent assistant/tool messages.

## Model UI

Use `GET /model` to populate current model, readonly provider status, available models, reasoning efforts, and thinking options.

Use `POST /model` only for model, thinking mode, and reasoning effort changes. Do not write provider profile, credential, or base URL fields unless the CLI/TUI later exposes matching functionality.

After a write, wait for `modelConfig` and render from that event.
