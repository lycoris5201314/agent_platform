import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../core/config.js";
import { createProviderLaunchConfig } from "./provider-launch.js";

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
