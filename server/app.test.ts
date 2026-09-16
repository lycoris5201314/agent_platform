import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "./app.js";
import { loadConfig } from "./core/config.js";

test("P0 API closes the mock task, lazy tree, approval and PTY terminal loops", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-p0-e2e-"));
  const dataDir = path.join(directory, "data");
  const workspacePath = path.join(directory, "workspace");
  const base = loadConfig();
    const application = await createAgentApplication({ ...base, dataDir, defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const preflight = await application.app.inject({
      method: "OPTIONS", url: "/api/tasks/example", headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "PATCH" },
    });
    assert.equal(preflight.statusCode, 204, preflight.body);
    assert.match(String(preflight.headers["access-control-allow-methods"]), /PATCH/);
    assert.match(String(preflight.headers["access-control-allow-methods"]), /PUT/);
    const created = await application.app.inject({
      method: "POST", url: "/api/tasks",
      payload: { title: "P0 E2E", prompt: "run", runtime: "mock", workspacePath },
    });
    assert.equal(created.statusCode, 201);
    const taskId = created.json().task.id as string;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && application.store.getTask(taskId)?.status !== "succeeded") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completedTask = application.store.getTask(taskId);
    assert.equal(completedTask?.status, "succeeded", JSON.stringify({ error: completedTask?.error, events: application.store.listEvents(taskId).slice(-12) }, null, 2));
    if (process.platform === "win32") {
      const openedTerminal = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/terminal/sessions`, payload: { cols: 80, rows: 20 } });
      assert.equal(openedTerminal.statusCode, 201, openedTerminal.body);
      const sessionId = openedTerminal.json().session.id as string;
      assert.equal(openedTerminal.json().session.permissionProfile, ":workspace");
      await new Promise((resolve) => setTimeout(resolve, 600));
      const input = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/terminal/sessions/${sessionId}/input`, payload: { data: "Write-Output 'API_CONPTY_OK'\r" } });
      assert.equal(input.statusCode, 202, input.body);
      const outputDeadline = Date.now() + 5_000;
      while (Date.now() < outputDeadline && !application.terminalManager.get(taskId, sessionId)?.output.includes("API_CONPTY_OK")) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(application.terminalManager.get(taskId, sessionId)?.output ?? "", /API_CONPTY_OK/);
      const closedTerminal = await application.app.inject({ method: "DELETE", url: `/api/tasks/${taskId}/terminal/sessions/${sessionId}` });
      assert.equal(closedTerminal.statusCode, 202);
    }
    const delegated = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/children`, payload: { title: "child", prompt: "child work", isolation: "shared" } });
    assert.equal(delegated.statusCode, 201, delegated.body);
    assert.equal(delegated.json().task.parentTaskId, taskId);
    assert.match(String(delegated.json().task.checkpoint.delegationContext), /你是由 Agent Foundry 主任务显式委派的子 Agent/);
    assert.ok(application.store.listEvents(taskId).some((event) => event.type === "child-task.created"));
    writeFileSync(path.join(workspacePath, "p0.txt"), "p0\n");
    const tree = await application.app.inject({ method: "GET", url: `/api/tasks/${taskId}/workspace/tree?path=` });
    assert.equal(tree.statusCode, 200);
    assert.ok(tree.json().entries.some((entry: { path: string }) => entry.path === "p0.txt"));

    const change = await application.app.inject({
      method: "POST", url: `/api/tasks/${taskId}/workspace/changes`, payload: { operation: "stage", path: "p0.txt" },
    });
    assert.equal(change.statusCode, 202);
    const changeDecision = await application.app.inject({
      method: "POST", url: `/api/approvals/${change.json().approval.id}/decision`, payload: { decision: "approved" },
    });
    assert.equal(changeDecision.statusCode, 200);
    assert.equal(changeDecision.json().execution.exitCode, 0);

    const terminal = await application.app.inject({
      method: "POST", url: `/api/tasks/${taskId}/terminal`, payload: { command: "printf p0-terminal" },
    });
    assert.equal(terminal.statusCode, 202);
    const terminalDecision = await application.app.inject({
      method: "POST", url: `/api/approvals/${terminal.json().approval.id}/decision`, payload: { decision: "approved" },
    });
    assert.equal(terminalDecision.statusCode, 200);
    assert.match(terminalDecision.json().execution.output, /p0-terminal/);
    const nextWorkspace = path.join(directory, "next-workspace");
    mkdirSync(nextWorkspace);
    const switched = await application.app.inject({ method: "PUT", url: `/api/tasks/${taskId}/workspace/current`, payload: { path: nextWorkspace } });
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.json().task.workspacePath, nextWorkspace);
    assert.equal(switched.json().root.kind, "primary");
    assert.ok(switched.json().workspaceRoots.some((root: { path: string; kind: string }) => root.path === workspacePath && root.kind === "additional"));
    const initializedGit = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/workspace/git/initialize` });
    assert.equal(initializedGit.statusCode, 201, initializedGit.body);
    assert.match(initializedGit.json().commit, /^[0-9a-f]{40,64}$/i);
    const attachmentPath = path.join(directory, "attachment.txt"); writeFileSync(attachmentPath, "attached");
    const followUp = await application.app.inject({
      method: "POST", url: `/api/tasks/${taskId}/messages`,
      payload: { content: "read it", attachments: [attachmentPath], model: "mock-adjusted", reasoningEffort: "high", sandboxMode: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "auto_review" },
    });
    assert.equal(followUp.statusCode, 202, followUp.body);
    assert.match(followUp.json().message.content, /attachments/);
    assert.equal(followUp.json().task.model, "mock-adjusted");
    assert.equal(followUp.json().task.reasoningEffort, "high");
    assert.equal(followUp.json().task.sandboxMode, "read-only");
    assert.equal(followUp.json().task.approvalPolicy, "untrusted");
    assert.equal(followUp.json().task.approvalsReviewer, "auto_review");
    const models = await application.app.inject({ method: "GET", url: "/api/models" });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.json().models, []);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
