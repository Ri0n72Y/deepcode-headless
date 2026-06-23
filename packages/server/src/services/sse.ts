/**
 * Server-sent events stream helpers.
 *
 * Summary:
 * Opens and writes SSE streams for frontend event subscriptions. Runtime event
 * production remains behind a small subscribe interface.
 *
 * Exports:
 * - openSseStream(request: IncomingMessage, response: ServerResponse, runtime: SseRuntime): void
 * - writeSseEvent(response: ServerResponse, eventName: string, data: JsonValue): void
 * - type SseRuntime
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeadlessEvent } from "./events";
import type { JsonValue } from "./types";

export type SseRuntime = {
  subscribe(listener: (event: HeadlessEvent) => void): () => void;
};

export function openSseStream(request: IncomingMessage, response: ServerResponse, runtime: SseRuntime): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  writeSseEvent(response, "connected", { type: "connected" });
  const unsubscribe = runtime.subscribe((event) => writeSseEvent(response, event.type, event));
  const timer = setInterval(() => response.write(": keep-alive\n\n"), 15000);
  request.on("close", () => {
    clearInterval(timer);
    unsubscribe();
  });
}

export function writeSseEvent(response: ServerResponse, eventName: string, data: JsonValue): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
