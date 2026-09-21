import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "../app.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./store.js";

test("persists bounded goal settings on a task", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-goal-store-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "goal", prompt: "finish the project", goalMode: true, goalMaxTurns: 50 }, { runtime: "mock", model: "mock" });
    assert.equal(task.goalStatus, "active");
    assert.equal(task.goalObjective, "finish the project");
    assert.equal(task.goalMaxTurns, 20);
    assert.equal(task.goalCompletedTurns, 0);
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
      goalMode: true, goalMaxTurns: 5, workspacePath, sandboxMode: "danger-full-access",
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
    const events = application.store.listEvents(taskId);
    assert.ok(events.some((event) => event.type === "goal.continuation.queued"));
    assert.ok(events.some((event) => event.type === "goal.completed"));

    const resumed = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/goal`, payload: { action: "resume" } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().task.status, "queued");
    const paused = await application.app.inject({ method: "POST", url: `/api/tasks/${taskId}/goal`, payload: { action: "pause" } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().task.goalStatus, "paused");
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});
