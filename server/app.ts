import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig, publicConfig, type AppConfig } from "./core/config.js";
import { EventBus } from "./core/event-bus.js";
import { TaskStore } from "./core/store.js";
import { ToolGateway } from "./core/tool-gateway.js";
import type { RequestIdentity, WorkspaceTreeEntry } from "./core/types.js";
import { IdentityService } from "./security/identity.js";
import { SecretVault } from "./security/secret-vault.js";
import { CodexControlClient, type CodexControlTransport } from "./runtime/codex-control.js";
import { createProviderLaunchConfig } from "./runtime/provider-launch.js";
import { MultiAgentService } from "./workflow/multi-agent.js";
import { SettingsService } from "./core/settings.js";
import { TaskRunner } from "./workflow/task-runner.js";
import { ApprovalNotifier } from "./core/approval-notifier.js";
import { runInWorkspace } from "./workspace/wsl-workspace.js";
import { TerminalManager } from "./terminal/terminal-manager.js";
import { resolveServerLogLevel } from "./core/logging.js";

export interface AgentApplication {
  app: FastifyInstance;
  config: AppConfig;
  runner: TaskRunner;
  store: TaskStore;
  terminalManager: TerminalManager;
  close: () => Promise<void>;
}

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  runtime: z.enum(["mock", "codex"]).optional(),
  provider: z.enum(["openai", "deepseek", "custom"]).optional(),
  model: z.string().trim().max(120).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra"]).optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
  workspacePath: z.string().trim().max(500).optional(),
  waitSeconds: z.number().int().min(0).max(86_400).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  parentTaskId: z.string().uuid().optional(),
  section: z.string().trim().max(80).optional(),
  attachments: z.array(z.string().min(1).max(1_000)).max(20).optional(),
  goalMode: z.boolean().optional(),
  goalObjective: z.string().trim().min(1).max(100_000).optional(),
  goalMaxTurns: z.number().int().min(2).max(20).optional(),
  goalDeadlineHours: z.number().int().min(1).max(168).optional(),
  goalTokenBudget: z.number().int().min(10_000).max(10_000_000).optional(),
});

const continueConversationSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  attachments: z.array(z.string().min(1).max(1_000)).max(20).optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  provider: z.enum(["openai", "deepseek", "custom"]).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra"]).optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
});
const providerSecretSchema = z.object({ apiKey: z.string().trim().min(8).max(10_000).nullable() });
const goalActionSchema = z.object({
  action: z.enum(["pause", "resume", "complete"]),
  additionalTurns: z.number().int().min(1).max(10).optional(),
  additionalHours: z.number().int().min(1).max(168).optional(),
  additionalTokens: z.number().int().min(10_000).max(1_000_000).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  section: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  provider: z.enum(["openai", "deepseek", "custom"]).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra"]).optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one task property is required",
});

const workspaceFileQuerySchema = z.object({
  path: z.string().min(1).max(1_000),
  rootId: z.string().uuid().optional(),
});

const workspaceTreeQuerySchema = z.object({ path: z.string().max(1_000).optional().default(""), rootId: z.string().uuid().optional() });
const workspaceChangeSchema = z.object({ operation: z.enum(["stage", "unstage", "discard", "stage_patch"]), path: z.string().min(1).max(1_000), patch: z.string().max(1_000_000).optional() }).refine((value) => value.operation !== "stage_patch" || Boolean(value.patch), { message: "A patch is required for partial staging" });
const workspaceWriteSchema = z.object({ path: z.string().min(1).max(1_000), content: z.string().max(2_000_000) });
const workspaceRootSchema = z.object({ path: z.string().min(1).max(500), label: z.string().trim().min(1).max(80).optional() });
const symbolQuerySchema = z.object({ q: z.string().trim().min(1).max(120) });
const reviewCommentSchema = z.object({ path: z.string().min(1).max(1_000), line: z.number().int().min(1).max(10_000_000), side: z.enum(["old", "new"]), body: z.string().trim().min(1).max(4_000) });
const terminalCommandSchema = z.object({ command: z.string().trim().min(1).max(2_000) });
const terminalOpenSchema = z.object({ cols: z.number().int().min(20).max(400).optional(), rows: z.number().int().min(5).max(200).optional() });
const terminalInputSchema = z.object({ data: z.string().max(32_000) });
const terminalResizeSchema = z.object({ cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) });
const childTaskSchema = z.object({
  title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(100_000),
  isolation: z.enum(["worktree", "shared"]).optional(), priority: z.number().int().min(-100).max(100).optional(),
});
const automationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  runtime: z.enum(["mock", "codex"]),
  provider: z.enum(["openai", "deepseek", "custom"]),
  model: z.string().trim().max(120).nullable().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra"]).nullable().optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
  approvalsReviewer: z.enum(["user", "auto_review"]),
  workspacePath: z.string().trim().max(500).nullable().optional(),
  scheduleKind: z.enum(["once", "interval", "daily", "weekly"]),
  onceAt: z.string().datetime().nullable().optional(),
  intervalMinutes: z.number().int().min(15).max(43_200).nullable().optional(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  status: z.enum(["active", "paused"]).optional(),
});
const createAutomationSchema = automationFieldsSchema.superRefine((value, context) => {
  if (value.scheduleKind === "once" && !value.onceAt) context.addIssue({ code: "custom", path: ["onceAt"], message: "Choose a future time" });
  if (value.scheduleKind === "interval" && !value.intervalMinutes) context.addIssue({ code: "custom", path: ["intervalMinutes"], message: "Choose an interval" });
  if ((value.scheduleKind === "daily" || value.scheduleKind === "weekly") && !value.timeOfDay) context.addIssue({ code: "custom", path: ["timeOfDay"], message: "Choose a time" });
  if (value.scheduleKind === "weekly" && !value.weekdays?.length) context.addIssue({ code: "custom", path: ["weekdays"], message: "Choose at least one weekday" });
});
const updateAutomationSchema = automationFieldsSchema.partial().refine((value) => Object.keys(value).length > 0, { message: "At least one automation property is required" });
const activeStatusesForWorkspaceChange = new Set(["queued", "preparing", "running", "verifying", "waiting_approval", "waiting_timer", "waiting_external", "waiting_retry"]);
const settingsSchema = z.object({
  defaultRuntime: z.enum(["mock", "codex"]).optional(), defaultProvider: z.enum(["openai", "deepseek", "custom"]).optional(),
  defaultWorkspace: z.string().max(500).optional(), workerConcurrency: z.number().int().min(1).max(8).optional(),
  providerConcurrency: z.number().int().min(1).max(8).optional(), sandboxEnabled: z.boolean().optional(),
  sandboxImage: z.string().trim().min(1).max(200).optional(), sandboxCpuLimit: z.number().min(.25).max(16).optional(),
  sandboxMemoryMb: z.number().int().min(256).max(32768).optional(), sandboxNetwork: z.enum(["none", "bridge"]).optional(),
  skillsExtraRoots: z.array(z.string().max(500)).max(20).optional(), mcpConfigPath: z.string().max(500).optional(),
  verificationCommands: z.array(z.string().max(500)).max(30).optional(),
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
  approvalWebhookUrl: z.union([z.string().url().max(1_000), z.literal("")]).optional(),
  providerProfiles: z.record(z.enum(["openai", "deepseek", "custom"]), z.object({
    baseUrl: z.union([z.string().url().max(1_000), z.literal("")]),
    defaultModel: z.string().trim().min(1).max(120), codexCompatible: z.boolean(),
  })).optional(),
});

function resolveWorkspaceFile(root: string, requestedPath: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(absoluteRoot, requestedPath);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("File path is outside the task workspace");
  }
  return absoluteFile;
}

async function findNamedFile(root: string, fragment: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await findNamedFile(candidate, fragment);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name.includes(fragment) && entry.name.endsWith(".jsonl")) return candidate;
    }
  } catch { /* missing legacy rollout root */ }
  return null;
}

function attachmentPrompt(artifacts: Array<{ path: string; id: string }>, dockerEnabled: boolean): string {
  if (!artifacts.length) return "";
  return `\n\n<attachments>\n${artifacts.map((item) => {
    const visiblePath = dockerEnabled ? `/agent-artifacts/${path.basename(item.path)}` : item.path;
    return `${path.basename(item.path)}: ${visiblePath} (artifact:${item.id})`;
  }).join("\n")}\n</attachments>`;
}

async function resolveExistingWorkspaceFile(root: string, requestedPath: string): Promise<string> {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  const absoluteFile = await fs.realpath(resolveWorkspaceFile(root, requestedPath));
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved file path is outside the task workspace");
  }
  return absoluteFile;
}

async function resolveExistingWorkspaceDirectory(root: string, requestedPath: string): Promise<string> {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  const candidate = requestedPath ? path.resolve(absoluteRoot, requestedPath) : absoluteRoot;
  const absoluteDirectory = await fs.realpath(candidate);
  const relative = path.relative(absoluteRoot, absoluteDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Directory path is outside the task workspace");
  const stat = await fs.stat(absoluteDirectory);
  if (!stat.isDirectory()) throw new Error("Path is not a directory");
  return absoluteDirectory;
}

async function listWorkspaceDirectory(root: string, requestedPath: string, statuses: Map<string, string>): Promise<WorkspaceTreeEntry[]> {
  const directory = await resolveExistingWorkspaceDirectory(root, requestedPath);
  const ignored = new Set([".git", "node_modules", "dist", ".next", ".vinext", ".agent-data"]);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: WorkspaceTreeEntry[] = [];
  for (const entry of entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const relative = path.relative(root, path.join(directory, entry.name)).replaceAll("\\", "/");
    let hasChildren = false;
    if (entry.isDirectory()) {
      const children = await fs.readdir(path.join(directory, entry.name), { withFileTypes: true }).catch(() => []);
      hasChildren = children.some((child) => !ignored.has(child.name) && !child.isSymbolicLink());
    }
    result.push({ name: entry.name, path: relative, type: entry.isDirectory() ? "directory" : "file", hasChildren, gitStatus: statuses.get(relative) });
  }
  return result;
}

async function listWorkspaceFiles(root: string, limit = 160): Promise<string[]> {
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", ".next", ".vinext"]);
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 5 || files.length >= limit) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= limit || ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else files.push(relative);
    }
  }
  await visit(root, 0);
  return files;
}

export async function createAgentApplication(
  config: AppConfig = loadConfig(),
  dependencies: { codexControl?: CodexControlTransport; automationIntervalMs?: number } = {},
): Promise<AgentApplication> {
  const store = new TaskStore(config.dataDir);
  const secretVault = new SecretVault(store);
  const resolveApiKey = (tenantId: string, providerId: "openai" | "deepseek" | "custom") => secretVault.get(tenantId, providerId) ?? (tenantId === "local" ? config.providers[providerId].apiKey : undefined) ?? null;
  const settings = new SettingsService(store, config);
  const resolveProvider = (tenantId: string, providerId: "openai" | "deepseek" | "custom") => settings.provider(tenantId, providerId);
  const bus = new EventBus();
  for (const recovery of store.recoverInterruptedTasks()) {
    store.appendEvent(recovery.taskId, recovery.outcome === "queued" ? "task.recovered" : "task.recovery.failed", {
      schemaVersion: 1, category: "task", phase: recovery.outcome === "queued" ? "queued" : "failed", turnId: `${recovery.taskId}:recovery`,
      title: recovery.outcome === "queued" ? "应用重启后已恢复任务" : "应用多次中断，任务已停止",
      detail: recovery.outcome === "queued" ? "上次执行被应用退出中断，已安全返回持久队列。" : "已达到恢复次数上限并进入死信，可在设置中人工重放。",
      attempt: recovery.attempt, maxAttempts: recovery.maxAttempts,
    });
  }

  const notifier = new ApprovalNotifier(store, bus, config);
  const runner = new TaskRunner(store, bus, config, resolveApiKey, notifier, resolveProvider);
  const workspaceForPath = (workspacePath: string) => runner.workspaceManager.handle(workspacePath);
  const tools = new ToolGateway(store, bus, config, notifier);
  const identities = new WeakMap<FastifyRequest, RequestIdentity>();
  const identityService = new IdentityService(config);
  const codexControl = dependencies.codexControl ?? new CodexControlClient(config, resolveApiKey, resolveProvider);
  const modelCatalogCache = new Map<string, { expiresAt: number; value: import("./core/types.js").ModelChoice[]; error?: string }>();
  const multiAgent = new MultiAgentService(store, config);
  const terminalManager = new TerminalManager();
  const backgroundOperations = new Set<Promise<unknown>>();
  const trackBackground = (operation: Promise<unknown>) => {
    const tracked = operation.finally(() => backgroundOperations.delete(tracked));
    backgroundOperations.add(tracked);
    void tracked.catch(() => undefined);
  };
  const launchAutomation = async (automation: import("./core/types.js").TaskAutomation, scheduledFor = new Date().toISOString()) => {
    try {
      const actor: RequestIdentity = { tenantId: automation.tenantId, userId: automation.userId, role: "member" };
      store.assertQuota(actor);
      const provider = settings.provider(automation.tenantId, automation.provider);
      const model = automation.model || provider.defaultModel;
      if (automation.runtime === "codex" && (!resolveApiKey(automation.tenantId, provider.id) || !provider.codexCompatible)) {
        throw new Error(!resolveApiKey(automation.tenantId, provider.id)
          ? `${provider.label} API key is not configured`
          : `${provider.label} does not have a Codex-compatible runtime adapter`);
      }
      const task = store.createTask({
        title: automation.name, prompt: automation.prompt, runtime: automation.runtime, provider: automation.provider,
        model, reasoningEffort: automation.reasoningEffort ?? undefined, sandboxMode: automation.sandboxMode,
        approvalPolicy: automation.approvalPolicy, approvalsReviewer: automation.approvalsReviewer,
        workspacePath: automation.workspacePath ?? undefined, tenantId: automation.tenantId, userId: automation.userId,
        section: "自动化",
      }, { runtime: automation.runtime, model });
      store.recordAutomationRun(automation.id, scheduledFor, task.id);
      bus.publish(store.appendEvent(task.id, "automation.task.created", {
        schemaVersion: 1, category: "task", phase: "queued", turnId: `${task.id}:automation`,
        title: `由自动化“${automation.name}”创建`, automationId: automation.id, scheduledFor,
      }));
      store.audit(actor, "automation.run", "automation", automation.id, { taskId: task.id, scheduledFor });
      return task;
    } catch (error) {
      store.recordAutomationRun(automation.id, scheduledFor, null, error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const app = Fastify({
    // Request-by-request info logs are invisible in the packaged desktop app
    // and create substantial I/O during polling. Keep warnings by default and
    // allow explicit diagnostic verbosity through AGENT_LOG_LEVEL.
    logger: { level: resolveServerLogLevel(process.env.AGENT_LOG_LEVEL) },
    forceCloseConnections: true,
  });
  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: (origin, callback) => {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
  });
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    try {
      const identity = identityService.resolve(request);
      store.ensureMembership(identity);
      identities.set(request, identity);
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  const identity = (request: FastifyRequest) => identities.get(request) ?? { tenantId: "local", userId: "local-user", role: "owner" as const };
  const scopedTask = (request: FastifyRequest, id: string) => store.getTaskFor(id, identity(request));
  const taskRoot = (request: FastifyRequest, taskId: string, rootId?: string) => {
    const task = scopedTask(request, taskId);
    if (!task?.workspacePath) throw new Error("Task has no workspace");
    if (!rootId) {
      const primary = store.listWorkspaceRoots(task.id).find((root) => root.kind === "primary");
      return { path: task.workspacePath, rootId: primary?.id ?? null, readOnly: false, label: primary?.label ?? path.basename(task.workspacePath) };
    }
    const root = store.listWorkspaceRoots(task.id).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error("Workspace root not found");
    return { path: root.path, rootId: root.id, readOnly: root.kind === "additional", label: root.label };
  };
  const assertRemotePath = (actor: RequestIdentity, candidate: string): void => {
    if (config.auth.mode === "local" || actor.tenantId === "local") return;
    const relative = path.relative(config.allowedWorkspaceRoot, path.resolve(candidate));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Remote paths must stay under ${config.allowedWorkspaceRoot}`);
  };
  const locateRollout = (threadId: string): string | null => {
    const roots = [process.env.CODEX_HOME, path.join(process.env.USERPROFILE ?? "", ".codex")].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      for (const parent of [path.join(root, "sessions"), path.join(root, "archived_sessions")]) {
        if (!fsSync.existsSync(parent)) continue;
        const pending = [parent];
        while (pending.length) {
          const directory = pending.pop()!;
          for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(candidate);
            else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) return candidate;
          }
        }
      }
    }
    return null;
  };
  const normalizeTaskRollout = async (rolloutPath: string, task: import("./core/types.js").AgentTask): Promise<boolean> => {
    const contents = await fs.readFile(rolloutPath, "utf8");
    const newline = contents.indexOf("\n");
    const firstLine = newline >= 0 ? contents.slice(0, newline) : contents;
    let record: Record<string, unknown>;
    try { record = JSON.parse(firstLine) as Record<string, unknown>; } catch { return false; }
    if (record.type !== "session_meta") return false;
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : {};
    const provider = resolveProvider(task.tenantId, task.provider);
    const modelProvider = createProviderLaunchConfig(provider, resolveApiKey(task.tenantId, task.provider) ?? undefined).modelProvider;
    const desiredCwd = "/workspace";
    if (payload.cwd === desiredCwd && payload.model_provider === modelProvider && payload.originator === "Agent Foundry") return false;
    record.payload = { ...payload, cwd: desiredCwd, model_provider: modelProvider, originator: "Agent Foundry" };
    const rewritten = `${JSON.stringify(record)}${newline >= 0 ? contents.slice(newline) : "\n"}`;
    await fs.writeFile(rolloutPath, rewritten, "utf8");
    return true;
  };
  const ensureTaskRollout = async (task: import("./core/types.js").AgentTask): Promise<{ migrated: boolean; path: string | null }> => {
    if (!task.threadId || !config.docker.enabled) return { migrated: false, path: null };
    const codexHome = path.join(config.dataDir, "codex-homes", task.id);
    const existing = await findNamedFile(path.join(codexHome, "sessions"), task.threadId);
    if (existing) return { migrated: false, path: existing };
    const source = locateRollout(task.threadId);
    if (!source) return { migrated: false, path: null };
    const relative = path.relative(path.join(process.env.CODEX_HOME ?? path.dirname(path.dirname(path.dirname(source))), "sessions"), source);
    const safeRelative = relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(source) : relative;
    const target = path.join(codexHome, "sessions", safeRelative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await normalizeTaskRollout(target, task);
    return { migrated: true, path: target };
  };
  const prepareTaskControl = async (task: import("./core/types.js").AgentTask): Promise<string | undefined> => {
    await ensureTaskRollout(task);
    let sandbox = store.getSandbox(task.id);
    if (config.docker.enabled && (!sandbox?.containerId || sandbox.state === "released")) {
      const workspace = await runner.workspaceManager.prepare(task);
      sandbox = (await runner.sandboxManager.prepare(task, workspace)).sandbox;
    }
    return sandbox?.kind === "docker" ? sandbox.containerId ?? undefined : undefined;
  };
  const taskControl = async (task: import("./core/types.js").AgentTask, method: string, params: Record<string, unknown>, timeoutMs = 30_000) => {
    const containerId = await prepareTaskControl(task);
    return codexControl.request(method, params, task.provider, timeoutMs, task.tenantId, containerId);
  };

  app.get("/api/health", async () => ({
    ok: true,
    service: "agent-foundry-local",
    workspace: await runner.workspaceManager.health(),
    sandbox: await runner.sandboxManager.health(),
    runtime: {
      platform: process.platform, arch: process.arch, node: process.version,
      codexAvailable: Boolean(process.env.CODEX_PATH && fsSync.existsSync(process.env.CODEX_PATH)),
      proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY),
      customCaConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      environmentReloadedAt: process.env.AGENT_ENV_RELOADED_AT || null,
    },
    time: new Date().toISOString(),
  }));

  app.get("/api/config", async (request) => {
    const tenantId = identity(request).tenantId;
    const tenantConfig = { ...config, providers: Object.fromEntries(Object.keys(config.providers).map((id) => [id, settings.provider(tenantId, id as "openai" | "deepseek" | "custom")])) as AppConfig["providers"] };
    return publicConfig(tenantConfig, Object.fromEntries(Object.keys(config.providers).map((id) => [id, Boolean(resolveApiKey(tenantId, id as "openai" | "deepseek" | "custom"))])));
  });
  app.get("/api/automations", async (request) => {
    const automations = store.listAutomationsFor(identity(request));
    return {
      automations,
      runs: automations.flatMap((automation) => store.listAutomationRuns(automation.id, 10).map((run) => ({
        ...run, taskStatus: run.taskId ? store.getTask(run.taskId)?.status ?? null : null,
      }))),
    };
  });
  app.post("/api/automations", async (request, reply) => {
    identityService.require(identity(request), "member");
    const parsed = createAutomationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid automation", issues: parsed.error.issues });
    const actor = identity(request);
    try {
      if (parsed.data.workspacePath) assertRemotePath(actor, parsed.data.workspacePath);
      const automation = store.createAutomation({ ...parsed.data, tenantId: actor.tenantId, userId: actor.userId });
      store.audit(actor, "automation.create", "automation", automation.id, { scheduleKind: automation.scheduleKind });
      return reply.code(201).send({ automation });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch<{ Params: { id: string } }>("/api/automations/:id", async (request, reply) => {
    const actor = identity(request);
    identityService.require(actor, "member");
    if (!store.getAutomationFor(request.params.id, actor)) return reply.code(404).send({ error: "Automation not found" });
    const parsed = updateAutomationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid automation update", issues: parsed.error.issues });
    try {
      if (parsed.data.workspacePath) assertRemotePath(actor, parsed.data.workspacePath);
      const automation = store.updateAutomation(request.params.id, parsed.data);
      store.audit(actor, "automation.update", "automation", automation.id, { status: automation.status });
      return { automation };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/automations/:id/run", async (request, reply) => {
    const actor = identity(request);
    identityService.require(actor, "member");
    const automation = store.getAutomationFor(request.params.id, actor);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });
    const task = await launchAutomation(automation);
    if (!task) return reply.code(409).send({ error: store.listAutomationRuns(automation.id, 1)[0]?.error ?? "Automation could not start" });
    return reply.code(202).send({ task });
  });
  app.delete<{ Params: { id: string } }>("/api/automations/:id", async (request, reply) => {
    const actor = identity(request);
    identityService.require(actor, "member");
    if (!store.getAutomationFor(request.params.id, actor)) return reply.code(404).send({ error: "Automation not found" });
    store.deleteAutomation(request.params.id);
    store.audit(actor, "automation.delete", "automation", request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { archived?: string; limit?: string; query?: string } }>("/api/tasks", async (request) => {
    const requestedLimit = Number.parseInt(request.query.limit ?? "100", 10);
    return store.queryTasksFor(identity(request), {
      archived: request.query.archived === "true",
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
      query: request.query.query?.slice(0, 200),
    });
  });
  app.get<{ Params: { id: string }; Querystring: { turnLimit?: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    const requestedTurnLimit = Number.parseInt(request.query.turnLimit ?? "30", 10);
    const turnLimit = Math.max(1, Math.min(1_000, Number.isFinite(requestedTurnLimit) ? requestedTurnLimit : 30));
    return {
      task,
      events: store.listRecentEvents(task.id, Math.min(10_000, Math.max(800, turnLimit * 20))),
      eventTotal: store.countEvents(task.id),
      messages: store.listRecentTurnMessages(task.id, turnLimit),
      turnTotal: store.countConversationTurns(task.id),
      memory: store.getConversationMemory(task.id),
      memoryEntries: store.listMemory(task.id),
      approvals: store.listApprovals().filter((approval) => approval.taskId === task.id),
      sandbox: store.getSandbox(task.id),
      signals: store.listSignals(task.id),
      children: store.listChildTasks(task.id),
      workspaceRoots: store.listWorkspaceRoots(task.id),
      reviewComments: store.listReviewComments(task.id),
      artifacts: store.listArtifacts(task.id).map((artifact) => ({ ...artifact, path: path.basename(artifact.path) })),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const actor = identity(request);
    identityService.require(actor, "member");
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    try {
      const sandbox = store.getSandbox(task.id);
      if (sandbox?.kind === "docker" && sandbox.state !== "released") await runner.sandboxManager.release(task.id);
      const deleted = store.deleteArchivedTaskFor(task.id, actor);
      store.audit(actor, "task.delete", "task", task.id, { title: deleted.title, artifactBytes: deleted.artifactBytes });
      return { deleted };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; rootId?: string } }>("/api/tasks/:id/workspace/tree", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (!task.workspacePath) return reply.code(409).send({ error: "Task has no workspace" });
    const parsed = workspaceTreeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid directory path" });
    try {
      const root = taskRoot(request, task.id, parsed.data.rootId);
      const status = await runInWorkspace(workspaceForPath(root.path), "git", ["status", "--short", "--untracked-files=all"], 10_000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const statuses = new Map(status.stdout.split(/\r?\n/).filter(Boolean).map((line) => [line.slice(3).trim(), line.slice(0, 2) || "??"]));
      return { path: parsed.data.path, rootId: root.rootId, label: root.label, readOnly: root.readOnly, entries: await listWorkspaceDirectory(root.path, parsed.data.path, statuses) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/workspace", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (!task.workspacePath) return { path: null, files: [], changes: [] };
    const files = await listWorkspaceFiles(task.workspacePath);
    const status = await runInWorkspace(
      workspaceForPath(task.workspacePath),
      "git",
      ["status", "--short", "--untracked-files=all"],
      10_000,
    ).catch(() => ({ code: 1, stdout: "", stderr: "Git status unavailable" }));
    const changes = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2) || "??",
      path: line.slice(3).trim(),
    }));
    return { path: task.workspacePath, files, filesTruncated: files.length >= 160, changes, gitAvailable: status.code === 0 };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; rootId?: string } }>("/api/tasks/:id/workspace/file", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (!task.workspacePath) return reply.code(409).send({ error: "Task has no workspace" });
    const parsed = workspaceFileQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid file path is required" });
    try {
      const root = taskRoot(request, task.id, parsed.data.rootId);
      const absoluteFile = await resolveExistingWorkspaceFile(root.path, parsed.data.path);
      const stat = await fs.stat(absoluteFile);
      if (!stat.isFile()) return reply.code(400).send({ error: "Path is not a file" });
      if (stat.size > 1_000_000) return reply.code(413).send({ error: "File is larger than the 1 MB preview limit" });
      const buffer = await fs.readFile(absoluteFile);
      if (buffer.includes(0)) return reply.code(415).send({ error: "Binary files cannot be previewed" });
      return { path: parsed.data.path, content: buffer.toString("utf8"), size: stat.size, rootId: root.rootId, readOnly: root.readOnly };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { id: string } }>("/api/tasks/:id/workspace/file", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.workspacePath) return reply.code(404).send({ error: "Task or workspace not found" });
    identityService.require(identity(request), "member");
    const parsed = workspaceWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid file update" });
    try {
      const target = resolveWorkspaceFile(task.workspacePath, parsed.data.path);
      const parent = path.dirname(target);
      const realRoot = await fs.realpath(task.workspacePath);
      const realParent = await fs.realpath(parent);
      const relative = path.relative(realRoot, realParent);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("File path is outside the task workspace");
      const key = `${task.id}:write:${parsed.data.path}:${Buffer.from(parsed.data.content).toString("base64url").slice(-32)}`;
      const operation = store.beginIdempotent(task.id, key, "workspace.file.write");
      if (!operation.fresh && operation.record.state === "completed") return { path: parsed.data.path, idempotent: true };
      await fs.writeFile(target, parsed.data.content, "utf8");
      store.finishIdempotent(key, "completed", { path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content) });
      store.audit(identity(request), "workspace.file.write", "file", parsed.data.path, { taskId: task.id });
      return { path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content) };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/workspace/roots", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = workspaceRootSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid workspace root" });
    const absolute = path.resolve(parsed.data.path);
    try { assertRemotePath(identity(request), absolute); } catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    try { if (!(await fs.stat(absolute)).isDirectory()) throw new Error("Not a directory"); }
    catch { return reply.code(400).send({ error: "Workspace root must be an existing directory" }); }
    const root = store.addWorkspaceRoot(task.id, absolute, parsed.data.label ?? path.basename(absolute));
    const sandbox = store.getSandbox(task.id);
    const active = ["preparing", "running", "verifying", "waiting_approval"].includes(task.status);
    if (sandbox?.kind === "docker" && sandbox.state !== "released" && !active) await runner.sandboxManager.release(task.id);
    if (active) return reply.code(202).send({ root, warning: "Root saved; it will be mounted after the current turn finishes" });
    return reply.code(201).send({ root, sandboxRestarted: sandbox?.kind === "docker" });
  });

  app.put<{ Params: { id: string } }>("/api/tasks/:id/workspace/current", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    if (activeStatusesForWorkspaceChange.has(task.status)) return reply.code(409).send({ error: "任务执行或等待期间不能切换工作区，请先停止任务" });
    const parsed = workspaceRootSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid workspace path" });
    const absolute = path.resolve(parsed.data.path);
    try { assertRemotePath(identity(request), absolute); } catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    try { if (!(await fs.stat(absolute)).isDirectory()) throw new Error("Not a directory"); }
    catch { return reply.code(400).send({ error: "Workspace must be an existing directory" }); }
    const sandbox = store.getSandbox(task.id);
    if (sandbox?.kind === "docker" && sandbox.state !== "released") await runner.sandboxManager.release(task.id);
    const root = store.setPrimaryWorkspaceRoot(task.id, absolute, parsed.data.label ?? path.basename(absolute));
    store.audit(identity(request), "workspace.current.set", "workspace", root.id, { taskId: task.id, path: absolute });
    bus.publish(store.appendEvent(task.id, "workspace.current.updated", { category: "workspace", phase: "completed", title: "当前工作区已切换", path: absolute }));
    return { task: store.getTask(task.id), root, workspaceRoots: store.listWorkspaceRoots(task.id) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/workspace/git/initialize", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.workspacePath) return reply.code(404).send({ error: "Task or workspace not found" });
    identityService.require(identity(request), "member");
    if (activeStatusesForWorkspaceChange.has(task.status)) return reply.code(409).send({ error: "任务执行或等待期间不能初始化 Git，请先停止任务" });
    const workspace = workspaceForPath(task.workspacePath);
    const existingHead = await runInWorkspace(workspace, "git", ["rev-parse", "--verify", "HEAD"], 10_000);
    if (existingHead.code === 0) return { initialized: false, commit: existingHead.stdout.trim() };
    const repository = await runInWorkspace(workspace, "git", ["rev-parse", "--is-inside-work-tree"], 10_000);
    if (repository.code !== 0) {
      const initialized = await runInWorkspace(workspace, "git", ["init"], 30_000);
      if (initialized.code !== 0) return reply.code(400).send({ error: `Git 初始化失败：${initialized.stderr || initialized.stdout}` });
    }
    const staged = await runInWorkspace(workspace, "git", ["add", "-A"], 120_000);
    if (staged.code !== 0) return reply.code(400).send({ error: `无法创建初始提交：${staged.stderr || staged.stdout}` });
    const committed = await runInWorkspace(workspace, "git", ["-c", "user.name=Agent Foundry", "-c", "user.email=agent-foundry@local", "commit", "--allow-empty", "-m", "Initialize Agent Foundry workspace"], 120_000);
    if (committed.code !== 0) return reply.code(400).send({ error: `无法创建初始提交：${committed.stderr || committed.stdout}` });
    const head = await runInWorkspace(workspace, "git", ["rev-parse", "HEAD"], 10_000);
    store.audit(identity(request), "workspace.git.initialize", "workspace", task.id, { path: task.workspacePath, commit: head.stdout.trim() });
    bus.publish(store.appendEvent(task.id, "workspace.git.initialized", { category: "workspace", phase: "completed", title: "已创建 Git 初始提交", commit: head.stdout.trim() }));
    return reply.code(201).send({ initialized: true, commit: head.stdout.trim() });
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; rootId?: string } }>("/api/tasks/:id/workspace/symbols", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.workspacePath) return reply.code(404).send({ error: "Task or workspace not found" });
    const parsed = symbolQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A search query is required" });
    let root;
    try { root = taskRoot(request, task.id, request.query.rootId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const result = await runInWorkspace(workspaceForPath(root.path), "rg", ["-n", "--no-heading", "--glob", "!node_modules/**", "--glob", "!.git/**", parsed.data.q, "."], 20_000);
    const matches = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200).map((line) => { const match = line.match(/^(.+?):(\d+):(.*)$/); return match ? { path: match[1].replace(/^\.\//, ""), line: Number(match[2]), preview: match[3].trim() } : { path: "", line: 0, preview: line }; });
    return { matches };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/review-comments", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = reviewCommentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid review comment" });
    resolveWorkspaceFile(task.workspacePath!, parsed.data.path);
    return reply.code(201).send({ comment: store.addReviewComment(task.id, parsed.data.path, parsed.data.line, parsed.data.side, parsed.data.body) });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/handoff", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = continueConversationSchema.pick({ content: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Handoff instruction is required" });
    const completedChildren = store.listChildTasks(task.id).filter((child) => child.status === "succeeded");
    const summary = completedChildren.map((child) => `- ${child.title}: ${child.result ?? "已完成"}`).join("\n");
    try {
      const result = store.continueConversation(task.id, `${parsed.data.content}\n\n<child_agent_results>\n${summary || "暂无已完成的子任务"}\n</child_agent_results>`);
      store.audit(identity(request), "task.handoff", "task", task.id, { children: completedChildren.map((child) => child.id) });
      return reply.code(202).send(result);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; turn?: string } }>("/api/tasks/:id/workspace/diff", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (!task.workspacePath) return reply.code(409).send({ error: "Task has no workspace" });
    const parsed = workspaceFileQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid file path is required" });
    try {
      resolveWorkspaceFile(task.workspacePath, parsed.data.path);
      if (request.query.turn !== undefined) {
        const turn = Number(request.query.turn);
        const summary = [...store.listAllEvents(task.id)].reverse().find((event) => event.type === "turn.workspace.summary" && String(event.payload.platformTurnId ?? "").endsWith(`:turn:${turn}`));
        const fullDiff = typeof summary?.payload.diff === "string" ? summary.payload.diff : "";
        const sections = fullDiff.split(/(?=^diff --git )/m).filter(Boolean);
        const matching = sections.find((section) => section.startsWith(`diff --git a/${parsed.data.path} b/${parsed.data.path}\n`) || section.includes(`\n+++ b/${parsed.data.path}\n`) || section.includes(`\n--- a/${parsed.data.path}\n`));
        if (matching) return { path: parsed.data.path, diff: matching };
        const baselineTree = typeof summary?.payload.baselineTree === "string" ? summary.payload.baselineTree : "";
        const currentTree = typeof summary?.payload.currentTree === "string" ? summary.payload.currentTree : "";
        if (baselineTree && currentTree) {
          const exact = await runInWorkspace(workspaceForPath(task.workspacePath), "git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", baselineTree, currentTree, "--", parsed.data.path], 10_000);
          if (exact.code === 0 && exact.stdout) return { path: parsed.data.path, diff: exact.stdout };
        }
        return { path: parsed.data.path, diff: "No textual diff is available for this turn." };
      }
      const tracked = await runInWorkspace(workspaceForPath(task.workspacePath), "git", ["diff", "--no-ext-diff", "--", parsed.data.path], 10_000);
      const staged = await runInWorkspace(workspaceForPath(task.workspacePath), "git", ["diff", "--cached", "--no-ext-diff", "--", parsed.data.path], 10_000);
      let diff = [staged.stdout, tracked.stdout].filter(Boolean).join("\n");
      if (!diff) {
        const untracked = await runInWorkspace(workspaceForPath(task.workspacePath), "git", ["ls-files", "--others", "--exclude-standard", "--", parsed.data.path], 10_000);
        if (untracked.stdout.trim()) {
          const safeFile = await resolveExistingWorkspaceFile(task.workspacePath, parsed.data.path);
          const fileStat = await fs.stat(safeFile);
          if (fileStat.size > 1_000_000) return reply.code(413).send({ error: "Diff is larger than the 1 MB preview limit" });
          const fileBuffer = await fs.readFile(safeFile);
          if (fileBuffer.includes(0)) return reply.code(415).send({ error: "Binary diffs cannot be previewed" });
          const content = fileBuffer.toString("utf8");
          diff = [`diff --git a/${parsed.data.path} b/${parsed.data.path}`, "new file mode 100644", "--- /dev/null", `+++ b/${parsed.data.path}`, `@@ -0,0 +1,${content.split(/\r?\n/).length} @@`, ...content.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
        }
      }
      return { path: parsed.data.path, diff: diff || "No textual diff is available." };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/workspace/changes", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = workspaceChangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid workspace change", issues: parsed.error.issues });
    try { return reply.code(202).send({ approval: tools.requestWorkspaceChange(request.params.id, parsed.data.operation, parsed.data.path, parsed.data.patch) }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/terminal", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = terminalCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid terminal command", issues: parsed.error.issues });
    try {
      const sandbox = store.getSandbox(task.id);
      if (config.docker.enabled && (!sandbox?.containerId || sandbox.state === "released")) {
        const workspace = await runner.workspaceManager.prepare(task);
        await runner.sandboxManager.prepare(task, workspace);
      }
      return reply.code(202).send({ approval: tools.requestTerminal(request.params.id, parsed.data.command) });
    }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/terminal/sessions", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    return { sessions: terminalManager.list(request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/terminal/sessions", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = terminalOpenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid terminal size", issues: parsed.error.issues });
    try {
      const preparedWorkspace = await runner.workspaceManager.prepare(task);
      const prepared = await runner.sandboxManager.prepare(task, preparedWorkspace);
      const session = terminalManager.open(task, prepared.workspace, parsed.data.cols, parsed.data.rows);
      bus.publish(store.appendEvent(task.id, "terminal.session.opened", {
        schemaVersion: 1, category: "terminal", phase: "completed", turnId: `${task.id}:terminal:${session.id}`,
        title: `交互终端已打开（${session.permissionProfile}）`, terminalSessionId: session.id,
        sandboxMode: session.sandboxMode, permissionProfile: session.permissionProfile,
      }));
      return reply.code(201).send({ session });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string; sessionId: string } }>("/api/tasks/:id/terminal/sessions/:sessionId/input", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = terminalInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid terminal input", issues: parsed.error.issues });
    try { await terminalManager.write(request.params.id, request.params.sessionId, parsed.data.data); return reply.code(202).send({ accepted: true }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string; sessionId: string } }>("/api/tasks/:id/terminal/sessions/:sessionId/resize", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    const parsed = terminalResizeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid terminal size", issues: parsed.error.issues });
    try { terminalManager.resize(request.params.id, request.params.sessionId, parsed.data.cols, parsed.data.rows); return { resized: true }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.delete<{ Params: { id: string; sessionId: string } }>("/api/tasks/:id/terminal/sessions/:sessionId", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    await terminalManager.close(request.params.id, request.params.sessionId);
    return reply.code(202).send({ closed: true });
  });

  app.get<{ Params: { id: string; sessionId: string } }>("/api/tasks/:id/terminal/sessions/:sessionId/stream", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    const session = terminalManager.get(request.params.id, request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "Terminal session not found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "Access-Control-Allow-Origin": request.headers.origin ?? "*",
    });
    const send = (chunk: { data: string; offset: number }) => reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (session.output) send({ data: session.output, offset: session.outputOffset + session.output.length });
    const unsubscribe = terminalManager.subscribe(request.params.id, request.params.sessionId, send);
    const keepAlive = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
  });

  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (request, reply) => {
    const artifact = store.getArtifact(request.params.id);
    if (!artifact || !scopedTask(request, artifact.taskId)) return reply.code(404).send({ error: "Artifact not found" });
    reply.header("Content-Type", artifact.mimeType);
    reply.header("Content-Disposition", `inline; filename=\"${path.basename(artifact.path)}\"`);
    return reply.send(await fs.readFile(artifact.path));
  });

  app.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid task", issues: parsed.error.issues });
    }
    const input = parsed.data;
    const actor = identity(request);
    identityService.require(actor, "member");
    try {
      if (input.workspacePath) assertRemotePath(actor, input.workspacePath);
      for (const attachment of input.attachments ?? []) assertRemotePath(actor, attachment);
    } catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    store.assertQuota(actor);
    const tenantSettings = settings.get(actor.tenantId);
    const runtime = input.runtime ?? tenantSettings.defaultRuntime ?? config.defaultRuntime;
    const provider = settings.provider(actor.tenantId, input.provider ?? tenantSettings.defaultProvider);
    const model = input.model || provider.defaultModel;
    const tenantApiKey = resolveApiKey(actor.tenantId, provider.id);
    if (runtime === "codex" && (!tenantApiKey || !provider.codexCompatible)) {
      return reply.code(400).send({
        error: !tenantApiKey
          ? `${provider.label} API key is not configured`
          : `${provider.label} does not yet have a Codex-compatible runtime adapter`,
      });
    }
    const workspacePath = input.workspacePath || tenantSettings.defaultWorkspace || undefined;
    try { if (workspacePath) assertRemotePath(actor, workspacePath); }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    const task = store.createTask({ ...input, workspacePath, tenantId: actor.tenantId, userId: actor.userId }, { runtime, model });
    try {
      const initialArtifacts = (input.attachments ?? []).map((file) => store.importAttachment(task.id, file));
      if (initialArtifacts.length) {
        const enriched = `${task.prompt}${attachmentPrompt(initialArtifacts, config.docker.enabled)}`;
        store.updateTask(task.id, { prompt: enriched });
        store.appendMessage(task.id, "user", enriched, 0);
      }
    } catch (error) {
      store.deleteFreshTask(task.id);
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    store.audit(actor, "task.create", "task", task.id, { runtime, provider: task.provider, parentTaskId: task.parentTaskId });
    bus.publish(store.appendEvent(task.id, "task.created", {
      runtime: task.runtime,
      provider: task.provider,
      durableWaitSeconds: task.waitSeconds,
      goalStatus: task.goalStatus,
      goalDeadlineAt: task.goalDeadlineAt,
      goalTokenBudget: task.goalTokenBudget,
    }));
    return reply.code(201).send({ task: store.getTask(task.id) });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (request, reply) => {
    if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = continueConversationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Message cannot be empty", issues: parsed.error.issues });
    }
    try {
      const current = store.getTask(request.params.id)!;
      if (!["succeeded", "failed", "cancelled"].includes(current.status)) return reply.code(409).send({ error: "Wait for the current turn to finish before attaching files" });
      for (const attachment of parsed.data.attachments ?? []) assertRemotePath(identity(request), attachment);
      const artifacts = (parsed.data.attachments ?? []).map((file) => store.importAttachment(request.params.id, file));
      const attachmentText = attachmentPrompt(artifacts, config.docker.enabled);
      if (parsed.data.sandboxMode && parsed.data.sandboxMode !== current.sandboxMode) {
        const currentSandbox = store.getSandbox(current.id);
        if (currentSandbox?.kind === "docker" && currentSandbox.state !== "released") await runner.sandboxManager.release(current.id);
      }
      const { task, message } = store.continueConversation(request.params.id, `${parsed.data.content}${attachmentText}`, {
        provider: parsed.data.provider ?? current.provider,
        model: parsed.data.model === undefined ? current.model : parsed.data.model, reasoningEffort: parsed.data.reasoningEffort ?? current.reasoningEffort,
        sandboxMode: parsed.data.sandboxMode ?? current.sandboxMode, approvalPolicy: parsed.data.approvalPolicy ?? current.approvalPolicy,
        approvalsReviewer: parsed.data.approvalsReviewer ?? current.approvalsReviewer,
      });
      bus.publish(store.appendEvent(task.id, "conversation.message", {
        messageId: message.id,
        turn: message.turn,
        role: message.role,
        preview: message.content.slice(0, 240),
      }));
      return reply.code(202).send({
        task,
        message,
        messages: store.listMessages(task.id),
        memory: store.getConversationMemory(task.id),
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/goal", async (request, reply) => {
    const actor = identity(request);
    identityService.require(actor, "member");
    const task = store.getTaskFor(request.params.id, actor);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (task.goalStatus === "inactive") return reply.code(409).send({ error: "This task is not a persistent goal" });
    const parsed = goalActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid goal action", issues: parsed.error.issues });
    const { action } = parsed.data;
    try {
      if (action === "pause") {
        let updated = store.updateTask(task.id, { goalStatus: "paused" });
        if (updated.status === "queued" && updated.checkpoint?.phase === "goal_continuation") {
          updated = store.transition(task.id, "cancelled", { finishedAt: new Date().toISOString(), cancelRequested: false });
        }
        bus.publish(store.appendEvent(task.id, "goal.paused", { schemaVersion: 1, category: "task", phase: "waiting", title: "持续目标已由用户暂停", progress: updated.goalProgress }));
      } else if (action === "complete") {
        let updated = store.updateTask(task.id, { goalStatus: "completed", goalProgress: Math.max(task.goalProgress, 100), goalNextStep: "用户结束了持续目标" });
        if (updated.status === "queued" && updated.checkpoint?.phase === "goal_continuation") {
          updated = store.transition(task.id, "cancelled", { finishedAt: new Date().toISOString(), cancelRequested: false });
        }
        bus.publish(store.appendEvent(task.id, "goal.completed", { schemaVersion: 1, category: "task", phase: "completed", title: "持续目标已由用户结束", progress: updated.goalProgress }));
      } else {
        const extra = parsed.data.additionalTurns ?? 3;
        const goalMaxTurns = task.goalCompletedTurns >= task.goalMaxTurns ? Math.min(20, task.goalCompletedTurns + extra) : task.goalMaxTurns;
        const deadlineExpired = task.goalStatus === "deadline_reached" || Boolean(task.goalDeadlineAt && Date.parse(task.goalDeadlineAt) <= Date.now());
        const goalDeadlineAt = deadlineExpired
          ? new Date(Date.now() + (parsed.data.additionalHours ?? 4) * 3_600_000).toISOString()
          : task.goalDeadlineAt;
        const goalTokenBudget = task.goalStatus === "budget_reached"
          ? Math.min(10_000_000, task.goalTokenBudget + (parsed.data.additionalTokens ?? 100_000))
          : task.goalTokenBudget;
        store.updateTask(task.id, { goalStatus: "active", goalMaxTurns, goalDeadlineAt, goalTokenBudget });
        if (["succeeded", "failed", "cancelled"].includes(task.status)) {
          store.transition(task.id, "queued", {
            prompt: `继续执行持续目标“${task.goalObjective ?? task.title}”。请先检查已有工作和最近进度，再推进下一项未完成工作。`,
            result: null, error: null, checkpoint: { phase: "goal_continuation", resumedByUser: true },
            startedAt: null, finishedAt: null, cancelRequested: false,
          });
        }
        bus.publish(store.appendEvent(task.id, "goal.resumed", { schemaVersion: 1, category: "task", phase: "started", title: "持续目标已恢复", completedTurns: task.goalCompletedTurns, maxTurns: goalMaxTurns, goalDeadlineAt, goalTokenBudget, goalTokensUsed: task.goalTokensUsed }));
      }
      store.audit(actor, `goal.${action}`, "task", task.id, { additionalTurns: parsed.data.additionalTurns ?? null, additionalHours: parsed.data.additionalHours ?? null, additionalTokens: parsed.data.additionalTokens ?? null });
      return { task: store.getTask(task.id) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages/last/retract", async (request, reply) => {
    let task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    const actor = identity(request);
    identityService.require(actor, "member");
    try {
      if (activeStatusesForWorkspaceChange.has(task.status)) {
        store.requestCancel(task.id);
        await runner.cancel(task.id);
        task = store.getTask(task.id)!;
      }
      const hasUserMessage = store.listMessages(task.id).some((message) => message.role === "user");
      if (!hasUserMessage) return reply.code(409).send({ error: "没有可以编辑的上一条消息" });
      let threadContext: "rolled_back" | "detached" | "not_needed" = "not_needed";
      if (task.runtime === "codex" && task.threadId) {
        try {
          await taskControl(task, "thread/rollback", { threadId: task.threadId, numTurns: 1 }, 60_000);
          threadContext = "rolled_back";
        } catch {
          store.updateTask(task.id, { threadId: null });
          threadContext = "detached";
        }
      }
      const message = store.retractLatestTurn(task.id);
      store.audit(actor, "conversation.turn.retract", "task", task.id, { turn: message.turn, threadContext });
      return {
        task: store.getTask(task.id), message, threadContext,
        messages: store.listMessages(task.id), events: store.listEvents(task.id), memory: store.getConversationMemory(task.id),
      };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/providers", async (request) => ({ providers: Object.keys(config.providers).map((id) => settings.provider(identity(request).tenantId, id as "openai" | "deepseek" | "custom")).map((provider) => ({
    id: provider.id, label: provider.label, configured: Boolean(resolveApiKey(identity(request).tenantId, provider.id)), defaultModel: provider.defaultModel,
    baseUrl: provider.baseUrl ?? "", codexCompatible: provider.codexCompatible,
  })) }));

  app.get("/api/models", async (request) => {
    const actor = identity(request);
    const choices: import("./core/types.js").ModelChoice[] = [];
    const errors: Array<{ provider: string; error: string }> = [];
    for (const id of Object.keys(config.providers) as Array<"openai" | "deepseek" | "custom">) {
      const provider = settings.provider(actor.tenantId, id);
      if (!resolveApiKey(actor.tenantId, id) || !provider.codexCompatible) continue;
      let models: Array<Record<string, unknown>> = [];
      const cacheKey = `${actor.tenantId}:${id}:${provider.defaultModel}:${provider.baseUrl ?? ""}`;
      const cached = modelCatalogCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        choices.push(...cached.value);
        if (cached.error) errors.push({ provider: id, error: cached.error });
        continue;
      }
      let catalogError: string | undefined;
      try {
        if (id === "openai") {
          const result = await codexControl.request("model/list", { includeHidden: false, limit: 100 }, id, 30_000, actor.tenantId);
          models = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
        }
      }
      catch (error) { catalogError = error instanceof Error ? error.message : String(error); errors.push({ provider: id, error: catalogError }); }
      if (!models.length && provider.defaultModel) models = [{ model: provider.defaultModel, displayName: provider.defaultModel, isDefault: true, supportedReasoningEfforts: [] }];
      const providerChoices: import("./core/types.js").ModelChoice[] = [];
      for (const model of models) {
        const modelId = String(model.model ?? model.id ?? "").trim();
        if (!modelId) continue;
        const effortOptions = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
        const supported = effortOptions.map((value) => String((value as Record<string, unknown>)?.reasoningEffort ?? value)).filter((value): value is import("./core/types.js").TaskReasoningEffort => ["minimal", "low", "medium", "high", "xhigh", "ultra"].includes(value));
        providerChoices.push({ provider: id, providerLabel: provider.label, model: modelId, displayName: String(model.displayName ?? modelId), isDefault: Boolean(model.isDefault ?? modelId === provider.defaultModel), supportedReasoningEfforts: supported });
      }
      choices.push(...providerChoices);
      modelCatalogCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: providerChoices, error: catalogError });
    }
    return { models: choices, errors };
  });

  app.put<{ Params: { provider: "openai" | "deepseek" | "custom" } }>("/api/providers/:provider/secret", async (request, reply) => {
    const actor = identity(request); identityService.require(actor, "admin");
    const parsed = providerSecretSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid provider secret" });
    const provider = config.providers[request.params.provider];
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    if (parsed.data.apiKey) secretVault.set(actor.tenantId, provider.id, parsed.data.apiKey);
    else secretVault.remove(actor.tenantId, provider.id);
    store.audit(actor, parsed.data.apiKey ? "provider.secret.set" : "provider.secret.remove", "provider", provider.id);
    return { provider: { id: provider.id, configured: Boolean(resolveApiKey(actor.tenantId, provider.id)) } };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/steer", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = continueConversationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Message cannot be empty" });
    try { await runner.steer(task.id, parsed.data.content); return reply.code(202).send({ task: store.getTask(task.id), messages: store.listMessages(task.id) }); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid task update", issues: parsed.error.issues });
    }
    try {
      let task = scopedTask(request, request.params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });
      if (parsed.data.title !== undefined) task = store.renameTask(task.id, parsed.data.title);
      if (parsed.data.archived !== undefined) {
        task = store.setTaskArchived(task.id, parsed.data.archived);
        if (task.threadId && task.runtime === "codex") {
          const archived = parsed.data.archived;
          const syncTask = task;
          const taskId = task.id;
          trackBackground(taskControl(syncTask, archived ? "thread/archive" : "thread/unarchive", { threadId: task.threadId })
            .then(() => bus.publish(store.appendEvent(taskId, "task.archive.sync.completed", { category: "task", phase: "completed", title: archived ? "Codex 对话归档同步完成" : "Codex 对话恢复同步完成" })))
            .catch((error) => bus.publish(store.appendEvent(taskId, "task.archive.sync.failed", { category: "task", phase: "failed", title: "本地状态已更新，但 Codex 同步失败", detail: error instanceof Error ? error.message : String(error) })))
            .finally(() => { if (store.getSandbox(taskId)?.kind === "docker") runner.sandboxManager.markIdle(taskId); }));
        }
      }
      if (parsed.data.pinned !== undefined) task = store.setTaskPinned(task.id, parsed.data.pinned);
      if (parsed.data.section !== undefined) task = store.setTaskSection(task.id, parsed.data.section);
      const runtimeSettings = Object.fromEntries(Object.entries({
        provider: parsed.data.provider, model: parsed.data.model, reasoningEffort: parsed.data.reasoningEffort, sandboxMode: parsed.data.sandboxMode,
        approvalPolicy: parsed.data.approvalPolicy, approvalsReviewer: parsed.data.approvalsReviewer,
      }).filter(([, value]) => value !== undefined));
      if (Object.keys(runtimeSettings).length) {
        if (!["succeeded", "failed", "cancelled"].includes(task.status)) return reply.code(409).send({ error: "请等待当前轮次结束后再调整模型或权限" });
        if (parsed.data.sandboxMode && parsed.data.sandboxMode !== task.sandboxMode) {
          const currentSandbox = store.getSandbox(task.id);
          if (currentSandbox?.kind === "docker" && currentSandbox.state !== "released") await runner.sandboxManager.release(task.id);
        }
        task = store.updateTask(task.id, runtimeSettings);
      }
      if (task.threadId && parsed.data.title !== undefined) void taskControl(task, "thread/name/set", { threadId: task.threadId, name: parsed.data.title }).catch(() => undefined);
      if (task.threadId && parsed.data.pinned !== undefined) void taskControl(task, "thread/metadata/update", { threadId: task.threadId, isPinned: parsed.data.pinned }).catch(() => undefined);
      store.audit(identity(request), "task.update", "task", task.id, parsed.data);
      bus.publish(store.appendEvent(task.id, "task.updated", parsed.data));
      return { task };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/events",
    async (request, reply) => {
      if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
      return { events: store.listEvents(request.params.id, Number(request.query.after ?? 0)) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/stream",
    async (request, reply) => {
      const task = scopedTask(request, request.params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": request.headers.origin ?? "*",
      });
      const send = (event: object) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      for (const event of store.listEvents(task.id, Number(request.query.after ?? 0))) send(event);
      const unsubscribe = bus.subscribe(task.id, send);
      const keepAlive = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      request.raw.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    try {
      if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
      identityService.require(identity(request), "member");
      const current = store.getTask(request.params.id)!;
      if (current.goalStatus === "active") store.updateTask(current.id, { goalStatus: "paused", goalNextStep: "当前执行已由用户停止，可检查结果后恢复目标。" });
      const task = store.requestCancel(request.params.id);
      await runner.cancel(task.id);
      bus.publish(store.appendEvent(task.id, "task.cancel_requested"));
      return { task: store.getTask(task.id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    try {
      if (!scopedTask(request, request.params.id)) return reply.code(404).send({ error: "Task not found" });
      identityService.require(identity(request), "member");
      const task = store.retry(request.params.id);
      bus.publish(store.appendEvent(task.id, "task.retried", { attempt: task.attempt }));
      return { task };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/children", async (request, reply) => {
    const parent = scopedTask(request, request.params.id);
    if (!parent) return reply.code(404).send({ error: "Task not found" });
    identityService.require(identity(request), "member");
    const parsed = childTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid child task", issues: parsed.error.issues });
    try {
      const child = await multiAgent.createChild(parent, parsed.data);
      store.audit(identity(request), "task.delegate", "task", child.id, { parentTaskId: parent.id, isolation: parsed.data.isolation ?? "worktree" });
      bus.publish(store.appendEvent(parent.id, "child-task.created", { schemaVersion: 1, category: "task", phase: "started", turnId: `${parent.id}:child`, title: `已委派：${child.title}`, childTaskId: child.id }));
      return reply.code(201).send({ task: child });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string; childId: string } }>("/api/tasks/:id/children/:childId/merge", async (request, reply) => {
    const parent = scopedTask(request, request.params.id);
    const child = scopedTask(request, request.params.childId);
    if (!parent || !child || child.parentTaskId !== parent.id) return reply.code(404).send({ error: "Child task not found" });
    identityService.require(identity(request), "member");
    if (child.status !== "succeeded") return reply.code(409).send({ error: "Child task has not succeeded" });
    const branch = typeof child.checkpoint?.branch === "string" ? child.checkpoint.branch : "";
    if (!branch) return reply.code(409).send({ error: "Child task does not have a worktree branch" });
    return reply.code(202).send({ approval: tools.requestChildMerge(parent.id, child.id, branch) });
  });

  app.get<{ Querystring: { cwd?: string; provider?: "openai" | "deepseek" | "custom"; taskId?: string } }>("/api/codex/catalog", async (request, reply) => {
    identityService.require(identity(request), "viewer");
    try {
      const task = request.query.taskId ? scopedTask(request, request.query.taskId) : null;
      if (request.query.taskId && !task) return reply.code(404).send({ error: "Task not found" });
      const sandbox = task ? store.getSandbox(task.id) : null;
      const cwd = sandbox?.kind === "docker" ? "/workspace" : request.query.cwd || task?.workspacePath || process.cwd();
      return await codexControl.catalog(cwd, request.query.provider ?? task?.provider ?? "openai", identity(request).tenantId, sandbox?.kind === "docker" && sandbox.state !== "released" ? sandbox.containerId ?? undefined : undefined);
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Body: { path?: string; enabled?: boolean; provider?: "openai" | "deepseek" | "custom"; taskId?: string } }>("/api/codex/skills/config", async (request, reply) => {
    identityService.require(identity(request), "admin");
    if (typeof request.body?.path !== "string" || typeof request.body?.enabled !== "boolean") return reply.code(400).send({ error: "path and enabled are required" });
    const task = request.body.taskId ? scopedTask(request, request.body.taskId) : null;
    const sandbox = task ? store.getSandbox(task.id) : null;
    try { return { result: await codexControl.request("skills/config/write", { path: request.body.path, enabled: request.body.enabled }, request.body.provider ?? "openai", 30_000, identity(request).tenantId, sandbox?.kind === "docker" ? sandbox.containerId ?? undefined : undefined) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Body: { provider?: "openai" | "deepseek" | "custom"; taskId?: string } }>("/api/codex/mcp/reload", async (request, reply) => {
    identityService.require(identity(request), "admin");
    const task = request.body?.taskId ? scopedTask(request, request.body.taskId) : null;
    if (request.body?.taskId && !task) return reply.code(404).send({ error: "Task not found" });
    const sandbox = task ? store.getSandbox(task.id) : null;
    try { return { result: await codexControl.reloadMcp(request.body?.provider ?? task?.provider ?? "openai", identity(request).tenantId, sandbox?.kind === "docker" && sandbox.state !== "released" ? sandbox.containerId ?? undefined : undefined) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post<{ Params: { id: string }; Body: { lastTurnId?: string } }>("/api/tasks/:id/fork", async (request, reply) => {
    const source = scopedTask(request, request.params.id);
    if (!source?.threadId) return reply.code(409).send({ error: "Task has no Codex thread to fork" });
    if (activeStatusesForWorkspaceChange.has(source.status)) return reply.code(409).send({ error: "任务正在执行或等待，完成后才能创建分支" });
    identityService.require(identity(request), "member");
    try {
      const containerId = await prepareTaskControl(source);
      const sandbox = store.getSandbox(source.id);
      const result = await codexControl.request("thread/fork", { threadId: source.threadId, lastTurnId: request.body?.lastTurnId ?? null, ephemeral: false }, source.provider, 30_000, source.tenantId, sandbox?.kind === "docker" ? sandbox.containerId ?? undefined : undefined);
      const forkedThread = result.thread as Record<string, unknown> | undefined;
      const forkedThreadId = String(forkedThread?.id ?? "");
      if (!forkedThreadId) throw new Error("Codex did not return the forked thread id");
      const branch = store.forkConversation(source.id, `${source.title}（分支）`, forkedThreadId);
      const sourceCodexHome = path.join(config.dataDir, "codex-homes", source.id);
      const branchCodexHome = path.join(config.dataDir, "codex-homes", branch.id);
      if (containerId && sandbox?.kind === "docker") await fs.cp(sourceCodexHome, branchCodexHome, { recursive: true, force: true });
      bus.publish(store.appendEvent(source.id, "conversation.branch.created", { schemaVersion: 1, category: "turn", phase: "completed", turnId: `${source.id}:branch`, title: `已从此对话创建分支：${branch.title}`, branchTaskId: branch.id }));
      bus.publish(store.appendEvent(branch.id, "conversation.branch.origin", { schemaVersion: 1, category: "turn", phase: "completed", turnId: `${branch.id}:branch`, title: `此分支由“${source.title}”创建`, sourceTaskId: source.id }));
      return reply.code(201).send({ task: branch, thread: forkedThread });
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) });
    }
    finally { if (store.getSandbox(source.id)?.kind === "docker") runner.sandboxManager.markIdle(source.id); }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/compact", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.threadId) return reply.code(409).send({ error: "Task has no Codex thread" });
    if (activeStatusesForWorkspaceChange.has(task.status)) return reply.code(409).send({ error: "任务正在执行或等待，完成后才能压缩上下文" });
    identityService.require(identity(request), "member");
    try {
      const containerId = await prepareTaskControl(task);
      const fallbackUsage = [...store.listRecentEvents(task.id)].reverse().find((event) => event.type === "agent.turn.usage")?.payload.usage as Record<string, unknown> | undefined;
      bus.publish(store.appendEvent(task.id, "context.compaction.started", { schemaVersion: 1, category: "memory", phase: "started", turnId: `${task.id}:compact`, title: "正在压缩上下文", before: fallbackUsage ?? null }));
      const result = await codexControl.compactThread(task.threadId, task.provider, task.tenantId, containerId).catch((error) => ({
        before: null, after: null, completed: false, error: error instanceof Error ? error.message : String(error),
      }));
      const before = result.before ?? fallbackUsage ?? null;
      if (!result.completed) {
        const reason = result.error ?? "Codex 未完成上下文压缩";
        if (task.provider !== "openai") {
          const memorySummary = store.getConversationMemory(task.id).summary;
          const estimatedTokens = Math.max(1, Math.ceil(Buffer.byteLength(memorySummary, "utf8") / 4));
          const contextWindow = Number((before as Record<string, unknown> | null)?.modelContextWindow ?? 258_400);
          const after = { total: { totalTokens: estimatedTokens }, totalTokens: estimatedTokens, modelContextWindow: contextWindow };
          store.updateTask(task.id, { threadId: null });
          bus.publish(store.appendEvent(task.id, "context.compaction.completed", { schemaVersion: 1, category: "memory", phase: "completed", turnId: `${task.id}:compact`, title: "上下文已在本机压缩", before, after, localFallback: true, detachedThreadId: task.threadId }));
          return { result: { ...result, completed: true, error: null }, before, after, localFallback: true };
        }
        bus.publish(store.appendEvent(task.id, "context.compaction.failed", { schemaVersion: 1, category: "memory", phase: "failed", turnId: `${task.id}:compact`, title: "上下文压缩失败", before, detail: reason }));
        return reply.code(409).send({ error: reason, before, after: result.after });
      }
      bus.publish(store.appendEvent(task.id, "context.compaction.completed", { schemaVersion: 1, category: "memory", phase: "completed", turnId: `${task.id}:compact`, title: "上下文压缩完成", before, after: result.after }));
      return { result, before, after: result.after };
    }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { if (store.getSandbox(task.id)?.kind === "docker") runner.sandboxManager.markIdle(task.id); }
  });

  app.post<{ Params: { id: string }; Body: { instructions?: string } }>("/api/tasks/:id/review", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.threadId) return reply.code(409).send({ error: "Task has no Codex thread" });
    identityService.require(identity(request), "member");
    const target = request.body?.instructions ? { type: "custom", instructions: request.body.instructions } : { type: "uncommittedChanges" };
    if (activeStatusesForWorkspaceChange.has(task.status)) return reply.code(409).send({ error: "任务正在执行或等待，完成后才能开始审阅" });
    try {
      const containerId = await prepareTaskControl(task);
      bus.publish(store.appendEvent(task.id, "review.started", { schemaVersion: 1, category: "turn", phase: "started", turnId: `${task.id}:review`, title: "Codex 正在审阅" }));
      const result = await codexControl.reviewThread(task.threadId, target, task.provider, task.tenantId, containerId);
      if (!result.completed) {
        bus.publish(store.appendEvent(task.id, "review.failed", { schemaVersion: 1, category: "turn", phase: "failed", turnId: `${task.id}:review`, title: "Codex 审阅失败", detail: result.error }));
        return reply.code(409).send({ error: result.error ?? "Codex 审阅失败", result });
      }
      bus.publish(store.appendEvent(task.id, "review.completed", { schemaVersion: 1, category: "turn", phase: "completed", turnId: `${task.id}:review`, title: "Codex 审阅完成", reviewThreadId: result.reviewThreadId, reviewTurnId: result.turnId, summary: result.summary }));
      return { result };
    }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { if (store.getSandbox(task.id)?.kind === "docker") runner.sandboxManager.markIdle(task.id); }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/background-terminals", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.threadId) return reply.code(409).send({ error: "Task has no Codex thread" });
    try { return await taskControl(task, "thread/backgroundTerminals/list", { threadId: task.threadId, limit: 100 }); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.delete<{ Params: { id: string; processId: string } }>("/api/tasks/:id/background-terminals/:processId", async (request, reply) => {
    const task = scopedTask(request, request.params.id);
    if (!task?.threadId) return reply.code(409).send({ error: "Task has no Codex thread" });
    identityService.require(identity(request), "member");
    try { return await taskControl(task, "thread/backgroundTerminals/terminate", { threadId: task.threadId, processId: request.params.processId }); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/approvals", async (request) => {
    const allowed = new Set(store.listTasksFor(identity(request), 10_000, false).map((task) => task.id));
    return { approvals: store.listApprovals().filter((approval) => allowed.has(approval.taskId)) };
  });
  app.post<{ Params: { id: string }; Body: { decision?: string } }>(
    "/api/approvals/:id/decision",
    async (request, reply) => {
      if (request.body?.decision !== "approved" && request.body?.decision !== "rejected") {
        return reply.code(400).send({ error: "decision must be approved or rejected" });
      }
      try {
        const existing = store.getApproval(request.params.id);
        if (!existing) return reply.code(404).send({ error: "Approval not found" });
        if (!scopedTask(request, existing.taskId)) return reply.code(404).send({ error: "Approval not found" });
        identityService.require(identity(request), "member");
        const approval = store.resolveApproval(request.params.id, request.body.decision);
        let execution: Record<string, unknown> | null = null;
        if (request.body.decision === "approved" && approval.request.action === "child_merge") {
          const parent = store.getTask(approval.taskId)!;
          const child = store.getTask(String(approval.request.childTaskId));
          if (!child) throw new Error("Child task not found");
          execution = await multiAgent.mergeChild(parent, child);
        } else if (request.body.decision === "approved" && ["workspace_change", "terminal"].includes(approval.kind)) execution = await tools.executeApproved(approval);
        bus.publish(store.appendEvent(approval.taskId, "approval.resolved", {
          schemaVersion: 1, category: "approval", phase: "completed", turnId: `${approval.taskId}:approval`,
          title: request.body.decision === "approved" ? "审批已通过" : "审批已拒绝", approvalId: approval.id,
          decision: request.body.decision, feedbackToAgent: approval.kind === "command" || approval.kind === "file_change",
        }));
        return { approval, execution };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.get("/api/platform/status", async (request) => {
    identityService.require(identity(request), "viewer");
    return {
      worker: { concurrency: config.workerConcurrency, providerConcurrency: config.providerConcurrency, leaseMs: config.workerLeaseMs, activeByProvider: store.countActiveByProvider() },
      signals: store.listSignals().filter((signal) => scopedTask(request, signal.taskId)),
      deadLetters: store.listDeadLetters().filter((letter) => scopedTask(request, letter.taskId)),
      quota: store.getQuota(identity(request).tenantId),
      usage: store.usageSummary(identity(request).tenantId),
      storage: store.storageSummary(identity(request).tenantId),
    };
  });

  app.post<{ Params: { id: string } }>("/api/dead-letters/:id/replay", async (request, reply) => {
    identityService.require(identity(request), "member");
    const letter = store.listDeadLetters().find((item) => item.id === request.params.id);
    if (!letter || !scopedTask(request, letter.taskId)) return reply.code(404).send({ error: "Dead letter not found" });
    try {
      const replay = store.replayDeadLetter(letter.id);
      store.audit(identity(request), "dead_letter.replay", "dead_letter", letter.id, { taskId: letter.taskId });
      bus.publish(store.appendEvent(letter.taskId, "task.dead_letter.replayed", { schemaVersion: 1, category: "task", phase: "queued", turnId: `${letter.taskId}:replay`, title: "死信已人工重放", deadLetterId: letter.id }));
      return replay;
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/settings", async (request) => ({ settings: settings.get(identity(request).tenantId), data: settings.dataSummary() }));
  app.patch("/api/settings", async (request, reply) => {
    identityService.require(identity(request), "admin");
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid settings", issues: parsed.error.issues });
    const value = settings.update(identity(request).tenantId, parsed.data);
    const sandboxChanged = ["sandboxEnabled", "sandboxImage", "sandboxCpuLimit", "sandboxMemoryMb", "sandboxNetwork", "skillsExtraRoots", "mcpConfigPath"]
      .some((key) => key in parsed.data);
    if (sandboxChanged) await runner.sandboxManager.releaseIdleNow();
    if (parsed.data.skillsExtraRoots) {
      try { await codexControl.setSkillsExtraRoots(parsed.data.skillsExtraRoots, value.defaultProvider, identity(request).tenantId); }
      catch (error) { return reply.code(503).send({ error: `Settings saved, but Codex skills roots could not be applied: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    store.audit(identity(request), "settings.update", "settings", null, parsed.data);
    return { settings: value, restartRequired: false, idleSandboxesRecreated: sandboxChanged };
  });

  app.get("/api/audit", async (request) => {
    identityService.require(identity(request), "admin");
    return { entries: store.listAudit(identity(request)) };
  });

  app.post<{ Params: { key: string }; Body: { payload?: Record<string, unknown> } }>("/api/signals/:key/resolve", async (request, reply) => {
    const signal = store.getSignalByCorrelation(request.params.key);
    if (!signal || !scopedTask(request, signal.taskId)) return reply.code(404).send({ error: "Signal not found" });
    identityService.require(identity(request), "member");
    const resolved = store.resolveSignal(signal.id, request.body?.payload ?? {});
    store.audit(identity(request), "signal.resolve", "signal", signal.id, { correlationKey: signal.correlationKey });
    return { signal: resolved };
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    reply.code(message.startsWith("Forbidden:") ? 403 : 500).send({ error: message });
  });

  let closed = false;
  let automationBusy = false;
  const processDueAutomations = async () => {
    if (automationBusy || closed) return;
    automationBusy = true;
    try {
      for (const due of store.claimDueAutomations()) await launchAutomation(due.automation, due.scheduledFor);
    } finally { automationBusy = false; }
  };
  const automationTimer = setInterval(() => trackBackground(processDueAutomations()), dependencies.automationIntervalMs ?? 15_000);
  automationTimer.unref();
  trackBackground(processDueAutomations());
  runner.start();
  return {
    app,
    config,
    runner,
    store,
    terminalManager,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(automationTimer);
      await terminalManager.closeAll();
      await runner.stop();
      await app.close();
      await Promise.allSettled([...backgroundOperations]);
      store.close();
    },
  };
}
