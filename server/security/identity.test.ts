import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentApplication } from "../app.js";
import { loadConfig } from "../core/config.js";

test("token mode rejects spoofed roles and enforces signed RBAC", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-auth-"));
  const base = loadConfig();
  const secret = "test-master-secret-with-enough-entropy";
  const application = await createAgentApplication({ ...base, dataDir: directory, defaultRuntime: "mock", auth: { mode: "token", token: secret }, docker: { ...base.docker, enabled: false } });
  try {
    assert.equal((await application.app.inject({ method: "GET", url: "/api/tasks" })).statusCode, 401);
    assert.equal((await application.app.inject({ method: "GET", url: "/api/tasks", headers: { authorization: "Bearer wrong", "x-agent-role": "owner" } })).statusCode, 401);
    const payload = Buffer.from(JSON.stringify({ tenantId: "tenant-view", userId: "viewer", role: "viewer", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    const authorization = `Bearer ${payload}.${signature}`;
    assert.equal((await application.app.inject({ method: "GET", url: "/api/tasks", headers: { authorization } })).statusCode, 200);
    assert.equal((await application.app.inject({ method: "PATCH", url: "/api/settings", headers: { authorization }, payload: { workerConcurrency: 1 } })).statusCode, 403);
    assert.equal((await application.app.inject({ method: "GET", url: "/api/tasks", headers: { authorization: `Bearer ${secret}` } })).statusCode, 200);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});
