import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../core/config.js";
import { TaskStore } from "../core/store.js";
import type { AgentTask, CreateTaskInput } from "../core/types.js";
import { createWorkspaceHandle, runInWorkspace, workspaceRuntimePath } from "../workspace/wsl-workspace.js";

export class MultiAgentService {
  constructor(private readonly store: TaskStore, private readonly config: AppConfig) {}

  async createChild(parent: AgentTask, input: Pick<CreateTaskInput, "title" | "prompt" | "runtime" | "provider" | "model" | "priority"> & { isolation?: "worktree" | "shared" }): Promise<AgentTask> {
    if (!parent.workspacePath) throw new Error("Parent task has no workspace");
    let workspacePath = parent.workspacePath;
    let branch: string | null = null;
    let worktreeCommit: string | null = null;
    const parentWorkspace = createWorkspaceHandle(parent.workspacePath, this.config.workspaceMode, this.config.wslDistro);
    if ((input.isolation ?? "worktree") === "worktree") {
      const probe = await runInWorkspace(parentWorkspace, "git", ["rev-parse", "--verify", "HEAD"], 10_000);
      if (probe.code !== 0) throw new Error("独立 Git worktree 需要当前工作区是 Git 仓库，并且至少有一次提交。你可以创建初始 Git 提交后重试，或改用共享工作区。");
      const childId = crypto.randomUUID();
      branch = `agent-foundry/${childId.slice(0, 12)}`;
      workspacePath = path.join(this.config.dataDir, "worktrees", childId);
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      const created = await runInWorkspace(parentWorkspace, "git", ["worktree", "add", "-b", branch, workspaceRuntimePath(parentWorkspace, workspacePath)], 60_000);
      if (created.code !== 0) throw new Error(`Unable to create child worktree: ${created.stderr || created.stdout}`);
      if (this.config.docker.enabled) {
        worktreeCommit = probe.stdout.trim();
        await fs.rm(workspacePath, { recursive: true, force: true });
        await fs.mkdir(workspacePath, { recursive: true });
        // The child workspace is mounted into Docker without the parent repo. A
        // shared clone would leave objects/info/alternates pointing outside the
        // mount, so materialize a self-contained object database instead.
        const childWorkspace = createWorkspaceHandle(workspacePath, this.config.workspaceMode, this.config.wslDistro);
        const cloned = await runInWorkspace(childWorkspace, "git", ["clone", "--no-hardlinks", "--no-checkout", workspaceRuntimePath(childWorkspace, parent.workspacePath), "."], 60_000);
        if (cloned.code !== 0) throw new Error(`Unable to materialize Docker child workspace: ${cloned.stderr || cloned.stdout}`);
        const checkedOut = await runInWorkspace(childWorkspace, "git", ["checkout", "-b", branch, worktreeCommit], 60_000);
        if (checkedOut.code !== 0) throw new Error(`Unable to checkout Docker child branch: ${checkedOut.stderr || checkedOut.stdout}`);
      }
    }
    const parentMemory = this.store.getConversationMemory(parent.id);
    const delegationContext = [
      "<subagent_context>",
      "你是由 Agent Foundry 主任务显式委派的子 Agent。只完成下面的子任务，不要把自己当作主 Agent。",
      `主任务 ID：${parent.id}`,
      `主任务标题：${parent.title}`,
      "下面是主任务的持久化会话摘要；它是经过裁剪的交接上下文，不等同于复制完整主对话：",
      parentMemory.summary.slice(-12_000) || "（主任务暂无可交接的对话摘要）",
      "完成后请清楚汇报结果、产物和仍需主 Agent 决定的问题。",
      "</subagent_context>",
    ].join("\n");
    const child = this.store.createTask({
      ...input, workspacePath, parentTaskId: parent.id, tenantId: parent.tenantId, userId: parent.userId,
      runtime: input.runtime ?? parent.runtime, provider: input.provider ?? parent.provider, model: input.model ?? parent.model ?? undefined,
      reasoningEffort: parent.reasoningEffort ?? undefined, sandboxMode: parent.sandboxMode,
      approvalPolicy: parent.approvalPolicy, approvalsReviewer: parent.approvalsReviewer,
    }, { runtime: parent.runtime, model: input.model ?? parent.model ?? "" });
    this.store.updateTask(child.id, { checkpoint: { phase: "child_task", parentTaskId: parent.id, baseWorkspace: parent.workspacePath, branch, isolation: input.isolation ?? "worktree", worktreeCommit, delegationContext } });
    this.store.createSignal(parent.id, "child_task", `child:${child.id}`, { childTaskId: child.id, state: "running", branch });
    return this.store.getTask(child.id)!;
  }

  resolveChild(child: AgentTask): void {
    if (!child.parentTaskId) return;
    const signal = this.store.getSignalByCorrelation(`child:${child.id}`);
    if (signal?.state === "pending") this.store.resolveSignal(signal.id, { childTaskId: child.id, state: child.status, result: child.result, error: child.error });
  }

  async mergeChild(parent: AgentTask, child: AgentTask): Promise<{ code: number; output: string; conflicts: string[] }> {
    if (child.parentTaskId !== parent.id) throw new Error("Task is not a child of this parent");
    if (child.status !== "succeeded") throw new Error("Only a succeeded child task can be merged");
    const branch = typeof child.checkpoint?.branch === "string" ? child.checkpoint.branch : null;
    if (!branch) throw new Error("Child task does not use an isolated worktree branch");
    const workspace = createWorkspaceHandle(parent.workspacePath!, this.config.workspaceMode, this.config.wslDistro);
    const result = await runInWorkspace(workspace, "git", ["merge", "--no-ff", "--no-edit", branch], 120_000);
    const conflicts = result.code === 0 ? [] : (await runInWorkspace(workspace, "git", ["diff", "--name-only", "--diff-filter=U"], 20_000)).stdout.split(/\r?\n/).filter(Boolean);
    if (result.code !== 0) await runInWorkspace(workspace, "git", ["merge", "--abort"], 30_000);
    return { code: result.code, output: `${result.stdout}\n${result.stderr}`.trim(), conflicts };
  }
}
