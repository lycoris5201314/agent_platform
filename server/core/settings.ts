import fs from "node:fs";
import path from "node:path";
import type { AppConfig, ProviderConfig } from "./config.js";
import type { ProviderId } from "./types.js";
import { TaskStore } from "./store.js";

export interface PlatformSettings {
  defaultRuntime: "mock" | "codex";
  defaultProvider: "openai" | "deepseek" | "custom";
  defaultWorkspace: string;
  workerConcurrency: number;
  providerConcurrency: number;
  sandboxEnabled: boolean;
  sandboxImage: string;
  sandboxCpuLimit: number;
  sandboxMemoryMb: number;
  sandboxNetwork: "none" | "bridge";
  skillsExtraRoots: string[];
  mcpConfigPath: string;
  verificationCommands: string[];
  approvalPolicy: AppConfig["approvalPolicy"];
  approvalWebhookUrl: string;
  providerProfiles: Record<ProviderId, { baseUrl: string; defaultModel: string; codexCompatible: boolean }>;
}

export class SettingsService {
  constructor(private readonly store: TaskStore, private readonly config: AppConfig) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    )`);
    this.apply(this.get("local"));
  }

  get(tenantId: string): PlatformSettings {
    const saved = this.store.db.prepare("SELECT value_json FROM app_settings WHERE tenant_id = ? AND key = 'platform'")
      .get(tenantId) as unknown as { value_json: string } | undefined;
    const defaults: PlatformSettings = {
      defaultRuntime: this.config.defaultRuntime,
      defaultProvider: "openai",
      defaultWorkspace: "",
      workerConcurrency: this.config.workerConcurrency,
      providerConcurrency: this.config.providerConcurrency,
      sandboxEnabled: this.config.docker.enabled,
      sandboxImage: this.config.docker.image,
      sandboxCpuLimit: this.config.docker.cpuLimit,
      sandboxMemoryMb: this.config.docker.memoryMb,
      sandboxNetwork: this.config.docker.networkPolicy,
      skillsExtraRoots: [],
      mcpConfigPath: path.join(process.env.USERPROFILE ?? process.cwd(), ".codex", "config.toml"),
      verificationCommands: [],
      approvalPolicy: this.config.approvalPolicy,
      approvalWebhookUrl: this.config.approvalWebhookUrl ?? "",
      providerProfiles: Object.fromEntries(Object.entries(this.config.providers).map(([id, provider]) => [id, {
        baseUrl: provider.baseUrl ?? "", defaultModel: provider.defaultModel, codexCompatible: provider.codexCompatible,
      }])) as PlatformSettings["providerProfiles"],
    };
    if (!saved) return defaults;
    try {
      const parsed = JSON.parse(saved.value_json) as Partial<PlatformSettings>;
      return { ...defaults, ...parsed, providerProfiles: { ...defaults.providerProfiles, ...(parsed.providerProfiles ?? {}) } };
    }
    catch { return defaults; }
  }

  provider(tenantId: string, providerId: ProviderId): ProviderConfig {
    const base = this.config.providers[providerId];
    const profile = this.get(tenantId).providerProfiles?.[providerId];
    if (!profile) return base;
    return {
      ...base,
      baseUrl: profile.baseUrl.trim().replace(/\/$/, "") || undefined,
      defaultModel: profile.defaultModel.trim() || base.defaultModel,
      codexCompatible: profile.codexCompatible,
      capabilities: { ...base.capabilities, responses: profile.codexCompatible, tools: profile.codexCompatible },
    };
  }

  update(tenantId: string, patch: Partial<PlatformSettings>): PlatformSettings {
    const next = { ...this.get(tenantId), ...patch };
    this.store.db.prepare(`INSERT INTO app_settings (tenant_id, key, value_json, updated_at) VALUES (?, 'platform', ?, ?)
      ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(tenantId, JSON.stringify(next), new Date().toISOString());
    // Runtime-wide worker/sandbox values belong to the local installation.
    // Tenant preferences are persisted but must never mutate another tenant's process.
    if (tenantId === "local") this.apply(next);
    return next;
  }

  private apply(next: PlatformSettings): void {
    this.config.defaultRuntime = next.defaultRuntime;
    this.config.workerConcurrency = next.workerConcurrency;
    this.config.providerConcurrency = next.providerConcurrency;
    this.config.docker.enabled = next.sandboxEnabled;
    this.config.docker.image = next.sandboxImage;
    this.config.docker.cpuLimit = next.sandboxCpuLimit;
    this.config.docker.memoryMb = next.sandboxMemoryMb;
    this.config.docker.networkPolicy = next.sandboxNetwork;
    this.config.skillsExtraRoots = next.skillsExtraRoots;
    this.config.mcpConfigPath = next.mcpConfigPath;
    this.config.approvalPolicy = next.approvalPolicy;
    this.config.approvalWebhookUrl = next.approvalWebhookUrl || undefined;
    this.config.verificationCommands = next.verificationCommands;
  }

  dataSummary(): Record<string, unknown> {
    const databasePath = path.join(this.config.dataDir, "agent-platform.db");
    const databaseBytes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
    const version = this.store.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get() as unknown as { version: number };
    return { dataDir: this.config.dataDir, databasePath, databaseBytes, schemaVersion: version.version };
  }
}
