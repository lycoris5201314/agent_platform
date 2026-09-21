import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyTaskResponse } from "../../app/lib/task-requests.ts";

test("applies async task responses only to the conversation that requested them", () => {
  assert.equal(shouldApplyTaskResponse("task-a", "task-a"), true);
  assert.equal(shouldApplyTaskResponse("task-b", "task-a"), false);
  assert.equal(shouldApplyTaskResponse(null, "task-a"), false);
});
