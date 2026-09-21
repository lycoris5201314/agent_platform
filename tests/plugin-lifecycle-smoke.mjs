import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const codexScript = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
const marketplace = path.join(root, "tests", "fixtures", "plugin-marketplace");
const codexHome = await mkdtemp(path.join(root, ".agent-plugin-smoke-"));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexScript, ...args], { cwd: root, windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`codex ${args.join(" ")} exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(new Error(`Invalid Codex JSON: ${stdout}\n${stderr}`, { cause: error })); }
      }
    });
  });
}

try {
  await run(["plugin", "marketplace", "add", marketplace, "--json"]);
  const discovered = await run(["plugin", "list", "--available", "--json"]);
  assert.equal(discovered.available.some((plugin) => plugin.pluginId === "smoke-plugin@agent-foundry-smoke"), true);
  await run(["plugin", "add", "smoke-plugin@agent-foundry-smoke", "--json"]);
  const installed = await run(["plugin", "list", "--json"]);
  assert.equal(installed.installed.some((plugin) => plugin.pluginId === "smoke-plugin@agent-foundry-smoke"), true);
  await run(["plugin", "remove", "smoke-plugin@agent-foundry-smoke", "--json"]);
  const removed = await run(["plugin", "list", "--json"]);
  assert.equal(removed.installed.some((plugin) => plugin.pluginId === "smoke-plugin@agent-foundry-smoke"), false);
  console.log("Plugin lifecycle smoke passed (discover, install, remove).");
} finally {
  await rm(codexHome, { recursive: true, force: true });
}
