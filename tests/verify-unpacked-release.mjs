import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

const directory = path.resolve("release/Agent Foundry");
const executable = path.join(directory, "Agent Foundry.exe");
const environmentPath = path.join(directory, "agent.env");
accessSync(executable, constants.X_OK);
accessSync(environmentPath, constants.R_OK);
const environment = readFileSync(environmentPath, "utf8");
const hasCompatibleKey = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "MODEL_API_KEY"].some((name) => {
  const match = environment.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
  return Boolean(match?.[1]);
});
execFileSync(executable, [hasCompatibleKey ? "--real-smoke-test" : "--smoke-test"], {
  cwd: directory,
  windowsHide: true,
  stdio: "inherit",
  timeout: hasCompatibleKey ? 300_000 : 180_000,
});
console.log(`Extracted release smoke passed (${hasCompatibleKey ? "real provider" : "packaged runtime only"}): ${executable}`);
