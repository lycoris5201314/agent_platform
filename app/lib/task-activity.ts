export type ActivityStatus =
  | "queued" | "preparing" | "waiting_timer" | "waiting_external" | "waiting_approval"
  | "waiting_retry" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";

export type ActivityTask = { id: string; title: string; status: ActivityStatus; error?: string | null };

export type TaskAlert = { title: string; body: string; kind: "completed" | "failed" | "attention" };

const runningStatuses = new Set<ActivityStatus>(["queued", "preparing", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry", "running", "verifying"]);

export function isActivityTask(task: ActivityTask, unread: ReadonlySet<string>): boolean {
  return runningStatuses.has(task.status) || unread.has(task.id);
}

export function taskTransitionAlert(previous: ActivityStatus | undefined, task: ActivityTask): TaskAlert | null {
  if (!previous || previous === task.status) return null;
  if (task.status === "succeeded") return { kind: "completed", title: "任务已完成", body: task.title };
  if (task.status === "failed") return { kind: "failed", title: "任务执行失败", body: task.error ? `${task.title}：${task.error}` : task.title };
  if (task.status === "waiting_approval") return { kind: "attention", title: "任务等待批准", body: task.title };
  if (task.status === "waiting_external") return { kind: "attention", title: "任务等待外部输入", body: task.title };
  return null;
}
