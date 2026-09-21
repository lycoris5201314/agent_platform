import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const assetsDirectory = path.resolve("dist/client/assets");

async function matchingAssets(prefix) {
  const names = await readdir(assetsDirectory);
  return names.filter((name) => name.startsWith(prefix) && name.endsWith(".js"));
}

test("keeps the main console bundle small and optional features split", async () => {
  const consoleAssets = await matchingAssets("AgentConsole-");
  assert.equal(consoleAssets.length, 1, "expected one AgentConsole client chunk");
  const consoleSize = (await stat(path.join(assetsDirectory, consoleAssets[0]))).size;
  assert.ok(consoleSize < 180 * 1024, `AgentConsole chunk is ${(consoleSize / 1024).toFixed(1)} KB; budget is 180 KB`);

  assert.ok((await matchingAssets("MarkdownContent-")).length > 0, "Markdown renderer must remain lazy-loaded");
  assert.ok((await matchingAssets("TerminalPanel-")).length > 0, "terminal must remain lazy-loaded");
  assert.ok((await matchingAssets("AutomationsPanel-")).length > 0, "automations must remain lazy-loaded");
});
