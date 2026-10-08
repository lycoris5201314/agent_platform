import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const packageVersion = process.env.npm_package_version
  ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const installer = path.resolve(`release/Agent-Foundry-Setup-${packageVersion}-x64.exe`);
// NSIS may terminate every process with the application name, even for a
// different install directory. Never let a smoke install close a user's app.
if (process.platform === "win32") {
  const active = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name 'Agent Foundry' -ErrorAction SilentlyContinue).Count",
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();
  if (!/^0$/.test(active)) throw new Error("Exit Agent Foundry from the system tray before installer verification. The installer has not been started.");
}
const testRoot = mkdtempSync(path.join(os.tmpdir(), "agent-foundry-installer-smoke-"));
const installDirectory = path.join(testRoot, "Agent Foundry");
const executable = path.join(installDirectory, "Agent Foundry.exe");
const uninstaller = path.join(installDirectory, "Uninstall Agent Foundry.exe");

function runStage(stage, file, args, options = {}) {
  console.log(`[installer smoke] ${stage}`);
  try {
    execFileSync(file, args, {
      windowsHide: true,
      stdio: "inherit",
      ...options,
    });
  } catch (error) {
    const status = typeof error?.status === "number" ? `, exit ${error.status}` : "";
    const signal = error?.signal ? `, signal ${error.signal}` : "";
    throw new Error(`Installer smoke failed during ${stage}${status}${signal}`, { cause: error });
  }
}

function describeRemainder(directory) {
  if (!existsSync(directory)) return "directory already removed";
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
    .slice(0, 40)
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)) || entry.name);
  return entries.length > 0 ? entries.join(", ") : "empty directory (likely a transient process lock)";
}

async function removeWithRetry(directory, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      if (!existsSync(directory)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  const reason = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : "unknown lock";
  throw new Error(`Could not clean installer smoke directory after ${timeoutMs / 1000}s (${reason}); remaining: ${describeRemainder(directory)}`);
}

try {
  accessSync(installer, constants.R_OK);
  runStage("silent install", installer, ["/S", `/D=${installDirectory}`], {
    cwd: testRoot,
    timeout: 180_000,
  });
  accessSync(executable, constants.X_OK);
  runStage("installed application startup", executable, ["--smoke-test"], {
    cwd: testRoot,
    timeout: 180_000,
  });
  console.log(`Installed desktop smoke passed: ${executable}`);
  runStage("installed image and dialog interactions", executable, ["--interaction-smoke-test"], {
    cwd: testRoot,
    timeout: 180_000,
  });
} finally {
  try {
    accessSync(uninstaller, constants.X_OK);
    // NSIS normally copies the uninstaller to Temp and returns before that copy
    // finishes. _?= keeps it in place, so this process waits for a real uninstall.
    // NSIS requires _?= to be the final argument and without surrounding quotes.
    runStage("synchronous silent uninstall", uninstaller, ["/S", `_?=${installDirectory}`], {
      cwd: testRoot,
      timeout: 120_000,
    });
  } catch (error) {
    if (existsSync(uninstaller)) console.warn(error instanceof Error ? error.message : String(error));
  }
  await removeWithRetry(testRoot);
  console.log("[installer smoke] cleanup complete");
}
