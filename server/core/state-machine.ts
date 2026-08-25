import type { TaskStatus } from "./types.js";

const transitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["preparing", "cancelled"]),
  preparing: new Set(["running", "waiting_timer", "waiting_retry", "failed", "cancelled"]),
  waiting_timer: new Set(["queued", "cancelled"]),
  waiting_external: new Set(["queued", "cancelled"]),
  waiting_approval: new Set(["queued", "cancelled"]),
  waiting_retry: new Set(["queued", "failed", "cancelled"]),
  running: new Set(["verifying", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry", "failed", "cancelled"]),
  verifying: new Set(["running", "waiting_approval", "waiting_retry", "succeeded", "failed", "cancelled"]),
  succeeded: new Set(["queued"]),
  failed: new Set(["queued"]),
  cancelled: new Set(["queued"]),
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].has(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
