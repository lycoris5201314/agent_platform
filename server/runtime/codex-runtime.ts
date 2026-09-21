import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AppConfig, ProviderConfig } from "../core/config.js";
import type { ApprovalInput, GoalProgressReport } from "../core/types.js";
import type { AgentRuntime, RuntimeContext, RuntimeResult, RuntimeWaitingApproval, RuntimeWaitingExternal, RuntimeWaitingTimer } from "./runtime.js";
import { codexNativePlatformArgs, codexPermissionProfile, codexProcessEnvironment, createProviderLaunchConfig } from "./provider-launch.js";

type JsonObject = Record<string, unknown>;
type RpcId = number | string;

interface PendingRpc {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
}

interface PendingOutcome {
  resolve: (value: RuntimeResult) => void;
  reject: (error: Error) => void;
}

class AppServerTurn {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, PendingRpc>();
  private nextId = 1;
  private outcome?: PendingOutcome;
  private finalResponse = "";
  private threadId?: string;
  private turnId?: string;
  private usage?: Record<string, unknown>;
  private closed = false;
  private initialized: Promise<void>;
  private stderr = "";
  private readonly modelProvider: string;
  private readonly reasoningSummaries = new Map<string, string>();
  private readonly reasoningFlushTimers = new Map<string, NodeJS.Timeout>();
  private goalReport?: GoalProgressReport;

  constructor(
    private readonly context: RuntimeContext,
    private readonly config: AppConfig,
    private readonly apiKey: string,
    private readonly provider: ProviderConfig,
  ) {
    const launch = createProviderLaunchConfig(provider, apiKey);
    this.modelProvider = launch.modelProvider;
    const inDocker = Boolean(context.workspace.containerId);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(inDocker), ...launch.args];
    const executable = inDocker ? (process.env.DOCKER_PATH ?? "docker") : (config.codexPath ?? "codex");
    const dockerEnvironment = inDocker
      ? [...launch.dockerEnvironment, "-e", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE=agent_foundry_local"]
      : [];
    const spawnArgs = inDocker
      ? ["exec", "-i", ...dockerEnvironment, "-w", context.workspace.runtimePath ?? "/workspace", context.workspace.containerId!, "codex", ...args]
      : args;
    this.child = spawn(executable, spawnArgs, {
      cwd: inDocker ? process.cwd() : context.workspace.windowsPath,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: inDocker
        ? { ...process.env, ...launch.environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" }
        : codexProcessEnvironment(config, {
            ...launch.environment,
            CODEX_PERMISSION_PROFILE: codexPermissionProfile(this.context.task.sandboxMode),
          }),
    });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_000);
    });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed && code !== 0) this.fail(new Error(`Codex App Server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}: ${this.stderr.trim()}`));
    });
    context.signal.addEventListener("abort", () => this.close(), { once: true });
    this.initialized = this.initialize();
  }

  async start(): Promise<RuntimeResult> {
    await this.initialized;
    const common = {
      model: this.context.task.model ?? this.provider.defaultModel,
      modelProvider: this.modelProvider,
      cwd: this.context.workspace.runtimePath ?? this.context.workspace.windowsPath,
      approvalPolicy: this.context.task.approvalPolicy,
      approvalsReviewer: this.context.task.approvalsReviewer,
      // Named profiles are the current App Server permission contract. The
      // task container is already the isolation boundary, so its inner profile
      // must be full access rather than a nested OS sandbox.
      permissions: codexPermissionProfile(this.context.task.sandboxMode, Boolean(this.context.workspace.containerId)),
      reasoningEffort: this.context.task.reasoningEffort,
      config: { sandbox_workspace_write: { network_access: false }, web_search: "disabled" },
      runtimeWorkspaceRoots: this.context.workspace.runtimeWorkspaceRoots ?? [this.context.workspace.runtimePath ?? this.context.workspace.windowsPath],
    };
    const dynamicTools = [{
      type: "function", name: "durable_wait",
      description: "Pause this task durably without running sleep. Use for waits longer than a few seconds or when an external result is not ready. The platform releases the worker and resumes this exact tool call after the timer.",
      inputSchema: { type: "object", properties: { seconds: { type: "integer", minimum: 1, maximum: 86400 }, reason: { type: "string" } }, required: ["seconds"], additionalProperties: false },
    }, {
      type: "function", name: "wait_for_external_signal",
      description: "Pause until an external webhook or system sends a durable signal. Use when completion time is unknown.",
      inputSchema: { type: "object", properties: { correlationKey: { type: "string", minLength: 1, maxLength: 120 }, reason: { type: "string" } }, required: ["correlationKey"], additionalProperties: false },
    }, ...(this.context.task.goalStatus === "active" ? [{
      type: "function", name: "report_goal_progress",
      description: "Required at the end of every persistent-goal iteration. Report whether the objective needs another autonomous iteration, is complete, or is blocked. Be conservative: use completed only after verification, and blocked when user input or approval is required.",
      inputSchema: { type: "object", properties: {
        status: { type: "string", enum: ["continue", "completed", "blocked"] },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string", minLength: 1, maxLength: 1000 },
        nextStep: { type: "string", minLength: 1, maxLength: 1000 },
        blocker: { type: "string", maxLength: 1000 },
      }, required: ["status", "progress", "summary", "nextStep"], additionalProperties: false },
    }] : [])];
    const response = this.context.task.threadId
      ? await this.request("thread/resume", { threadId: this.context.task.threadId, ...common })
      : await this.request("thread/start", { ...common, dynamicTools, ephemeral: false, historyMode: "paginated" });
    const thread = asObject(response.thread);
    this.threadId = String(thread.id ?? this.context.task.threadId ?? "");
    if (this.threadId) this.context.saveThreadId(this.threadId);
    const outcome = this.waitForOutcome();
    const turnResponse = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: this.context.prompt, text_elements: [] }],
      model: common.model,
      effort: this.context.task.reasoningEffort,
      // Ask App Server for the public reasoning summary stream. Raw internal
      // reasoning notifications are intentionally never surfaced or stored.
      summary: "detailed",
      approvalPolicy: common.approvalPolicy,
      approvalsReviewer: common.approvalsReviewer,
      permissions: common.permissions,
      cwd: this.context.workspace.runtimePath ?? this.context.workspace.windowsPath,
      runtimeWorkspaceRoots: common.runtimeWorkspaceRoots,
    });
    this.turnId = String(asObject(turnResponse.turn).id ?? this.context.platformTurnId);
    return outcome;
  }

  async steer(text: string): Promise<void> {
    await this.initialized;
    if (!this.threadId || !this.turnId) throw new Error("Codex turn is not ready for steering");
    await this.request("turn/steer", {
      threadId: this.threadId,
      turnId: this.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interrupt(): Promise<void> {
    await this.initialized;
    if (this.threadId && this.turnId) await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    this.close();
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.27.4" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", undefined);
    if (this.context.workspace.runtimeSkillRoots?.length) {
      await this.request("skills/extraRoots/set", { extraRoots: this.context.workspace.runtimeSkillRoots });
    }
  }

  private waitForOutcome(): Promise<RuntimeResult> {
    return new Promise((resolve, reject) => { this.outcome = { resolve, reject }; });
  }

  private request(method: string, params: unknown): Promise<JsonObject> {
    const id = this.nextId++;
    const promise = new Promise<JsonObject>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  private respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(message: JsonObject): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id as RpcId);
      if (!pending) return;
      this.pending.delete(message.id as RpcId);
      if (message.error) pending.reject(new Error(String(asObject(message.error).message ?? JSON.stringify(message.error))));
      else pending.resolve(asObject(message.result));
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) this.onServerRequest(message.method, message.id as RpcId, asObject(message.params));
    else this.onNotification(message.method, asObject(message.params));
  }

  private onServerRequest(method: string, id: RpcId, params: JsonObject): void {
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : String(params.command ?? "");
      this.resolveApprovalOutcome(id, "command", {
        title: "命令执行需要审批",
        description: String(params.reason ?? "Agent 请求执行受限命令"),
        kind: "command",
        risk: classifyRisk(command, Boolean(params.networkApprovalContext)),
        command: command || null,
        cwd: typeof params.cwd === "string" ? params.cwd : this.context.workspace.windowsPath,
        networkHost: extractNetworkHost(params),
        scope: "仅本次工具调用",
        request: { rpcMethod: method, rpcId: id, questionIds: (Array.isArray(params.questions) ? params.questions : []).map((value) => String(asObject(value).id ?? "confirmation")), ...params },
      });
      return;
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      this.resolveApprovalOutcome(id, "file_change", {
        title: "文件修改需要审批",
        description: String(params.reason ?? "Agent 请求修改工作区文件"),
        kind: "file_change",
        risk: params.grantRoot ? "high" : "medium",
        cwd: this.context.workspace.windowsPath,
        path: typeof params.grantRoot === "string" ? params.grantRoot : null,
        scope: params.grantRoot ? `允许写入 ${String(params.grantRoot)}` : "仅本次文件变更",
        request: { rpcMethod: method, rpcId: id, ...params },
      });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.resolveApprovalOutcome(id, "command", {
        title: "Agent 需要用户确认",
        description: summarizeQuestions(params),
        kind: "command",
        risk: "low",
        cwd: this.context.workspace.windowsPath,
        scope: "本次交互",
        request: { rpcMethod: method, rpcId: id, ...params },
      });
      return;
    }
    if (method === "item/tool/call" && String(params.tool ?? "") === "durable_wait") {
      this.resolveTimerOutcome(id, params);
      return;
    }
    if (method === "item/tool/call" && String(params.tool ?? "") === "wait_for_external_signal") {
      this.resolveExternalOutcome(id, params);
      return;
    }
    if (method === "item/tool/call" && String(params.tool ?? "") === "report_goal_progress") {
      const args = asObject(params.arguments);
      const status = ["continue", "completed", "blocked"].includes(String(args.status)) ? String(args.status) as GoalProgressReport["status"] : "blocked";
      this.goalReport = {
        status,
        progress: Math.max(0, Math.min(100, Math.trunc(Number(args.progress ?? 0)))),
        summary: String(args.summary ?? "未提供进度摘要").slice(0, 1000),
        nextStep: String(args.nextStep ?? "等待用户决定").slice(0, 1000),
        blocker: args.blocker ? String(args.blocker).slice(0, 1000) : null,
      };
      this.context.emit("goal.progress.reported", {
        category: "task", phase: status === "blocked" ? "waiting" : "progress", title: status === "completed" ? "持续目标已完成" : status === "blocked" ? "持续目标需要用户处理" : "持续目标进度已更新",
        turnId: this.turnId ?? this.context.platformTurnId, ...this.goalReport,
      });
      this.respond(id, { contentItems: [{ type: "inputText", text: "Goal progress recorded. Finish this iteration with a concise user-facing update." }], success: true });
      return;
    }
    this.context.emit("agent.request.unsupported", {
      category: "approval", phase: "failed", title: "未支持的交互请求", detail: method,
      turnId: this.turnId ?? this.context.platformTurnId, request: params,
    });
    this.respond(id, { decision: "cancel" });
  }

  private resolveTimerOutcome(id: RpcId, params: JsonObject): void {
    const active = this.outcome;
    if (!active) { this.respond(id, { contentItems: [{ type: "inputText", text: "Unable to schedule wait" }], success: false }); return; }
    const args = asObject(params.arguments);
    const seconds = Math.max(1, Math.min(86_400, Number(args.seconds ?? 60)));
    const reason = String(args.reason ?? "等待外部结果").slice(0, 500);
    this.outcome = undefined;
    const waiting: RuntimeWaitingTimer = {
      kind: "waiting_timer", threadId: this.threadId, seconds, reason,
      resume: async () => {
        const next = this.waitForOutcome();
        this.respond(id, { contentItems: [{ type: "inputText", text: `Durable wait completed after ${seconds} seconds. Re-check the expected result now.` }], success: true });
        return next;
      },
      close: () => this.close(),
    };
    active.resolve(waiting);
  }

  private resolveExternalOutcome(id: RpcId, params: JsonObject): void {
    const active = this.outcome;
    if (!active) { this.respond(id, { contentItems: [{ type: "inputText", text: "Unable to register external signal" }], success: false }); return; }
    const args = asObject(params.arguments);
    const requestedKey = String(args.correlationKey ?? "signal").replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 120) || "signal";
    const correlationKey = `external:${this.context.task.id}:${requestedKey}`;
    const reason = String(args.reason ?? "Waiting for an external result").slice(0, 500);
    this.outcome = undefined;
    const waiting: RuntimeWaitingExternal = {
      kind: "waiting_external", threadId: this.threadId, correlationKey, reason,
      resume: async (payload) => {
        const next = this.waitForOutcome();
        this.respond(id, { contentItems: [{ type: "inputText", text: `External signal ${correlationKey} was resolved. Payload: ${JSON.stringify(payload)}` }], success: true });
        return next;
      },
      close: () => this.close(),
    };
    active.resolve(waiting);
  }

  private resolveApprovalOutcome(id: RpcId, kind: ApprovalInput["kind"], approval: Omit<ApprovalInput, "taskId">): void {
    const active = this.outcome;
    if (!active) {
      this.respond(id, { decision: "decline" });
      return;
    }
    this.outcome = undefined;
    const waiting: RuntimeWaitingApproval = {
      kind: "waiting_approval",
      threadId: this.threadId,
      approval,
      resume: async (decision) => {
        const next = this.waitForOutcome();
        const rpcMethod = String(approval.request?.rpcMethod ?? "");
        const legacy = rpcMethod === "applyPatchApproval" || rpcMethod === "execCommandApproval";
        if (rpcMethod === "item/tool/requestUserInput") {
          const questionIds = Array.isArray(approval.request?.questionIds) ? approval.request.questionIds.map(String) : ["confirmation"];
          this.respond(id, { answers: Object.fromEntries(questionIds.map((questionId) => [questionId, { answers: [decision === "approved" ? "批准" : "拒绝"] }])) });
        } else {
          this.respond(id, {
            decision: decision === "approved"
              ? legacy ? "approved" : "accept"
              : legacy ? { denied: { rejection: "用户拒绝了此工具请求，请保留上下文并寻找安全替代方案。" } } : "decline",
          });
        }
        this.context.emit("agent.approval.resolved", {
          category: "approval", phase: "completed", title: decision === "approved" ? "审批已通过，继续原步骤" : "审批已拒绝，已将结果反馈给 Agent",
          turnId: this.turnId ?? this.context.platformTurnId, toolCallId: String(approval.request?.itemId ?? id), decision, kind,
        });
        return next;
      },
      close: () => this.close(),
    };
    active.resolve(waiting);
  }

  private onNotification(method: string, params: JsonObject): void {
    const turnId = String(params.turnId ?? asObject(params.turn).id ?? this.turnId ?? this.context.platformTurnId);
    if (method === "turn/started") {
      this.turnId = turnId;
      this.context.emit("agent.turn.started", { category: "turn", phase: "started", turnId, title: "模型开始处理", startedAt: new Date().toISOString() });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.usage = asObject(params.tokenUsage);
      this.context.emit("agent.turn.usage", { category: "turn", phase: "progress", turnId, usage: this.usage });
      return;
    }
    if (method === "turn/plan/updated") {
      this.context.emit("agent.plan.updated", { category: "step", phase: "progress", turnId, title: "执行计划已更新", steps: params.plan ?? params });
      return;
    }
    if (method === "item/reasoning/summaryPartAdded") {
      const itemId = String(params.itemId ?? "reasoning");
      const current = this.reasoningSummaries.get(itemId) ?? "";
      if (current && !current.endsWith("\n\n")) this.reasoningSummaries.set(itemId, `${current.trimEnd()}\n\n`);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const itemId = String(params.itemId ?? "reasoning");
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) return;
      const next = `${this.reasoningSummaries.get(itemId) ?? ""}${delta}`.slice(-16_000);
      this.reasoningSummaries.set(itemId, next);
      if (!this.reasoningFlushTimers.has(itemId)) {
        const timer = setTimeout(() => {
          this.reasoningFlushTimers.delete(itemId);
          this.emitReasoningSummary(itemId, turnId, "progress");
        }, 600);
        this.reasoningFlushTimers.set(itemId, timer);
      }
      return;
    }
    // App Server may emit item/reasoning/textDelta, which is private raw
    // reasoning rather than a user-facing summary. Deliberately ignore it.
    if (method === "item/reasoning/textDelta") return;
    if (method === "item/started" || method === "item/completed") {
      const item = asObject(params.item);
      const completed = method === "item/completed";
      const itemId = String(item.id ?? "");
      const itemType = String(item.type ?? "item");
      if (itemType === "reasoning" && completed && itemId) {
        const timer = this.reasoningFlushTimers.get(itemId);
        if (timer) clearTimeout(timer);
        this.reasoningFlushTimers.delete(itemId);
        const completedDetail = itemDetail(item);
        if (completedDetail) this.reasoningSummaries.set(itemId, completedDetail);
        this.emitReasoningSummary(itemId, turnId, "completed");
        return;
      }
      if (itemType === "agentMessage" && typeof item.text === "string") this.finalResponse = item.text;
      const isTool = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration"].includes(itemType);
      const type = isTool ? `agent.tool.${completed ? "completed" : "started"}` : `agent.step.${completed ? "completed" : "started"}`;
      this.context.emit(type, {
        category: isTool ? "tool" : "step", phase: completed ? "completed" : "started", turnId,
        stepId: itemId || undefined, toolCallId: isTool ? itemId : undefined,
        title: itemTitle(item), detail: itemDetail(item), exitCode: item.exitCode ?? undefined,
        durationMs: item.durationMs ?? undefined, item,
      });
      return;
    }
    if (method.endsWith("/outputDelta")) {
      this.context.emit("agent.tool.output", {
        category: "tool", phase: "progress", turnId, toolCallId: String(params.itemId ?? params.processId ?? ""),
        title: "工具正在输出", detail: String(params.delta ?? ""),
      });
      return;
    }
    if (method === "turn/diff/updated") {
      this.context.emit("agent.workspace.diff", { category: "workspace", phase: "progress", turnId, title: "工作区差异已更新", diff: params.diff ?? params });
      return;
    }
    if (method === "turn/completed") {
      const turn = asObject(params.turn);
      const status = String(turn.status ?? "completed");
      if (status === "failed") {
        const error = asObject(turn.error);
        this.fail(new Error(String(error.message ?? "Codex turn failed")));
        return;
      }
      const active = this.outcome;
      this.outcome = undefined;
      this.context.emit("agent.turn.completed", {
        category: "turn", phase: "completed", turnId, title: "模型处理完成",
        durationMs: typeof turn.durationMs === "number" ? turn.durationMs : undefined, usage: this.usage,
      });
      active?.resolve({ kind: "completed", finalResponse: this.finalResponse || "Codex 已完成本轮任务。", threadId: this.threadId, usage: this.usage, goalReport: this.goalReport });
      this.close();
      return;
    }
    if (method === "error") {
      const error = asObject(params.error);
      this.context.emit("agent.runtime.error", { category: "turn", phase: "failed", turnId, title: "运行时错误", detail: String(error.message ?? params.message ?? "Unknown error") });
    }
  }

  private emitReasoningSummary(itemId: string, turnId: string, phase: "progress" | "completed"): void {
    const detail = this.reasoningSummaries.get(itemId)?.trim() || (phase === "completed" ? "当前模型未返回可公开展示的推理摘要；命令、工具调用和验证步骤仍会逐项显示。" : "");
    if (!detail) return;
    this.context.emit(phase === "completed" ? "agent.step.completed" : "agent.step.updated", {
      category: "step", phase, turnId, stepId: itemId,
      title: phase === "completed" ? "推理摘要" : "正在分析与规划",
      detail,
      item: { id: itemId, type: "reasoning", summary: [detail] },
    });
  }

  private fail(error: Error): void {
    error = this.describeProviderError(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.outcome?.reject(error);
    this.outcome = undefined;
    this.close();
  }

  private describeProviderError(error: Error): Error {
    if (!/(?:401\s+Unauthorized|Authentication Fails|incorrect api key)/i.test(error.message)) return error;
    return new Error(`${this.provider.label} 鉴权失败（401）。请在“设置 → 模型 Provider”中重新保存或检查 API Key；当前请求已绑定到 ${this.modelProvider}，不会使用其他 Provider 的登录状态。原始错误：${error.message}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.reasoningFlushTimers.values()) clearTimeout(timer);
    this.reasoningFlushTimers.clear();
    try { this.child.stdin.end(); } catch { /* process already closed */ }
    try { this.child.kill(); } catch { /* process already closed */ }
  }
}

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  private readonly active = new Map<string, AppServerTurn>();
  constructor(
    private readonly config: AppConfig,
    private readonly resolveApiKey?: (tenantId: string, provider: import("../core/types.js").ProviderId) => string | null,
    private readonly resolveProvider?: (tenantId: string, provider: import("../core/types.js").ProviderId) => ProviderConfig,
  ) {}

  async run(context: RuntimeContext): Promise<RuntimeResult> {
    const provider = this.resolveProvider?.(context.task.tenantId, context.task.provider) ?? this.config.providers[context.task.provider];
    const apiKey = this.resolveApiKey?.(context.task.tenantId, provider.id) ?? provider.apiKey;
    if (!apiKey) throw new Error(`${provider.label} API key is not configured`);
    if (!provider.codexCompatible) throw new Error(`${provider.label} is not Codex Responses-compatible`);
    const turn = new AppServerTurn(context, this.config, apiKey, provider);
    this.active.set(context.task.id, turn);
    try { return await turn.start(); }
    finally { if (this.active.get(context.task.id) === turn) this.active.delete(context.task.id); }
  }

  steer(taskId: string, text: string): Promise<void> {
    const turn = this.active.get(taskId);
    if (!turn) throw new Error("Task has no active Codex turn");
    return turn.steer(text);
  }

  interrupt(taskId: string): Promise<void> {
    const turn = this.active.get(taskId);
    if (!turn) throw new Error("Task has no active Codex turn");
    return turn.interrupt();
  }

  hasActive(taskId: string): boolean { return this.active.has(taskId); }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function itemTitle(item: JsonObject): string {
  const type = String(item.type ?? "item");
  if (type === "commandExecution") return `执行命令：${String(item.command ?? "")}`;
  if (type === "fileChange") return "修改工作区文件";
  if (type === "mcpToolCall" || type === "dynamicToolCall") return `调用工具：${String(item.tool ?? "")}`;
  if (type === "reasoning") return "正在分析与规划";
  if (type === "plan") return "模型正在规划";
  if (type === "agentMessage") return "模型回复";
  return `处理 ${type}`;
}

function itemDetail(item: JsonObject): string {
  if (typeof item.aggregatedOutput === "string") return item.aggregatedOutput;
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.summary)) return item.summary.map((part) => typeof part === "string" ? part : String(asObject(part).text ?? "")).filter(Boolean).join("\n\n");
  if (item.changes) return JSON.stringify(item.changes);
  return "";
}

function classifyRisk(command: string, hasNetwork: boolean): ApprovalInput["risk"] {
  if (hasNetwork || /\b(rm|del|rmdir|format|shutdown|reboot|curl|wget|ssh|scp|git\s+push|npm\s+publish)\b/i.test(command)) return "high";
  if (/\b(git\s+(add|restore|reset|commit)|npm\s+(install|run)|pip\s+install|cargo\s+)\b/i.test(command)) return "medium";
  return "low";
}

function extractNetworkHost(params: JsonObject): string | null {
  const context = asObject(params.networkApprovalContext);
  for (const key of ["host", "hostname", "domain"]) if (typeof context[key] === "string") return context[key] as string;
  return null;
}

function summarizeQuestions(params: JsonObject): string {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.map((value) => {
    const question = asObject(value);
    return String(question.question ?? question.header ?? "需要用户输入");
  }).join("\n") || "Agent 需要用户确认后继续。";
}
