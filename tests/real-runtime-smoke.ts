import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentApplication } from "../server/app.js";
import { loadConfig } from "../server/core/config.js";
import { TaskStore } from "../server/core/store.js";
import { SecretVault } from "../server/security/secret-vault.js";

for (const envPath of [path.resolve("release/agent.env"), path.resolve("agent.env")]) {
  if (!process.env.DEEPSEEK_API_KEY && existsSync(envPath)) process.loadEnvFile(envPath);
}
const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-real-runtime-"));
const config = { ...loadConfig(), dataDir: path.join(directory, "data"), defaultRuntime: "codex" as const };
let provider = process.env.DEEPSEEK_API_KEY ? "deepseek" as const : "openai" as const;
if (!process.env.DEEPSEEK_API_KEY && process.platform === "win32") {
  const liveStore = new TaskStore(path.join(process.env.APPDATA ?? "", "agent-foundry-local", "data"));
  try {
    const key = new SecretVault(liveStore).get("local", "deepseek");
    if (key) { config.providers.deepseek.apiKey = key; provider = "deepseek"; }
  } finally { liveStore.close(); }
}
const workspace = path.join(directory, "workspace");
mkdirSync(workspace, { recursive: true });
execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
execFileSync("git", ["-c", "user.name=Agent Foundry Smoke", "-c", "user.email=smoke@localhost", "commit", "--allow-empty", "-m", "smoke baseline", "--quiet"], { cwd: workspace, windowsHide: true });
const application = await createAgentApplication(config);
try {
  const response = await application.app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      title: "Real runtime smoke",
      prompt: "这是运行时连通性和轮次产物测试。请在工作区创建 result.txt，内容为 P0_RUNTIME_OK，然后回复 P0_RUNTIME_OK。",
      runtime: "codex",
      provider,
      reasoningEffort: "medium",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      workspacePath: workspace,
    },
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  const taskId = response.json().task.id as string;
  const deadline = Date.now() + 180_000;
  let status = "queued";
  while (Date.now() < deadline) {
    const task = application.store.getTask(taskId);
    status = task?.status ?? "missing";
    if (["succeeded", "failed", "cancelled", "waiting_approval"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const task = application.store.getTask(taskId);
  if (task?.status !== "succeeded" || !task.result?.includes("P0_RUNTIME_OK")) {
    throw new Error(`Real runtime smoke failed (${task?.status}): ${task?.error ?? task?.result ?? "timeout"}`);
  }
  const events = application.store.listEvents(taskId);
  if (!events.some((event) => event.type === "agent.turn.started") || !events.some((event) => event.type === "agent.turn.completed")) {
    throw new Error("Real runtime completed without normalized turn events");
  }
  const turnSummary = events.find((event) => event.type === "turn.workspace.summary");
  if (!turnSummary || !Array.isArray(turnSummary.payload.changes) || !turnSummary.payload.changes.some((change) => String((change as Record<string, unknown>).path) === "result.txt")) {
    throw new Error("Real runtime completed without a turn-scoped workspace summary for result.txt");
  }
  const child = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/children`, payload: { title: "Real delegated child", prompt: "直接回复 CHILD_OK，不要调用工具，不要修改文件。", isolation: "worktree" } });
  if (child.statusCode !== 201) throw new Error(`Real child delegation failed: ${child.body}`);
  const childId = child.json().task.id as string;
  const childDeadline = Date.now() + 180_000;
  while (Date.now() < childDeadline && !["succeeded", "failed", "cancelled", "waiting_approval"].includes(application.store.getTask(childId)?.status ?? "missing")) await new Promise((resolve) => setTimeout(resolve, 500));
  const completedChild = application.store.getTask(childId);
  if (completedChild?.status !== "succeeded") throw new Error(`Real delegated child did not succeed (${completedChild?.status ?? "missing"}): ${completedChild?.error ?? "no error detail"}`);
  if (!completedChild.result?.includes("CHILD_OK")) throw new Error(`Real delegated child lost its assignment: ${completedChild.result ?? "no result"}`);
  if (completedChild.checkpoint?.isolation !== "worktree" || !completedChild.checkpoint?.branch) throw new Error("Real delegated child did not use an isolated Git worktree");
  if (!String(completedChild.checkpoint?.delegationContext ?? "").includes("你是由 Agent Foundry 主任务显式委派的子 Agent")) throw new Error("Real delegated child did not receive its identity and parent handoff context");

  const fork = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/fork`, payload: {} });
  if (fork.statusCode !== 201 || fork.json().task.threadId === task.threadId) throw new Error(`Real thread fork failed: ${fork.body}`);

  const review = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/review`, payload: { instructions: "只检查 result.txt 是否包含 P0_RUNTIME_OK，并用一句话报告。" } });
  if (review.statusCode !== 200 || !review.json().result.completed) throw new Error(`Real review failed: ${review.body}`);

  const archived = await application.app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, payload: { archived: true } });
  if (archived.statusCode !== 200 || !archived.json().task.archivedAt) throw new Error(`Real archive failed: ${archived.body}`);
  const restored = await application.app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, payload: { archived: false } });
  if (restored.statusCode !== 200 || restored.json().task.archivedAt) throw new Error(`Real unarchive failed: ${restored.body}`);

  const compact = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compact`, payload: {} });
  if (compact.statusCode !== 200 || !compact.json().result.completed) throw new Error(`Real compact failed: ${compact.body}`);
  if (usageTokens(compact.json().after) > usageTokens(compact.json().before)) throw new Error(`Compact increased reported context usage: ${compact.body}`);
  if (provider === "deepseek" && compact.json().localFallback && application.store.getTask(taskId)?.threadId !== null) throw new Error(`DeepSeek local compact did not detach the unsupported remote thread: ${compact.body}`);
  console.log(`Real ${provider} feature smoke passed: runtime, delegate, fork, review, compact, archive (${events.length} durable events)`);
} finally {
  await application.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break; }
    catch (error) { if (attempt === 4) console.warn(`Smoke cleanup deferred: ${error instanceof Error ? error.message : String(error)}`); else await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const usage = value as Record<string, unknown>;
  const total = usage.total && typeof usage.total === "object" && !Array.isArray(usage.total) ? usage.total as Record<string, unknown> : {};
  return Number(total.totalTokens ?? usage.totalTokens ?? 0);
}
