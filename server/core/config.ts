import path from "node:path";
import type { ProviderId, RuntimeKind } from "./types.js";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  codexCompatible: boolean;
  capabilities: { responses: boolean; streaming: boolean; tools: boolean; reasoning: boolean };
}

export interface AppConfig {
  port: number;
  dataDir: string;
  defaultRuntime: RuntimeKind;
  workspaceMode: "native" | "wsl2";
  wslDistro: string;
  codexPath?: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  workerConcurrency: number;
  providerConcurrency: number;
  workerLeaseMs: number;
  docker: {
    enabled: boolean;
    image: string;
    cpuLimit: number;
    memoryMb: number;
    networkPolicy: "none" | "bridge";
    idleTtlMinutes: number;
  };
  auth: { mode: "local" | "token"; token?: string };
  skillsExtraRoots: string[];
  mcpConfigPath?: string;
  approvalWebhookUrl?: string;
  allowedWorkspaceRoot: string;
  verificationCommands: string[];
  providers: Record<ProviderId, ProviderConfig>;
}

function asRuntime(value: string | undefined): RuntimeKind {
  return value === "codex" ? "codex" : "mock";
}

export function loadConfig(): AppConfig {
  const openAiKey = process.env.OPENAI_API_KEY;
  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  const deepSeekModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const deepSeekBaseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com")
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
  const customKey = process.env.MODEL_API_KEY;
  const customUsesResponses = process.env.MODEL_WIRE_API === "responses";
  const sandboxBackend = (process.env.AGENT_SANDBOX ?? "native").toLowerCase();
  const workspaceMode = process.env.AGENT_WORKSPACE_MODE === "wsl2" || sandboxBackend === "wsl2" ? "wsl2" : "native";
  const defaultRuntime = process.env.AGENT_RUNTIME
    ? asRuntime(process.env.AGENT_RUNTIME)
    : openAiKey || deepSeekKey || (customKey && customUsesResponses)
      ? "codex"
      : "mock";

  return {
    port: Number(process.env.AGENT_API_PORT ?? 8788),
    dataDir: path.resolve(process.cwd(), process.env.AGENT_DATA_DIR ?? ".agent-data"),
    defaultRuntime,
    workspaceMode,
    wslDistro: process.env.WSL_DISTRO ?? "Ubuntu-24.04",
    codexPath: process.env.CODEX_PATH || undefined,
    sandboxMode: (process.env.CODEX_SANDBOX_MODE as AppConfig["sandboxMode"]) ?? "workspace-write",
    approvalPolicy: (process.env.CODEX_APPROVAL_POLICY as AppConfig["approvalPolicy"]) ?? "on-request",
    workerConcurrency: Math.max(1, Math.min(Number(process.env.AGENT_WORKER_CONCURRENCY ?? 2), 8)),
    providerConcurrency: Math.max(1, Math.min(Number(process.env.AGENT_PROVIDER_CONCURRENCY ?? 2), 8)),
    workerLeaseMs: Math.max(15_000, Number(process.env.AGENT_WORKER_LEASE_MS ?? 45_000)),
    docker: {
      enabled: sandboxBackend === "docker",
      image: process.env.AGENT_DOCKER_IMAGE ?? "agent-foundry-sandbox:local",
      cpuLimit: Math.max(0.25, Number(process.env.AGENT_DOCKER_CPUS ?? 2)),
      memoryMb: Math.max(256, Number(process.env.AGENT_DOCKER_MEMORY_MB ?? 2048)),
      // Codex App Server itself must reach the configured model endpoint. Tool
      // network access remains disabled by the Codex sandbox configuration.
      networkPolicy: process.env.AGENT_DOCKER_NETWORK === "none" ? "none" : "bridge",
      idleTtlMinutes: Math.max(1, Number(process.env.AGENT_DOCKER_IDLE_TTL_MINUTES ?? 30)),
    },
    auth: {
      mode: process.env.AGENT_AUTH_MODE === "token" ? "token" : "local",
      token: process.env.AGENT_AUTH_TOKEN || undefined,
    },
    skillsExtraRoots: [],
    mcpConfigPath: process.env.CODEX_CONFIG_PATH || undefined,
    approvalWebhookUrl: process.env.AGENT_APPROVAL_WEBHOOK_URL || undefined,
    allowedWorkspaceRoot: path.resolve(process.env.AGENT_ALLOWED_WORKSPACE_ROOT ?? path.join(process.cwd(), ".agent-data", "remote-workspaces")),
    verificationCommands: [],
    providers: {
      openai: {
        id: "openai",
        label: "OpenAI",
        apiKey: openAiKey,
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultModel: process.env.OPENAI_MODEL ?? "gpt-5.2-codex",
        codexCompatible: true,
        capabilities: { responses: true, streaming: true, tools: true, reasoning: true },
      },
      deepseek: {
        id: "deepseek",
        label: "DeepSeek",
        apiKey: deepSeekKey,
        baseUrl: deepSeekBaseUrl,
        defaultModel: deepSeekModel,
        codexCompatible: deepSeekModel === "deepseek-v4-flash",
        capabilities: { responses: deepSeekModel === "deepseek-v4-flash", streaming: true, tools: true, reasoning: true },
      },
      custom: {
        id: "custom",
        label: "OpenAI-compatible",
        apiKey: customKey,
        baseUrl: process.env.MODEL_BASE_URL,
        defaultModel: process.env.MODEL_NAME ?? "custom-model",
        codexCompatible: customUsesResponses,
        capabilities: { responses: customUsesResponses, streaming: true, tools: customUsesResponses, reasoning: false },
      },
    },
  };
}

export function publicConfig(config: AppConfig, configuredProviders?: Partial<Record<ProviderId, boolean>>) {
  return {
    defaultRuntime: config.defaultRuntime,
    workspace: {
      kind: config.workspaceMode,
      distro: config.workspaceMode === "wsl2" ? config.wslDistro : null,
      label: config.workspaceMode === "wsl2" ? `WSL2 · ${config.wslDistro}` : "Windows 原生",
    },
    scheduler: {
      concurrency: config.workerConcurrency,
      providerConcurrency: config.providerConcurrency,
      leaseMs: config.workerLeaseMs,
    },
    sandbox: config.docker,
    auth: { mode: config.auth.mode },
    runtimes: [
      { id: "mock", label: "Mock（无需密钥）", available: true },
      {
        id: "codex",
        label: "Codex App Server",
        available: Object.values(config.providers).some(
          (provider) => provider.codexCompatible && (configuredProviders?.[provider.id] ?? Boolean(provider.apiKey)),
        ),
      },
    ],
    providers: Object.values(config.providers).map((provider) => ({
      id: provider.id,
      label: provider.label,
      configured: configuredProviders?.[provider.id] ?? Boolean(provider.apiKey),
      defaultModel: provider.defaultModel,
      codexCompatible: provider.codexCompatible,
      capabilities: provider.capabilities,
    })),
  };
}
