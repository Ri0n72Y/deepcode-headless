# DeepCode Headless API

This document is the frontend contract for the local HTTP server started by `deepcode --server`.

The intended frontend architecture is:

1. Start the CLI server as a local child process.
2. Read the printed token from stdout.
3. Open one `EventSource` connection to `/events?token=<token>`.
4. Send user actions through HTTP `fetch` calls.
5. Treat SSE events as the source of truth for UI state.

The server intentionally uses HTTP + SSE only. Do not add a WebSocket dependency unless the UI later proves that HTTP + SSE is insufficient.

## Scope contract

The server mirrors capabilities already present in the CLI/TUI. Frontend clients must not assume backend-only
features exist. In particular, the headless API does not provide:

- prompt queueing
- multi-session concurrent execution
- provider profile write APIs
- API key or base URL write APIs
- MCP restart, enable, disable, config editing, or logs APIs
- single-process kill APIs
- backend raw display state
- WebSocket transport

## Start command

```bash
deepcode --server
deepcode --server --port 8787
deepcode --server --host 127.0.0.1 --port 8787
```

The duplicate `--headless` command has been removed. Use only `--server`.

Default behavior:

- Host: `127.0.0.1`
- Port: `8787`
- Auth: enabled by default
- Token transport: `?token=...`, `x-deepcode-token`, or `Authorization: Bearer ...`
- Non-local bind: `--host 0.0.0.0` or `--host ::` requires `--unsafe-bind`
- No auth: `--no-auth`, for trusted local development only

Example stdout:

```text
deepcode headless listening on http://127.0.0.1:8787 token=<token>
```

The printed wording still says `headless` because the internal module is named `headless`. The public command is `--server`.

## Frontend boot sequence

```ts
const token = "...";
const baseUrl = "http://127.0.0.1:8787";

const events = new EventSource(`${baseUrl}/events?token=${encodeURIComponent(token)}`);

events.addEventListener("appendMessage", (event) => {
  const payload = JSON.parse(event.data);
});

await fetch(`${baseUrl}/ready`, {
  method: "POST",
  headers: { "x-deepcode-token": token },
});
```

`/ready` sends initial UI state through SSE and also returns the same initial event list in the HTTP response. The UI should still process SSE as the canonical stream.

## HTTP and JSON errors

All JSON routes accept request bodies up to 2 MiB. Empty bodies are treated as `{}`. Invalid JSON returns:

```json
{
  "ok": false,
  "error": "Invalid JSON body"
}
```

with HTTP `400`.

Bodies larger than the server limit return:

```json
{
  "ok": false,
  "error": "Request body too large"
}
```

with HTTP `413`.

Failed `{ "ok": false }` route results are normalized to HTTP error status codes:

- `400`: invalid body, missing parameter, unsupported value, or explicit invalid selection.
- `401`: missing or invalid token.
- `404`: missing route or resource.
- `409`: runtime state conflict, such as busy, no active session, pending permission request state, or no adjustable timeout.
- `413`: JSON request body too large.
- `500`: unexpected internal failure.

Do not infer success from a `200` transport status alone; always check `ok`.

## Event envelope

Every runtime event has this common shape:

```ts
type HeadlessEvent = {
  type: string;
  requestId?: string;
  sequence: number;
  timestamp: string;
  [key: string]: unknown;
};
```

Use `sequence` for ordering. Use `requestId` to associate streaming updates with a submitted prompt.

## Core SSE events

| Event | Meaning |
| --- | --- |
| `connected` | SSE stream opened. |
| `initializeEmpty` | UI should show an empty conversation. |
| `loadSession` | UI should load one session and replace message state. |
| `showSessionsList` | UI should show or refresh the session list. |
| `skillsList` | Available skills changed or were requested. |
| `userMessage` | A prompt was accepted and should be shown in the chat. |
| `loading` | Agent turn started or ended. |
| `appendMessage` | SessionManager emitted a visible assistant/tool/system message. |
| `sessionStatus` | Session state changed. Contains status, processes, askPermissions, tokenTelemetry. |
| `permissionRequest` | The current turn is blocked waiting for user permission. |
| `llmStreamProgress` | Token/progress estimate during streaming. |
| `mcpStatus` | MCP server status changed. |
| `processStdout` | A tracked process wrote stdout. |
| `modelConfig` | Current model/thinking config changed or was requested. |
| `openFile` | Server accepted an open-file action. |
| `openFileFailed` | All opener commands failed. |
| `shutdown` | Server is closing. |
| `error` | Server-side request handling or agent execution error. |

## Raw display scope

The headless server does not expose backend raw display state. `/raw` may appear as an unimplemented CLI
slash-command stub because the CLI has a `/raw` command, and it may return 405 or 501. Frontend clients must
not depend on `GET /raw` or `POST /raw`; raw, normal, and lite display choices are owned by the frontend.

## Basic routes

### `GET /events`

Opens the SSE stream.

Auth should usually be passed through the query string because browser `EventSource` cannot set custom headers:

```ts
new EventSource(`${baseUrl}/events?token=${token}`);
```

### `GET|POST /ready`

Initializes frontend state.

Emits:

- `initializeEmpty` or `loadSession`
- `skillsList`
- `modelConfig`

### `GET /health`

Returns server health and project root.

### `GET /version`

Returns CLI version.

### `GET /commands`

Returns slash command route metadata derived from the CLI command registry.

## Prompt route

### `POST /prompt`

Request:

```json
{
  "text": "Explain this project",
  "skills": [],
  "imageUrls": []
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "requestId": "..."
  }
}
```

The HTTP request returns `202` quickly. The UI receives ongoing messages and status changes from SSE.

If another prompt turn is already running, the server returns:

```json
{
  "ok": false,
  "error": "DeepCode is busy",
  "requestId": "..."
}
```

## Image attachments

The backend accepts these image forms:

```json
{
  "imageUrls": ["data:image/png;base64,..."]
}
```

```json
{
  "imageUrls": ["https://example.com/image.png"]
}
```

```json
{
  "images": [
    { "dataUrl": "data:image/png;base64,..." },
    { "url": "https://example.com/image.png" },
    { "filePath": "relative/path/in/project.png" },
    { "path": "relative/path/in/project.jpg" }
  ]
}
```

Local file images are converted by the server to data URLs. File paths must stay inside `projectRoot`. Supported local extensions:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.webp`

Max local image size: 10 MiB.

Browser `blob:` URLs cannot be read by the server. A browser/Tauri frontend must convert blob attachments to data URLs before sending them:

```ts
async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```

## Model config

### `GET /model`

Returns current resolved model config:

- `availableModels` is derived from the same shared model option list used by the TUI `/model` dropdown.
- Current supported model options are `deepseek-v4-pro` and `deepseek-v4-flash`.
- Provider information is readonly. The response may expose `baseURL` and `apiKeyConfigured`, but never the API key value.

```json
{
  "ok": true,
  "data": {
    "model": "deepseek-v4-pro",
    "baseURL": "https://api.deepseek.com",
    "provider": {
      "baseURL": "https://api.deepseek.com",
      "apiKeyConfigured": true
    },
    "availableModels": [
      {
        "model": "deepseek-v4-pro",
        "thinkingDefault": true,
        "supportsMultimodal": false
      },
      {
        "model": "deepseek-v4-flash",
        "thinkingDefault": true,
        "supportsMultimodal": false
      }
    ],
    "reasoningEfforts": ["high", "max"],
    "thinkingOptions": [true, false],
    "temperature": null,
    "thinkingEnabled": true,
    "reasoningEffort": "max",
    "debugLogEnabled": false,
    "telemetryEnabled": true,
    "webSearchTool": null
  }
}
```

### `POST /model`

Updates project or user settings using the same selection helper as the TUI model command.

Only these fields are accepted for writes:

- `model`
- `thinkingEnabled`
- `reasoningEffort`

The route does not write provider, API key, or base URL settings.

Request:

```json
{
  "model": "deepseek-v4-pro",
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

Allowed `reasoningEffort` values:

- `high`
- `max`

If `reasoningEffort` is omitted, the current setting is preserved. If it is present and not `high` or `max`,
the server returns HTTP `400` with `reasoningEffort must be high or max`.

Emits:

- `modelConfig`

## Processes

### `GET /processes`

Returns active session process state. With no active session, returns HTTP `409` and `No active session`.
When a session is active but no process is running, `processes` is `null`.

### `POST /processes/timeout`

Adjusts the active Bash timeout using:

```json
{ "deltaMs": 60000 }
```

If no adjustable timeout exists, returns HTTP `409` and `No adjustable active bash timeout`. Invalid `deltaMs`
values return HTTP `400`.

The headless server does not expose a single-process kill API. Use `POST /interrupt` for the active turn.

## MCP

### `GET /mcp`

Returns MCP status and may emit `mcpStatus`. The headless server does not expose MCP management routes such as
restart, enable, disable, config editing, or logs.

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

## Sessions

### `GET /sessions`

Returns all sessions.

### `POST /select-session`

Request:

```json
{ "sessionId": "..." }
```

Emits:

- `loadSession`
- `skillsList`

### `POST /sessions/rename`

Request:

```json
{
  "sessionId": "...",
  "summary": "New title"
}
```

`name` is accepted as an alias for `summary`.

Emits:

- `showSessionsList`
- `sessionStatus` for the renamed session when available

### `POST /sessions/delete`

Request:

```json
{ "sessionId": "..." }
```

If the deleted session is active, the server clears the active session and emits `initializeEmpty`.

Emits:

- `initializeEmpty` when deleting the active session
- `showSessionsList`

### `GET|POST /back-to-list`

Compatibility route for the VSCode plugin UI action. Emits `showSessionsList`.

## Skills

### `GET|POST /request-skills`

Compatibility route for the VSCode plugin UI action. Emits `skillsList`.

### `GET /skills`

Slash command route. Emits and returns `skillsList`.

## Permissions

### `GET /permissions/pending`

Returns active pending permission request, if any.

### `POST /permissions/reply`

Allow example:

```json
{
  "permissions": [
    { "toolCallId": "...", "permission": "allow" }
  ],
  "alwaysAllows": ["write-in-cwd"]
}
```

Deny and let the model continue with another approach:

```json
{
  "permissions": [
    { "toolCallId": "...", "permission": "deny" }
  ],
  "mode": "deny-and-continue"
}
```

Deny and stop:

```json
{
  "permissions": [
    { "toolCallId": "...", "permission": "deny" }
  ],
  "mode": "deny-and-stop"
}
```

## Undo

### `GET /undo`

Returns undo targets for the active session.

### `POST /undo/restore`

Request:

```json
{
  "sessionId": "...",
  "messageId": "...",
  "restoreConversation": true,
  "restoreCode": true
}
```

Defaults:

- `restoreConversation`: true
- `restoreCode`: false

Emits:

- `loadSession`
- `showSessionsList`

### `POST /undo/restore-code`

Restores code only.

Request:

```json
{
  "sessionId": "...",
  "messageId": "..."
}
```

### `POST /undo/restore-conversation`

Restores conversation only.

Request:

```json
{
  "sessionId": "...",
  "messageId": "..."
}
```

## Open file

### `POST /open-file`

Also supports `/openFile` for plugin compatibility.

Request:

```json
{
  "filePath": "src/foo.ts",
  "line": 12
}
```

The server validates that the file path stays inside the project root. It then tries:

1. `code -g <file>:<line>`
2. macOS fallback: `open <file>`
3. Windows fallback: `cmd.exe /c start "" <file>`
4. Linux fallback: `xdg-open <file>`

The HTTP response means that the request was accepted. If every opener fails asynchronously, the SSE stream receives `openFileFailed`.

## Interrupt and lifecycle

### `POST /interrupt`

Interrupts the active turn and explicitly emits the latest `sessionStatus`.

### `POST /exit`

Closes the server. The slash command route `/exit` also works.

The server emits `shutdown`, ends active SSE responses, closes the HTTP server, and disposes the runtime after close.

For local validation, run these smoke tests on macOS, Windows, and Linux:

```bash
npm run typecheck
npm run build

deepcode --server
curl -N "http://127.0.0.1:8787/events?token=<token>"
curl "http://127.0.0.1:8787/ready" -H "x-deepcode-token: <token>"
curl "http://127.0.0.1:8787/model" -H "x-deepcode-token: <token>"
curl "http://127.0.0.1:8787/prompt" -H "content-type: application/json" -H "x-deepcode-token: <token>" -d '{"text":"hello"}'
curl "http://127.0.0.1:8787/open-file" -H "content-type: application/json" -H "x-deepcode-token: <token>" -d '{"filePath":"package.json","line":1}'
curl "http://127.0.0.1:8787/exit" -X POST -H "x-deepcode-token: <token>"
```
