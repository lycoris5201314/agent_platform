import path from "node:path";
import type { AppConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { TaskStore } from "./store.js";
import type { Approval, ApprovalInput } from "./types.js";
import { runInWorkspace, runInWorkspacePty, toWslPath } from "../workspace/wsl-workspace.js";
import { spawn } from "node:child_process";
import type { ApprovalNotifier } from "./approval-notifier.js";

export class ToolGateway {
  constructor(private readonly store: TaskStore, private readonly bus: EventBus, private readonly config: AppConfig, private readonly notifier?: ApprovalNotifier) {}

  requestWorkspaceChange(taskId: string, operation: "stage" | "unstage" | "discard" | "stage_patch", filePath: string, patchText?: string): Approval {
    const task = this.requireWorkspace(taskId);
    const safePath = validateRelativePath(filePath);
    const details: Record<typeof operation, { title: string; description: string; risk: ApprovalInput["risk"] }> = {
      stage: { title: "暂存文件变更", description: `将 ${safePath} 加入 Git 暂存区`, risk: "medium" },
      unstage: { title: "取消暂存文件", description: `将 ${safePath} 移出 Git 暂存区，不丢失内容`, risk: "medium" },
      discard: { title: "丢弃文件变更", description: `永久丢弃 ${safePath} 的未提交内容`, risk: "high" },
      stage_patch: { title: "部分暂存文件变更", description: `只暂存 ${safePath} 中选定的补丁`, risk: "medium" },
    };
    const info = details[operation];
    const approval = this.store.createApproval({
      taskId, ...info, kind: "workspace_change", cwd: task.workspacePath, path: safePath,
      scope: operation === "stage_patch" ? "仅选定补丁" : "仅此文件", request: { action: "workspace_change", operation, path: safePath, patch: patchText },
    });
    this.publish(taskId, "approval.requested", { category: "approval", phase: "waiting", title: info.title, approvalId: approval.id, risk: info.risk, path: safePath, scope: "仅此文件" });
    void this.notifier?.notify(approval);
    return approval;
  }

  requestTerminal(taskId: string, command: string): Approval {
    const task = this.requireWorkspace(taskId);
    const normalized = command.trim();
    if (!normalized || normalized.length > 2_000 || normalized.includes("\u0000")) throw new Error("终端命令无效或过长");
    const risk = classifyTerminalRisk(normalized);
    const approval = this.store.createApproval({
      taskId, title: "终端命令需要审批", description: normalized, kind: "terminal", risk,
      command: normalized, cwd: task.workspacePath, scope: `单次${this.store.getSandbox(taskId)?.kind === "docker" ? " Docker" : " WSL2"} PTY 命令`,
      networkHost: extractHost(normalized), request: { action: "terminal", command: normalized },
    });
    this.publish(taskId, "approval.requested", { category: "approval", phase: "waiting", title: approval.title, approvalId: approval.id, risk, command: normalized, cwd: task.workspacePath, networkHost: approval.networkHost, scope: approval.scope });
    void this.notifier?.notify(approval);
    return approval;
  }

  requestChildMerge(parentTaskId: string, childTaskId: string, branch: string): Approval {
    const parent = this.requireWorkspace(parentTaskId);
    const approval = this.store.createApproval({
      taskId: parentTaskId, title: "合并子 Agent 结果", description: `将子任务 ${childTaskId} 的分支 ${branch} 合并到主工作区`,
      kind: "workspace_change", risk: "high", cwd: parent.workspacePath, scope: "单次子任务合并",
      request: { action: "child_merge", childTaskId, branch },
    });
    this.publish(parentTaskId, "approval.requested", { category: "approval", phase: "waiting", title: approval.title, approvalId: approval.id, risk: approval.risk, scope: approval.scope });
    void this.notifier?.notify(approval);
    return approval;
  }

  async executeApproved(approval: Approval): Promise<Record<string, unknown> | null> {
    if (approval.status !== "approved") return null;
    const task = this.requireWorkspace(approval.taskId);
    const action = String(approval.request.action ?? "");
    const sandbox = this.store.getSandbox(task.id);
    const workspace = {
      windowsPath: task.workspacePath!, wslPath: toWslPath(task.workspacePath!), distro: this.config.wslDistro,
      runtimePath: sandbox?.kind === "docker" ? sandbox.guestPath : undefined,
      containerId: sandbox?.kind === "docker" && sandbox.state !== "released" ? sandbox.containerId ?? undefined : undefined,
    };
    if (action === "workspace_change") {
      const operation = String(approval.request.operation);
      const filePath = validateRelativePath(String(approval.request.path));
      const args = operation === "stage" ? ["add", "--", filePath]
        : operation === "unstage" ? ["restore", "--staged", "--", filePath]
          : ["restore", "--staged", "--worktree", "--", filePath];
      this.publish(task.id, "workspace.change.started", { category: "workspace", phase: "started", title: approval.title, toolCallId: approval.id, path: filePath });
      const started = Date.now();
      let result = operation === "stage_patch"
        ? await runPatch(workspace, String(approval.request.patch ?? ""))
        : await runInWorkspace(workspace, "git", args, 30_000);
      if (operation === "discard" && result.code !== 0) {
        const untracked = await runInWorkspace(workspace, "git", ["ls-files", "--others", "--exclude-standard", "--", filePath], 10_000);
        if (untracked.stdout.split(/\r?\n/).some((entry) => entry.trim() === filePath)) {
          const clean = await runInWorkspace(workspace, "git", ["clean", "-f", "--", filePath], 30_000);
          if (clean.code === 0) result = clean;
        }
      }
      const payload = { category: "workspace", phase: result.code === 0 ? "completed" : "failed", title: approval.title, toolCallId: approval.id, path: filePath, exitCode: result.code, durationMs: Date.now() - started, output: `${result.stdout}\n${result.stderr}`.trim() };
      this.publish(task.id, "workspace.change.completed", payload);
      if (result.code !== 0) throw new Error(payload.output || "Git 操作失败");
      return payload;
    }
    if (action === "terminal") {
      const command = String(approval.request.command ?? approval.command ?? "");
      this.publish(task.id, "terminal.command.started", { category: "terminal", phase: "started", title: "PTY 命令执行中", toolCallId: approval.id, command, cwd: task.workspacePath });
      const started = Date.now();
      const result = await runInWorkspacePty(workspace, command, 180_000);
      const output = `${result.stdout}\n${result.stderr}`.replaceAll("\u0000", "").trim();
      const payload = { category: "terminal", phase: result.code === 0 ? "completed" : "failed", title: "PTY 命令执行完成", toolCallId: approval.id, command, cwd: task.workspacePath, exitCode: result.code, durationMs: Date.now() - started, output };
      this.publish(task.id, "terminal.command.completed", payload);
      return payload;
    }
    return null;
  }

  private publish(taskId: string, type: string, payload: Record<string, unknown>): void {
    const task = this.store.getTask(taskId);
    this.bus.publish(this.store.appendEvent(taskId, type, { schemaVersion: 1, turnId: `${taskId}:review:${task?.attempt ?? 0}`, ...payload }));
  }

  private requireWorkspace(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (!task.workspacePath) throw new Error("Task has no workspace");
    return task;
  }
}

function validateRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error("路径必须位于任务工作区内");
  return normalized;
}

function classifyTerminalRisk(command: string): ApprovalInput["risk"] {
  if (/\b(rm|rmdir|del|format|shutdown|reboot|git\s+push|npm\s+publish|curl|wget|ssh|scp)\b/i.test(command)) return "high";
  return /[>|;&]|\b(git\s+(add|restore|reset|commit)|npm\s+(install|run)|pip\s+install)\b/i.test(command) ? "medium" : "low";
}

function extractHost(command: string): string | null {
  const match = command.match(/https?:\/\/([^/\s]+)/i);
  return match?.[1] ?? null;
}

function runPatch(workspace: { windowsPath: string; wslPath: string; distro: string; runtimePath?: string; containerId?: string }, patchText: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!patchText.trim()) return reject(new Error("Partial staging patch is empty"));
    const inDocker = Boolean(workspace.containerId);
    const executable = inDocker ? (process.env.DOCKER_PATH ?? "docker") : "wsl.exe";
    const args = inDocker
      ? ["exec", "-i", "-w", workspace.runtimePath ?? "/workspace", workspace.containerId!, "git", "apply", "--cached", "--recount", "-"]
      : ["-d", workspace.distro, "--cd", workspace.wslPath, "--", "git", "apply", "--cached", "--recount", "-"];
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(patchText);
  });
}
