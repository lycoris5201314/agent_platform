import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Verifier } from "./verifier.js";
import { createWorkspaceHandle } from "../workspace/wsl-workspace.js";

test("detects a generic project and emits layered check callbacks", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-verifier-"));
  try {
    mkdirSync(path.join(directory, ".git"));
    writeFileSync(path.join(directory, "README.md"), "ok");
    const callbacks: string[] = [];
    const executors = new Map<string, string>();
    const result = await new Verifier().verify(createWorkspaceHandle(directory, "native", ""), (phase, check) => {
      callbacks.push(`${phase}:${check.id}`);
      if (phase === "started") executors.set(check.id, check.executor);
    });
    assert.ok(result.projectTypes.includes("generic"));
    assert.ok(result.checks.some((check) => check.id === "git-diff-check"));
    assert.ok(callbacks.includes("started:git-diff-check"));
    assert.equal(executors.get("git-diff-check"), "host", "read-only Git verification must not depend on the Codex sandbox helper");
    assert.equal(executors.get("git-status"), "host", "read-only Git verification must remain reliable after repeated runs");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allows an ordinary Windows workspace when Git is not installed or initialized", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-foundry-no-git-"));
  try {
    writeFileSync(path.join(directory, "notes.txt"), "works without Git");
    const result = await new Verifier().verify(createWorkspaceHandle(directory, "native", ""));
    assert.equal(result.passed, true);
    assert.ok(!result.checks.some((check) => check.id.startsWith("git-")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
