import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "../app.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./store.js";
import { reportedGoalTokenDelta } from "../workflow/task-runner.js";

test("persists bounded goal settings on a task", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-store-"));
  const store = new TaskStore(directory);
  try {
    const before = Date.now();
    const task = store.createTask({ title: "goal", prompt: "finish the project", goalMode: true, goalMaxTurns: 50, goalDeadlineHours: 4, goalTokenBudget: 250_000 }, { runtime: "mock", model: "mock" });
    assert.equal(task.goalStatus, "active");
    assert.equal(task.goalObjective, "finish the project");
    assert.equal(task.goalMaxTurns, 20);
    assert.equal(task.goalCompletedTurns, 0);
    assert.ok(task.goalDeadlineAt);
    assert.ok(Date.parse(task.goalDeadlineAt) >= before + 4 * 3_600_000);
    assert.equal(task.goalTokenBudget, 250_000);
    assert.equal(task.goalTokensUsed, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("lists persistent goals by tenant without mixing ordinary or archived tasks", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-list-"));
  const store = new TaskStore(directory);
  const owner = { tenantId: "tenant-a", userId: "owner", role: "owner" as const };
  try {
    const active = store.createTask({ title: "active", prompt: "continue", goalMode: true, tenantId: owner.tenantId, userId: owner.userId }, { runtime: "mock", model: "mock" });
    const archived = store.createTask({ title: "archived", prompt: "hidden", goalMode: true, tenantId: owner.tenantId, userId: owner.userId }, { runtime: "mock", model: "mock" });
    const ordinary = store.createTask({ title: "ordinary", prompt: "one turn", tenantId: owner.tenantId, userId: owner.userId }, { runtime: "mock", model: "mock" });
    store.createTask({ title: "other tenant", prompt: "private", goalMode: true, tenantId: "tenant-b", userId: "other" }, { runtime: "mock", model: "mock" });
    for (const task of [archived, ordinary]) {
      store.transition(task.id, "preparing"); store.transition(task.id, "running"); store.transition(task.id, "verifying"); store.transition(task.id, "succeeded");
    }
    store.setTaskArchived(archived.id, true);
    assert.deepEqual(store.listGoalsFor(owner).map((task) => task.id), [active.id]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("computes durable goal token deltas from per-turn, cumulative and reset usage", () => {
  assert.deepEqual(reportedGoalTokenDelta({ last: { totalTokens: 7_500 }, total: { totalTokens: 22_000 } }, 14_500), { delta: 7_500, cumulative: 22_000 });
  assert.deepEqual(reportedGoalTokenDelta({ total: { inputTokens: 18_000, outputTokens: 4_000 } }, 14_500), { delta: 7_500, cumulative: 22_000 });
  assert.deepEqual(reportedGoalTokenDelta({ total: { totalTokens: 3_000 } }, 22_000), { delta: 3_000, cumulative: 3_000 });
  assert.deepEqual(reportedGoalTokenDelta({ inputTokens: 800, outputTokens: 200 }, 3_000), { delta: 1_000, cumulative: 3_000 });
  assert.deepEqual(reportedGoalTokenDelta(undefined, 3_000), { delta: 0, cumulative: 3_000 });
});

test("expires a queued persistent goal after its durable deadline", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-deadline-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "deadline", prompt: "finish before cutoff", goalMode: true, goalDeadlineHours: 1 }, { runtime: "mock", model: "mock" });
    store.updateTask(task.id, { goalDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    assert.deepEqual(store.expireQueuedGoalDeadlines(), [task.id]);
    const expired = store.getTask(task.id)!;
    assert.equal(expired.status, "cancelled");
    assert.equal(expired.goalStatus, "deadline_reached");
    assert.deepEqual(store.expireQueuedGoalDeadlines(), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persistent goal automatically continues and stops after a verified completion report", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-api-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const workspacePath = path.join(directory, "workspace");
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: {
      title: "bounded goal", prompt: "complete two safe stages", runtime: "mock", provider: "openai",
      goalMode: true, goalMaxTurns: 5, goalDeadlineHours: 1, goalTokenBudget: 100_000, workspacePath, sandboxMode: "danger-full-access",
    } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && application.store.getTask(taskId)?.status !== "succeeded") await new Promise((resolve) => setTimeout(resolve, 50));
    const task = application.store.getTask(taskId)!;
    assert.equal(task.status, "succeeded", JSON.stringify({ error: task.error, events: application.store.listEvents(taskId).slice(-20) }, null, 2));
    assert.equal(task.goalStatus, "completed");
    assert.equal(task.goalCompletedTurns, 2);
    assert.equal(task.goalProgress, 100);
    assert.equal(task.goalTokensUsed, 12_000);
    assert.equal(task.goalTokenBudget, 100_000);
    assert.ok(task.goalDeadlineAt);
    const events = application.store.listEvents(taskId);
    assert.ok(events.some((event) => event.type === "goal.continuation.queued"));
    assert.ok(events.some((event) => event.type === "goal.completed"));
    const goalList = await application.app.inject({ method: "GET", url: "/api/goals?includeCompleted=true" });
    assert.equal(goalList.statusCode, 200, goalList.body);
    assert.ok(goalList.json().goals.some((goal: { id: string; goalStatus: string }) => goal.id === taskId && goal.goalStatus === "completed"));

    application.store.updateTask(taskId, { goalStatus: "deadline_reached", goalDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    const resumed = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/goal`, payload: { action: "resume", additionalHours: 2 } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().task.status, "queued");
    assert.equal(resumed.json().task.goalStatus, "active");
    assert.ok(Date.parse(resumed.json().task.goalDeadlineAt) > Date.now() + 100 * 60 * 1_000);
    const paused = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/goal`, payload: { action: "pause" } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().task.goalStatus, "paused");
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persistent goal stops automatic continuation at the provider-reported token budget", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-budget-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const created = await application.app.inject({ method: "POST", url: "/api/tasks", payload: {
      title: "Token 预算验收", prompt: "continue until the durable budget stops the goal", runtime: "mock", provider: "openai",
      goalMode: true, goalMaxTurns: 10, goalTokenBudget: 10_000, workspacePath: path.join(directory, "workspace"), sandboxMode: "danger-full-access",
    } });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const task = application.store.getTask(taskId);
      if (task?.status === "succeeded" && task.goalStatus !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const task = application.store.getTask(taskId)!;
    assert.equal(task.status, "succeeded");
    assert.equal(task.goalStatus, "budget_reached");
    assert.equal(task.goalCompletedTurns, 2);
    assert.equal(task.goalTokensUsed, 12_000);
    assert.ok(application.store.listEvents(taskId).some((event) => event.type === "goal.budget.reached"));

    const resumed = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/goal`, payload: { action: "resume", additionalTokens: 100_000 } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().task.goalStatus, "active");
    assert.equal(resumed.json().task.goalTokenBudget, 110_000);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});
