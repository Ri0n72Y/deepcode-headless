/**
 * HTTP route dispatch service.
 *
 * Summary:
 * Maps local server HTTP paths to runtime actions. This service owns request path
 * dispatch only; runtime behavior stays behind the RouteRuntime interface.
 *
 * Exports:
 * - routeRequest(input: RouteRequestInput): Promise<void>
 * - type RouteRuntime
 * - type RouteRequestInput
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildHeadlessCommandRoutes, findHeadlessCommandRoute } from "../command-map";
import { buildPromptContent } from "./prompt-content";
import { readJsonBody, type RequestBody } from "./request-body";
import { sendJson } from "./response";
import type { JsonValue } from "./types";

export type RouteRuntime = {
  ready(): Promise<JsonValue>;
  getModelConfig(): JsonValue;
  updateModelConfig(body: RequestBody): JsonValue;
  listProcesses(): JsonValue;
  adjustProcessTimeout(body: RequestBody): JsonValue;
  listSessions(): JsonValue;
  renameSession(body: RequestBody): JsonValue;
  deleteSession(body: RequestBody): JsonValue;
  sendSkillsList(): Promise<JsonValue>;
  showSessionsList(): JsonValue;
  openFile(body: RequestBody): JsonValue;
  pendingPermissions(): JsonValue;
  replyPermissions(body: RequestBody): JsonValue;
  selectSession(sessionId: string): Promise<JsonValue>;
  startPrompt(prompt: unknown): JsonValue;
  interrupt(): JsonValue;
  restoreUndo(body: RequestBody, defaults?: { restoreCode?: boolean; restoreConversation?: boolean }): JsonValue;
  newSession(): Promise<JsonValue>;
  undoTargets(): JsonValue;
  getMcpStatus(): unknown[];
};

export type RouteRequestInput = {
  request: IncomingMessage;
  response: ServerResponse;
  runtime: RouteRuntime;
  version: string;
  projectRoot: string;
  shutdown: () => void;
};

export async function routeRequest(input: RouteRequestInput): Promise<void> {
  const { request, response, runtime, version, projectRoot, shutdown } = input;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";

  if ((method === "GET" || method === "POST") && pathname === "/ready") {
    return sendJson(response, 200, await runtime.ready());
  }
  if (method === "GET" && pathname === "/health") {
    return sendJson(response, 200, { ok: true, data: { version, projectRoot } });
  }
  if (method === "GET" && pathname === "/version") {
    return sendJson(response, 200, { ok: true, data: { version } });
  }
  if (method === "GET" && pathname === "/commands") {
    return sendJson(response, 200, { ok: true, data: buildHeadlessCommandRoutes() });
  }
  if (method === "GET" && pathname === "/model") {
    return sendJson(response, 200, runtime.getModelConfig());
  }
  if (method === "POST" && pathname === "/model") {
    return sendJson(response, 200, runtime.updateModelConfig(await readJsonBody(request)));
  }
  if (method === "GET" && pathname === "/processes") {
    return sendJson(response, 200, runtime.listProcesses());
  }
  if (method === "POST" && pathname === "/processes/timeout") {
    return sendJson(response, 200, runtime.adjustProcessTimeout(await readJsonBody(request)));
  }
  if (method === "GET" && pathname === "/sessions") {
    return sendJson(response, 200, { ok: true, data: runtime.listSessions() });
  }
  if (method === "POST" && pathname === "/sessions/rename") {
    return sendJson(response, 200, runtime.renameSession(await readJsonBody(request)));
  }
  if (method === "POST" && pathname === "/sessions/delete") {
    return sendJson(response, 200, runtime.deleteSession(await readJsonBody(request)));
  }
  if ((method === "GET" || method === "POST") && pathname === "/request-skills") {
    return sendJson(response, 200, await runtime.sendSkillsList());
  }
  if ((method === "GET" || method === "POST") && pathname === "/back-to-list") {
    return sendJson(response, 200, runtime.showSessionsList());
  }
  if (method === "POST" && (pathname === "/open-file" || pathname === "/openFile")) {
    return sendJson(response, 200, runtime.openFile(await readJsonBody(request)));
  }
  if (method === "GET" && pathname === "/permissions/pending") {
    return sendJson(response, 200, runtime.pendingPermissions());
  }
  if (method === "POST" && pathname === "/permissions/reply") {
    return sendJson(response, 202, runtime.replyPermissions(await readJsonBody(request)));
  }
  if (method === "POST" && pathname === "/select-session") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await runtime.selectSession(String(body.sessionId ?? "")));
  }
  if (method === "POST" && pathname === "/prompt") {
    const prompt = buildPromptContent(projectRoot, await readJsonBody(request));
    return sendJson(response, prompt.ok ? 202 : 400, prompt.ok ? runtime.startPrompt(prompt.data) : { ok: false, error: prompt.error });
  }
  if (method === "POST" && pathname === "/interrupt") {
    return sendJson(response, 200, runtime.interrupt());
  }
  if (method === "POST" && pathname === "/undo/restore") {
    return sendJson(response, 200, runtime.restoreUndo(await readJsonBody(request)));
  }
  if (method === "POST" && pathname === "/undo/restore-code") {
    return sendJson(response, 200, runtime.restoreUndo(await readJsonBody(request), { restoreCode: true, restoreConversation: false }));
  }
  if (method === "POST" && pathname === "/undo/restore-conversation") {
    return sendJson(response, 200, runtime.restoreUndo(await readJsonBody(request), { restoreCode: false, restoreConversation: true }));
  }
  if (method === "POST" && pathname === "/exit") {
    sendJson(response, 200, { ok: true });
    setTimeout(shutdown, 0);
    return;
  }

  const command = findHeadlessCommandRoute(pathname);
  if (!command) {
    return sendJson(response, 404, { ok: false, error: "Not found" });
  }
  if (method !== command.method && !(command.name === "undo" && method === "GET")) {
    return sendJson(response, 405, { ok: false, error: `Use ${command.method} ${command.path}` });
  }
  if (!command.implemented) {
    return sendJson(response, 501, { ok: false, error: `Command ${command.label} is not implemented in server mode yet.` });
  }
  if (command.name === "skills") {
    return sendJson(response, 200, await runtime.sendSkillsList());
  }
  if (command.name === "mcp") {
    return sendJson(response, 200, { ok: true, data: runtime.getMcpStatus() });
  }
  if (command.name === "resume") {
    return sendJson(response, 200, runtime.showSessionsList());
  }
  if (command.name === "new") {
    return sendJson(response, 200, await runtime.newSession());
  }
  if (command.name === "undo") {
    return sendJson(response, 200, runtime.undoTargets());
  }
  if (command.name === "exit") {
    sendJson(response, 200, { ok: true });
    setTimeout(shutdown, 0);
    return;
  }

  const body = method === "POST" ? await readJsonBody(request) : {};
  const prompt = buildPromptContent(projectRoot, { ...body, text: `/${command.name}` });
  return sendJson(response, prompt.ok ? 202 : 400, prompt.ok ? runtime.startPrompt(prompt.data) : { ok: false, error: prompt.error });
}
