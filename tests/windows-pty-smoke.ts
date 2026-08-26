import path from "node:path";
import { TerminalManager } from "../server/terminal/terminal-manager.js";
import { createWorkspaceHandle } from "../server/workspace/wsl-workspace.js";

if (process.platform !== "win32") {
  console.log("Windows ConPTY smoke test skipped on non-Windows host");
  process.exit(0);
}

process.env.CODEX_PATH ??= path.resolve("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const manager = new TerminalManager();
const task = { id: "pty-smoke", sandboxMode: "workspace-write" } as Parameters<TerminalManager["open"]>[0];
const session = manager.open(task, createWorkspaceHandle(process.cwd(), "native", "Ubuntu"), 90, 25);
let output = "";
let completed = false;
const timer = setTimeout(() => {
  void manager.closeAll();
  console.error(output);
  process.exitCode = 1;
}, 8_000);
manager.subscribe(task.id, session.id, ({ data }) => {
  output += data;
  if (completed || !output.includes("CONPTY_OK")) return;
  completed = true;
  clearTimeout(timer);
  manager.write(task.id, session.id, "exit\r");
  setTimeout(() => { void manager.closeAll().then(() => { console.log(`Windows ConPTY smoke test passed (${session.permissionProfile})`); process.exit(0); }); }, 1_000);
});
setTimeout(() => manager.write(task.id, session.id, "Write-Output 'CONPTY_OK'\r"), 700);
