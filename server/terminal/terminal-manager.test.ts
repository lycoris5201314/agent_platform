import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableTerminalStartupFailure, replayTerminalOutput, shouldSweepTerminalSession } from "./terminal-manager.js";

test("keeps visible terminals and reclaims hidden idle or exited sessions", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  const stale = { status: "running" as const, lastActiveAt: "2026-09-22T11:00:00.000Z" };
  const recent = { status: "running" as const, lastActiveAt: "2026-09-22T11:59:30.000Z" };
  const exited = { status: "exited" as const, lastActiveAt: "2026-09-22T12:00:00.000Z" };

  assert.equal(shouldSweepTerminalSession(stale, 1, now - 30 * 60_000), false, "a visible terminal must remain active");
  assert.equal(shouldSweepTerminalSession(stale, 0, now - 30 * 60_000), true, "a hidden stale terminal should be reclaimed");
  assert.equal(shouldSweepTerminalSession(recent, 0, now - 30 * 60_000), false, "a recently active hidden terminal should remain available");
  assert.equal(shouldSweepTerminalSession(exited, 0, now - 30 * 60_000), true, "an exited hidden terminal should be removed");
});

test("replays only terminal output missing after an SSE reconnect", () => {
  const session = { output: "456789", outputOffset: 4 };
  assert.deepEqual(replayTerminalOutput(session, 0), { data: "456789", offset: 10 }, "a new subscriber receives the retained buffer");
  assert.deepEqual(replayTerminalOutput(session, 7), { data: "789", offset: 10 }, "a reconnect resumes after its last event id");
  assert.deepEqual(replayTerminalOutput(session, 2), { data: "456789", offset: 10 }, "a subscriber older than the retained buffer receives what remains");
  assert.equal(replayTerminalOutput(session, 10), null, "an up-to-date subscriber receives no duplicate output");
  assert.equal(replayTerminalOutput(session, 99), null, "a future offset does not duplicate the buffer");
});

test("only retries the transient missing sandbox home startup failure", () => {
  assert.equal(isRetryableTerminalStartupFailure('CODEX_HOME points to "C:\\\\Temp\\\\codex-sandbox", but that path does not exist'), true);
  assert.equal(isRetryableTerminalStartupFailure("PowerShell executable was not found"), false);
  assert.equal(isRetryableTerminalStartupFailure("Access is denied"), false);
});
