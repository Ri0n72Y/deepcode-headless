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
