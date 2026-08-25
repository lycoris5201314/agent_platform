import type { TaskEvent } from "./types.js";

type Listener = (event: TaskEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: TaskEvent): void {
    for (const listener of this.listeners.get(event.taskId) ?? []) {
      listener(event);
    }
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
}
