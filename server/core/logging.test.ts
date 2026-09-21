import assert from "node:assert/strict";
import test from "node:test";
import { resolveServerLogLevel } from "./logging.ts";

test("server logging defaults to warnings to keep packaged polling quiet", () => {
  assert.equal(resolveServerLogLevel(undefined), "warn");
  assert.equal(resolveServerLogLevel(""), "warn");
  assert.equal(resolveServerLogLevel("verbose"), "warn");
});

test("server logging accepts explicit diagnostic levels", () => {
  assert.equal(resolveServerLogLevel("info"), "info");
  assert.equal(resolveServerLogLevel(" DEBUG "), "debug");
  assert.equal(resolveServerLogLevel("SILENT"), "silent");
});
