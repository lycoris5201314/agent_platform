import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../core/config.js";
import { CodexPluginManager } from "./plugin-manager.js";

test("plugin manager uses structured Codex commands and normalizes untrusted catalog fields", async () => {
  const calls: string[][] = [];
  const manager = new CodexPluginManager(loadConfig(), async (args) => {
    calls.push(args);
    if (args[1] === "list") return { installed: [{ pluginId: "docs@local", name: " docs\n", marketplaceName: "local", version: "1.0", installed: true, enabled: true, installPolicy: "AVAILABLE", authPolicy: "ON_USE", secret: "hidden" }], available: [{ pluginId: "mail@remote", name: "mail", marketplaceName: "remote", installed: false, enabled: false }] };
    if (args[2] === "list") return { marketplaces: [{ name: "local", root: "C:\\plugins" }] };
    return { ok: true };
  });
  const catalog = await manager.catalog();
  assert.deepEqual(catalog.installed[0], { pluginId: "docs@local", name: "docs", marketplaceName: "local", version: "1.0", installed: true, enabled: true, installPolicy: "AVAILABLE", authPolicy: "ON_USE" });
  assert.equal(catalog.available[0].pluginId, "mail@remote");
  assert.deepEqual(catalog.marketplaces, [{ name: "local", root: "C:\\plugins" }]);
  await manager.install("mail@remote");
  await manager.remove("mail@remote");
  await manager.addMarketplace("owner/repo");
  await manager.upgradeMarketplaces("remote");
  await manager.removeMarketplace("remote");
  assert.deepEqual(calls.slice(2), [["plugin", "add", "mail@remote", "--json"], ["plugin", "remove", "mail@remote", "--json"], ["plugin", "marketplace", "add", "owner/repo", "--json"], ["plugin", "marketplace", "upgrade", "remote", "--json"], ["plugin", "marketplace", "remove", "remote", "--json"]]);
});
