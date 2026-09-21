import path from "node:path";
import type { AppConfig, ProviderConfig } from "../core/config.js";
import type { TaskSandboxMode } from "../core/types.js";

export interface ProviderLaunchConfig {
  args: string[];
  environment: Record<string, string>;
  dockerEnvironment: string[];
  modelProvider: string;
}

const PROVIDER_KEY_ENV = "AGENT_PROVIDER_API_KEY";
const INHERITED_CODEX_SESSION_KEYS = [
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_CI",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

/**
 * Start a standalone Codex process instead of accidentally joining the Codex
 * Desktop session that launched Agent Foundry during development. The selected
 * config.toml also becomes the native runtime's real CODEX_HOME.
 */
export function codexProcessEnvironment(
  config: AppConfig,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const key of INHERITED_CODEX_SESSION_KEYS) delete environment[key];
  Object.assign(environment, overrides, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" });

  if (config.mcpConfigPath && path.basename(config.mcpConfigPath).toLowerCase() === "config.toml") {
    environment.CODEX_HOME = path.dirname(path.resolve(config.mcpConfigPath));
  } else {
    delete environment.CODEX_HOME;
  }
  return environment;
}

/** Current App Server releases prefer named permission profiles over the
 * legacy sandbox enum. Using the profile explicitly prevents a parent process
 * or a user's config.toml default from silently downgrading workspace writes. */
export function codexPermissionProfile(mode: TaskSandboxMode, inContainer = false): string {
  if (inContainer || mode === "danger-full-access") return ":danger-full-access";
  return mode === "workspace-write" ? ":workspace" : ":read-only";
}

/** Portable Windows builds cannot assume the administrator-approved elevated
 * sandbox has been set up. OpenAI documents `unelevated` as the supported
 * fallback, so select it explicitly for native processes and keep Docker/WSL
 * isolated by their own backend. */
export function codexNativePlatformArgs(inContainer = false, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" && !inContainer ? ["-c", 'windows.sandbox="unelevated"'] : [];
}

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
