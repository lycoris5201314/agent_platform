# Agent Foundry Local

一个本机单用户优先、保留多租户接口的持久化 Agent 平台。它复用 Codex App Server，并在外层实现任务状态机、SQLite 队列、租约/心跳、持久信号、审批、Docker 沙箱、隔离式会话记忆、多 Agent worktree 和验证闭环。

## Windows 桌面版（推荐给日常使用者）

运行 `release/Agent-Foundry-Setup-0.3.2-x64.exe` 完成安装。桌面版会自动启动 Web、API 和任务调度器。关闭主窗口后任务会留在系统托盘继续运行；从托盘选择“退出”才会关闭服务并释放端口。自 v0.3.1 起只发布 Setup 安装版，不再生成 Portable 版本。

桌面版内部仍使用两个仅绑定到 `127.0.0.1` 的随机临时端口，这是 Web 界面与本机 API 通信所必需的实现细节。端口由 Windows 自动选择，不对局域网开放，并随应用退出自动释放。

创建任务时点击“浏览文件夹…”即可从 Windows 磁盘中选择工作区；任务运行后，“当前活动”和“模型执行过程”会显示正在读取文件、查看目录、写入文件、执行命令、模型回复以及验证结果。任务详情右侧还可直接在资源管理器中打开工作区。

右侧文件栏可脱离任务根目录浏览本机磁盘，进入子目录、返回上级或回到当前 Agent 工作区；停止状态下可将浏览位置设为任务的新工作区。文本文件可直接编辑，PDF 和常见图片可内嵌预览，其他二进制文件可交给 Windows 默认程序打开。

每个任务可独立选择模型、推理深度、Codex 沙箱权限（只读/工作区写入/完全访问）、审批策略（非可信操作询问/请求批准/无需批准）以及审批人（用户/自动风险审查）。同一连续对话可在下一轮前调整这些设置。Docker 是外层容器隔离；Docker bridge 模式下模型 App Server 与命令仍共享容器网络，详情会标记为 `unrestricted`，当前版本尚未实现二者的网络命名空间拆分。

模型下拉框只列出已经配置 API Key 且可用于 Codex Responses 协议的 Provider。OpenAI 从 Codex `model/list` 读取实时模型目录；第三方 Provider 当前使用已验证并保存的默认模型配置，避免把未经验证的任意模型名发送给运行时。

每轮对话开始时会记录独立工作区快照，结束后只显示本轮新增、修改或删除的文件以及行数，不再把工作区所有历史未提交变更混在一起；本轮新增文件会作为产物入口显示。分支复制真实对话历史和 Codex rollout，不会插入“继续此分支对话”伪消息。压缩会等待 Codex 完成通知并展示压缩前后上下文占比。

首轮任务完成后，无需重新创建任务：在同一会话底部继续输入消息即可。后续消息会复用原工作区、模型配置和 Codex Thread。完整对话与最近上下文会写入本地 SQLite 记忆，关闭或重启 EXE 后仍可继续；新建任务会创建独立 Codex Thread，且默认只检索本对话记忆。

可在“设置与运行时”直接填写 Provider API Key；密钥由 Windows DPAPI 按当前 Windows 用户加密后写入本地数据库，界面和 API 不回传明文。`agent.env` 仍可用于开发和应急配置，保存后桌面应用会直接重新加载 Provider 与模型并刷新界面，无需重启。没有 Key 时可使用 Mock runtime。

开发者重新生成 Setup 安装版：

```powershell
npm install
npm run desktop:dist
```

构建完成后除 Setup 外，还会刷新 `release/Agent Foundry/` 可直接运行目录，并保留其中已有的 `agent.env`。正式验收使用 `npm run release:verify`：它会从该目录启动应用；检测到兼容 Key 时必须真实完成一次模型任务，随后再验证 Setup 的全新安装、内置 Codex 和 Windows 终端。

Windows 原生模式是默认执行后端，不需要安装 WSL2、Ubuntu、Docker Desktop 或 Git。Codex App Server、验证和交互式 PowerShell 终端均直接在 Windows 上执行，并统一套用当前任务的 Codex Windows 沙箱档位。Git 仅在分支、worktree、差异与提交等 Git 功能中需要。WSL2 与 Docker 保留为可选后端；未配置代码签名证书的自建 EXE 可能触发 Windows SmartScreen 提示。

## 当前能力

- Web 控制台：连续对话、持久化 Memory、系统文件夹选择器、可读的模型执行过程、取消与重试
- 持久任务流：队列和 checkpoint 存在 SQLite，进程重启后仍可唤醒定时任务
- 两种 runtime：无需密钥的 `mock`，以及真实的 Codex App Server 双向协议
- 通用 provider 注册表：OpenAI、DeepSeek、自定义 OpenAI-compatible 配置彼此独立
- Windows 原生 workspace：自动创建 Git 工作区，直接在本机准备、执行和验证；无需 WSL2
- 验证闭环：自动识别 Node/Python/Rust，分层执行类型、测试、构建和 Git 检查；失败最多自动修复两次
- 安全默认值：Codex 使用 `workspace-write`，默认关闭网络，审批策略默认为 `on-request`
- 审批闭环：命令、文件变更、工作区操作和用户终端统一显示风险、目录、网络目标与作用范围
- 工作区审阅：懒加载目录树、只读预览、逐文件 diff、暂存/取消暂存/丢弃审批
- 执行记录：稳定 turn/step/tool ID，耗时、退出码、Token、重试次数和大输出 artifact 引用
- Windows ConPTY 终端：每个任务可打开持续交互式 PowerShell，会话支持彩色输出、输入、窗口缩放，并继承该任务的只读/工作区/完全访问沙箱档位
- Windows 桌面集成：系统托盘后台运行、任务完成/失败/等待审批通知、活动任务防休眠、窗口位置与尺寸恢复、系统深色模式、右键编辑菜单、文件拖放和剪贴板图片
- 可靠队列：优先级、Worker lease/heartbeat、Provider/租户并发、指数退避、死信和幂等记录
- 长期任务：Codex 可调用 `durable_wait`，释放 Worker；到期或重启后继续，不依赖长时间 `sleep`
- Docker 沙箱：每任务独立容器、资源限制、工作区/附件/会话挂载和空闲回收
- 长任务：定时 `durable_wait` 与未知时长 `wait_for_external_signal`，均可释放 Worker 并从 SQLite checkpoint 恢复
- 多 Agent：子任务、Git worktree、handoff、合并审批和冲突安全撤销
- 多租户接口：Bearer 鉴权模式、RBAC、行级隔离、DPAPI 密钥、审计与配额
- Codex 管理：模型能力、Skills、MCP、权限/协作模式目录及 MCP 热重载

> DeepSeek 已为 `deepseek-v4-flash` 提供面向 Codex 的 Responses API，可直接复用 Codex App Server 工具流。`deepseek-v4-pro` 暂时不支持该 Responses API；自定义 provider 只有明确实现 Responses API 时才能用于 Codex。

## 快速开始

开发前置条件：Windows、Node.js 22.13+；Git 建议安装但普通任务不强制。WSL2 Ubuntu 与 Docker Desktop 仅在测试对应可选后端时需要。

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

默认地址：

- Web：http://localhost:3000（以终端输出为准）
- API：http://localhost:8788
- 健康检查：http://localhost:8788/api/health

不设置任何 key 时会自动使用 Mock runtime。真实运行 Codex：

```dotenv
AGENT_RUNTIME=codex
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.2-codex
```

使用 DeepSeek 时，编辑项目根目录的 `.env`：

```dotenv
DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

重启 `npm run dev`，新建任务时选择“Codex App Server”运行时和“DeepSeek”供应商。不要把 Base URL 写成 `/v1`，也不要选择当前尚未支持 Responses API 的 `deepseek-v4-pro`。

不要提交 `.env`；仓库只保留无密钥的 `.env.example`。

## 为什么长等待不使用 sleep

任务需要等待时，Codex 可调用平台注入的 `durable_wait` 动态工具。系统把状态改成 `waiting_timer`，保存 durable signal、`next_wakeup_at` 和 checkpoint。短等待可精确恢复原工具调用；长等待或重启后在同一 Codex thread 中重新检查结果。

```text
queued → preparing → waiting_timer ──到期/重启恢复──→ queued
                     ↓
                  cancelled

queued → preparing → running → verifying → succeeded
                         └───────────────→ failed → retry → queued
```

数据库位于 `.agent-data/agent-platform.db`，自动创建的工作区位于 `.agent-data/workspaces/<task-id>`。

## 目录

```text
app/                 Web 控制台
server/core/         类型、状态机、配置、SQLite、事件总线、Tool Gateway
server/runtime/      Mock 与 Codex App Server runtime
server/sandbox/      每任务 Docker 沙箱与生命周期
server/security/     鉴权身份和 Windows DPAPI 密钥库
server/terminal/     持续交互式 ConPTY / WSL2 / Docker 终端会话
server/workspace/    Windows 原生、WSL2 与 Docker 工作区命令路由
server/workflow/     调度器和任务执行闭环
server/verification/ 验证器
tests/               渲染测试
```

## API

- `GET /api/health`、`GET /api/config`
- `GET/POST /api/tasks`、`POST /api/tasks/:id/messages|steer|handoff`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/stream`（SSE）
- `GET /api/tasks/:id/workspace/tree`（懒加载目录）
- `GET /api/tasks/:id/workspace/file|diff`
- `POST /api/tasks/:id/workspace/changes`（生成审批）
- `POST /api/tasks/:id/terminal`（兼容旧版的一次性命令审批）
- `GET/POST /api/tasks/:id/terminal/sessions`，以及会话的 `stream|input|resize|DELETE`（交互终端）
- `GET /api/artifacts/:id`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/retry`
- `GET /api/approvals`
- `POST /api/approvals/:id/decision`
- `GET/PATCH /api/settings`、`GET /api/platform/status|audit`
- 子任务/合并、fork、compact、review、后台终端、Skills/MCP API

## 验证

```powershell
npm run typecheck
npm run test:unit
npm run build
npm run appserver:smoke
npm run sandbox:smoke
npm run desktop:smoke
npm run windows:smoke
npm test
```

参考：[Codex App Server](https://developers.openai.com/codex/app-server/)、[Codex 配置参考](https://developers.openai.com/codex/config-reference/)、[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)、[Codex GitHub 仓库](https://github.com/openai/codex)。
