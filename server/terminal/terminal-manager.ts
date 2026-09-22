import { randomUUID } from "node:crypto";
import path from "node:path";
import * as pty from "node-pty";
import type { AgentTask, TaskSandboxMode, WorkspaceHandle } from "../core/types.js";
import { codexPermissionProfile, codexSandboxEnvironment, resolveCodexExecutable } from "../workspace/wsl-workspace.js";

const MAX_OUTPUT_CHARS = 240_000;
export const TERMINAL_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface TerminalSessionView {
  id: string;
  taskId: string;
  cwd: string;
  shell: string;
  sandboxMode: TaskSandboxMode;
  permissionProfile: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: string;
  lastActiveAt: string;
  output: string;
  outputOffset: number;
}

interface TerminalSession extends TerminalSessionView {
  process: pty.IPty;
  subscribers: Set<(chunk: { data: string; offset: number }) => void>;
  closed: Promise<void>;
  resolveClosed: () => void;
  closing: boolean;
}

export function shouldSweepTerminalSession(
  session: Pick<TerminalSessionView, "status" | "lastActiveAt">,
  subscriberCount: number,
  cutoff: number,
): boolean {
  return subscriberCount === 0 && (session.status === "exited" || Date.parse(session.lastActiveAt) <= cutoff);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function windowsPowerShell(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function launchSpec(workspace: WorkspaceHandle, sandboxMode: TaskSandboxMode): { executable: string; args: string[]; cwd: string; shell: string; permissionProfile: string } {
  if (workspace.containerId) {
    return {
      executable: process.env.DOCKER_PATH ?? "docker",
      args: ["exec", "-it", "-w", workspace.runtimePath ?? "/workspace", workspace.containerId, "sh", "-l"],
      cwd: process.cwd(), shell: "Docker shell", permissionProfile: "container",
    };
  }
  if (workspace.kind === "wsl2") {
    return {
      executable: "wsl.exe",
      args: ["-d", workspace.distro, "--cd", workspace.wslPath, "--", "bash", "-l"],
      cwd: workspace.windowsPath, shell: `${workspace.distro} · bash`, permissionProfile: "wsl2",
    };
  }
  if (process.platform === "win32") {
    const codexPath = resolveCodexExecutable();
    const profile = codexPermissionProfile(sandboxMode);
    return {
      executable: codexPath,
      args: ["sandbox", "-P", profile, "-C", workspace.windowsPath, "--", windowsPowerShell(), "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass"],
      cwd: workspace.windowsPath, shell: "Windows PowerShell", permissionProfile: profile,
    };
  }
  return { executable: "sh", args: ["-l"], cwd: workspace.windowsPath, shell: "shell", permissionProfile: sandboxMode };
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  open(task: AgentTask, workspace: WorkspaceHandle, columns = 100, rows = 28): TerminalSessionView {
    const existing = [...this.sessions.values()].find((session) => session.taskId === task.id && session.status === "running");
    if (existing) return this.view(existing);
    const spec = launchSpec(workspace, task.sandboxMode);
    const now = new Date().toISOString();
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const child = pty.spawn(spec.executable, spec.args, {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(columns, 400)),
      rows: Math.max(5, Math.min(rows, 200)),
      cwd: spec.cwd,
      env: { ...(process.platform === "win32" && workspace.kind === "native" ? codexSandboxEnvironment() : process.env), TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
      useConpty: process.platform === "win32",
      useConptyDll: process.platform === "win32",
    });
    const session: TerminalSession = {
      id: randomUUID(), taskId: task.id, cwd: workspace.windowsPath, shell: spec.shell,
      sandboxMode: task.sandboxMode, permissionProfile: spec.permissionProfile,
      status: "running", exitCode: null, createdAt: now, lastActiveAt: now,
      output: "", outputOffset: 0, process: child, subscribers: new Set(), closed, resolveClosed, closing: false,
    };
    this.sessions.set(session.id, session);
    // node-pty's Windows implementation otherwise rethrows transient pipe
    // errors as uncaught exceptions. Keep them inside the terminal lifecycle
    // so one unhealthy ConPTY session cannot terminate the API process.
    const handleTerminalError = (error: NodeJS.ErrnoException) => {
      if (session.status !== "running") return;
      session.status = "exited";
      session.exitCode = -1;
      session.lastActiveAt = new Date().toISOString();
      const data = `\r\n[终端连接异常：${error.code ?? error.message}]\r\n`;
      session.output += data;
      const offset = session.outputOffset + session.output.length;
      for (const subscriber of session.subscribers) subscriber({ data, offset });
      session.resolveClosed();
    };
    const windowsChild = child as unknown as {
      on: (event: string, listener: (error: NodeJS.ErrnoException) => void) => void;
      _agent?: { inSocket?: { on: (event: string, listener: (error: NodeJS.ErrnoException) => void) => void } };
    };
    windowsChild.on("error", handleTerminalError);
    windowsChild._agent?.inSocket?.on("error", handleTerminalError);
    child.onData((data) => {
      session.lastActiveAt = new Date().toISOString();
      session.output += data;
      if (session.output.length > MAX_OUTPUT_CHARS) {
        const removed = session.output.length - MAX_OUTPUT_CHARS;
        session.output = session.output.slice(removed);
        session.outputOffset += removed;
      }
      const offset = session.outputOffset + session.output.length;
      for (const subscriber of session.subscribers) subscriber({ data, offset });
    });
    child.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.lastActiveAt = new Date().toISOString();
      const data = `\r\n[终端已退出，代码 ${exitCode}]\r\n`;
      session.output += data;
      const offset = session.outputOffset + session.output.length;
      for (const subscriber of session.subscribers) subscriber({ data, offset });
      session.resolveClosed();
    });
    return this.view(session);
  }

  list(taskId: string): TerminalSessionView[] {
    return [...this.sessions.values()].filter((session) => session.taskId === taskId).map((session) => this.view(session));
  }

  get(taskId: string, sessionId: string): TerminalSessionView | null {
    const session = this.sessionFor(taskId, sessionId);
    return session ? this.view(session) : null;
  }

  async write(taskId: string, sessionId: string, data: string): Promise<void> {
    const session = this.requireRunning(taskId, sessionId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        session.process.write(data);
        session.lastActiveAt = new Date().toISOString();
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EAGAIN" || attempt === 4) throw error;
        await delay(40 * 2 ** attempt);
      }
    }
  }

  resize(taskId: string, sessionId: string, columns: number, rows: number): void {
    const session = this.requireRunning(taskId, sessionId);
    session.process.resize(Math.max(20, Math.min(columns, 400)), Math.max(5, Math.min(rows, 200)));
  }

  async close(taskId: string, sessionId: string): Promise<void> {
    const session = this.sessionFor(taskId, sessionId);
    if (!session) return;
    await this.stopSession(session);
    this.sessions.delete(session.id);
  }

  async sweepIdle(maxIdleMs = TERMINAL_IDLE_TIMEOUT_MS, now = Date.now()): Promise<string[]> {
    const cutoff = now - Math.max(0, maxIdleMs);
    const removable = [...this.sessions.values()].filter((session) => shouldSweepTerminalSession(session, session.subscribers.size, cutoff));
    await Promise.allSettled(removable.map((session) => this.stopSession(session)));
    for (const session of removable) this.sessions.delete(session.id);
    return removable.map((session) => session.id);
  }

  subscribe(taskId: string, sessionId: string, subscriber: (chunk: { data: string; offset: number }) => void): () => void {
    const session = this.sessionFor(taskId, sessionId);
    if (!session) throw new Error("Terminal session not found");
    session.subscribers.add(subscriber);
    return () => session.subscribers.delete(subscriber);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => this.stopSession(session)));
    this.sessions.clear();
  }

  private async stopSession(session: TerminalSession): Promise<void> {
    if (session.status !== "running") return;
    if (session.closing) {
      await Promise.race([session.closed, delay(2_500)]);
      return;
    }
    session.closing = true;

    // Let the interactive shell release its ConPTY handles itself. Calling
    // node-pty.kill() twice, or immediately after a DELETE request, can leave the
    // native Windows host in a corrupt state during Electron shutdown.
    try {
      session.process.write("\x03");
      await delay(100);
      session.process.write(process.platform === "win32" ? "exit\r" : "exit\n");
    } catch {
      // The process may already have closed between the status check and write.
    }

    const exitedGracefully = await Promise.race([
      session.closed.then(() => true),
      delay(1_200).then(() => false),
    ]);
    if (!exitedGracefully && session.status === "running") {
      try { session.process.kill(); } catch { /* already closed */ }
      await Promise.race([session.closed, delay(1_500)]);
    }
  }

  private sessionFor(taskId: string, sessionId: string): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    return session?.taskId === taskId ? session : null;
  }

  private requireRunning(taskId: string, sessionId: string): TerminalSession {
    const session = this.sessionFor(taskId, sessionId);
    if (!session) throw new Error("Terminal session not found");
    if (session.status !== "running") throw new Error("Terminal session has exited");
    return session;
  }

  private view(session: TerminalSession): TerminalSessionView {
    return {
      id: session.id, taskId: session.taskId, cwd: session.cwd, shell: session.shell,
      sandboxMode: session.sandboxMode, permissionProfile: session.permissionProfile,
      status: session.status, exitCode: session.exitCode, createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt, output: session.output, outputOffset: session.outputOffset,
    };
  }
}
