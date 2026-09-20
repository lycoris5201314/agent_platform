import assert from "node:assert/strict";
import test from "node:test";
import { clampDetachedWindowPosition, conversationWindowUrl, isPointOutsideWindow, isScreenPoint } from "../../desktop/window-detach.js";

test("only detaches a conversation after the pointer leaves its source window", () => {
  const bounds = { x: 100, y: 80, width: 1200, height: 800 };
  assert.equal(isPointOutsideWindow({ x: 500, y: 400 }, bounds), false);
  assert.equal(isPointOutsideWindow({ x: 90, y: 400 }, bounds), true);
  assert.equal(isPointOutsideWindow({ x: 1310, y: 400 }, bounds), true);
  assert.equal(isScreenPoint({ x: -200, y: 50 }), true);
  assert.equal(isScreenPoint({ x: "20", y: 50 }), false);
});

test("keeps a detached conversation visible on the nearest display", () => {
  const position = clampDetachedWindowPosition(
    { x: 2500, y: 1300 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
    { width: 1000, height: 760 },
  );
  assert.deepEqual(position, { x: 2428, y: 320 });
});

test("builds an isolated conversation URL without losing API routing", () => {
  const url = new URL(conversationWindowUrl("http://127.0.0.1:3000", "http://127.0.0.1:8788", "task-123"));
  assert.equal(url.searchParams.get("api"), "http://127.0.0.1:8788");
  assert.equal(url.searchParams.get("task"), "task-123");
  assert.equal(url.searchParams.get("detached"), "1");
});
