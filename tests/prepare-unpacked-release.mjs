import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const releaseDirectory = path.resolve("release");
const source = path.join(releaseDirectory, "win-unpacked");
const target = path.join(releaseDirectory, "Agent Foundry");
const staging = path.join(releaseDirectory, `.agent-foundry-unpacked-${process.pid}`);
const existingEnvironmentPath = path.join(target, "agent.env");
const preservedEnvironment = existsSync(existingEnvironmentPath) ? readFileSync(existingEnvironmentPath) : null;

// Fail before removing any files when the user's extracted application is running.
if (process.platform === "win32" && existsSync(target)) {
  const active = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name 'Agent Foundry' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:AGENT_FOUNDRY_REPLACE_EXE }).Count",
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, AGENT_FOUNDRY_REPLACE_EXE: path.join(target, "Agent Foundry.exe") } }).trim();
  if (!/^0$/.test(active)) throw new Error(`Exit Agent Foundry from the system tray before replacing ${target}. No extracted files have been removed.`);
}

if (!existsSync(source)) throw new Error(`Unpacked Electron build is missing: ${source}`);
mkdirSync(releaseDirectory, { recursive: true });
rmSync(staging, { recursive: true, force: true });
cpSync(source, staging, { recursive: true, force: true });
writeFileSync(
  path.join(staging, "agent.env"),
  preservedEnvironment ?? readFileSync(path.resolve("desktop/agent.env.example")),
);
try {
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  renameSync(staging, target);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw new Error(`Cannot refresh ${target}. Exit every running Agent Foundry window and build again. ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`Prepared extracted release directory: ${target}`);
