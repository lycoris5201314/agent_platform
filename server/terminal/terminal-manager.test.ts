import assert from "node:assert/strict";
import test from "node:test";
import { shouldSweepTerminalSession } from "./terminal-manager.js";

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
