import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTask } from "../core/types.js";
import { WorkspaceManager, runInWorkspace, runInWorkspaceEnv, runInWorkspacePty } from "./wsl-workspace.js";

function task(workspacePath: string): AgentTask {
  return {
    id: crypto.randomUUID(), tenantId: "local", userId: "test", title: "native", prompt: "test",
    status: "queued", runtime: "mock", provider: "openai", model: "mock", reasoningEffort: null,
    sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
    workspacePath, projectWorkspacePath: workspacePath, threadId: null, result: null, error: null, checkpoint: null, waitSeconds: 0,
    nextWakeupAt: null, cancelRequested: false, attempt: 0, priority: 0, maxAttempts: 1,
    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null,
    parentTaskId: null, rootTaskId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, archivedAt: null, pinnedAt: null, section: null,
    goalStatus: "inactive", goalObjective: null, goalMaxTurns: 0, goalCompletedTurns: 0,
    goalProgress: 0, goalLastSummary: null, goalNextStep: null,
  };
}

test("prepares and executes a workspace directly on Windows without WSL2", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-foundry-native-"));
  try {
    const manager = new WorkspaceManager(path.join(root, "generated"), "native", "");
    const workspace = await manager.prepare(task(path.join(root, "workspace")));
    assert.equal(workspace.kind, "native");
    assert.equal(workspace.runtimePath, workspace.windowsPath);
    assert.ok(existsSync(path.join(workspace.windowsPath, ".git")));

    const git = await runInWorkspace(workspace, "git", ["rev-parse", "--is-inside-work-tree"]);
    assert.equal(git.code, 0, git.stderr);
    assert.equal(git.stdout.trim(), "true");

    const environment = await runInWorkspaceEnv(workspace, { AGENT_FOUNDRY_NATIVE_TEST: "ready" }, process.execPath, ["-e", "process.stdout.write(process.env.AGENT_FOUNDRY_NATIVE_TEST || '')"]);
    assert.equal(environment.code, 0, environment.stderr);
    assert.equal(environment.stdout, "ready");

    const outputPath = path.join(workspace.windowsPath, "native-shell.txt");
    const shell = process.platform === "win32"
      ? await runInWorkspacePty(workspace, "Set-Content -LiteralPath 'native-shell.txt' -Value 'windows-ready' -NoNewline")
      : await runInWorkspacePty(workspace, "printf windows-ready > native-shell.txt");
    assert.equal(shell.code, 0, shell.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "windows-ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
