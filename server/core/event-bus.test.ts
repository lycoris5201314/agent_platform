import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, isTaskListActivity } from "./event-bus.js";
import type { TaskEvent } from "./types.js";

function event(taskId: string, type: string, id = 1): TaskEvent {
  return { id, taskId, type, payload: {}, createdAt: new Date(0).toISOString() };
}

test("broadcasts task activity without mixing task-specific subscriptions", () => {
  const bus = new EventBus();
  const taskEvents: string[] = [];
  const globalEvents: string[] = [];
  const unsubscribeTask = bus.subscribe("task-a", (value) => taskEvents.push(`${value.taskId}:${value.type}`));
  const unsubscribeAll = bus.subscribeAll((value) => globalEvents.push(`${value.taskId}:${value.type}`));

  bus.publish(event("task-a", "task.running", 1));
  bus.publish(event("task-b", "task.succeeded", 2));
  unsubscribeTask();
  unsubscribeAll();
  bus.publish(event("task-a", "task.failed", 3));

  assert.deepEqual(taskEvents, ["task-a:task.running"]);
  assert.deepEqual(globalEvents, ["task-a:task.running", "task-b:task.succeeded"]);
});

test("only task-list-relevant events trigger global list refreshes", () => {
  for (const type of ["task.running", "goal.completed", "child-task.created", "conversation.branch.created", "automation.task.created"]) {
    assert.equal(isTaskListActivity(event("task", type)), true, type);
  }
  for (const type of ["agent.tool.started", "agent.reasoning.delta", "terminal.command.completed", "memory.updated"]) {
    assert.equal(isTaskListActivity(event("task", type)), false, type);
  }
});
