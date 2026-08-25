import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "./store.js";
import { decodeGitPath, isUserVisibleWorkspacePath, workspaceSummaryFields } from "./workspace-summary.js";

test("decodes non-ASCII Git paths and excludes transient workspace files", () => {
  const name = "资料.md";
  const quoted = `"${[...Buffer.from(name)].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("")}"`;
  assert.equal(decodeGitPath(quoted), name);
  assert.equal(isUserVisibleWorkspacePath("tmp/lesson/preview/page.png"), false);
  assert.equal(isUserVisibleWorkspacePath("app/node_modules/library/index.js"), false);
  assert.equal(isUserVisibleWorkspacePath(name), true);
});

test("keeps durable summary metadata when a workspace event is compacted", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-workspace-summary-"));
  const store = new TaskStore(directory);
  try {
    const task = store.createTask({ title: "summary", prompt: "test" }, { runtime: "mock", model: "mock" });
    const changes = [
      ...Array.from({ length: 1_941 }, (_, index) => ({ status: "A", path: `tmp/lesson/node_modules/pkg-${index}/index.js`, additions: 100, deletions: 0 })),
      { status: "A", path: "lesson.pdf", additions: null, deletions: null },
      { status: "A", path: "guide.md", additions: 42, deletions: 0 },
    ];
    const event = store.appendEvent(task.id, "turn.workspace.summary", {
      schemaVersion: 1, category: "workspace", phase: "completed", turnId: `${task.id}:turn:0`,
      changes, additions: 194_142, deletions: 0, outputs: changes.map((change) => change.path), diff: "x".repeat(70_000),
    });
    assert.equal(event.payload.truncated, true);
    assert.equal(event.payload.changeCount, 2);
    assert.equal(event.payload.additions, 42);
    assert.deepEqual(event.payload.outputs, ["lesson.pdf", "guide.md"]);
    assert.deepEqual((event.payload.changes as Array<{ path: string }>).map((change) => change.path), ["lesson.pdf", "guide.md"]);

    const artifactRef = String(event.payload.artifactRef);
    store.db.prepare("UPDATE task_events SET payload_json = ? WHERE id = ?").run(JSON.stringify({
      schemaVersion: 1, category: "workspace", phase: "completed", turnId: `${task.id}:turn:0`, artifactRef, truncated: true,
    }), event.id);
    const recovered = store.listEvents(task.id).find((candidate) => candidate.id === event.id)!;
    assert.equal(recovered.payload.summaryRecovered, true);
    assert.equal(recovered.payload.changeCount, 2);
    assert.deepEqual(recovered.payload.outputs, ["lesson.pdf", "guide.md"]);
    assert.equal(store.listEvents(task.id).find((candidate) => candidate.id === event.id)?.payload.changeCount, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("caps visible rows without losing the total count", () => {
  const changes = Array.from({ length: 250 }, (_, index) => ({ status: "M", path: `src/file-${index}.ts`, additions: 1, deletions: 1 }));
  const summary = workspaceSummaryFields({ changes }, 200);
  assert.equal(summary.changeCount, 250);
  assert.equal((summary.changes as unknown[]).length, 200);
  assert.equal(summary.changesTruncated, true);
  assert.equal(summary.additions, 250);
  assert.equal(summary.deletions, 250);
});
