import { spawn } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenAIClient,
  defaultsToThinkingMode,
  getCompactPromptTokenThreshold,
  resolveCurrentSettings,
  SessionManager,
  supportsMultimodal,
  writeModelConfigSelection,
  type ModelConfigSelection,
  type PermissionScope,
  type ReasoningEffort,
  type ResolvedDeepcodingSettings,
  type SessionEntry,
  type SessionMessage,
  type SkillInfo,
  type UserPromptContent,
  type UserToolPermission,
} from "@vegamo/deepcode-core";
import { MODEL_COMMAND_MODELS, MODEL_COMMAND_THINKING_OPTIONS } from "../ui/components/ModelsDropdown";
import { buildHeadlessCommandRoutes, findHeadlessCommandRoute } from "./command-map";

export type HeadlessOptions = {
  args: string[];
  projectRoot: string;
  version: string;
};

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

type RequestBody = {
  text?: unknown;
  prompt?: unknown;
  skills?: unknown;
  images?: unknown;
  imageUrls?: unknown;
  sessionId?: unknown;
  permissions?: unknown;
  alwaysAllows?: unknown;
  decisions?: unknown;
  mode?: unknown;
  filePath?: unknown;
  path?: unknown;
  line?: unknown;
  messageId?: unknown;
  restoreCode?: unknown;
  restoreConversation?: unknown;
  summary?: unknown;
  name?: unknown;
  model?: unknown;
  thinkingEnabled?: unknown;
  reasoningEffort?: unknown;
  deltaMs?: unknown;
};

type HeadlessEvent = {
  type: string;
  requestId?: string;
  sequence?: number;
  timestamp?: string;
  [key: string]: unknown;
};

type OpenFileRequest = {
  absolutePath: string;
  relativePath: string;
  line: number;
};

type OpenFileCommand = {
  command: string;
  args: string[];
};

type ModelOption = {
  model: string;
  thinkingDefault: boolean;
  supportsMultimodal: boolean;
};

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const VALID_PERMISSION_SCOPES = new Set<PermissionScope>([
  "read-in-cwd",
  "read-out-cwd",
  "write-in-cwd",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "query-git-log",
  "mutate-git-log",
  "network",
  "mcp",
]);

export async function runHeadlessHttp(options: HeadlessOptions): Promise<void> {
  const host = readArgValue(options.args, "--host") ?? DEFAULT_HOST;
  const port = Number(readArgValue(options.args, "--port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${String(readArgValue(options.args, "--port"))}`);
  }
  if ((host === "0.0.0.0" || host === "::") && !options.args.includes("--unsafe-bind")) {
    throw new Error("Binding outside localhost requires --unsafe-bind.");
  }

  const authDisabled = options.args.includes("--no-auth");
  if (authDisabled) {
    process.stderr.write("Warning: deepcode headless auth is disabled. Use only in a trusted local dev environment.\n");
  }
  const accessToken = authDisabled ? null : crypto.randomUUID();
  const runtime = new HeadlessRuntime(options.projectRoot);
  await runtime.init();

  const activeResponses = new Set<ServerResponse>();
  const httpServer = createServer(async (request, response) => {
    activeResponses.add(response);
    response.on("close", () => activeResponses.delete(response));
    try {
      setBaseHeaders(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (accessToken && !isAuthorized(request, accessToken)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      await routeRequest({
        request,
        response,
        runtime,
        version: options.version,
        projectRoot: options.projectRoot,
        shutdown: () => shutdown(),
      });
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 500;
      sendJson(response, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.notifyShutdown();
    shutdownServer(httpServer, activeResponses);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  const authHint = accessToken ? ` token=${accessToken}` : " auth=disabled";
  process.stdout.write(`deepcode headless listening on http://${host}:${port}${authHint}\n`);

  await new Promise<void>((resolve) => {
    httpServer.on("close", resolve);
  });
  runtime.dispose();
}

class HeadlessRuntime {
  private readonly projectRoot: string;
  private readonly listeners = new Set<(event: HeadlessEvent) => void>();
  private readonly sessionManager: SessionManager;
  private activeRequestId: string | null = null;
  private sequence = 0;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.sessionManager = new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      onAssistantMessage: (message, shouldConnect) => {
        if (message.visible === false) {
          return;
        }
        this.pushEvent({ type: "appendMessage", message: serializeMessage(message), shouldConnect });
      },
      onSessionEntryUpdated: (entry) => {
        this.pushEvent({
          type: "sessionStatus",
          sessionId: entry.id,
          status: entry.status,
          processes: serializeProcesses(entry.processes),
          askPermissions: entry.askPermissions,
          tokenTelemetry: this.buildTokenTelemetry(entry),
        });
        if (entry.status === "ask_permission") {
          this.pushEvent({
            type: "permissionRequest",
            sessionId: entry.id,
            askPermissions: entry.askPermissions ?? [],
          });
        }
      },
      onLlmStreamProgress: (progress) => this.pushEvent({ type: "llmStreamProgress", progress }),
      onMcpStatusChanged: () => this.pushEvent({ type: "mcpStatus", statuses: this.getMcpStatus() }),
      onProcessStdout: (pid, chunk) => this.pushEvent({ type: "processStdout", pid, chunk }),
    });
  }

  async init(): Promise<void> {
    await this.sessionManager.initMcpServers(resolveCurrentSettings(this.projectRoot).mcpServers);
  }

  dispose(): void {
    this.sessionManager.dispose();
    this.listeners.clear();
  }

  notifyShutdown(): void {
    this.pushEvent({ type: "shutdown" });
  }

  subscribe(listener: (event: HeadlessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ready(): Promise<JsonValue> {
    const events: HeadlessEvent[] = [];
    events.push(this.pushEvent(this.buildInitialSessionEvent()));
    events.push(this.pushEvent(await this.buildSkillsListEvent()));
    events.push(this.pushEvent({ type: "modelConfig", config: this.buildModelConfig(resolveCurrentSettings(this.projectRoot)) }));
    return { ok: true, data: { events } };
  }

  listSessions(): SessionEntry[] {
    return this.sessionManager.listSessions();
  }

  async sendSkillsList(sessionId?: string): Promise<JsonValue> {
    const event = await this.buildSkillsListEvent(sessionId);
    this.pushEvent(event);
    return { ok: true, data: event };
  }

  getMcpStatus(): unknown[] {
    return this.sessionManager.getMcpStatus();
  }

  getModelConfig(): JsonValue {
    return { ok: true, data: this.buildModelConfig(resolveCurrentSettings(this.projectRoot)) };
  }

  updateModelConfig(body: RequestBody): JsonValue {
    const current = resolveCurrentSettings(this.projectRoot);
    const selected = normalizeModelSelection(body, current);
    if (!selected.ok) {
      return { ok: false, error: selected.error };
    }
    const result = writeModelConfigSelection(selected.data, current, this.projectRoot);
    const next = resolveCurrentSettings(this.projectRoot);
    const event = this.pushEvent({ type: "modelConfig", config: this.buildModelConfig(next), changed: result.changed });
    return { ok: true, data: event };
  }

  listProcesses(): JsonValue {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      return { ok: false, error: "No active session" };
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    return { ok: true, data: { sessionId, processes: serializeProcesses(session.processes) } };
  }

  adjustProcessTimeout(body: RequestBody): JsonValue {
    const delta = normalizeDeltaMs(body.deltaMs);
    if (!delta.ok) {
      return { ok: false, error: delta.error };
    }
    const result = this.sessionManager.adjustActiveBashTimeout(delta.data);
    if (!result) {
      return { ok: false, error: "No adjustable active bash timeout" };
    }
    this.pushActiveSessionStatus();
    return { ok: true, data: result as JsonValue };
  }

  showSessionsList(): JsonValue {
    const event = { type: "showSessionsList", sessions: this.buildSessionsList() };
    this.pushEvent(event);
    return { ok: true, data: event };
  }

  async selectSession(sessionId: string): Promise<JsonValue> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    this.sessionManager.setActiveSessionId(sessionId);
    const loadEvent = this.buildLoadSessionEvent(session);
    const skillsEvent = await this.buildSkillsListEvent(sessionId);
    this.pushEvent(loadEvent);
    this.pushEvent(skillsEvent);
    return { ok: true, data: { events: [loadEvent, skillsEvent] } };
  }

  async newSession(): Promise<JsonValue> {
    if (this.activeRequestId) {
      return { ok: false, error: "DeepCode is busy" };
    }
    this.sessionManager.setActiveSessionId(null);
    const initEvent = this.buildInitializeEmptyEvent();
    const skillsEvent = await this.buildSkillsListEvent();
    this.pushEvent(initEvent);
    this.pushEvent(skillsEvent);
    return { ok: true, data: { events: [initEvent, skillsEvent] } };
  }

  interrupt(): JsonValue {
    const sessionId = this.sessionManager.getActiveSessionId();
    this.sessionManager.interruptActiveSession();
    this.pushActiveSessionStatus();
    const session = sessionId ? this.sessionManager.getSession(sessionId) : null;
    return { ok: true, data: { sessionId, status: session?.status ?? null } };
  }

  openFile(body: RequestBody): JsonValue {
    const request = normalizeOpenFileRequest(this.projectRoot, body);
    if (!request.ok) {
      return { ok: false, error: request.error };
    }
    const opened = launchOpenFile(request.data, (error) => {
      this.pushEvent({
        type: "openFileFailed",
        filePath: request.data.relativePath,
        absolutePath: request.data.absolutePath,
        line: request.data.line,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const event = this.pushEvent({
      type: "openFile",
      filePath: request.data.relativePath,
      absolutePath: request.data.absolutePath,
      line: request.data.line,
      opener: opened,
    });
    return { ok: true, data: event };
  }

  undoTargets(): JsonValue {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      return { ok: false, error: "No active session" };
    }
    return { ok: true, data: this.sessionManager.listUndoTargets(sessionId) };
  }

  restoreUndo(body: RequestBody, defaults: { restoreCode?: boolean; restoreConversation?: boolean } = {}): JsonValue {
    const sessionId = normalizeSessionId(body.sessionId, this.sessionManager.getActiveSessionId());
    if (!sessionId) {
      return { ok: false, error: "No active session" };
    }
    const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
    if (!messageId) {
      return { ok: false, error: "messageId is required" };
    }
    const restoreCode = defaults.restoreCode ?? body.restoreCode === true;
    const restoreConversation = defaults.restoreConversation ?? body.restoreConversation !== false;
    if (!restoreCode && !restoreConversation) {
      return { ok: false, error: "restoreCode or restoreConversation must be true" };
    }
    try {
      if (restoreCode) {
        this.sessionManager.restoreSessionCode(sessionId, messageId);
      }
      if (restoreConversation) {
        this.sessionManager.restoreSessionConversation(sessionId, messageId);
      }
      const events: HeadlessEvent[] = [];
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        const loadEvent = this.buildLoadSessionEvent(session);
        this.pushEvent(loadEvent);
        events.push(loadEvent);
      }
      const listEvent = { type: "showSessionsList", sessions: this.buildSessionsList() };
      this.pushEvent(listEvent);
      events.push(listEvent);
      return { ok: true, data: { sessionId, messageId, restoredCode: restoreCode, restoredConversation, events } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  renameSession(body: RequestBody): JsonValue {
    const sessionId = normalizeSessionId(body.sessionId, this.sessionManager.getActiveSessionId());
    const summary = typeof body.summary === "string" ? body.summary : typeof body.name === "string" ? body.name : "";
    if (!sessionId) {
      return { ok: false, error: "sessionId is required" };
    }
    if (!summary.trim()) {
      return { ok: false, error: "summary is required" };
    }
    const renamed = this.sessionManager.renameSession(sessionId, summary);
    if (!renamed) {
      return { ok: false, error: "Session not found or summary is empty" };
    }
    const event = { type: "showSessionsList", sessions: this.buildSessionsList() };
    this.pushEvent(event);
    this.pushActiveSessionStatus();
    return { ok: true, data: event };
  }

  deleteSession(body: RequestBody): JsonValue {
    const sessionId = normalizeSessionId(body.sessionId, this.sessionManager.getActiveSessionId());
    if (!sessionId) {
      return { ok: false, error: "sessionId is required" };
    }
    const wasActive = this.sessionManager.getActiveSessionId() === sessionId;
    const deleted = this.sessionManager.deleteSession(sessionId);
    if (!deleted) {
      return { ok: false, error: "Session not found" };
    }
    const events: HeadlessEvent[] = [];
    if (wasActive) {
      this.sessionManager.setActiveSessionId(null);
      const initEvent = this.buildInitializeEmptyEvent();
      this.pushEvent(initEvent);
      events.push(initEvent);
    }
    const listEvent = { type: "showSessionsList", sessions: this.buildSessionsList() };
    this.pushEvent(listEvent);
    events.push(listEvent);
    return { ok: true, data: { sessionId, events } };
  }

  pendingPermissions(): JsonValue {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      return { ok: false, error: "No active session" };
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    return { ok: true, data: { sessionId, status: session.status, askPermissions: session.askPermissions ?? [] } };
  }

  replyPermissions(body: RequestBody): JsonValue {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      return { ok: false, error: "No active session" };
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    if (!session.askPermissions || session.askPermissions.length === 0) {
      return { ok: false, error: "No pending permission request" };
    }
    const permissions = normalizeUserPermissions(body.permissions ?? body.decisions);
    if (permissions.length === 0) {
      return { ok: false, error: "No permission replies provided" };
    }
    const alwaysAllows = normalizePermissionScopes(body.alwaysAllows);
    const hasDeny = permissions.some((permission) => permission.permission === "deny");
    const mode = typeof body.mode === "string" ? body.mode : undefined;
    const text = typeof body.text === "string" ? body.text : typeof body.prompt === "string" ? body.prompt : "/continue";
    if (hasDeny && mode === "deny-and-stop") {
      this.sessionManager.denySessionPermission(sessionId);
      this.pushActiveSessionStatus();
      return { ok: true, data: { sessionId, denied: true } };
    }
    return this.startPrompt({ text: text.trim() || "/continue", permissions, alwaysAllows });
  }

  startPrompt(userPrompt: UserPromptContent): JsonValue {
    if (this.activeRequestId) {
      return { ok: false, error: "DeepCode is busy", requestId: this.activeRequestId };
    }
    const requestId = crypto.randomUUID();
    this.activeRequestId = requestId;
    void this.runPromptTurn(requestId, userPrompt);
    return { ok: true, data: { accepted: true, requestId } };
  }

  private async runPromptTurn(requestId: string, userPrompt: UserPromptContent): Promise<void> {
    const previousRequestId = this.activeRequestId;
    this.activeRequestId = requestId;
    const displayPrompt = userPrompt.text || (userPrompt.imageUrls && userPrompt.imageUrls.length > 0 ? "粘贴的图像" : "");
    this.pushEvent({ type: "userMessage", content: displayPrompt });
    this.pushEvent({ type: "loading", value: true });
    try {
      await this.sessionManager.handleUserPrompt(userPrompt);
      this.pushEvent(await this.buildSkillsListEvent());
      this.pushActiveSessionStatus();
      this.pushEvent({ type: "showSessionsList", sessions: this.buildSessionsList() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEvent({ type: "assistant", content: `Request failed: ${message}` });
      this.pushEvent({ type: "error", message });
    } finally {
      this.pushEvent({ type: "loading", value: false });
      this.activeRequestId = previousRequestId === requestId ? null : previousRequestId;
    }
  }

  private pushActiveSessionStatus(): void {
    const sessionId = this.sessionManager.getActiveSessionId();
    const session = sessionId ? this.sessionManager.getSession(sessionId) : null;
    if (!sessionId || !session) {
      return;
    }
    this.pushEvent({
      type: "sessionStatus",
      sessionId,
      status: session.status,
      processes: serializeProcesses(session.processes),
      askPermissions: session.askPermissions,
      tokenTelemetry: this.buildTokenTelemetry(session),
    });
  }

  private pushEvent(event: HeadlessEvent): HeadlessEvent {
    const enriched: HeadlessEvent = {
      ...event,
      requestId: event.requestId ?? this.activeRequestId ?? undefined,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      listener(enriched);
    }
    return enriched;
  }

  private buildInitialSessionEvent(): HeadlessEvent {
    const sessions = this.sessionManager.listSessions();
    if (sessions.length === 0) {
      return this.buildInitializeEmptyEvent();
    }
    const latestSession = sessions[0];
    this.sessionManager.setActiveSessionId(latestSession.id);
    return this.buildLoadSessionEvent(latestSession);
  }

  private buildInitializeEmptyEvent(): HeadlessEvent {
    return { type: "initializeEmpty", sessions: this.buildSessionsList(), status: null, tokenTelemetry: this.buildTokenTelemetry(null) };
  }

  private buildLoadSessionEvent(session: SessionEntry): HeadlessEvent {
    const messages = this.sessionManager.listSessionMessages(session.id).filter((message) => message.visible);
    return {
      type: "loadSession",
      sessionId: session.id,
      summary: session.summary || "Untitled",
      status: session.status,
      processes: serializeProcesses(session.processes),
      tokenTelemetry: this.buildTokenTelemetry(session),
      sessions: this.buildSessionsList(),
      messages: messages.map((message) => serializeMessage(message)),
    };
  }

  private async buildSkillsListEvent(sessionId?: string): Promise<HeadlessEvent> {
    const skills = await this.sessionManager.listSkills(sessionId ?? this.sessionManager.getActiveSessionId() ?? undefined);
    return { type: "skillsList", skills };
  }

  private buildSessionsList(): Array<Pick<SessionEntry, "id" | "createTime" | "updateTime" | "status"> & { summary: string }> {
    return this.sessionManager.listSessions().map((session) => ({
      id: session.id,
      summary: session.summary || "Untitled",
      createTime: session.createTime,
      updateTime: session.updateTime,
      status: session.status,
    }));
  }

  private buildTokenTelemetry(session: SessionEntry | null): JsonValue {
    const settings = resolveCurrentSettings(this.projectRoot);
    return {
      model: settings.model,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      activeTokens: session?.activeTokens ?? 0,
      compactPromptTokenThreshold: getCompactPromptTokenThreshold(settings.model),
      usage: session?.usage ?? null,
    };
  }

  private buildModelConfig(settings: ResolvedDeepcodingSettings): JsonValue {
    return {
      model: settings.model,
      baseURL: settings.baseURL,
      provider: { baseURL: settings.baseURL, apiKeyConfigured: Boolean(settings.apiKey) },
      availableModels: buildAvailableModelOptions(),
      reasoningEfforts: buildReasoningEffortOptions(),
      thinkingOptions: buildThinkingOptions(),
      temperature: settings.temperature,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      telemetryEnabled: settings.telemetryEnabled,
      webSearchTool: settings.webSearchTool,
    };
  }
}

async function routeRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  runtime: HeadlessRuntime;
  version: string;
  projectRoot: string;
  shutdown: () => void;
}): Promise<void> {
  const { request, response, runtime, version, projectRoot, shutdown } = input;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";

  if (method === "GET" && pathname === "/events") return openSseStream(request, response, runtime);
  if ((method === "GET" || method === "POST") && pathname === "/ready") return sendJson(response, 200, await runtime.ready());
  if (method === "GET" && pathname === "/health") return sendJson(response, 200, { ok: true, data: { version, projectRoot } });
  if (method === "GET" && pathname === "/version") return sendJson(response, 200, { ok: true, data: { version } });
  if (method === "GET" && pathname === "/commands") return sendJson(response, 200, { ok: true, data: buildHeadlessCommandRoutes() });
  if (method === "GET" && pathname === "/model") return sendJson(response, 200, runtime.getModelConfig());
  if (method === "POST" && pathname === "/model") return sendJson(response, 200, runtime.updateModelConfig(await readJsonBody(request)));
  if (method === "GET" && pathname === "/processes") return sendJson(response, 200, runtime.listProcesses());
  if (method === "POST" && pathname === "/processes/timeout") {
    return sendJson(response, 200, runtime.adjustProcessTimeout(await readJsonBody(request)));
  }
  if (method === "GET" && pathname === "/sessions") return sendJson(response, 200, { ok: true, data: runtime.listSessions() });
  if (method === "POST" && pathname === "/sessions/rename") return sendJson(response, 200, runtime.renameSession(await readJsonBody(request)));
  if (method === "POST" && pathname === "/sessions/delete") return sendJson(response, 200, runtime.deleteSession(await readJsonBody(request)));
  if ((method === "GET" || method === "POST") && pathname === "/request-skills") return sendJson(response, 200, await runtime.sendSkillsList());
  if ((method === "GET" || method === "POST") && pathname === "/back-to-list") return sendJson(response, 200, runtime.showSessionsList());
  if (method === "POST" && (pathname === "/open-file" || pathname === "/openFile")) return sendJson(response, 200, runtime.openFile(await readJsonBody(request)));
  if (method === "GET" && pathname === "/permissions/pending") return sendJson(response, 200, runtime.pendingPermissions());
  if (method === "POST" && pathname === "/permissions/reply") return sendJson(response, 202, runtime.replyPermissions(await readJsonBody(request)));
  if (method === "POST" && pathname === "/select-session") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await runtime.selectSession(String(body.sessionId ?? "")));
  }
  if (method === "POST" && pathname === "/prompt") {
    const prompt = buildPrompt(projectRoot, await readJsonBody(request));
    return sendJson(response, prompt.ok ? 202 : 400, prompt.ok ? runtime.startPrompt(prompt.data) : { ok: false, error: prompt.error });
  }
  if (method === "POST" && pathname === "/interrupt") return sendJson(response, 200, runtime.interrupt());
  if (method === "POST" && pathname === "/undo/restore") return sendJson(response, 200, runtime.restoreUndo(await readJsonBody(request)));
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
    return sendJson(response, 501, { ok: false, error: `Command ${command.label} is not implemented in headless mode yet.` });
  }
  if (command.name === "skills") return sendJson(response, 200, await runtime.sendSkillsList());
  if (command.name === "mcp") return sendJson(response, 200, { ok: true, data: runtime.getMcpStatus() });
  if (command.name === "resume") return sendJson(response, 200, runtime.showSessionsList());
  if (command.name === "new") return sendJson(response, 200, await runtime.newSession());
  if (command.name === "undo") return sendJson(response, 200, runtime.undoTargets());
  if (command.name === "exit") {
    sendJson(response, 200, { ok: true });
    setTimeout(shutdown, 0);
    return;
  }
  const body = method === "POST" ? await readJsonBody(request) : {};
  const prompt = buildPrompt(projectRoot, { ...body, text: `/${command.name}` });
  return sendJson(response, prompt.ok ? 202 : 400, prompt.ok ? runtime.startPrompt(prompt.data) : { ok: false, error: prompt.error });
}

function openSseStream(request: IncomingMessage, response: ServerResponse, runtime: HeadlessRuntime): void {
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

function writeSseEvent(response: ServerResponse, eventName: string, data: JsonValue): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildPrompt(projectRoot: string, body: RequestBody): { ok: true; data: UserPromptContent } | { ok: false; error: string } {
  const text = typeof body.text === "string" ? body.text : typeof body.prompt === "string" ? body.prompt : "";
  const imageUrls = normalizeImageUrls(projectRoot, body);
  if (!imageUrls.ok) {
    return imageUrls;
  }
  const skills = Array.isArray(body.skills) ? (body.skills as SkillInfo[]) : undefined;
  return { ok: true, data: { text, imageUrls: imageUrls.data, skills } };
}

function normalizeImageUrls(projectRoot: string, body: RequestBody): { ok: true; data: string[] } | { ok: false; error: string } {
  const rawItems = [...toArray(body.imageUrls), ...toArray(body.images)];
  const result: string[] = [];
  for (const item of rawItems) {
    const normalized = normalizeImageItem(projectRoot, item);
    if (!normalized.ok) {
      return normalized;
    }
    if (normalized.data && !result.includes(normalized.data)) {
      result.push(normalized.data);
    }
  }
  return { ok: true, data: result };
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function normalizeImageItem(projectRoot: string, item: unknown): { ok: true; data: string | null } | { ok: false; error: string } {
  if (typeof item === "string") {
    return normalizeImageString(projectRoot, item);
  }
  if (!isRecord(item)) {
    return { ok: false, error: "Image item must be a string or object" };
  }
  if (typeof item.dataUrl === "string") return normalizeImageString(projectRoot, item.dataUrl);
  if (typeof item.url === "string") return normalizeImageString(projectRoot, item.url);
  if (typeof item.filePath === "string") return readImageFileAsDataUrl(projectRoot, item.filePath);
  if (typeof item.path === "string") return readImageFileAsDataUrl(projectRoot, item.path);
  return { ok: false, error: "Image object requires dataUrl, url, filePath, or path" };
}

function normalizeImageString(projectRoot: string, value: string): { ok: true; data: string | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, data: null };
  if (/^data:image\//iu.test(trimmed)) return { ok: true, data: trimmed };
  if (/^blob:/iu.test(trimmed)) return { ok: false, error: "blob: image URLs must be converted to data URLs before sending to the server" };
  if (/^https?:\/\//iu.test(trimmed)) return { ok: true, data: trimmed };
  if (/^file:\/\//iu.test(trimmed)) {
    try {
      return readImageFileAsDataUrl(projectRoot, fileURLToPath(trimmed));
    } catch {
      return { ok: false, error: "Invalid file URL image" };
    }
  }
  return readImageFileAsDataUrl(projectRoot, trimmed);
}

function readImageFileAsDataUrl(projectRoot: string, filePath: string): { ok: true; data: string } | { ok: false; error: string } {
  const request = normalizeProjectFilePath(projectRoot, filePath);
  if (!request.ok) return request;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(request.data.absolutePath);
  } catch {
    return { ok: false, error: `Image file not found: ${request.data.relativePath}` };
  }
  if (!stat.isFile()) return { ok: false, error: `Image path is not a file: ${request.data.relativePath}` };
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: `Image file is too large: ${request.data.relativePath}` };
  const mime = getImageMimeType(request.data.absolutePath);
  if (!mime) return { ok: false, error: `Unsupported image type: ${request.data.relativePath}` };
  return { ok: true, data: `data:${mime};base64,${fs.readFileSync(request.data.absolutePath).toString("base64")}` };
}

function getImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return null;
}

function normalizeUserPermissions(value: unknown): UserToolPermission[] {
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.entries(value).map(([toolCallId, permission]) => ({ toolCallId, permission })) : [];
  return entries
    .map((item) => {
      if (!isRecord(item) || typeof item.toolCallId !== "string") return null;
      if (item.permission !== "allow" && item.permission !== "deny") return null;
      return { toolCallId: item.toolCallId, permission: item.permission } satisfies UserToolPermission;
    })
    .filter((item): item is UserToolPermission => item !== null);
}

function normalizePermissionScopes(value: unknown): PermissionScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter((item): item is PermissionScope => typeof item === "string" && VALID_PERMISSION_SCOPES.has(item as PermissionScope));
  return scopes.length > 0 ? Array.from(new Set(scopes)) : undefined;
}

function buildReasoningEffortOptions(): ReasoningEffort[] {
  const efforts = MODEL_COMMAND_THINKING_OPTIONS
    .map((option) => option.reasoningEffort)
    .filter((effort): effort is ReasoningEffort => effort === "high" || effort === "max");
  return Array.from(new Set(efforts));
}

function buildThinkingOptions(): boolean[] {
  return Array.from(new Set(MODEL_COMMAND_THINKING_OPTIONS.map((option) => option.thinkingEnabled)));
}

function normalizeModelSelection(body: RequestBody, current: ResolvedDeepcodingSettings): { ok: true; data: ModelConfigSelection } | { ok: false; error: string } {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : current.model;
  const thinkingEnabled = typeof body.thinkingEnabled === "boolean" ? body.thinkingEnabled : current.thinkingEnabled;
  const hasReasoningEffort = Object.prototype.hasOwnProperty.call(body, "reasoningEffort");
  const requestedReasoningEffort = hasReasoningEffort ? normalizeReasoningEffort(body.reasoningEffort) : undefined;
  if (hasReasoningEffort && !requestedReasoningEffort) {
    return { ok: false, error: "reasoningEffort must be high or max" };
  }
  return { ok: true, data: { model, thinkingEnabled, reasoningEffort: requestedReasoningEffort ?? current.reasoningEffort } };
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "high" || value === "max" ? value : undefined;
}

function normalizeDeltaMs(value: unknown): { ok: true; data: number } | { ok: false; error: string } {
  const deltaMs = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(deltaMs) && deltaMs !== 0 ? { ok: true, data: deltaMs } : { ok: false, error: "deltaMs must be a non-zero finite number" };
}

function normalizeSessionId(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function buildAvailableModelOptions(): ModelOption[] {
  return MODEL_COMMAND_MODELS.map((model) => ({ model, thinkingDefault: defaultsToThinkingMode(model), supportsMultimodal: supportsMultimodal(model) }));
}

function normalizeOpenFileRequest(projectRoot: string, body: RequestBody): { ok: true; data: OpenFileRequest } | { ok: false; error: string } {
  const rawPath = typeof body.filePath === "string" ? body.filePath : typeof body.path === "string" ? body.path : "";
  const request = normalizeProjectFilePath(projectRoot, rawPath);
  if (!request.ok) return request;
  const lineNumber = Number(body.line ?? 1);
  const line = Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : 1;
  return { ok: true, data: { ...request.data, line } };
}

function normalizeProjectFilePath(projectRoot: string, filePath: string): { ok: true; data: Omit<OpenFileRequest, "line"> } | { ok: false; error: string } {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) return { ok: false, error: "filePath is required" };
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(path.isAbsolute(trimmedPath) ? trimmedPath : path.join(root, trimmedPath));
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, error: "filePath must point to a file inside the project root" };
  }
  return { ok: true, data: { absolutePath, relativePath } };
}

function launchOpenFile(request: OpenFileRequest, onFinalError: (error: unknown) => void): OpenFileCommand | null {
  const commands = getOpenFileCommands(request.absolutePath, request.line);
  let index = 0;
  const tryNext = (): void => {
    const candidate = commands[index];
    if (!candidate) {
      onFinalError(new Error("No available opener command"));
      return;
    }
    index += 1;
    try {
      const child = spawn(candidate.command, candidate.args, { detached: true, stdio: "ignore" });
      child.once("error", () => tryNext());
      child.unref();
    } catch (error) {
      if (index >= commands.length) onFinalError(error);
      else tryNext();
    }
  };
  tryNext();
  return commands[0] ?? null;
}

function getOpenFileCommands(filePath: string, line: number): OpenFileCommand[] {
  const commands: OpenFileCommand[] = [{ command: "code", args: ["-g", `${filePath}:${line}`] }];
  if (process.platform === "darwin") commands.push({ command: "open", args: [filePath] });
  else if (process.platform === "win32") commands.push({ command: "cmd.exe", args: ["/c", "start", "", filePath] });
  else commands.push({ command: "xdg-open", args: [filePath] });
  return commands;
}

function serializeMessage(message: SessionMessage): JsonValue {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    contentParams: message.contentParams,
    messageParams: message.messageParams,
    compacted: message.compacted,
    visible: message.visible,
    createTime: message.createTime,
    updateTime: message.updateTime,
    meta: message.meta,
    checkpointHash: message.checkpointHash,
  };
}

function serializeProcesses(processes: SessionEntry["processes"]): JsonValue {
  if (!processes || processes.size === 0) return null;
  const result: Record<string, unknown> = {};
  for (const [pid, entry] of processes.entries()) result[pid] = entry;
  return result;
}

function setBaseHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  response.setHeader("Access-Control-Allow-Origin", isAllowedLocalOrigin(origin) ? origin : "http://127.0.0.1");
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "content-type, x-deepcode-token, authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response: ServerResponse, statusCode: number, payload: JsonValue): void {
  if (response.headersSent) return;
  const finalStatusCode = statusCode < 400 && isFailurePayload(payload) ? statusCodeForFailure(payload) : statusCode;
  response.writeHead(finalStatusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function isFailurePayload(payload: JsonValue): payload is Record<string, unknown> & { ok: false; error?: unknown } {
  return isRecord(payload) && payload.ok === false;
}

function statusCodeForFailure(payload: Record<string, unknown> & { ok: false; error?: unknown }): number {
  const error = typeof payload.error === "string" ? payload.error.toLowerCase() : "";
  if (error.includes("not found")) return 404;
  if (error.includes("required") || error.includes("invalid") || error.includes("unsupported") || error.includes("too large") || error.includes("must") || error.includes("no permission replies")) return 400;
  if (error.includes("busy") || error.includes("no active") || error.includes("pending") || error.includes("permission request") || error.includes("permission mismatch") || error.includes("permission denied") || error.includes("conflict") || error.includes("state") || error.includes("adjustable")) return 409;
  return 400;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.searchParams.get("token") === token) return true;
  if (request.headers["x-deepcode-token"] === token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(request: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpRequestError("Request body too large", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RequestBody;
  } catch {
    throw new HttpRequestError("Invalid JSON body", 400);
  }
}

function readArgValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAllowedLocalOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function shutdownServer(httpServer: ReturnType<typeof createServer>, activeResponses: Set<ServerResponse>): void {
  for (const response of activeResponses) {
    if (!response.writableEnded) {
      try {
        response.end();
      } catch {
        // ignore close failures
      }
    }
  }
  httpServer.close();
}
