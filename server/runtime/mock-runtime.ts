import type { AgentRuntime, RuntimeContext, RuntimeResult } from "./runtime.js";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export class MockRuntime implements AgentRuntime {
  readonly id = "mock" as const;

  async run({ task, memory, workspace, signal, emit }: RuntimeContext): Promise<RuntimeResult> {
    emit("agent.plan", {
      summary: "分析目标、检查工作区、执行实现并验证结果",
      steps: ["读取任务上下文", "执行受控修改", "运行验证闭环"],
    });
    await pause(350, signal);
    emit("tool.started", { tool: "workspace.inspect", command: "git status --short", cwd: workspace.runtimePath ?? workspace.windowsPath });
    await pause(450, signal);
    emit("tool.completed", { tool: "workspace.inspect", exitCode: 0, output: "工作区已就绪" });
    await pause(300, signal);
    emit("agent.message", { text: `已完成“${task.title}”的演示执行。当前会话已持久化 ${memory.messageCount} 条消息，可继续发送下一条指令。` });
    return {
      kind: "completed",
      finalResponse: memory.messageCount > 1
        ? `任务“${task.title}”的本轮演示已完成。Mock runtime 已读取 ${memory.messageCount} 条持久化会话消息。记忆片段：${memory.summary.slice(-600)}`
        : `任务“${task.title}”已完成。当前使用 Mock runtime 验证了队列、事件流、持久化等待与验证闭环。`,
    };
  }
}
