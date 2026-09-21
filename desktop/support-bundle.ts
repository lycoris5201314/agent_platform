import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../server/core/config.js";
import type { TaskStore } from "../server/core/store.js";

const sensitiveKeyPattern = /(?:api.?key|access.?token|auth.?token|secret|password|authorization|cookie)/i;

export interface SupportBundleResult {
  directory: string;
  generatedAt: string;
  taskCount: number;
}

export function redactSupportValue(value: unknown, key = ""): unknown {
  if (sensitiveKeyPattern.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-API-KEY]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, "Bearer [REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSupportValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactSupportValue(item, name)]));
  }
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(redactSupportValue(value), null, 2)}\n`, "utf8");
}

function exportLogs(sourceDirectory: string, targetDirectory: string, prefix: string): string[] {
  if (!fs.existsSync(sourceDirectory)) return [];
  fs.mkdirSync(targetDirectory, { recursive: true });
  const copied: string[] = [];
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(sourceDirectory, entry.name);
    const stat = fs.statSync(source);
    if (stat.size > 5 * 1024 * 1024) continue;
    const targetName = `${prefix}-${entry.name.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`;
    const target = path.join(targetDirectory, targetName);
    const content = fs.readFileSync(source, "utf8");
    fs.writeFileSync(target, String(redactSupportValue(content)), "utf8");
    copied.push(targetName);
  }
  return copied;
}

export function writeSupportBundle(options: {
  dataDir: string;
  userDataDir: string;
  appVersion: string;
  config: AppConfig;
  store: TaskStore;
}): SupportBundleResult {
  const generatedAt = new Date().toISOString();
  const directory = path.join(options.dataDir, "问题反馈资料");
  const tasksDirectory = path.join(directory, "conversations");
  const logsDirectory = path.join(directory, "logs");
  fs.mkdirSync(tasksDirectory, { recursive: true });
  fs.mkdirSync(logsDirectory, { recursive: true });

  const identity = { tenantId: "local", userId: "local-user", role: "owner" as const };
  const tasks = [
    ...options.store.listTasksFor(identity, 10_000, false),
    ...options.store.listTasksFor(identity, 10_000, true),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const approvals = options.store.listApprovals();
  const automations = options.store.listAutomationsFor(identity);

  for (const task of tasks) {
    writeJson(path.join(tasksDirectory, `${task.id}.json`), {
      task,
      messages: options.store.listMessages(task.id, 100_000),
      memory: options.store.getConversationMemory(task.id),
      events: options.store.listAllEvents(task.id),
      approvals: approvals.filter((approval) => approval.taskId === task.id),
      artifacts: options.store.listArtifacts(task.id).map(({ id, kind, path: artifactPath, mimeType, size, createdAt }) => ({ id, kind, path: artifactPath, mimeType, size, createdAt })),
      sandbox: options.store.getSandbox(task.id),
      workspaceRoots: options.store.listWorkspaceRoots(task.id),
      signals: options.store.listSignals(task.id),
    });
  }
  writeJson(path.join(directory, "automations.json"), automations.map((automation) => ({
    ...automation, runs: options.store.listAutomationRuns(automation.id, 100),
  })));

  const providerSummary = Object.values(options.config.providers).map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: Boolean(provider.apiKey),
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    codexCompatible: provider.codexCompatible,
    capabilities: provider.capabilities,
  }));
  writeJson(path.join(directory, "system.json"), {
    generatedAt,
    appVersion: options.appVersion,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    locale: Intl.DateTimeFormat().resolvedOptions(),
    dataDir: options.dataDir,
    workspaceMode: options.config.workspaceMode,
    sandboxMode: options.config.sandboxMode,
    docker: options.config.docker,
    scheduler: { workerConcurrency: options.config.workerConcurrency, providerConcurrency: options.config.providerConcurrency, workerLeaseMs: options.config.workerLeaseMs },
    providers: providerSummary,
    proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY),
  });

  const logs = [
    ...exportLogs(path.join(options.dataDir, "logs"), logsDirectory, "data"),
    ...exportLogs(path.join(options.userDataDir, "logs"), logsDirectory, "desktop"),
  ];
  writeJson(path.join(directory, "manifest.json"), {
    generatedAt,
    taskCount: tasks.length,
    activeTaskCount: tasks.filter((task) => !task.archivedAt).length,
    archivedTaskCount: tasks.filter((task) => Boolean(task.archivedAt)).length,
    automationCount: automations.length,
    conversationFiles: tasks.map((task) => `conversations/${task.id}.json`),
    logs,
    excluded: ["API Key 明文", "agent.env", "SQLite 数据库", "附件正文", "工作区文件正文"],
  });
  fs.writeFileSync(path.join(directory, "请先阅读.txt"), [
    "Agent Foundry 问题反馈资料",
    "",
    "此目录用于复现问题，包含全部本机对话消息、任务状态、关键与底层事件、审批记录、运行环境摘要和脱敏日志。",
    "API Key、agent.env、SQLite 数据库、附件正文和工作区文件正文不会复制到这里；常见 Token 形式还会再次脱敏。",
    "",
    "对话内容和本机路径仍可能包含隐私。发送给开发者前请自行检查 conversations 与 logs 目录。",
    "需要最新资料时，请在 Agent Foundry 的“设置与运行时”中再次点击“生成并打开问题反馈资料”。",
  ].join("\r\n"), "utf8");

  return { directory, generatedAt, taskCount: tasks.length };
}
