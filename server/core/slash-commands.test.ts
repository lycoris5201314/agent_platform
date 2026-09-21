import assert from "node:assert/strict";
import test from "node:test";
import { matchingSlashCommands } from "../../app/lib/slash-commands.js";
import { isActivityTask, taskTransitionAlert } from "../../app/lib/task-activity.js";

test("slash commands filter by text and current task capability", () => {
  const idle = { hasTask: true, hasThread: true, active: false, detached: false };
  assert.deepEqual(matchingSlashCommands("/comp", idle).map((command) => command.name), ["compact"]);
  assert.deepEqual(matchingSlashCommands("/goals", idle).map((command) => command.name), ["goals"]);
  assert.equal(matchingSlashCommands("/goals", { ...idle, detached: true }).length, 0);
  assert.equal(matchingSlashCommands("/stop", idle).length, 0);
  assert.deepEqual(matchingSlashCommands("/stop", { ...idle, active: true }).map((command) => command.name), ["stop"]);
  assert.equal(matchingSlashCommands("/compact now", idle).length, 0);
});

test("activity helpers only alert on meaningful task transitions", () => {
  assert.equal(taskTransitionAlert("running", { id: "1", title: "完成报告", status: "succeeded" })?.kind, "completed");
  assert.equal(taskTransitionAlert("running", { id: "1", title: "继续执行", status: "running" }), null);
  assert.equal(taskTransitionAlert(undefined, { id: "1", title: "首次载入", status: "failed" }), null);
  assert.equal(isActivityTask({ id: "1", title: "运行中", status: "running" }, new Set()), true);
  assert.equal(isActivityTask({ id: "2", title: "已读完成", status: "succeeded" }, new Set()), false);
  assert.equal(isActivityTask({ id: "2", title: "未读完成", status: "succeeded" }, new Set(["2"])), true);
});
