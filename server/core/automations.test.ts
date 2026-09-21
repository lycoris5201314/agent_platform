import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "../app.js";
import { computeNextAutomationRun } from "./automation-schedule.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./store.js";

test("computes interval, daily and weekly automation schedules", () => {
  const from = new Date(2026, 8, 21, 10, 30, 0, 0);
  assert.equal(new Date(computeNextAutomationRun({ scheduleKind: "interval", intervalMinutes: 30 }, from)!).getTime(), from.getTime() + 30 * 60_000);
  const daily = new Date(computeNextAutomationRun({ scheduleKind: "daily", timeOfDay: "09:15" }, from)!);
  assert.equal(daily.getDate(), from.getDate() + 1);
  assert.equal(`${String(daily.getHours()).padStart(2, "0")}:${String(daily.getMinutes()).padStart(2, "0")}`, "09:15");
  const weekly = new Date(computeNextAutomationRun({ scheduleKind: "weekly", timeOfDay: "11:00", weekdays: [from.getDay()] }, from)!);
  assert.equal(weekly.getTime() - from.getTime(), 30 * 60_000);
  assert.throws(() => computeNextAutomationRun({ scheduleKind: "interval", intervalMinutes: 1 }, from), /between 15 minutes/);
});

test("persists, claims and records automation runs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-automations-"));
  const store = new TaskStore(directory);
  try {
    const created = store.createAutomation({
      tenantId: "local", userId: "local-user", name: "daily report", prompt: "summarize",
      runtime: "mock", provider: "openai", model: "mock", sandboxMode: "workspace-write",
      approvalPolicy: "on-request", approvalsReviewer: "user", scheduleKind: "interval", intervalMinutes: 15,
    });
    assert.equal(created.status, "active");
    assert.ok(created.nextRunAt);
    const due = store.claimDueAutomations(new Date(new Date(created.nextRunAt!).getTime() + 1));
    assert.equal(due.length, 1);
    assert.equal(due[0].automation.id, created.id);
    assert.ok(due[0].automation.nextRunAt && due[0].automation.nextRunAt > created.nextRunAt!);
    const task = store.createTask({ title: created.name, prompt: created.prompt, runtime: "mock" }, { runtime: "mock", model: "mock" });
    store.recordAutomationRun(created.id, due[0].scheduledFor, task.id);
    assert.equal(store.listAutomationRuns(created.id)[0].taskId, task.id);
    assert.equal(store.updateAutomation(created.id, { status: "paused" }).nextRunAt, null);
    assert.equal(store.deleteAutomation(created.id), true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("automation API creates a durable definition and can run it now", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-automation-api-"));
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } }, { automationIntervalMs: 25 });
  try {
    const onceAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await application.app.inject({ method: "POST", url: "/api/automations", payload: {
      name: "automation smoke", prompt: "run once", runtime: "mock", provider: "openai", model: "mock",
      reasoningEffort: "medium", sandboxMode: "workspace-write", approvalPolicy: "on-request",
      approvalsReviewer: "user", scheduleKind: "once", onceAt,
    } });
    assert.equal(created.statusCode, 201, created.body);
    const automationId = created.json().automation.id as string;
    const run = await application.app.inject({ method: "POST", url: `/api/automations/${automationId}/run` });
    assert.equal(run.statusCode, 202, run.body);
    const taskId = run.json().task.id as string;
    assert.equal(application.store.listAutomationRuns(automationId)[0].taskId, taskId);
    const paused = await application.app.inject({ method: "PATCH", url: `/api/automations/${automationId}`, payload: { status: "paused" } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().automation.nextRunAt, null);
    const listed = await application.app.inject({ method: "GET", url: "/api/automations" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().automations.length, 1);
    assert.equal(listed.json().runs.length, 1);

    const scheduled = await application.app.inject({ method: "POST", url: "/api/automations", payload: {
      name: "background schedule", prompt: "wake after restart", runtime: "mock", provider: "openai", model: "mock",
      sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
      scheduleKind: "once", onceAt: new Date(Date.now() + 3_600_000).toISOString(),
    } });
    const scheduledId = scheduled.json().automation.id as string;
    application.store.db.prepare("UPDATE task_automations SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), scheduledId);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && application.store.listAutomationRuns(scheduledId).length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    const scheduledRuns = application.store.listAutomationRuns(scheduledId);
    assert.equal(scheduledRuns.length, 1, "background scheduler did not create a durable run");
    assert.ok(scheduledRuns[0].taskId);
    assert.equal(application.store.getAutomation(scheduledId)?.status, "paused");
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});
