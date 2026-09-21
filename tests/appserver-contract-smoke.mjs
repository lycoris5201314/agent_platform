import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const executable = process.env.CODEX_PATH || path.join(root, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const schemaDirectory = mkdtempSync(path.join(root, ".agent-protocol-smoke-"));

try {
  execFileSync(executable, ["app-server", "generate-ts", "--out", schemaDirectory], { cwd: root, windowsHide: true, stdio: "pipe" });
  const clientRequest = readFileSync(path.join(schemaDirectory, "ClientRequest.ts"), "utf8");
  const supported = new Set([...clientRequest.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]));
  const sourceFiles = ["server/runtime/codex-runtime.ts", "server/runtime/codex-control.ts", "server/app.ts"];
  const invoked = new Set();
  for (const relative of sourceFiles) {
    const source = readFileSync(path.join(root, relative), "utf8");
    for (const match of source.matchAll(/\b(?:rpc\.call|this\.request|codexControl\.request)\(\s*"([^"]+)"/g)) invoked.add(match[1]);
    for (const call of source.matchAll(/taskControl\([\s\S]{0,220}?\)/g)) {
      for (const method of call[0].matchAll(/"((?:thread|turn|review|model|skills|mcpServer|permissionProfile|collaborationMode|config)\/[^" ]+)"/g)) invoked.add(method[1]);
    }
  }
  const unsupported = [...invoked].filter((method) => !supported.has(method)).sort();
  assert.deepEqual(unsupported, [], `Agent Foundry calls App Server methods absent from bundled Codex: ${unsupported.join(", ")}`);
  assert.ok(supported.has("command/exec/terminate"), "Bundled schema must expose the supported connection-scoped process termination API");
  assert.equal(supported.has("thread/backgroundTerminals/terminate"), false, "Do not restore the removed non-existent background terminal API");
  console.log(`App Server contract smoke passed (${invoked.size} used methods, ${supported.size} supported methods).`);
} finally {
  rmSync(schemaDirectory, { recursive: true, force: true });
}
