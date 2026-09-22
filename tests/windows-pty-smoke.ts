import assert from "node:assert/strict";
import path from "node:path";
import { TerminalManager } from "../server/terminal/terminal-manager.js";
import { createWorkspaceHandle } from "../server/workspace/wsl-workspace.js";

if (process.platform !== "win32") {
  console.log("Windows ConPTY smoke test skipped on non-Windows host");
  process.exit(0);
}
if (process.env.CODEX_PERMISSION_PROFILE) {
  console.log("Windows ConPTY smoke test skipped inside an existing Codex Windows sandbox; packaged desktop smoke covers the normal host path");
  process.exit(0);
}

process.env.CODEX_PATH ??= path.resolve("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const manager = new TerminalManager();
const task = { id: "pty-smoke", sandboxMode: "workspace-write" } as Parameters<TerminalManager["open"]>[0];
const session = await manager.open(task, createWorkspaceHandle(process.cwd(), "native", "Ubuntu"), 90, 25);
let output = "";
let completed = false;
const inputTimer = setInterval(() => { if (!completed) void manager.write(task.id, session.id, "Write-Output 'CONPTY_OK'\r").catch(() => undefined); }, 750);
const timer = setTimeout(() => {
  completed = true;
  clearInterval(inputTimer);
  void manager.closeAll().finally(() => {
    console.error(output || "ConPTY did not return the expected marker before timeout");
    process.exit(1);
  });
}, 15_000);
const unsubscribe = manager.subscribe(task.id, session.id, ({ data }) => {
  output += data;
  if (completed || !output.includes("CONPTY_OK")) return;
  completed = true;
  clearTimeout(timer);
  clearInterval(inputTimer);
  void (async () => {
    const protectedIds = await manager.sweepIdle(0);
    assert.ok(!protectedIds.includes(session.id), "a terminal with a visible SSE subscriber must not be swept");
    unsubscribe();
    const removedIds = await manager.sweepIdle(0);
    assert.ok(removedIds.includes(session.id), "a hidden idle terminal must be swept");
    assert.equal(manager.get(task.id, session.id), null);
    await manager.closeAll();
    console.log(`Windows ConPTY smoke test passed (${session.permissionProfile}, idle cleanup)`);
    process.exit(0);
  })().catch(async (error) => {
    await manager.closeAll();
    console.error(error);
    process.exit(1);
  });
});
