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

test("enforces persistent goal dependencies in storage and scheduler order", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-dependency-"));
  const store = new TaskStore(directory);
  const owner = { tenantId: "tenant-a", userId: "owner", role: "owner" as const };
  try {
    store.ensureMembership(owner);
    const dependent = store.createTask({ title: "下游目标", prompt: "wait for upstream", goalMode: true, tenantId: owner.tenantId, userId: owner.userId, priority: 100 }, { runtime: "mock", model: "mock" });
    const prerequisite = store.createTask({ title: "前置目标", prompt: "finish first", goalMode: true, tenantId: owner.tenantId, userId: owner.userId, priority: 1 }, { runtime: "mock", model: "mock" });

    const dependency = store.addTaskDependency(dependent.id, prerequisite.id, owner);
    assert.equal(dependency.satisfied, false);
    assert.equal(store.listTaskDependenciesFor([dependent.id])[dependent.id]?.[0]?.title, "前置目标");
    assert.equal(store.claimNextTask("worker-a")?.id, prerequisite.id, "blocked high-priority goal must not be claimed");
    store.transition(prerequisite.id, "running");
    store.transition(prerequisite.id, "verifying");
    store.transition(prerequisite.id, "succeeded", { goalStatus: "completed", finishedAt: new Date().toISOString() });
    assert.equal(store.listTaskDependencies(dependent.id)[0]?.satisfied, true);
    store.setTaskArchived(prerequisite.id, true);
    assert.throws(() => store.deleteArchivedTaskFor(prerequisite.id, owner), /仍被其他持续目标依赖/);
    store.setTaskArchived(prerequisite.id, false);
    assert.equal(store.claimNextTask("worker-b")?.id, dependent.id, "dependent goal unlocks after terminal completion");

    const first = store.createTask({ title: "cycle-a", prompt: "a", goalMode: true, tenantId: owner.tenantId, userId: owner.userId }, { runtime: "mock", model: "mock" });
    const second = store.createTask({ title: "cycle-b", prompt: "b", goalMode: true, tenantId: owner.tenantId, userId: owner.userId }, { runtime: "mock", model: "mock" });
    store.addTaskDependency(first.id, second.id, owner);
    assert.throws(() => store.addTaskDependency(second.id, first.id, owner), /循环/);

    const outsider = store.createTask({ title: "other tenant", prompt: "private", goalMode: true, tenantId: "tenant-b", userId: "other" }, { runtime: "mock", model: "mock" });
    assert.throws(() => store.addTaskDependency(first.id, outsider.id, owner), /不属于当前租户/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("does not allow dependency changes during an active goal turn", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-dependency-active-"));
  const store = new TaskStore(directory);
  const owner = { tenantId: "local", userId: "owner", role: "owner" as const };
  try {
    store.ensureMembership(owner);
    const running = store.createTask({ title: "running", prompt: "work", goalMode: true }, { runtime: "mock", model: "mock" });
    const prerequisite = store.createTask({ title: "prerequisite", prompt: "first", goalMode: true }, { runtime: "mock", model: "mock" });
    store.transition(running.id, "preparing");
    store.transition(running.id, "running");
    assert.throws(() => store.addTaskDependency(running.id, prerequisite.id, owner), /仍在执行/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("exposes tenant-scoped goal dependencies through the API", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-dependency-api-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } });
  try {
    const taskDefaults = { tenantId: "local", userId: "local-user", goalMode: true } as const;
    const dependent = application.store.createTask({ ...taskDefaults, title: "api dependent", prompt: "later" }, { runtime: "mock", model: "mock" });
    const prerequisite = application.store.createTask({ ...taskDefaults, title: "api prerequisite", prompt: "first" }, { runtime: "mock", model: "mock" });
    application.store.updateTask(dependent.id, { status: "succeeded", goalStatus: "paused", finishedAt: new Date().toISOString() });
    application.store.updateTask(prerequisite.id, { status: "succeeded", goalStatus: "paused", finishedAt: new Date().toISOString() });

    const added = await application.app.inject({ method: "POST", url: `/api/tasks/${dependent.id}/dependencies`, payload: { dependsOnTaskId: prerequisite.id } });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().dependency.dependsOnTaskId, prerequisite.id);
    const listed = await application.app.inject({ method: "GET", url: "/api/goals?includeCompleted=true" });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().dependencies[dependent.id][0].title, "api prerequisite");
    assert.ok(application.store.listEvents(dependent.id).some((event) => event.type === "goal.dependency.added"));

    const removed = await application.app.inject({ method: "DELETE", url: `/api/tasks/${dependent.id}/dependencies/${prerequisite.id}` });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.deepEqual(application.store.listTaskDependencies(dependent.id), []);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
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
