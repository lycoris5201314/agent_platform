import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "./app.js";
import { loadConfig } from "./core/config.js";
import type { CodexPluginCatalog, CodexPluginManagerTransport } from "./runtime/plugin-manager.js";

class FakePluginManager implements CodexPluginManagerTransport {
  calls: Array<[string, string?]> = [];
  async catalog(): Promise<CodexPluginCatalog> { this.calls.push(["catalog"]); return { installed: [], available: [], marketplaces: [] }; }
  async install(id: string) { this.calls.push(["install", id]); return { ok: true }; }
  async remove(id: string) { this.calls.push(["remove", id]); return { ok: true }; }
  async addMarketplace(source: string) { this.calls.push(["addMarketplace", source]); return { ok: true }; }
  async removeMarketplace(name: string) { this.calls.push(["removeMarketplace", name]); return { ok: true }; }
  async upgradeMarketplaces(name?: string) { this.calls.push(["upgradeMarketplaces", name]); return { ok: true }; }
}

test("plugin routes expose the complete marketplace lifecycle and reject malformed selectors", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-plugins-"));
  const manager = new FakePluginManager();
  const base = loadConfig();
  const application = await createAgentApplication({ ...base, dataDir: path.join(directory, "data"), defaultRuntime: "mock", docker: { ...base.docker, enabled: false } }, { pluginManager: manager });
  try {
    assert.equal((await application.app.inject({ method: "GET", url: "/api/codex/plugins" })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugins/install", payload: { pluginId: "mail@curated" } })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugins/remove", payload: { pluginId: "mail@curated" } })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugin-marketplaces", payload: { source: "owner/repo" } })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugin-marketplaces/upgrade", payload: {} })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugin-marketplaces/remove", payload: { name: "curated" } })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "POST", url: "/api/codex/plugins/install", payload: { pluginId: "--help" } })).statusCode, 400);
    assert.deepEqual(manager.calls, [["catalog"], ["install", "mail@curated"], ["remove", "mail@curated"], ["addMarketplace", "owner/repo"], ["upgradeMarketplaces", undefined], ["removeMarketplace", "curated"]]);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
