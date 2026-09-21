import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCapabilityCatalog } from "../../app/lib/capability-catalog.js";

test("normalizes Codex skills, MCP health and permission capabilities for the UI", () => {
  const catalog = normalizeCapabilityCatalog({
    providerCapabilities: { namespaceTools: true, imageGeneration: false, webSearch: true },
    skills: { data: [{ cwd: "C:\\work", skills: [{ name: "docs", description: "Create documents", path: "C:\\skills\\docs\\SKILL.md", scope: "user", enabled: true, pluginId: "docs@test" }] }] },
    mcp: { data: [
      { name: "github", runtimeStatus: null, tools: { search: {}, read: {} }, toolsError: null, authStatus: "bearerToken", pluginId: "github@test" },
      { name: "gmail", runtimeStatus: "failed", tools: {}, toolsError: "login required", authStatus: "notLoggedIn", pluginId: "gmail@test" },
      { name: "broken", runtimeStatus: "failed", tools: {}, toolsError: "connection refused", authStatus: "unsupported" },
    ] },
    permissionProfiles: { data: [{ id: ":read-only" }, { id: ":workspace" }] },
    collaborationModes: { data: [{ name: "Default" }, { name: "Plan" }] },
  });
  assert.equal(catalog.healthy, true);
  assert.deepEqual(catalog.features, { namespaceTools: true, imageGeneration: false, webSearch: true });
  assert.equal(catalog.skills[0].pluginId, "docs@test");
  assert.equal(catalog.mcpServers[0].status, "connected");
  assert.equal(catalog.mcpServers[1].status, "degraded");
  assert.equal(catalog.mcpServers[1].authStatus, "notLoggedIn");
  assert.equal(catalog.mcpServers[0].toolCount, 2);
  assert.equal(catalog.mcpServers[2].status, "unavailable");
  assert.deepEqual(catalog.permissionProfiles, [":read-only", ":workspace"]);
});

test("turns per-section protocol failures into concise actionable errors", () => {
  const catalog = normalizeCapabilityCatalog({ skills: { error: "app-server timed out\nsecret noise" }, mcp: { error: "MCP unavailable" } });
  assert.equal(catalog.healthy, false);
  assert.deepEqual(catalog.errors.map((error) => error.section), ["skills", "mcp"]);
  assert.equal(catalog.skills.length, 0);
  assert.equal(catalog.mcpServers.length, 0);
});
