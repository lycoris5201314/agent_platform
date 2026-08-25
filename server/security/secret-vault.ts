import { spawnSync } from "node:child_process";
import type { ProviderId } from "../core/types.js";
import { TaskStore } from "../core/store.js";
import type { AppConfig } from "../core/config.js";

const DPAPI_SCRIPT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$operation=[Console]::In.ReadLine()
$data=[Convert]::FromBase64String([Console]::In.ReadLine().Trim())
$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
if($operation -eq 'protect'){$out=[Security.Cryptography.ProtectedData]::Protect($data,$null,$scope)}else{$out=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,$scope)}
[Console]::Out.Write([Convert]::ToBase64String($out))`;

export class SecretVault {
  private readonly cache = new Map<string, string | null>();
  constructor(private readonly store: TaskStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS provider_secrets (
      tenant_id TEXT NOT NULL, provider_id TEXT NOT NULL, encrypted_value TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, provider_id)
    )`);
  }

  hydrateConfig(config: AppConfig, tenantId = "local"): void {
    for (const provider of Object.values(config.providers)) {
      if (!provider.apiKey) provider.apiKey = this.get(tenantId, provider.id) ?? undefined;
    }
  }

  set(tenantId: string, providerId: ProviderId, value: string): void {
    const encrypted = dpapi("protect", Buffer.from(value, "utf8"));
    this.store.db.prepare(`INSERT INTO provider_secrets (tenant_id, provider_id, encrypted_value, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, provider_id) DO UPDATE SET
      encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at`)
      .run(tenantId, providerId, encrypted, new Date().toISOString());
    this.cache.set(`${tenantId}:${providerId}`, value);
  }

  get(tenantId: string, providerId: ProviderId): string | null {
    const cacheKey = `${tenantId}:${providerId}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    const row = this.store.db.prepare("SELECT encrypted_value FROM provider_secrets WHERE tenant_id = ? AND provider_id = ?")
      .get(tenantId, providerId) as unknown as { encrypted_value: string } | undefined;
    if (!row) { this.cache.set(cacheKey, null); return null; }
    try { const value = dpapi("unprotect", Buffer.from(row.encrypted_value, "base64")).toString("utf8"); this.cache.set(cacheKey, value); return value; }
    catch { this.cache.set(cacheKey, null); return null; }
  }

  remove(tenantId: string, providerId: ProviderId): void {
    this.store.db.prepare("DELETE FROM provider_secrets WHERE tenant_id = ? AND provider_id = ?").run(tenantId, providerId);
    this.cache.set(`${tenantId}:${providerId}`, null);
  }
}

function dpapi(operation: "protect" | "unprotect", data: Buffer): string | Buffer {
  if (process.platform !== "win32") throw new Error("Encrypted provider vault currently requires Windows DPAPI");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
    input: `${operation}\n${data.toString("base64")}`, encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Windows DPAPI failed: ${result.error?.message ?? result.stderr.trim()}`);
  const encoded = result.stdout.trim();
  return operation === "protect" ? encoded : Buffer.from(encoded, "base64");
}
