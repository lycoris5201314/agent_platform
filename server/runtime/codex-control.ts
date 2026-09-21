import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { AppConfig, ProviderConfig } from "../core/config.js";
import type { ProviderId } from "../core/types.js";
import { codexNativePlatformArgs, codexProcessEnvironment, createProviderLaunchConfig } from "./provider-launch.js";

type JsonObject = Record<string, unknown>;
const CATALOG_SECTION_TIMEOUT_MS = 8_000;

export interface CompactThreadResult {
  before: JsonObject | null;
  after: JsonObject | null;
  completed: boolean;
  error: string | null;
}

export interface ReviewThreadResult {
  reviewThreadId: string;
  turnId: string;
  completed: boolean;
  summary: string;
  error: string | null;
}

export interface McpOAuthOperation {
  id: string;
  name: string;
  authorizationUrl: string;
  status: "pending" | "succeeded" | "failed";
  error: string | null;
  expiresAt: string;
}

export interface CodexControlTransport {
  request(method: string, params?: Record<string, unknown>, providerId?: ProviderId, timeoutMs?: number, tenantId?: string, containerId?: string): Promise<JsonObject>;
  compactThread(threadId: string, providerId: ProviderId, tenantId: string, containerId?: string): Promise<CompactThreadResult>;
  reviewThread(threadId: string, target: Record<string, unknown>, providerId: ProviderId, tenantId: string, containerId?: string): Promise<ReviewThreadResult>;
  catalog(cwd: string, providerId?: ProviderId, tenantId?: string, containerId?: string): Promise<Record<string, unknown>>;
  reloadMcp(providerId?: ProviderId, tenantId?: string, containerId?: string): Promise<JsonObject>;
  setSkillsExtraRoots(roots: string[], providerId?: ProviderId, tenantId?: string): Promise<JsonObject>;
  startMcpOAuth(name: string, providerId?: ProviderId, tenantId?: string): Promise<McpOAuthOperation>;
  getMcpOAuth(id: string, tenantId?: string): McpOAuthOperation | null;
  close(): void;
}

export class CodexControlClient implements CodexControlTransport {
  private readonly oauthOperations = new Map<string, { operation: McpOAuthOperation; tenantId: string; child: ChildProcessWithoutNullStreams }>();
  constructor(private readonly config: AppConfig, private readonly resolveApiKey?: (tenantId: string, provider: ProviderId) => string | null, private readonly resolveProvider?: (tenantId: string, provider: ProviderId) => ProviderConfig) {}

  async request(method: string, params: Record<string, unknown> = {}, providerId: ProviderId = "openai", timeoutMs = 30_000, tenantId = "local", containerId?: string): Promise<JsonObject> {
    const provider = this.resolveProvider?.(tenantId, providerId) ?? this.config.providers[providerId];
    const apiKey = this.resolveApiKey?.(tenantId, providerId) ?? provider.apiKey;
    const launch = createProviderLaunchConfig(provider, apiKey ?? undefined);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(Boolean(containerId)), ...launch.args];
    const executable = containerId ? (process.env.DOCKER_PATH ?? "docker") : (this.config.codexPath ?? "codex");
    const spawnArgs = containerId ? ["exec", "-i", ...launch.dockerEnvironment, containerId, "codex", ...args] : args;
    const child = spawn(executable, spawnArgs, {
      cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: containerId
        ? { ...process.env, ...launch.environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" }
        : codexProcessEnvironment(this.config, launch.environment),
    });
    try {
      const rpc = new RpcSession(child);
      await rpc.call("initialize", { clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.28.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, timeoutMs);
      rpc.notify("initialized", undefined);
      return await rpc.call(method, params, timeoutMs);
    } finally {
      child.kill();
    }
  }

  async compactThread(threadId: string, providerId: ProviderId, tenantId: string, containerId?: string): Promise<CompactThreadResult> {
    const provider = this.resolveProvider?.(tenantId, providerId) ?? this.config.providers[providerId];
    const apiKey = this.resolveApiKey?.(tenantId, providerId) ?? provider.apiKey;
    const launch = createProviderLaunchConfig(provider, apiKey ?? undefined);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(Boolean(containerId)), ...launch.args];
    const executable = containerId ? (process.env.DOCKER_PATH ?? "docker") : (this.config.codexPath ?? "codex");
    const spawnArgs = containerId ? ["exec", "-i", ...launch.dockerEnvironment, containerId, "codex", ...args] : args;
    const child = spawn(executable, spawnArgs, { cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: containerId ? { ...process.env, ...launch.environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" } : codexProcessEnvironment(this.config, launch.environment) });
    try {
      const rpc = new RpcSession(child);
      await rpc.call("initialize", { clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.28.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      rpc.notify("initialized", undefined);
      const usageBefore = rpc.waitForNotification((method, params) => method === "thread/tokenUsage/updated" && String(params.threadId ?? "") === threadId, 10_000).catch(() => null);
      await rpc.call("thread/resume", { threadId }, 30_000);
      const beforeNotification = await usageBefore;
      const terminal = rpc.waitForNotification((method, params) => {
        if (method === "thread/compacted" && String(params.threadId ?? "") === threadId) return true;
        if (method === "item/completed" && String(asObject(params.item).type ?? "") === "contextCompaction") return true;
        if (method === "turn/completed") return String(params.threadId ?? "") === threadId;
        return false;
      }, 180_000);
      const usageAfter = rpc.waitForNotification((method, params) => method === "thread/tokenUsage/updated" && String(params.threadId ?? "") === threadId, 30_000).catch(() => null);
      await rpc.call("thread/compact/start", { threadId }, 30_000);
      const terminalNotification = await terminal;
      const terminalTurn = asObject(terminalNotification.turn);
      const turnError = asObject(terminalTurn.error);
      const error = terminalTurn.status === "failed" ? String(turnError.message ?? "上下文压缩失败") : null;
      const afterNotification = await usageAfter;
      return {
        before: beforeNotification ? asObject(beforeNotification.tokenUsage) : null,
        after: afterNotification ? asObject(afterNotification.tokenUsage) : null,
        completed: !error,
        error,
      };
    } finally { child.kill(); }
  }

  async reviewThread(threadId: string, target: Record<string, unknown>, providerId: ProviderId, tenantId: string, containerId?: string): Promise<ReviewThreadResult> {
    const provider = this.resolveProvider?.(tenantId, providerId) ?? this.config.providers[providerId];
    const apiKey = this.resolveApiKey?.(tenantId, providerId) ?? provider.apiKey;
    const launch = createProviderLaunchConfig(provider, apiKey ?? undefined);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(Boolean(containerId)), ...launch.args];
    const executable = containerId ? (process.env.DOCKER_PATH ?? "docker") : (this.config.codexPath ?? "codex");
    const spawnArgs = containerId ? ["exec", "-i", ...launch.dockerEnvironment, containerId, "codex", ...args] : args;
    const child = spawn(executable, spawnArgs, { cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: containerId ? { ...process.env, ...launch.environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" } : codexProcessEnvironment(this.config, launch.environment) });
    try {
      const rpc = new RpcSession(child);
      await rpc.call("initialize", { clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.28.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      rpc.notify("initialized", undefined);
      await rpc.call("thread/resume", { threadId }, 30_000);
      const started = await rpc.call("review/start", { threadId, target, delivery: "inline" }, 60_000);
      const reviewThreadId = String(started.reviewThreadId ?? threadId);
      const reviewTurn = asObject(started.turn);
      const turnId = String(reviewTurn.id ?? "");
      if (!turnId) throw new Error("Codex 未返回审阅 turn id");
      let summary = "";
      const completed = await rpc.waitForNotification((method, params) => {
        if (method === "item/completed") {
          const item = asObject(params.item);
          if (String(item.type ?? "") === "agentMessage" && typeof item.text === "string") summary = item.text;
        }
        return method === "turn/completed" && String(asObject(params.turn).id ?? params.turnId ?? "") === turnId;
      }, 300_000);
      const turn = asObject(completed.turn);
      const error = asObject(turn.error);
      return { reviewThreadId, turnId, completed: String(turn.status ?? "completed") !== "failed", summary, error: turn.status === "failed" ? String(error.message ?? "Codex 审阅失败") : null };
    } finally { child.kill(); }
  }

  async catalog(cwd: string, providerId: ProviderId = "openai", tenantId = "local", containerId?: string): Promise<Record<string, unknown>> {
    const provider = this.resolveProvider?.(tenantId, providerId) ?? this.config.providers[providerId];
    const apiKey = this.resolveApiKey?.(tenantId, providerId) ?? provider.apiKey;
    const launch = createProviderLaunchConfig(provider, apiKey ?? undefined);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(Boolean(containerId)), ...launch.args];
    const executable = containerId ? (process.env.DOCKER_PATH ?? "docker") : (this.config.codexPath ?? "codex");
    const spawnArgs = containerId ? ["exec", "-i", ...launch.dockerEnvironment, containerId, "codex", ...args] : args;
    const child = spawn(executable, spawnArgs, { cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: containerId ? { ...process.env, ...launch.environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" } : codexProcessEnvironment(this.config, launch.environment) });
    try {
      const rpc = new RpcSession(child);
      await rpc.call("initialize", { clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.28.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      rpc.notify("initialized", undefined);
      const calls = await Promise.allSettled([
        rpc.call("model/list", { includeHidden: false, limit: 100 }, CATALOG_SECTION_TIMEOUT_MS),
        rpc.call("modelProvider/capabilities/read", {}, CATALOG_SECTION_TIMEOUT_MS),
        rpc.call("skills/list", { cwds: [cwd], forceReload: false }, CATALOG_SECTION_TIMEOUT_MS),
        rpc.call("mcpServerStatus/list", { cursor: null, limit: 200, detail: "toolsAndAuthOnly" }, CATALOG_SECTION_TIMEOUT_MS),
        rpc.call("permissionProfile/list", { cursor: null, limit: 100 }, CATALOG_SECTION_TIMEOUT_MS),
      ]);
      const value = (index: number) => calls[index].status === "fulfilled" ? calls[index].value : { error: (calls[index] as PromiseRejectedResult).reason instanceof Error ? (calls[index] as PromiseRejectedResult).reason.message : String((calls[index] as PromiseRejectedResult).reason) };
      return { models: value(0), providerCapabilities: value(1), skills: value(2), mcp: value(3), permissionProfiles: value(4), collaborationModes: { data: [] } };
    } finally { child.kill(); }
  }

  setSkillEnabled(path: string, enabled: boolean, providerId: ProviderId = "openai"): Promise<JsonObject> {
    return this.request("skills/config/write", { path, enabled }, providerId);
  }

  setSkillsExtraRoots(roots: string[], providerId: ProviderId = "openai", tenantId = "local"): Promise<JsonObject> {
    return this.request("skills/extraRoots/set", { extraRoots: roots }, providerId, 30_000, tenantId);
  }

  reloadMcp(providerId: ProviderId = "openai", tenantId = "local", containerId?: string): Promise<JsonObject> {
    return this.request("config/mcpServer/reload", {}, providerId, 30_000, tenantId, containerId);
  }

  async startMcpOAuth(name: string, providerId: ProviderId = "openai", tenantId = "local"): Promise<McpOAuthOperation> {
    const provider = this.resolveProvider?.(tenantId, providerId) ?? this.config.providers[providerId];
    const apiKey = this.resolveApiKey?.(tenantId, providerId) ?? provider.apiKey;
    const launch = createProviderLaunchConfig(provider, apiKey ?? undefined);
    const args = ["app-server", "--stdio", ...codexNativePlatformArgs(false), ...launch.args];
    const child = spawn(this.config.codexPath ?? "codex", args, { cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: codexProcessEnvironment(this.config, launch.environment) });
    try {
      const rpc = new RpcSession(child);
      await rpc.call("initialize", { clientInfo: { name: "agent-foundry-local", title: "Agent Foundry", version: "0.28.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      rpc.notify("initialized", undefined);
      const result = await rpc.call("mcpServer/oauth/login", { name, threadId: null, scopes: null, timeoutSecs: 300 }, 30_000);
      const authorizationUrl = String(result.authorizationUrl ?? "");
      if (!/^https:\/\//i.test(authorizationUrl)) throw new Error("Codex 未返回安全的 MCP 授权地址");
      const id = randomUUID();
      const operation: McpOAuthOperation = { id, name, authorizationUrl, status: "pending", error: null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      this.oauthOperations.set(id, { operation, tenantId, child });
      void rpc.waitForNotification((method, params) => method === "mcpServer/oauthLogin/completed" && String(params.name ?? "") === name, 5 * 60_000)
        .then((params) => {
          operation.status = params.success === true ? "succeeded" : "failed";
          operation.error = params.success === true ? null : String(params.error ?? "MCP 授权失败");
        })
        .catch((error) => { operation.status = "failed"; operation.error = error instanceof Error ? error.message : String(error); })
        .finally(() => { child.kill(); setTimeout(() => this.oauthOperations.delete(id), 5 * 60_000).unref(); });
      return { ...operation };
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  getMcpOAuth(id: string, tenantId = "local"): McpOAuthOperation | null {
    const entry = this.oauthOperations.get(id);
    return entry?.tenantId === tenantId ? { ...entry.operation } : null;
  }

  close(): void {
    for (const entry of this.oauthOperations.values()) entry.child.kill();
    this.oauthOperations.clear();
  }
}

class RpcSession {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = "";
  private readonly notificationWaiters = new Set<{ match: (method: string, params: JsonObject) => boolean; resolve: (params: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notifications: Array<{ method: string; params: JsonObject }> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => this.failAll(new Error(`Codex App Server exited with ${code}: ${this.stderr}`)));
  }

  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonObject> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })}\n`);
  }

  waitForNotification(match: (method: string, params: JsonObject) => boolean, timeoutMs: number): Promise<JsonObject> {
    const existing = this.notifications.find((notification) => match(notification.method, notification.params));
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (params: JsonObject) => { clearTimeout(waiter.timer); this.notificationWaiters.delete(waiter); resolve(params); }, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => { this.notificationWaiters.delete(waiter); reject(new Error("Codex 未在限定时间内报告操作完成")); }, timeoutMs);
      this.notificationWaiters.add(waiter);
    });
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    if (typeof message.method === "string" && message.id === undefined) {
      const params = asObject(message.params);
      this.notifications.push({ method: message.method, params });
      if (this.notifications.length > 200) this.notifications.shift();
      for (const waiter of [...this.notificationWaiters]) if (waiter.match(message.method, params)) waiter.resolve(params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String((message.error as JsonObject).message ?? JSON.stringify(message.error))));
    else pending.resolve((message.result as JsonObject) ?? {});
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.notificationWaiters.clear();
  }
}

function asObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
