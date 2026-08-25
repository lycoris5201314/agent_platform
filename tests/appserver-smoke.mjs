import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const executable = process.env.CODEX_PATH || path.resolve("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map();
let nextId = 1;
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const handler = pending.get(message.id);
  if (handler) {
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  }
});
const request = (method, params) => {
  const id = nextId++;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return result;
};
const timeout = setTimeout(() => { child.kill(); throw new Error(`App Server handshake timed out: ${stderr}`); }, 20_000);
try {
  const initialized = await request("initialize", { clientInfo: { name: "agent-foundry-smoke", title: "Agent Foundry Smoke", version: "0.2.6" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  const started = await request("thread/start", { cwd: process.cwd(), approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true, historyMode: "paginated", dynamicTools: [{ type: "function", name: "durable_wait", description: "Pause durably", inputSchema: { type: "object", properties: { seconds: { type: "integer", minimum: 1 } }, required: ["seconds"], additionalProperties: false } }, { type: "function", name: "wait_for_external_signal", description: "Wait for a durable external signal", inputSchema: { type: "object", properties: { correlationKey: { type: "string" } }, required: ["correlationKey"], additionalProperties: false } }] });
  if (!initialized || !started?.thread?.id) throw new Error("App Server returned an incomplete handshake");
  console.log(`App Server smoke passed (thread ${started.thread.id})`);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
