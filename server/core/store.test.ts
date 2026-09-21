import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "./store.js";

test("persists conversation turns and reuses thread/workspace state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-store-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({
      title: "持续会话",
      prompt: "第一轮问题",
      provider: "openai",
    }, { runtime: "mock", model: "mock" });
    store.updateTask(task.id, { workspacePath: "C:\\workspace", threadId: "thread-1" });
    store.transition(task.id, "preparing");
    store.transition(task.id, "running");
    store.appendMessage(task.id, "assistant", "第一轮回答");
    store.transition(task.id, "verifying");
    store.transition(task.id, "succeeded");

    const continued = store.continueConversation(task.id, "请继续第二轮");
    assert.equal(continued.task.status, "queued");
    assert.equal(continued.task.prompt, "请继续第二轮");
    assert.equal(continued.task.threadId, "thread-1");
    assert.equal(continued.task.workspacePath, "C:\\workspace");

    const messages = store.listMessages(task.id);
    assert.deepEqual(messages.map((message) => [message.turn, message.role, message.content]), [
      [0, "user", "第一轮问题"],
      [0, "assistant", "第一轮回答"],
      [1, "user", "请继续第二轮"],
    ]);
    const memory = store.getConversationMemory(task.id);
    assert.equal(memory.messageCount, 3);
    assert.match(memory.summary, /第一轮回答/);
    assert.match(memory.summary, /请继续第二轮/);
    assert.equal(store.renameTask(task.id, "新标题").title, "新标题");
    assert.throws(() => store.setTaskArchived(continued.task.id, true), /cannot be archived/);
    store.transition(task.id, "preparing");
    store.transition(task.id, "running");
    store.appendMessage(task.id, "assistant", "第二轮回答");
    store.transition(task.id, "verifying");
    store.transition(task.id, "succeeded");
    assert.ok(store.setTaskArchived(task.id, true).archivedAt);
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listTasks(100, true).length, 1);
    assert.equal(store.setTaskArchived(task.id, false).archivedAt, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps forward event streaming separate from the bounded recent detail window", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-event-window-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "long event history", prompt: "start" }, { runtime: "mock", model: "mock" });
    for (let index = 0; index < 1_205; index += 1) store.appendEvent(task.id, "agent.progress", { index });

    const firstPage = store.listEvents(task.id);
    const secondPage = store.listEvents(task.id, firstPage.at(-1)!.id);
    const recent = store.listRecentEvents(task.id, 800);

    assert.equal(firstPage.length, 1_000);
    assert.equal((firstPage[0].payload.index), 0);
    assert.equal(secondPage.length, 205);
    assert.equal(secondPage[0].payload.index, 1_000);
    assert.equal(recent.length, 800);
    assert.equal(recent[0].payload.index, 405);
    assert.equal(recent.at(-1)!.payload.index, 1_204);
    assert.equal(store.countEvents(task.id), 1_205);
    assert.equal(store.listAllEvents(task.id).length, 1_205);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("loads conversation messages by recent turn without losing the total history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-turn-window-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "long conversation", prompt: "user 0" }, { runtime: "mock", model: "mock" });
    store.appendMessage(task.id, "assistant", "assistant 0", 0);
    for (let turn = 1; turn < 75; turn += 1) {
      store.appendMessage(task.id, "user", `user ${turn}`, turn);
      store.appendMessage(task.id, "assistant", `assistant ${turn}`, turn);
    }

    const recent = store.listRecentTurnMessages(task.id, 30);
    assert.equal(store.countConversationTurns(task.id), 75);
    assert.equal(recent.length, 60);
    assert.equal(recent[0].turn, 45);
    assert.equal(recent.at(-1)!.turn, 74);
    assert.equal(store.listRecentTurnMessages(task.id, 60)[0].turn, 15);
    assert.equal(store.listRecentTurnMessages(task.id, 1).length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persists per-conversation model, reasoning and permission settings", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-turn-settings-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "settings", prompt: "first", model: "model-a", reasoningEffort: "low", sandboxMode: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "user" }, { runtime: "mock", model: "mock" });
    assert.equal(task.sandboxMode, "read-only");
    store.transition(task.id, "preparing"); store.transition(task.id, "running"); store.transition(task.id, "verifying"); store.transition(task.id, "succeeded");
    const next = store.continueConversation(task.id, "second", { model: "model-b", reasoningEffort: "high", sandboxMode: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "auto_review" }).task;
    assert.equal(next.model, "model-b"); assert.equal(next.reasoningEffort, "high"); assert.equal(next.sandboxMode, "danger-full-access");
    assert.equal(next.approvalPolicy, "never"); assert.equal(next.approvalsReviewer, "auto_review");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("paginates and searches the complete tenant task history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-task-query-"));
  const store = new TaskStore(directory);
  try {
    const identity = { tenantId: "history-tenant", userId: "owner", role: "owner" as const };
    for (let index = 0; index < 25; index += 1) {
      store.createTask({
        title: index === 24 ? "独有的旧对话" : `普通对话 ${index}`,
        prompt: index === 23 ? "搜索正文中的特殊线索" : "普通内容",
        tenantId: identity.tenantId,
        userId: identity.userId,
      }, { runtime: "mock", model: "mock" });
    }
    const firstPage = store.queryTasksFor(identity, { limit: 20 });
    assert.equal(firstPage.tasks.length, 20);
    assert.equal(firstPage.total, 25);
    assert.deepEqual(store.queryTasksFor(identity, { query: "独有的旧对话" }).tasks.map((task) => task.title), ["独有的旧对话"]);
    assert.deepEqual(store.queryTasksFor(identity, { query: "特殊线索" }).tasks.map((task) => task.prompt), ["搜索正文中的特殊线索"]);
    assert.equal(store.queryTasksFor(identity, { query: "%" }).total, 0, "LIKE wildcards must be treated as literal search text");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("retracts the latest turn before editing and rebuilds conversation memory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-edit-last-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "手滑消息", prompt: "错误的第一条消息" }, { runtime: "mock", model: "mock" });
    store.appendEvent(task.id, "task.running", { turnId: `${task.id}:turn:0` });
    store.appendMessage(task.id, "assistant", "不应保留的回答");
    store.updateTask(task.id, { status: "succeeded", result: "不应保留的回答", finishedAt: new Date().toISOString() });

    const retracted = store.retractLatestTurn(task.id);
    assert.equal(retracted.content, "错误的第一条消息");
    assert.deepEqual(store.listMessages(task.id), []);
    assert.equal(store.listEvents(task.id).length, 0);
    assert.equal(store.getConversationMemory(task.id).messageCount, 0);
    assert.equal(store.getTask(task.id)?.status, "cancelled");

    const resent = store.continueConversation(task.id, "修改后的第一条消息");
    assert.equal(resent.task.status, "queued");
    assert.equal(resent.task.title, "修改后的第一条消息");
    assert.deepEqual(store.listMessages(task.id).map((message) => message.content), ["修改后的第一条消息"]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("forks a completed conversation in the same project without injecting a fake user instruction", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-fork-"));
  const store = new TaskStore(directory);
  try {
    const source = store.createTask({ title: "source", prompt: "真实用户问题", workspacePath: "C:\\projects\\alpha" }, { runtime: "mock", model: "mock" });
    store.appendMessage(source.id, "assistant", "第一轮答复");
    store.updateTask(source.id, { status: "succeeded", result: "第一轮答复", threadId: "source-thread", finishedAt: new Date().toISOString() });
    const branch = store.forkConversation(source.id, "source（分支）", "forked-thread");
    assert.equal(branch.status, "succeeded");
    assert.equal(branch.threadId, "forked-thread");
    assert.equal(branch.rootTaskId, source.id);
    assert.equal(branch.projectWorkspacePath, source.workspacePath);
    assert.deepEqual(store.listMessages(branch.id).map((message) => message.content), ["真实用户问题", "第一轮答复"]);
    assert.equal(store.listMessages(branch.id).some((message) => message.content.includes("继续此分支对话")), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("repairs project grouping for branches created by older releases", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-fork-migration-"));
  let store = new TaskStore(directory);
  try {
    const source = store.createTask({ title: "source", prompt: "work", workspacePath: "E:\\projects\\legacy" }, { runtime: "mock", model: "mock" });
    store.updateTask(source.id, { status: "succeeded", result: "done", threadId: "source-thread", finishedAt: new Date().toISOString() });
    const branch = store.forkConversation(source.id, "source（分支）", "forked-thread");
    store.db.prepare("UPDATE tasks SET root_task_id = ? WHERE id = ?").run(branch.id, branch.id);
    store.db.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    store.close();

    store = new TaskStore(directory);
    const repaired = store.getTask(branch.id);
    assert.equal(repaired?.rootTaskId, source.id);
    assert.equal(repaired?.projectWorkspacePath, source.workspacePath);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolates memory and Codex threads between new conversations", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-memory-isolation-"));
  const store = new TaskStore(directory);
  try {
    const sharedWorkspace = "C:\\workspace\\shared";
    const first = store.createTask({
      title: "对话一", prompt: "记住：项目暗号是海星", workspacePath: sharedWorkspace,
    }, { runtime: "mock", model: "mock" });
    store.appendMessage(first.id, "assistant", "我记住了海星");
    store.updateTask(first.id, { threadId: "thread-first" });

    const second = store.createTask({
      title: "对话二", prompt: "项目暗号是什么？", workspacePath: sharedWorkspace,
    }, { runtime: "mock", model: "mock" });

    assert.equal(second.threadId, null);
    assert.ok(store.searchMemory(first.id, "海星").some((entry) => entry.content.includes("海星")));
    assert.equal(store.searchMemory(second.id, "海星").some((entry) => entry.content.includes("海星")), false);
    assert.equal(store.listMemory(second.id).every((entry) => entry.taskId === second.id), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists rich approvals, artifacts and sandbox lifecycle", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-p0-store-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "P0", prompt: "test" }, { runtime: "mock", model: "mock" });
    const approval = store.createApproval({
      taskId: task.id, title: "命令审批", description: "运行测试", kind: "command", risk: "medium",
      command: "npm test", cwd: "C:\\workspace", scope: "single", request: { rpcId: 7 },
    });
    assert.equal(store.getApproval(approval.id)?.command, "npm test");
    assert.equal(store.resolveApproval(approval.id, "rejected").status, "rejected");
    const artifact = store.createArtifact(task.id, "log", "x".repeat(70_000));
    assert.equal(store.getArtifact(artifact.id)?.size, 70_000);
    const event = store.appendEvent(task.id, "tool.output", { output: "y".repeat(70_000) });
    assert.equal(event.payload.truncated, true);
    assert.equal(typeof event.payload.artifactRef, "string");
    const sandbox = store.upsertSandbox(task.id, {
      kind: "wsl2", state: "active", windowsPath: "C:\\workspace", guestPath: "/mnt/c/workspace", networkPolicy: "runtime-denied",
    });
    assert.equal(sandbox.state, "active");
    assert.equal(store.getSandbox(task.id)?.guestPath, "/mnt/c/workspace");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("switches the primary workspace while retaining the previous root", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-workspace-switch-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "workspace", prompt: "test", workspacePath: "C:\\old" }, { runtime: "mock", model: "mock" });
    const primary = store.setPrimaryWorkspaceRoot(task.id, "D:\\new", "new");
    assert.equal(primary.kind, "primary");
    assert.equal(primary.path, "D:\\new");
    assert.equal(store.getTask(task.id)?.workspacePath, "D:\\new");
    assert.equal(store.listWorkspaceRoots(task.id).find((root) => root.path === "C:\\old")?.kind, "additional");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("supports priority leases, durable signals, retries and dead letters", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-p1-store-"));
  const store = new TaskStore(directory);
  try {
    const low = store.createTask({ title: "low", prompt: "low", priority: 0 }, { runtime: "mock", model: "mock" });
    const high = store.createTask({ title: "high", prompt: "high", priority: 50, maxAttempts: 2 }, { runtime: "mock", model: "mock" });
    const claimed = store.claimNextTask("worker-a", 30_000);
    assert.equal(claimed?.id, high.id);
    assert.equal(claimed?.leaseOwner, "worker-a");
    assert.equal(store.heartbeat(high.id, "worker-a", 30_000), true);
    const signal = store.createSignal(high.id, "webhook", "hook:one", { expected: true });
    assert.equal(store.createSignal(high.id, "webhook", "hook:one").id, signal.id);
    assert.equal(store.resolveSignal(signal.id, { received: true }).state, "resolved");
    assert.equal(store.consumeSignal(signal.id).state, "consumed");
    store.transition(high.id, "running");
    const retrying = store.scheduleRetry(high.id, "temporary");
    assert.equal(retrying.status, "waiting_retry");
    store.db.prepare("UPDATE tasks SET next_attempt_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), high.id);
    store.wakeDueTasks();
    assert.equal(store.getTask(high.id)?.status, "queued");
    const secondClaim = store.claimNextTask("worker-b", 30_000);
    assert.equal(secondClaim?.id, high.id);
    store.transition(high.id, "running");
    assert.equal(store.scheduleRetry(high.id, "permanent").status, "failed");
    assert.equal(store.listDeadLetters().length, 1);
    assert.equal(store.getTask(low.id)?.status, "queued");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("enforces tenant row isolation and records audit entries", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-p2-store-"));
  const store = new TaskStore(directory);
  try {
    const ownerA = { tenantId: "tenant-a", userId: "alice", role: "owner" as const };
    const ownerB = { tenantId: "tenant-b", userId: "bob", role: "owner" as const };
    store.ensureMembership(ownerA);
    store.ensureMembership(ownerB);
    const task = store.createTask({ title: "private", prompt: "secret", tenantId: ownerA.tenantId, userId: ownerA.userId }, { runtime: "mock", model: "mock" });
    assert.equal(store.getTaskFor(task.id, ownerA)?.id, task.id);
    assert.equal(store.getTaskFor(task.id, ownerB), null);
    store.audit(ownerA, "task.create", "task", task.id);
    assert.equal(store.listAudit(ownerA).length, 1);
    assert.equal(store.listAudit(ownerB).length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("imports attachments with quota checks and summarizes usage", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-artifact-"));
  const store = new TaskStore(path.join(directory, "data"));
  try {
    const identity = { tenantId: "tenant-files", userId: "owner", role: "owner" as const };
    store.ensureMembership(identity);
    const task = store.createTask({ title: "files", prompt: "inspect", tenantId: identity.tenantId, userId: identity.userId }, { runtime: "mock", model: "mock" });
    const source = path.join(directory, "input.txt"); writeFileSync(source, "attachment");
    assert.equal(store.importAttachment(task.id, source).kind, "attachment");
    assert.equal(store.listArtifacts(task.id).length, 1);
    store.appendEvent(task.id, "agent.turn.usage", { usage: { inputTokens: 7, outputTokens: 3 } });
    assert.deepEqual(store.usageSummary(identity.tenantId), { inputTokens: 7, outputTokens: 3 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("stops restart recovery at max attempts and dead-letters the task", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-recovery-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "recover", prompt: "run", maxAttempts: 1 }, { runtime: "mock", model: "mock" });
    store.transition(task.id, "preparing");
    assert.deepEqual(store.recoverInterruptedTasks(), []);
    assert.equal(store.getTask(task.id)?.status, "failed");
    assert.equal(store.listDeadLetters().length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("replays a dead letter once and resets the user retry budget", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-replay-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "replay", prompt: "run" }, { runtime: "mock", model: "mock" });
    store.transition(task.id, "preparing");
    store.transition(task.id, "running");
    store.updateTask(task.id, { attempt: task.maxAttempts - 1 });
    store.scheduleRetry(task.id, "terminal failure");
    const letter = store.listDeadLetters().find((item) => item.taskId === task.id);
    assert.ok(letter);
    const replay = store.replayDeadLetter(letter.id);
    assert.equal(replay.task.status, "queued");
    assert.equal(replay.task.attempt, 0);
    assert.ok(replay.letter.replayedAt);
    assert.throws(() => store.replayDeadLetter(letter.id), /already been replayed/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
