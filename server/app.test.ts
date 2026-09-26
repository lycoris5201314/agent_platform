import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAgentApplication } from "./app.js";
import { loadConfig } from "./core/config.js";
import { TaskStore } from "./core/store.js";

test("P0 API closes the mock task, lazy tree, approval and PTY terminal loops", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-p0-e2e-"));
  const dataDir = path.join(directory, "data");
  const workspaceTarget = path.join(directory, "workspace-target");
  const workspacePath = path.join(directory, "workspace");
  mkdirSync(workspaceTarget);
  symlinkSync(workspaceTarget, workspacePath, process.platform === "win32" ? "junction" : "dir");
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
    // The Codex Windows sandbox cannot create another restricted token inside
    // an already-sandboxed test process. Packaged/installer smoke tests cover
    // the real ConPTY path from a normal desktop process.
    if (process.platform === "win32" && !process.env.CODEX_PERMISSION_PROFILE) {
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
      assert.equal(application.terminalManager.get(taskId, sessionId), null, "closed terminal sessions must be removed from memory");
    }
    // Exercise workspace browsing before starting another worker against the
    // same shared directory. This keeps the assertion deterministic on slower
    // GitHub-hosted Windows runners while delegation is tested independently
    // below.
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
    const delegated = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/children`, payload: { title: "child", prompt: "child work", isolation: "shared" } });
    assert.equal(delegated.statusCode, 201, delegated.body);
    assert.equal(delegated.json().task.parentTaskId, taskId);
    assert.match(String(delegated.json().task.checkpoint.delegationContext), /你是由 Agent Foundry 主任务显式委派的子 Agent/);
    assert.ok(application.store.listEvents(taskId).some((event) => event.type === "child-task.created"));
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
    const taskFacets = await application.app.inject({ method: "GET", url: "/api/tasks/facets" });
    assert.equal(taskFacets.statusCode, 200, taskFacets.body);
    assert.ok(taskFacets.json().facets.providers.some((facet: { value: string }) => facet.value === "openai"));
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streams task-list activity immediately without waiting for polling", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-activity-stream-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await application.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (application.app.server.address() as AddressInfo).port;
    const stream = await fetch(`http://127.0.0.1:${port}/api/task-activity/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "live activity", prompt: "run", runtime: "mock" }),
    });
    assert.equal(created.status, 201);
    const taskId = (await created.json() as { task: { id: string } }).task.id;
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !received.includes(taskId)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("activity stream timed out")), 5_000)),
      ]);
      if (result.done) break;
      received += decoder.decode(result.value, { stream: true });
    }
    assert.match(received, new RegExp(taskId));
    assert.match(received, /task\.created|task\.preparing|task\.running/);
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    else controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resumes a conversation event stream after Last-Event-ID without replaying older events", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-sse-resume-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "SSE resume", prompt: "run", runtime: "mock" } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const checkpoint = application.store.appendEvent(taskId, "test.resume.checkpoint");
    const expected = application.store.appendEvent(taskId, "test.resume.expected", { marker: "AFTER_CHECKPOINT" });
    await application.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (application.app.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/stream?after=0`, {
      headers: { "Last-Event-ID": String(checkpoint.id) },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !received.includes("\n\n")) {
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("conversation stream timed out")), 5_000)),
      ]);
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    assert.match(received, new RegExp(`id: ${expected.id}\\n`));
    assert.match(received, /AFTER_CHECKPOINT/);
    assert.doesNotMatch(received, new RegExp(`id: ${checkpoint.id}\\n`));
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists a terminal startup failure for later support diagnostics", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-terminal-diagnostic-"));
  const workspacePath = path.join(directory, "workspace");
  mkdirSync(workspacePath);
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  const previousCodexPath = process.env.CODEX_PATH;
  try {
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "terminal diagnostic", prompt: "run", runtime: "mock", workspacePath } });
    const taskId = created.json().task.id as string;
    process.env.CODEX_PATH = path.join(directory, "missing-codex.exe");
    const opened = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/terminal/sessions`, payload: { cols: 80, rows: 20 } });
    assert.equal(opened.statusCode, 400, opened.body);
    const diagnostic = application.store.listAllEvents(taskId).find((event) => event.type === "terminal.session.failed");
    assert.equal(diagnostic?.payload.title, "交互终端启动失败");
    assert.match(String(diagnostic?.payload.detail), /missing-codex|not found|ENOENT/i);
  } finally {
    if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = previousCodexPath;
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archived conversation deletion is explicit, scoped and reflected in storage totals", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-delete-api-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "delete me", prompt: "finish", runtime: "mock" } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && application.store.getTask(taskId)?.status !== "succeeded") await new Promise((resolve) => setTimeout(resolve, 100));
    const tooEarly = await application.app.inject({ method: "DELETE", url: `/api/tasks/${taskId}` });
    assert.equal(tooEarly.statusCode, 409);
    const archived = await application.app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, payload: { archived: true } });
    assert.equal(archived.statusCode, 200, archived.body);
    const before = await application.app.inject({ method: "GET", url: "/api/platform/status" });
    assert.equal(before.json().storage.archivedTasks, 1);
    const deleted = await application.app.inject({ method: "DELETE", url: `/api/tasks/${taskId}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().deleted.taskId, taskId);
    assert.equal(application.store.getTask(taskId), null);
    const after = await application.app.inject({ method: "GET", url: "/api/platform/status" });
    assert.equal(after.json().storage.archivedTasks, 0);
    assert.ok(application.store.listAudit({ tenantId: "local", userId: "local-user", role: "owner" }).some((entry) => entry.action === "task.delete" && entry.resourceId === taskId));
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graceful application shutdown pauses an active task without consuming its retry budget", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-graceful-shutdown-"));
  const dataDir = path.join(directory, "data");
  const workspacePath = path.join(directory, "workspace");
  const base = loadConfig();
  const config = { ...base, dataDir, defaultRuntime: "mock" as const, docker: { ...base.docker, enabled: false } };
  const application = await createAgentApplication(config);
  let closed = false;
  try {
    const created = await application.app.inject({
      method: "POST", url: "/api/tasks",
      payload: { title: "resume after exit", prompt: "keep working", runtime: "mock", workspacePath },
    });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const runningDeadline = Date.now() + 10_000;
    while (Date.now() < runningDeadline && !["running", "verifying"].includes(application.store.getTask(taskId)?.status ?? "")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const before = application.store.getTask(taskId);
    assert.ok(before && ["running", "verifying"].includes(before.status), JSON.stringify(before));
    await application.close();
    closed = true;

    const persisted = new TaskStore(dataDir);
    try {
      const paused = persisted.getTask(taskId);
      assert.equal(paused?.status, "queued");
      assert.equal(paused?.attempt, before.attempt);
      assert.equal(paused?.cancelRequested, false);
      assert.equal(paused?.checkpoint?.phase, "application_shutdown");
      assert.ok(persisted.listEvents(taskId).some((event) => event.type === "task.shutdown.queued"));
    } finally { persisted.close(); }

    const restarted = await createAgentApplication(config);
    try {
      const completionDeadline = Date.now() + 20_000;
      while (Date.now() < completionDeadline && restarted.store.getTask(taskId)?.status !== "succeeded") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const completed = restarted.store.getTask(taskId);
      assert.equal(completed?.status, "succeeded", JSON.stringify(completed));
      assert.equal(completed?.attempt, before.attempt);
    } finally { await restarted.close(); }
  } finally {
    if (!closed) await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates and verifies a consistent live SQLite backup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-live-backup-"));
  const dataDir = path.join(directory, "data");
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir, defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "backup me", prompt: "persist this", runtime: "mock" } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const response = await application.app.inject({ method: "POST", url: "/api/platform/backup" });
    assert.equal(response.statusCode, 201, response.body);
    const result = response.json().backup as { path: string; directory: string; bytes: number; integrity: string };
    assert.ok(existsSync(result.path));
    assert.ok(path.resolve(result.path).startsWith(path.resolve(dataDir, "backups") + path.sep));
    assert.ok(result.bytes > 0);
    assert.equal(result.integrity, "ok");
    const copy = new DatabaseSync(result.path, { readOnly: true });
    try {
      const row = copy.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as unknown as { title: string } | undefined;
      assert.equal(row?.title, "backup me");
      const health = copy.prepare("PRAGMA quick_check").get() as unknown as Record<string, unknown>;
      assert.equal(String(Object.values(health)[0]), "ok");
    } finally { copy.close(); }
    assert.ok(application.store.listAudit({ tenantId: "local", userId: "local-user", role: "owner" }).some((entry) => entry.action === "database.backup"));
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
