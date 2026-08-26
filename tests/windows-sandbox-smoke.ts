import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceHandle, runInWorkspaceSandboxed } from "../server/workspace/wsl-workspace.js";

if (process.platform !== "win32") {
  console.log("Windows sandbox smoke test skipped on non-Windows host");
  process.exit(0);
}

process.env.CODEX_PATH ??= path.resolve("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-foundry-sandbox-workspace-"));
// Windows sandboxes intentionally allow the system temp directory, so the negative
// target must live outside both the workspace and TEMP.
const outsideRoot = await fs.mkdtemp(path.join(path.dirname(process.cwd()), "agent-foundry-sandbox-outside-"));
const workspace = createWorkspaceHandle(workspaceRoot, "native", "Ubuntu");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
try {
  const readOnlyTarget = path.join(workspaceRoot, "must-not-exist.txt");
  await runInWorkspaceSandboxed(workspace, "read-only", powershell, ["-NoProfile", "-Command", `Set-Content -LiteralPath '${readOnlyTarget}' -Value denied`], 20_000);
  if (await fs.stat(readOnlyTarget).then(() => true).catch(() => false)) throw new Error("read-only sandbox allowed a workspace write");

  const writableTarget = path.join(workspaceRoot, "allowed.txt");
  const allowed = await runInWorkspaceSandboxed(workspace, "workspace-write", powershell, ["-NoProfile", "-Command", `Set-Content -LiteralPath '${writableTarget}' -Value allowed`], 20_000);
  if (allowed.code !== 0 || !(await fs.stat(writableTarget).then(() => true).catch(() => false))) throw new Error(`workspace sandbox blocked an in-workspace write: ${allowed.stderr}`);

  const outsideTarget = path.join(outsideRoot, "must-not-exist.txt");
  await runInWorkspaceSandboxed(workspace, "workspace-write", powershell, ["-NoProfile", "-Command", `Set-Content -LiteralPath '${outsideTarget}' -Value denied`], 20_000);
  if (await fs.stat(outsideTarget).then(() => true).catch(() => false)) throw new Error("workspace sandbox allowed an out-of-workspace write");
  console.log("Windows sandbox smoke test passed (read-only and workspace-write boundaries)");
} finally {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
}
