import assert from "node:assert/strict";
import test from "node:test";
import { selectCoreActivityEvents, type ActivityEvent } from "../../app/lib/core-activity.ts";

function event(id: number, type: string, payload: Record<string, unknown> = {}): ActivityEvent {
  return { id, type, payload: { schemaVersion: 1, ...payload }, createdAt: new Date(id * 1_000).toISOString() };
}

test("shows only core conversation activity and collapses transient updates", () => {
  const visible = selectCoreActivityEvents([
    event(1, "task.preparing", { title: "准备本轮任务" }),
    event(2, "memory.loaded", { title: "加载记忆" }),
    event(3, "agent.turn.usage", { usage: { totalTokens: 10 } }),
    event(4, "agent.tool.started", { toolCallId: "command-1", title: "执行命令", item: { type: "commandExecution" } }),
    event(5, "agent.tool.output", { toolCallId: "command-1", detail: "chunk" }),
    event(6, "agent.tool.completed", { toolCallId: "command-1", title: "执行命令完成", item: { type: "commandExecution" } }),
    event(7, "agent.step.started", { stepId: "reasoning-1", title: "模型正在分析", item: { type: "reasoning" } }),
    event(8, "agent.step.updated", { stepId: "reasoning-1", title: "正在分析与规划", detail: "先检查文件，再运行测试", item: { type: "reasoning" } }),
    event(9, "agent.step.completed", { stepId: "reasoning-1", title: "推理摘要", detail: "确认修改方案", item: { type: "reasoning" } }),
    event(10, "agent.workspace.diff", { diff: "noise" }),
    event(11, "verification.started", { title: "开始验证" }),
    event(12, "verification.completed", { title: "验证通过", phase: "completed" }),
    event(13, "memory.updated", { title: "保存记忆" }),
  ]);

  assert.deepEqual(visible.map(({ id }) => id), [6, 9, 12]);
  assert.equal(visible[1]?.payload.detail, "确认修改方案");
});

test("keeps approvals, durable waits and errors while hiding separately rendered relations", () => {
  const visible = selectCoreActivityEvents([
    event(1, "approval.requested", { approvalId: "a1", title: "需要批准" }),
    event(2, "approval.notification.sent", { approvalId: "a1" }),
    event(3, "approval.resolved", { approvalId: "a1", title: "已批准" }),
    event(4, "task.waiting", { title: "持久化等待" }),
    event(5, "child-task.created", { title: "已委派" }),
    event(6, "turn.workspace.summary", { changeCount: 2 }),
    event(7, "agent.runtime.error", { title: "运行时错误", phase: "failed" }),
    event(8, "task.lease.recovered", { title: "Worker 租约过期，任务已恢复到队列" }),
    event(9, "goal.dependency.added", { dependsOnTaskId: "goal-a", title: "已设置前置目标 A" }),
    event(10, "goal.dependency.removed", { dependsOnTaskId: "goal-a", title: "已移除前置目标 A" }),
  ]);

  assert.deepEqual(visible.map(({ id }) => id), [3, 4, 7, 8, 10]);
});

test("keeps commands and reasoning from older persisted event formats", () => {
  const visible = selectCoreActivityEvents([
    event(1, "item.started", { event: { item: { id: "old-command", type: "command_execution", command: "npm test" } } }),
    event(2, "item.completed", { event: { item: { id: "old-command", type: "command_execution", command: "npm test" } } }),
    event(3, "item.completed", { event: { item: { id: "old-reasoning", type: "reasoning", text: "检查实现" } } }),
    event(4, "tool.started", { tool: "workspace.inspect", command: "git status" }),
    event(5, "tool.completed", { tool: "workspace.inspect", output: "clean" }),
  ]);

  assert.deepEqual(visible.map(({ id }) => id), [2, 3, 5]);
});
