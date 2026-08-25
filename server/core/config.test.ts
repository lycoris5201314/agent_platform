import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const keys = ["AGENT_RUNTIME", "AGENT_SANDBOX", "AGENT_WORKSPACE_MODE", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"] as const;

function withEnvironment(values: Partial<Record<(typeof keys)[number], string>>, run: () => void): void {
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("DeepSeek V4 Flash enables the Codex Responses runtime", () => {
  withEnvironment({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
    DEEPSEEK_MODEL: "deepseek-v4-flash",
  }, () => {
    const config = loadConfig();
    assert.equal(config.defaultRuntime, "codex");
    assert.equal(config.providers.deepseek.codexCompatible, true);
    assert.equal(config.providers.deepseek.baseUrl, "https://api.deepseek.com");
  });
});

test("defaults to the Windows native workspace without Docker or WSL2", () => {
  withEnvironment({}, () => {
    const config = loadConfig();
    assert.equal(config.workspaceMode, "native");
    assert.equal(config.docker.enabled, false);
  });
});

test("keeps WSL2 and Docker as explicit opt-in backends", () => {
  withEnvironment({ AGENT_WORKSPACE_MODE: "wsl2", AGENT_SANDBOX: "wsl2" }, () => {
    const config = loadConfig();
    assert.equal(config.workspaceMode, "wsl2");
    assert.equal(config.docker.enabled, false);
  });
  withEnvironment({ AGENT_SANDBOX: "docker" }, () => {
    const config = loadConfig();
    assert.equal(config.workspaceMode, "native");
    assert.equal(config.docker.enabled, true);
  });
});

test("DeepSeek V4 Pro remains blocked until its Responses API is available", () => {
  withEnvironment({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-v4-pro" }, () => {
    assert.equal(loadConfig().providers.deepseek.codexCompatible, false);
  });
});
