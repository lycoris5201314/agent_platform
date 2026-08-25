import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, isTerminal } from "./state-machine.js";

test("allows the durable timer wake-up loop", () => {
  assert.equal(canTransition("preparing", "waiting_timer"), true);
  assert.equal(canTransition("waiting_timer", "queued"), true);
});

test("rejects skipping verification", () => {
  assert.throws(() => assertTransition("running", "succeeded"), /Invalid task transition/);
});

test("recognizes terminal states", () => {
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("running"), false);
});

test("allows a completed conversation to accept another turn", () => {
  assert.equal(canTransition("succeeded", "queued"), true);
  assert.equal(canTransition("running", "queued"), false);
});
