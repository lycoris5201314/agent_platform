import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import type { AppConfig, ProviderConfig } from "../core/config.js";
import { codexNativePlatformArgs, codexPermissionProfile, codexProcessEnvironment, createProviderLaunchConfig } from "./provider-launch.js";

test("binds DeepSeek as a custom Responses provider with its own credential", () => {
  const provider: ProviderConfig = {
    id: "deepseek",
    label: "DeepSeek",
    apiKey: "secret",
    baseUrl: "https://api.deepseek.com/",
    defaultModel: "deepseek-v4-flash",
    codexCompatible: true,
    capabilities: { responses: true, streaming: true, tools: true, reasoning: true },
  };
  const launch = createProviderLaunchConfig(provider, "secret");
  assert.equal(launch.modelProvider, "agent_foundry_deepseek");
  assert.equal(launch.environment.AGENT_PROVIDER_API_KEY, "secret");
  assert.equal(launch.environment.CODEX_API_KEY, undefined);
  assert.deepEqual(launch.dockerEnvironment, ["-e", "AGENT_PROVIDER_API_KEY=secret"]);
  assert.ok(launch.args.includes('model_provider="agent_foundry_deepseek"'));
  assert.ok(launch.args.includes('model_providers.agent_foundry_deepseek.base_url="https://api.deepseek.com"'));
  assert.ok(launch.args.includes('model_providers.agent_foundry_deepseek.env_key="AGENT_PROVIDER_API_KEY"'));
  assert.ok(launch.args.includes("model_providers.agent_foundry_deepseek.requires_openai_auth=false"));
});

test("keeps the built-in provider for standard OpenAI", () => {
  const provider: ProviderConfig = {
    id: "openai",
    label: "OpenAI",
    apiKey: "secret",
    defaultModel: "gpt-5.2-codex",
    codexCompatible: true,
    capabilities: { responses: true, streaming: true, tools: true, reasoning: true },
  };
  const launch = createProviderLaunchConfig(provider, "secret");
  assert.equal(launch.modelProvider, "openai");
  assert.deepEqual(launch.args, []);
  assert.equal(launch.environment.CODEX_API_KEY, "secret");
});

test("isolates native Codex sessions and honors the selected config.toml", () => {
  const previousHome = process.env.CODEX_HOME;
  const previousSession = process.env.CODEX_SESSION_ID;
  process.env.CODEX_HOME = "C:\\parent-codex-home";
  process.env.CODEX_SESSION_ID = "parent-session";
  try {
    const config = { mcpConfigPath: "C:\\Users\\tester\\.codex\\config.toml" } as AppConfig;
    const environment = codexProcessEnvironment(config, { AGENT_PROVIDER_API_KEY: "secret" });
    assert.equal(environment.CODEX_HOME, path.resolve("C:\\Users\\tester\\.codex"));
    assert.equal(environment.CODEX_SESSION_ID, undefined);
    assert.equal(environment.AGENT_PROVIDER_API_KEY, "secret");
    assert.equal(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "agent_foundry_local");
    assert.equal(codexProcessEnvironment(config, { CODEX_PERMISSION_PROFILE: ":workspace" }).CODEX_PERMISSION_PROFILE, ":workspace");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSession === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = previousSession;
  }
});

test("maps platform sandbox choices to explicit Codex permission profiles", () => {
  assert.equal(codexPermissionProfile("read-only"), ":read-only");
  assert.equal(codexPermissionProfile("workspace-write"), ":workspace");
  assert.equal(codexPermissionProfile("danger-full-access"), ":danger-full-access");
  assert.equal(codexPermissionProfile("read-only", true), ":danger-full-access");
  assert.deepEqual(codexNativePlatformArgs(false, "win32"), ["-c", 'windows.sandbox="unelevated"']);
  assert.deepEqual(codexNativePlatformArgs(true, "win32"), []);
  assert.deepEqual(codexNativePlatformArgs(false, "linux"), []);
});
