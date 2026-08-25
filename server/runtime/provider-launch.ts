import type { ProviderConfig } from "../core/config.js";

export interface ProviderLaunchConfig {
  args: string[];
  environment: Record<string, string>;
  dockerEnvironment: string[];
  modelProvider: string;
}

const PROVIDER_KEY_ENV = "AGENT_PROVIDER_API_KEY";

/**
 * Give Codex a real custom model provider instead of redirecting its built-in
 * OpenAI provider. Redirecting `openai_base_url` leaves OpenAI's authentication
 * path active and can make a valid third-party key fail in the governor layer.
 */
export function createProviderLaunchConfig(provider: ProviderConfig, apiKey?: string): ProviderLaunchConfig {
  const builtInOpenAI = provider.id === "openai" && !provider.baseUrl;
  if (builtInOpenAI) {
    return {
      args: [],
      environment: apiKey ? { CODEX_API_KEY: apiKey } : {},
      dockerEnvironment: apiKey ? ["-e", `CODEX_API_KEY=${apiKey}`] : [],
      modelProvider: "openai",
    };
  }

  if (!provider.baseUrl) throw new Error(`${provider.label} base URL is not configured`);
  const modelProvider = `agent_foundry_${provider.id.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  const config = [
    `model_provider=${tomlString(modelProvider)}`,
    `model_providers.${modelProvider}.name=${tomlString(provider.label)}`,
    `model_providers.${modelProvider}.base_url=${tomlString(provider.baseUrl.replace(/\/$/, ""))}`,
    `model_providers.${modelProvider}.env_key=${tomlString(PROVIDER_KEY_ENV)}`,
    `model_providers.${modelProvider}.wire_api=${tomlString("responses")}`,
    `model_providers.${modelProvider}.requires_openai_auth=false`,
  ];
  return {
    args: config.flatMap((entry) => ["-c", entry]),
    environment: apiKey ? { [PROVIDER_KEY_ENV]: apiKey } : {},
    dockerEnvironment: apiKey ? ["-e", `${PROVIDER_KEY_ENV}=${apiKey}`] : [],
    modelProvider,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
