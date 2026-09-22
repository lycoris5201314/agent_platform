import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSupportBundle } from "../../desktop/support-bundle.js";
import type { AppConfig } from "./config.js";
import { TaskStore } from "./store.js";

test("exports complete conversations while redacting credentials", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-support-"));
  const dataDir = path.join(directory, "data");
  const store = new TaskStore(dataDir);
  const secret = "sk-testsecret123456789";
  const knownTokens = [
    "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
    "ghp_1234567890abcdefghijklmnopqrstuv",
    "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz",
    "AIza1234567890abcdefghijklmnopqrstuvwxyzABCD",
    "AKIA1234567890ABCDEF",
    "eyJheaderheader.payloadpayload.signature12345",
  ];
  const config: AppConfig = {
    port: 0, dataDir, defaultRuntime: "mock", workspaceMode: "native", wslDistro: "",
    sandboxMode: "workspace-write", approvalPolicy: "on-request", workerConcurrency: 1,
    providerConcurrency: 1, workerLeaseMs: 45_000,
    docker: { enabled: false, image: "test", cpuLimit: 1, memoryMb: 512, networkPolicy: "none", idleTtlMinutes: 5 },
    auth: { mode: "local" }, skillsExtraRoots: [], allowedWorkspaceRoot: directory, verificationCommands: [],
    providers: {
      openai: { id: "openai", label: "OpenAI", apiKey: secret, defaultModel: "mock", codexCompatible: true, capabilities: { responses: true, streaming: true, tools: true, reasoning: true } },
      deepseek: { id: "deepseek", label: "DeepSeek", defaultModel: "mock", codexCompatible: false, capabilities: { responses: false, streaming: true, tools: true, reasoning: true } },
      custom: { id: "custom", label: "Custom", defaultModel: "mock", codexCompatible: false, capabilities: { responses: false, streaming: true, tools: true, reasoning: true } },
    },
  };
  try {
    const task = store.createTask({ title: "反馈复现", prompt: `用户粘贴了 ${secret} ${knownTokens.join(" ")}` }, { runtime: "mock", model: "mock" });
    store.appendEvent(task.id, "agent.runtime.error", { Authorization: `Bearer ${secret}`, detail: `api_key=${secret}` });
    const result = writeSupportBundle({ dataDir, userDataDir: directory, appVersion: "test", config, store });
    const conversationPath = path.join(result.directory, "conversations", `${task.id}.json`);
    const exported = readFileSync(conversationPath, "utf8");
    const system = readFileSync(path.join(result.directory, "system.json"), "utf8");
    assert.match(exported, /反馈复现/);
    assert.match(exported, /REDACTED/);
    assert.doesNotMatch(exported, new RegExp(secret));
    assert.doesNotMatch(system, new RegExp(secret));
    for (const token of knownTokens) assert.doesNotMatch(exported, new RegExp(token));
    assert.equal(result.taskCount, 1);
    assert.equal(existsSync(path.join(result.directory, "请先阅读.txt")), true);
    assert.equal(readdirSync(result.directory).some((name) => /agent\.env|\.sqlite|\.db$/i.test(name)), false);
    const staleConversation = path.join(result.directory, "conversations", "deleted-task.json");
    writeFileSync(staleConversation, "must not survive regeneration", "utf8");
    writeSupportBundle({ dataDir, userDataDir: directory, appVersion: "test", config, store });
    assert.equal(existsSync(staleConversation), false, "regeneration must replace the old directory instead of retaining deleted conversations");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
