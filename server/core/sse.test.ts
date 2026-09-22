import assert from "node:assert/strict";
import test from "node:test";
import { encodeSseEvent, sseResumeOffset } from "./sse.js";

test("resumes SSE from the newest valid query or Last-Event-ID offset", () => {
  assert.equal(sseResumeOffset("12", "18"), 18);
  assert.equal(sseResumeOffset("12", undefined), 12);
  assert.equal(sseResumeOffset(undefined, "7"), 7);
  assert.equal(sseResumeOffset("invalid", "also-invalid"), 0);
  assert.equal(sseResumeOffset("-2", "3.5"), 0);
});

test("encodes an SSE id before its JSON payload", () => {
  assert.equal(encodeSseEvent(42, { type: "task.running" }), 'id: 42\ndata: {"type":"task.running"}\n\n');
});
