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
    const result = await new Verifier().verify(createWorkspaceHandle(directory, "native", ""), (phase, check) => callbacks.push(`${phase}:${check.id}`));
    assert.ok(result.projectTypes.includes("generic"));
    assert.ok(result.checks.some((check) => check.id === "git-diff-check"));
    assert.ok(callbacks.includes("started:git-diff-check"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
