import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyStagedDatabaseRestore, inspectDatabaseBackup, stageDatabaseRestore } from "../../desktop/database-restore.js";
import { TaskStore } from "./store.js";

test("validates, stages and atomically restores an Agent Foundry database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-database-restore-"));
  const sourceDirectory = path.join(directory, "source");
  const targetDirectory = path.join(directory, "target");
  const source = new TaskStore(sourceDirectory);
  source.createTask({ title: "来自备份", prompt: "restore me" }, { runtime: "mock", model: "mock" });
  const backup = await source.createBackup();
  source.close();
  const target = new TaskStore(targetDirectory);
  target.createTask({ title: "恢复前数据", prompt: "replace me" }, { runtime: "mock", model: "mock" });
  target.close();
  try {
    const inspection = inspectDatabaseBackup(backup.path);
    assert.equal(inspection.integrity, "ok");
    assert.equal(inspection.taskCount, 1);
    const staged = stageDatabaseRestore(backup.path, targetDirectory);
    applyStagedDatabaseRestore(staged.stagedPath, path.join(targetDirectory, "agent-platform.db"));
    const restored = new TaskStore(targetDirectory);
    try {
      const tasks = restored.listTasksFor({ tenantId: "local", userId: "local-user", role: "owner" }, 20, false);
      assert.deepEqual(tasks.map((task) => task.title), ["来自备份"]);
      assert.equal(restored.databaseHealth().ok, true);
    } finally { restored.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects arbitrary files before touching the current database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-database-invalid-"));
  const invalid = path.join(directory, "not-a-backup.db");
  const current = new TaskStore(directory);
  current.createTask({ title: "必须保留", prompt: "do not replace" }, { runtime: "mock", model: "mock" });
  current.close();
  fs.writeFileSync(invalid, "not sqlite");
  const stagedInvalid = path.join(directory, ".restore-00000000-0000-0000-0000-000000000000.db");
  fs.copyFileSync(invalid, stagedInvalid);
  try {
    assert.throws(() => inspectDatabaseBackup(invalid));
    assert.throws(() => applyStagedDatabaseRestore(stagedInvalid, path.join(directory, "agent-platform.db")));
    const reopened = new TaskStore(directory);
    try { assert.equal(reopened.listTasks()[0]?.title, "必须保留"); }
    finally { reopened.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
