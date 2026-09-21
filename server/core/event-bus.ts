import type { TaskEvent } from "./types.js";

type Listener = (event: TaskEvent) => void;

export function isTaskListActivity(event: TaskEvent): boolean {
  return event.type.startsWith("task.")
    || event.type.startsWith("goal.")
    || event.type === "child-task.created"
    || event.type === "conversation.branch.created"
    || event.type === "conversation.branch.origin"
    || event.type === "automation.task.created";
}

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly globalListeners = new Set<Listener>();

  publish(event: TaskEvent): void {
    for (const listener of this.listeners.get(event.taskId) ?? []) {
      listener(event);
    }
    for (const listener of this.globalListeners) listener(event);
  }

  subscribe(taskId: string, listener: Listener): () => void {
    const taskListeners = this.listeners.get(taskId) ?? new Set<Listener>();
    taskListeners.add(listener);
    this.listeners.set(taskId, taskListeners);
    return () => {
      taskListeners.delete(listener);
      if (taskListeners.size === 0) this.listeners.delete(taskId);
    };
  }

  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }
}
