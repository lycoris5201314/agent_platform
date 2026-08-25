import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../server/core/config.js";
import { TaskStore } from "../server/core/store.js";
import { DockerSandboxManager, docker } from "../server/sandbox/docker-sandbox.js";
import { WslWorkspaceManager } from "../server/workspace/wsl-workspace.js";

const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-docker-"));
const config = { ...loadConfig(), dataDir: path.join(directory, "data"), docker: { ...loadConfig().docker, enabled: true, image: "agent-foundry-sandbox:smoke" } };
const store = new TaskStore(config.dataDir);
const manager = new DockerSandboxManager(store, config);
try {
  const task = store.createTask({ title: "docker smoke", prompt: "verify", runtime: "mock", workspacePath: path.join(directory, "workspace") }, { runtime: "mock", model: "mock" });
  const workspace = await new WslWorkspaceManager(path.join(config.dataDir, "workspaces"), config.wslDistro).prepare(task);
  const prepared = await manager.prepare(task, workspace);
  assert.equal(prepared.sandbox.kind, "docker");
  assert.ok(prepared.sandbox.containerId);
  const run = await docker(["exec", "-w", "/workspace", prepared.sandbox.containerId!, "sh", "-lc", "printf docker-ready && test -d .git"], 30_000);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /docker-ready/);
  const write = await docker(["exec", "-w", "/workspace", prepared.sandbox.containerId!, "sh", "-lc", "printf sandbox-write > .sandbox-write-test && test -s .sandbox-write-test && mkdir -p /home/node/.codex && printf durable > /home/node/.codex/state-test"], 30_000);
  assert.equal(write.code, 0, write.stderr);
  const rootWrite = await docker(["exec", prepared.sandbox.containerId!, "sh", "-lc", "printf blocked > /root-write-test"], 30_000);
  assert.notEqual(rootWrite.code, 0, "workspace-write must keep the container root filesystem read-only");
  manager.markIdle(task.id);
  await manager.release(task.id);
  assert.equal(store.getSandbox(task.id)?.state, "released");
  console.log("Docker sandbox lifecycle smoke passed");
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
