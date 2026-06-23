# DeepCode Headless API

This document is the frontend contract for the standalone DeepCode local HTTP/SSE server package.

The server is started through the `@vegamo/deepcode-server` package. New integrations should use the `deepcode-server` binary. `deepcode-headless-server` is a compatibility alias for the same entrypoint.

Do not start the interactive `deepcode` CLI with `--server`, and do not add `@vegamo/deepcode-server` back to the CLI package.

## Frontend architecture

1. Start `deepcode-server` as the local server process.
2. Read the printed auth token from stdout when auth is enabled.
3. Open one SSE connection to `/events?token=<token>`.
4. Send user actions through HTTP requests.
5. Treat SSE events as the source of truth for UI state.

The server intentionally uses HTTP plus SSE only. Do not add a WebSocket dependency unless the UI later proves that HTTP plus SSE is insufficient.

## Scope contract

The server mirrors capabilities already present in the CLI/TUI. Frontend clients must not assume backend-only features exist.

The API does not provide:

- prompt queueing
- multi-session concurrent execution
- provider profile write APIs
- API key or base URL write APIs
- MCP restart, enable, disable, config editing, or logs APIs
- single-process kill APIs
- backend raw display state
- WebSocket transport

## Start command

Preferred commands:

`deepcode-server`

`deepcode-server --port 8787`

`deepcode-server --host 127.0.0.1 --port 8787`

`deepcode-server --no-auth`

Compatibility alias:

`deepcode-headless-server --port 8787`

Forbidden old CLI command:

`deepcode --server`

Default behavior:

- Host: `127.0.0.1`
- Port: `8787`
- Auth: enabled by default
- Auth transport: query token, `x-deepcode-token`, or `Authorization: Bearer ...`
- Non-local bind: `--host 0.0.0.0` or `--host ::` requires `--unsafe-bind`
- No auth: `--no-auth`, for trusted local development only

Example stdout with auth enabled:

`deepcode server listening on http://127.0.0.1:8787 token=<token>`

Example stdout with auth disabled:

`deepcode server listening on http://127.0.0.1:8787 auth=disabled`

## Frontend boot sequence

1. Start `deepcode-server --port 8787`.
2. Parse the stdout auth token.
3. Open `GET /events?token=<token>`.
4. Call `POST /ready` with the same token in `x-deepcode-token`.
5. Render initial state from `initializeEmpty`, `loadSession`, `skillsList`, and `modelConfig`.

`/ready` sends initial UI state through SSE and also returns the same initial event list in the HTTP response. The UI should still process SSE as the canonical stream.

## Auth smoke contract

Default auth mode must be tested separately from `--no-auth` mode:

1. Start `deepcode-server --port 8787`.
2. Parse `token=<token>` from stdout.
3. `GET /health` without auth must return `401`.
4. `GET /health` with `x-deepcode-token: <token>` must return `200`.
5. `GET /events?token=<token>` must emit `connected`.
6. `POST /exit` with auth must close the server.

`--no-auth` is allowed only as a trusted local development mode and must not be the only smoke test.

## HTTP and JSON errors

All JSON routes accept request bodies up to 2 MiB. Empty bodies are treated as `{}`.

Invalid JSON returns HTTP `400` with `{ ok: false, error: "Invalid JSON body" }`.

Bodies larger than the server limit return HTTP `413` with `{ ok: false, error: "Request body too large" }`.

Failed `{ ok: false }` route results are normalized to HTTP error status codes:

- `400`: invalid body, missing parameter, unsupported value, or explicit invalid selection
- `401`: missing or invalid auth
- `404`: missing route or resource
- `409`: runtime state conflict, such as busy, no active session, pending permission request state, or no adjustable timeout
- `413`: JSON request body too large
- `500`: unexpected internal failure

Do not infer success from a `200` transport status alone; always check `ok`.

## Event envelope

Every runtime event has this common shape:

- `type: string`
- `requestId?: string`
- `sequence: number`
- `timestamp: string`
- additional event-specific fields

Use `sequence` for ordering. Use `requestId` to associate streaming updates with a submitted prompt.

## Core SSE events

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

## Basic routes

### `GET /events`

Opens the SSE stream. Browser `EventSource` cannot set custom headers, so auth should usually be passed through the query string.

### `GET|POST /ready`

Initializes frontend state. Emits `initializeEmpty` or `loadSession`, `skillsList`, and `modelConfig`.

### `GET /health`

Returns server health and project root.

### `GET /version`

Returns server package version.

### `GET /commands`

Returns slash command route metadata derived from the shared server command map.

## Prompt route

### `POST /prompt`

Request fields:

- `text`
- `skills`
- `imageUrls`
- `images`
- `permissions`
- `alwaysAllows`

A successful request returns HTTP `202` with `{ ok: true, data: { accepted: true, requestId } }`. The assistant turn continues through SSE.

If another prompt turn is already running, the server returns `{ ok: false, error: "DeepCode is busy", requestId }` and an HTTP conflict status.

## Image attachments

Accepted image forms:

- data URL strings
- remote `http` or `https` image URLs
- objects with `dataUrl`
- objects with `url`
- objects with `filePath`
- objects with `path`

Local file images are converted by the server to data URLs. File paths must stay inside `projectRoot`.

Supported local extensions:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.webp`

Max local image size: 10 MiB.

Browser `blob:` URLs cannot be read by the server. A browser or Tauri frontend must convert blob attachments to data URLs before sending them.

## Model config

### `GET /model`

Returns current resolved model config, available model options, reasoning efforts, thinking options, and readonly provider information.

The response may expose `baseURL` and `apiKeyConfigured`, but never the API key value.

### `POST /model`

Updates only:

- `model`
- `thinkingEnabled`
- `reasoningEffort`

The route does not write provider, API key, or base URL settings.

## Processes

### `GET /processes`

Returns active session process state. With no active session, returns HTTP `409` and `No active session`.

### `POST /processes/timeout`

Adjusts the active Bash timeout with `deltaMs`.

The server does not expose a single-process kill API. Use `POST /interrupt` for the active turn.

## MCP

### `GET /mcp`

Returns MCP status and may emit `mcpStatus`. The server does not expose MCP management routes such as restart, enable, disable, config editing, or logs.

## Sessions

### `GET /sessions`

Returns all sessions.

### `POST /select-session`

Selects a session and emits `loadSession` plus `skillsList`.

### `POST /sessions/rename`

Renames a session. `name` is accepted as an alias for `summary`.

### `POST /sessions/delete`

Deletes a session. If the deleted session is active, the server clears the active session and emits `initializeEmpty`.

### `GET|POST /back-to-list`

Compatibility route for the frontend session-list action. Emits `showSessionsList`.

## Skills

### `GET|POST /request-skills`

Compatibility route for requesting current skills. Emits `skillsList`.

### `GET /skills`

Slash command route. Emits and returns `skillsList`.

## Permissions

### `GET /permissions/pending`

Returns active pending permission request, if any.

### `POST /permissions/reply`

Supports allow, deny-and-continue, and deny-and-stop permission responses.

## Undo

### `GET /undo`

Returns undo targets for the active session.

### `POST /undo/restore`

Restores conversation and/or code for a message.

### `POST /undo/restore-code`

Restores code only.

### `POST /undo/restore-conversation`

Restores conversation only.

## Open file

### `POST /open-file`

Validates that the path stays inside `projectRoot`, then attempts to open the file using platform-specific editor commands.

## Lifecycle

### `POST /interrupt`

Interrupts the active agent turn.

### `POST /exit`

Emits `shutdown` and closes the HTTP server.

## Negative route contract

These routes are intentionally not implemented and should return `404` if requested:

- `/prompt-queue`
- `/queue`
- `/provider`
- `/providers`
- `/mcp/restart`
- `/mcp/enable`
- `/mcp/disable`
- `/mcp/logs`
- `/processes/kill`

The backend does not expose raw display state. `/raw` may appear as an unimplemented slash-command stub because the TUI has a `/raw` command, but frontend clients must not depend on `GET /raw` or `POST /raw`.
