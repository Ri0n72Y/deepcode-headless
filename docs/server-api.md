# DeepCode Server API

[English](./server-api_en.md) · 中文

本文档是 DeepCode 本地 HTTP/SSE server 的前端集成契约。它合并并取代旧的 `docs/headless-api.md`、`docs/headless-cli-scope.md` 和 `docs/skills/deepcode-headless-frontend/SKILL.md`。

## 定位

Server 是与 CLI、VSCode companion 同级的运行时入口，依赖 `@vegamo/deepcode-core`，不依赖 `@vegamo/deepcode-cli`、Ink 或 CLI UI 组件。前端、Tauri、VSCode 等客户端应通过 HTTP 动作请求和 SSE 状态事件接入 server。

推荐入口是 `deepcode-server`。`deepcode-headless-server` 可作为兼容别名；不要把 `deepcode --server` 作为新集成的主入口。

## 启动

```bash
deepcode-server --port 8787
```

常用参数：

- `--host 127.0.0.1`：监听地址，默认仅本机。
- `--port 8787`：监听端口。
- `--project-root <path>`：项目根目录；桌面端不应假设进程 `cwd` 一定是项目根目录。
- `--no-auth`：仅用于可信本地开发。
- `--unsafe-bind`：允许非本机地址绑定，例如 `0.0.0.0`。

默认开启 token 鉴权。stdout 会打印类似：

```text
deepcode server listening on http://127.0.0.1:8787 token=<token>
```

鉴权 token 可通过以下任一方式传递：

- `?token=<token>`
- `x-deepcode-token: <token>`
- `Authorization: Bearer <token>`

## 前端启动流程

1. 启动 `deepcode-server` 子进程。
2. 从 stdout 读取 token。
3. 建立 `GET /events?token=<token>` SSE 连接。
4. 调用 `POST /ready` 初始化状态。
5. 以后以 SSE 事件作为 UI 状态来源，HTTP 只用于用户动作。

浏览器 `EventSource` 不能设置自定义 header，因此 SSE 通常使用 query token。

## 范围

Server 只暴露现有 DeepCode runtime / CLI-TUI 已有能力，不是独立管理后台。斜杠命令含义参考 [README 的“斜杠命令与按键功能”](../README.md#斜杠命令与按键功能)。

不提供：

- prompt queue
- 多 session 并发执行
- provider / API key / base URL 写入接口；配置参考 [configuration.md](./configuration.md)
- MCP 重启、启停、配置编辑、日志接口；MCP 配置参考 [mcp.md](./mcp.md)
- 完整 settings 管理接口
- 单进程 kill 接口
- backend raw display state
- WebSocket 传输

`/raw` 属于 CLI 显示模式。前端应自行决定 reasoning、tool detail 和 raw scrollback 的展示方式。

## 响应与错误

JSON 路由请求体上限为 2 MiB；空 body 按 `{}` 处理。

所有业务响应都应检查 `ok` 字段，不要只看 HTTP `200`。

| 状态码 | 含义 |
| --- | --- |
| `200` | 同步成功 |
| `202` | prompt 已接受，后续通过 SSE 推送 |
| `400` | body、参数或选择非法 |
| `401` | 缺少或错误 token |
| `404` | 路由或资源不存在 |
| `409` | runtime 状态冲突，例如 busy、无 active session、permission 状态不匹配 |
| `413` | JSON body 超过限制 |
| `500` | 未预期内部错误 |

错误响应形态：

```json
{ "ok": false, "error": "message" }
```

## SSE 事件

事件带有统一 envelope：`type`、`sequence`、`timestamp`，并可包含 `requestId`。前端用 `sequence` 排序，用 `requestId` 关联同一轮 prompt。

核心事件：

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

## HTTP 路由

| 路由 | 说明 |
| --- | --- |
| `GET /health` | 健康检查和项目根目录。 |
| `GET /version` | server 版本。 |
| `GET /events` | SSE 事件流。 |
| `GET\|POST /ready` | 初始化 UI 状态，并推送初始事件。 |
| `GET /commands` | server 支持的命令路由元数据。 |
| `POST /prompt` | 提交用户 prompt；成功返回 `202`，模型输出走 SSE。 |
| `POST /interrupt` | 中断当前 agent turn。 |
| `GET /sessions` | 会话列表。 |
| `POST /select-session` | 选择会话并推送 `loadSession`。 |
| `POST /sessions/rename` | 重命名会话；`name` 可作为 `summary` 别名。 |
| `POST /sessions/delete` | 删除会话。 |
| `GET\|POST /back-to-list` | 返回会话列表视图。 |
| `GET /skills`、`GET\|POST /request-skills` | 返回并推送 skills 列表；skill 机制参考 [README 的 Skills 段](../README.md#skills)。 |
| `GET /model` | 读取当前模型、thinking、reasoning effort 和只读 provider 信息。 |
| `POST /model` | 只更新 `model`、`thinkingEnabled`、`reasoningEffort`。 |
| `GET /mcp` | 返回 MCP 状态；不提供 MCP 管理接口。 |
| `GET /processes` | 当前 active session 的进程状态。 |
| `POST /processes/timeout` | 用 `deltaMs` 调整 active Bash timeout。 |
| `GET /permissions/pending` | 当前待处理 permission request。 |
| `POST /permissions/reply` | 回复 permission：`allow`、`deny-and-continue`、`deny-and-stop`。权限配置参考 [permission.md](./permission.md)。 |
| `GET /undo` | active session 的 undo targets。 |
| `POST /undo/restore` | 恢复 conversation 和/或 code。 |
| `POST /undo/restore-code` | 只恢复 code。 |
| `POST /undo/restore-conversation` | 只恢复 conversation。 |
| `POST /open-file` | 校验项目内路径并请求本机打开文件。 |
| `POST /exit` | 推送 `shutdown` 并关闭 server。 |

## Prompt 与图片

`POST /prompt` 可包含：

- `text`
- `skills`
- `imageUrls`
- `images`
- `permissions`
- `alwaysAllows`

图片支持 data URL、远程 `http/https` 图片 URL、`{ dataUrl }`、`{ url }`、`{ filePath }`、`{ path }`。本地图片路径必须位于 `projectRoot` 内，支持 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`，上限 10 MiB。

浏览器 `blob:` URL 无法由 server 读取，前端应先转换为 data URL。

## 前端实现约束

- UI 状态以 SSE 为准，HTTP 返回只表示动作是否被接受。
- `/prompt` 返回 busy 时不要排队，也不要重复发送。
- 权限请求到达时暂停当前 turn UI，通过 `/permissions/reply` 回复。
- `openFileFailed` 是可恢复 UI 提示，不应导致进程退出。
- 桌面端只在自己拥有 server 子进程时调用 `/exit`。

## 负向路由

以下能力当前不实现；客户端不得依赖：

- `/prompt-queue`
- `/queue`
- `/provider`
- `/providers`
- `/mcp/restart`
- `/mcp/enable`
- `/mcp/disable`
- `/mcp/logs`
- `/processes/kill`
- backend `/raw` 状态

## 最低验收

- `deepcode-server --help`
- `deepcode-server --port <port>`
- 默认 auth：无 token 的 `/health` 返回 `401`，带 token 返回 `200`
- `/events` 能收到 `connected`
- `/ready` 能推送初始状态
- `/model`、`/sessions`、`/skills`、`/mcp` 基础路由可用
- invalid JSON 返回 `400`
- body too large 返回 `413`
- `/exit` 能关闭本地 server

真实 provider prompt、permission 深路径、undo restore、长任务 interrupt、跨平台 open-file 和生命周期信号仍需单独 smoke。