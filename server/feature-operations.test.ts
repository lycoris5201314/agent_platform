import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "./app.js";
import { loadConfig } from "./core/config.js";
import type { ProviderId } from "./core/types.js";
import type { CodexControlTransport, CompactThreadResult, ReviewThreadResult } from "./runtime/codex-control.js";

class FakeCodexControl implements CodexControlTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  compactResult: CompactThreadResult = { before: { total: { totalTokens: 80_000 }, modelContextWindow: 258_400 }, after: { total: { totalTokens: 12_000 }, modelContextWindow: 258_400 }, completed: true, error: null };

  async request(method: string, params: Record<string, unknown> = {}, provider?: ProviderId): Promise<Record<string, unknown>> {
    void provider;
    this.calls.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "forked-thread" } };
    if (method === "review/start") return { reviewThreadId: String(params.threadId), turn: { id: "review-turn", status: "inProgress" } };
    return {};
  }

  async compactThread(): Promise<CompactThreadResult> { return this.compactResult; }
  async reviewThread(threadId: string): Promise<ReviewThreadResult> { this.calls.push({ method: "review/start", params: { threadId } }); return { reviewThreadId: threadId, turnId: "review-turn", completed: true, summary: "reviewed", error: null }; }
  async catalog(): Promise<Record<string, unknown>> { return {}; }
  async reloadMcp(): Promise<Record<string, unknown>> { return {}; }
  async setSkillsExtraRoots(): Promise<Record<string, unknown>> { return {}; }
}

test("real feature routes synchronize fork, compact, review and archive instead of only changing local UI state", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-feature-ops-"));
  const base = loadConfig();
  const control = new FakeCodexControl();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } }, { codexControl: control });
  try {
    const source = application.store.createTask({ title: "source", prompt: "work", runtime: "codex", provider: "deepseek", workspacePath: path.join(directory, "workspace") }, { runtime: "codex", model: "deepseek-v4-flash" });
    application.store.updateTask(source.id, { status: "succeeded", threadId: "source-thread", result: "done", finishedAt: new Date().toISOString() });
    application.store.appendMessage(source.id, "assistant", "done");

    const fork = await application.app.inject({ method: "POST", url: `/api/tasks/${source.id}/fork`, payload: {} });
    assert.equal(fork.statusCode, 201, fork.body);
    assert.equal(fork.json().task.threadId, "forked-thread");
    assert.equal(application.store.listMessages(fork.json().task.id).some((message) => message.content.includes("继续此分支")), false);

    const retracted = await application.app.inject({ method: "POST", url: `/api/tasks/${source.id}/messages/last/retract` });
    assert.equal(retracted.statusCode, 200, retracted.body);
    assert.equal(retracted.json().message.content, "work");
    assert.equal(retracted.json().threadContext, "rolled_back");
    assert.deepEqual(application.store.listMessages(source.id), []);
    assert.ok(control.calls.some((call) => call.method === "thread/rollback" && call.params.numTurns === 1));

    const compact = await application.app.inject({ method: "POST", url: `/api/tasks/${source.id}/compact`, payload: {} });
    assert.equal(compact.statusCode, 200, compact.body);
    assert.equal(compact.json().result.completed, true);
    assert.ok(application.store.listEvents(source.id).some((event) => event.type === "context.compaction.completed"));

    const review = await application.app.inject({ method: "POST", url: `/api/tasks/${source.id}/review`, payload: {} });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(review.json().result.turnId, "review-turn");
    assert.ok(application.store.listEvents(source.id).some((event) => event.type === "review.completed"));

    const archived = await application.app.inject({ method: "PATCH", url: `/api/tasks/${source.id}`, payload: { archived: true } });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.ok(archived.json().task.archivedAt);
    const restored = await application.app.inject({ method: "PATCH", url: `/api/tasks/${source.id}`, payload: { archived: false } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().task.archivedAt, null);
    assert.deepEqual(control.calls.filter((call) => ["thread/fork", "review/start", "thread/archive", "thread/unarchive"].includes(call.method)).map((call) => call.method), ["thread/fork", "review/start", "thread/archive", "thread/unarchive"]);

    control.compactResult = { before: { total: { totalTokens: 220_000 }, modelContextWindow: 258_400 }, after: null, completed: false, error: "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed gpt-5.5." };
    const localCompact = await application.app.inject({ method: "POST", url: `/api/tasks/${source.id}/compact`, payload: {} });
    assert.equal(localCompact.statusCode, 200, localCompact.body);
    assert.equal(localCompact.json().localFallback, true);
    assert.equal(application.store.getTask(source.id)?.threadId, null);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed Codex compaction is reported, while local archive remains usable when background sync fails", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-feature-failure-"));
  const base = loadConfig();
  const control = new FakeCodexControl();
  control.compactResult = { before: null, after: null, completed: false, error: "remote compaction failed" };
  const originalRequest = control.request.bind(control);
  control.request = async (method, params = {}, provider) => {
    if (method === "thread/archive") throw new Error("archive transport failed");
    return originalRequest(method, params, provider);
  };
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } }, { codexControl: control });
  try {
    const task = application.store.createTask({ title: "source", prompt: "work", runtime: "codex", provider: "openai", workspacePath: path.join(directory, "workspace") }, { runtime: "codex", model: "gpt-5.2-codex" });
    application.store.updateTask(task.id, { status: "succeeded", threadId: "source-thread", result: "done", finishedAt: new Date().toISOString() });
    const compact = await application.app.inject({ method: "POST", url: `/api/tasks/${task.id}/compact`, payload: {} });
    assert.equal(compact.statusCode, 409, compact.body);
    assert.ok(application.store.listEvents(task.id).some((event) => event.type === "context.compaction.failed"));
    assert.equal(application.store.listEvents(task.id).some((event) => event.type === "context.compaction.completed"), false);
    const archive = await application.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { archived: true } });
    assert.equal(archive.statusCode, 200, archive.body);
    assert.ok(application.store.getTask(task.id)?.archivedAt);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !application.store.listEvents(task.id).some((event) => event.type === "task.archive.sync.failed")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(application.store.listEvents(task.id).some((event) => event.type === "task.archive.sync.failed"));
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("editing the latest message falls back to local memory when thread rollback is unavailable", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-edit-fallback-"));
  const base = loadConfig();
  const control = new FakeCodexControl();
  control.request = async (method) => {
    if (method === "thread/rollback") throw new Error("rollback is unavailable");
    return {};
  };
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } }, { codexControl: control });
  try {
    const task = application.store.createTask({ title: "edit", prompt: "mistake", runtime: "codex", provider: "openai", workspacePath: path.join(directory, "workspace") }, { runtime: "codex", model: "gpt-5.2-codex" });
    application.store.updateTask(task.id, { status: "succeeded", threadId: "source-thread", result: "done", finishedAt: new Date().toISOString() });
    application.store.appendMessage(task.id, "assistant", "done");
    const retracted = await application.app.inject({ method: "POST", url: `/api/tasks/${task.id}/messages/last/retract` });
    assert.equal(retracted.statusCode, 200, retracted.body);
    assert.equal(retracted.json().threadContext, "detached");
    assert.equal(application.store.getTask(task.id)?.threadId, null);
    assert.deepEqual(application.store.listMessages(task.id), []);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
