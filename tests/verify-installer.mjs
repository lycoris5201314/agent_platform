import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const packageVersion = process.env.npm_package_version
  ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const installer = path.resolve(`release/Agent-Foundry-Setup-${packageVersion}-x64.exe`);
const testRoot = mkdtempSync(path.join(os.tmpdir(), "agent-foundry-installer-smoke-"));
const installDirectory = path.join(testRoot, "Agent Foundry");
const executable = path.join(installDirectory, "Agent Foundry.exe");
const uninstaller = path.join(installDirectory, "Uninstall Agent Foundry.exe");

try {
  accessSync(installer, constants.R_OK);
  execFileSync(installer, ["/S", `/D=${installDirectory}`], {
    windowsHide: true,
    stdio: "inherit",
    timeout: 180_000,
  });
  accessSync(executable, constants.X_OK);
  execFileSync(executable, ["--smoke-test"], {
    windowsHide: true,
    stdio: "inherit",
    timeout: 180_000,
  });
  console.log(`Installed desktop smoke passed: ${executable}`);
} finally {
  try {
    accessSync(uninstaller, constants.X_OK);
    execFileSync(uninstaller, ["/S"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 120_000,
    });
  } catch {
    // The installation may have failed before creating an uninstaller.
  }
  let cleaned = false;
  for (let attempt = 0; attempt < 20 && !cleaned; attempt += 1) {
    try {
      rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      cleaned = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!cleaned) console.warn(`Installer smoke cleanup deferred: ${testRoot}`);
}
