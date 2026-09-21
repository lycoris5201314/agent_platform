import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { AgentTask, TaskSandboxMode, WorkspaceHandle, WorkspaceKind } from "../core/types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

function nativeCommand(command: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable: command, args };
  const shim = command.replace(/\.cmd$/i, "").toLowerCase();
  if (!["npm", "npx", "pnpm", "yarn"].includes(shim)) return { executable: command, args };
  return {
    executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `${shim}.cmd`, ...args],
  };
}

export function codexPermissionProfile(mode: TaskSandboxMode): ":read-only" | ":workspace" | ":danger-full-access" {
  if (mode === "read-only") return ":read-only";
  if (mode === "danger-full-access") return ":danger-full-access";
  return ":workspace";
}

export function resolveCodexExecutable(): string {
  const bundled = path.resolve("node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const executable = process.env.CODEX_PATH?.trim() || (fsSync.existsSync(bundled) ? bundled : "");
  if (!executable) throw new Error("Windows 沙箱运行时未配置：缺少 CODEX_PATH");
  return executable;
}

export function codexSandboxEnvironment(): NodeJS.ProcessEnv {
  const sandboxHome = path.resolve(process.env.AGENT_FOUNDRY_SANDBOX_CODEX_HOME?.trim() || path.join(process.cwd(), ".agent-data", "codex-sandbox", String(process.pid)));
  fsSync.mkdirSync(sandboxHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: sandboxHome, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent_foundry_local" };
  for (const inherited of ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_CI", "CODEX_PERMISSION_PROFILE", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY"]) delete environment[inherited];
  return environment;
}

export function nativeSandboxCommand(
  workspace: WorkspaceHandle,
  sandboxMode: TaskSandboxMode,
  command: string,
  args: string[],
): { executable: string; args: string[]; cwd: string } {
  const executable = resolveCodexExecutable();
  const native = nativeCommand(command, args);
  return {
    executable,
    args: ["sandbox", "-P", codexPermissionProfile(sandboxMode), "-C", workspace.windowsPath, "--", native.executable, ...native.args],
    cwd: workspace.windowsPath,
  };
}

export function runOnHost(
  workingDirectory: string,
  command: string,
  args: string[],
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  const native = nativeCommand(command, args);
  return runProcess(native.executable, native.args, { cwd: workingDirectory, env, timeoutMs });
}

export function toWslPath(windowsPath: string): string {
  const normalized = path.resolve(windowsPath).replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!drive) return normalized;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

export function runInWsl(
  distro: string,
  workingDirectory: string,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return runProcess("wsl.exe", ["-d", distro, "--cd", toWslPath(workingDirectory), "--", command, ...args], {
    env: { ...process.env, WSL_UTF8: "1" }, timeoutMs,
  });
}

export function createWorkspaceHandle(windowsPath: string, kind: Exclude<WorkspaceKind, "docker">, distro: string): WorkspaceHandle {
  const absolute = path.resolve(windowsPath);
  return {
    kind,
    windowsPath: absolute,
    wslPath: kind === "wsl2" ? toWslPath(absolute) : absolute,
    distro: kind === "wsl2" ? distro : "",
    runtimePath: kind === "wsl2" ? toWslPath(absolute) : absolute,
  };
}

export function workspaceRuntimePath(workspace: WorkspaceHandle, windowsPath = workspace.windowsPath): string {
  if (workspace.containerId) return workspace.runtimePath ?? "/workspace";
  return workspace.kind === "wsl2" ? toWslPath(windowsPath) : path.resolve(windowsPath);
}

export function runInWorkspacePty(
  workspace: WorkspaceHandle,
  command: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  if (workspace.containerId) {
    return runOnHost(process.cwd(), process.env.DOCKER_PATH ?? "docker", [
      "exec", "-w", workspace.runtimePath ?? "/workspace", workspace.containerId,
      "script", "-qefc", command, "/dev/null",
    ], timeoutMs);
  }
  if (workspace.kind === "wsl2") {
    return runInWsl(workspace.distro, workspace.windowsPath, "script", ["-qefc", command, "/dev/null"], timeoutMs);
  }
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return runProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: workspace.windowsPath, env: process.env, timeoutMs,
    });
  }
  return runProcess("sh", ["-lc", command], { cwd: workspace.windowsPath, env: process.env, timeoutMs });
}

export function runInWorkspace(
  workspace: WorkspaceHandle,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  if (workspace.containerId) {
    return runOnHost(process.cwd(), process.env.DOCKER_PATH ?? "docker", ["exec", "-w", workspace.runtimePath ?? "/workspace", workspace.containerId, command, ...args], timeoutMs);
  }
  if (workspace.kind === "wsl2") return runInWsl(workspace.distro, workspace.windowsPath, command, args, timeoutMs);
  return runOnHost(workspace.windowsPath, command, args, timeoutMs);
}

/** Execute every platform-owned native command under the same Codex Windows sandbox policy as the agent. */
export function runInWorkspaceSandboxed(
  workspace: WorkspaceHandle,
  sandboxMode: TaskSandboxMode,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  if (workspace.kind !== "native" || process.platform !== "win32") {
    return runInWorkspace(workspace, command, args, timeoutMs);
  }
  const launch = nativeSandboxCommand(workspace, sandboxMode, command, args);
  return runProcess(launch.executable, launch.args, { cwd: launch.cwd, env: codexSandboxEnvironment(), timeoutMs });
}

export function runInWorkspaceEnv(
  workspace: WorkspaceHandle,
  variables: Record<string, string>,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  if (workspace.containerId) {
    const environment = Object.entries(variables).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return runOnHost(process.cwd(), process.env.DOCKER_PATH ?? "docker", ["exec", ...environment, "-w", workspace.runtimePath ?? "/workspace", workspace.containerId, command, ...args], timeoutMs);
  }
  if (workspace.kind === "wsl2") {
    return runInWsl(workspace.distro, workspace.windowsPath, "env", [...Object.entries(variables).map(([key, value]) => `${key}=${value}`), command, ...args], timeoutMs);
  }
  return runOnHost(workspace.windowsPath, command, args, timeoutMs, { ...process.env, ...variables });
}

export function runInWorkspaceWithInput(
  workspace: WorkspaceHandle,
  command: string,
  args: string[],
  input: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  if (workspace.containerId) {
    return runProcess(process.env.DOCKER_PATH ?? "docker", ["exec", "-i", "-w", workspace.runtimePath ?? "/workspace", workspace.containerId, command, ...args], { input, timeoutMs });
  }
  if (workspace.kind === "wsl2") {
    return runProcess("wsl.exe", ["-d", workspace.distro, "--cd", workspace.wslPath, "--", command, ...args], {
      env: { ...process.env, WSL_UTF8: "1" }, input, timeoutMs,
    });
  }
  const native = nativeCommand(command, args);
  return runProcess(native.executable, native.args, { cwd: workspace.windowsPath, env: process.env, input, timeoutMs });
}

export class WorkspaceManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly kind: Exclude<WorkspaceKind, "docker">,
    private readonly distro: string,
  ) {}

  handle(windowsPath: string): WorkspaceHandle {
    return createWorkspaceHandle(windowsPath, this.kind, this.distro);
  }

  async prepare(task: AgentTask): Promise<WorkspaceHandle> {
    const workspace = this.handle(task.workspacePath ?? path.join(this.workspaceRoot, task.id));
    await fs.mkdir(workspace.windowsPath, { recursive: true });
    try {
      await fs.access(path.join(workspace.windowsPath, ".git"));
    } catch {
      try {
        const result = await runInWorkspace(workspace, "git", ["init", "--quiet"]);
        if (result.code !== 0) throw new Error(`${this.kind === "wsl2" ? "WSL2" : "Windows"} git init failed: ${result.stderr.trim()}`);
      } catch (error) {
        // Native Windows can still run ordinary conversations, file tools and PowerShell
        // without Git. Git-only features report their own actionable error when invoked.
        if (this.kind !== "native" || !isMissingExecutable(error)) throw error;
      }
    }
    return workspace;
  }

  async health(): Promise<{ available: boolean; detail: string }> {
    try {
      if (this.kind === "wsl2") {
        const result = await runInWsl(this.distro, process.cwd(), "sh", ["-lc", "printf ready"], 5_000);
        return { available: result.code === 0, detail: result.stdout.trim() || result.stderr.trim() };
      }
      try {
        const result = await runOnHost(process.cwd(), "git", ["--version"], 5_000);
        return { available: true, detail: result.code === 0 ? `Windows native · ${result.stdout.trim()}` : "Windows native · Git 不可用（仅 Git 功能受限）" };
      } catch (error) {
        if (isMissingExecutable(error)) return { available: true, detail: "Windows native · Git 未安装（普通任务可用）" };
        throw error;
      }
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

// Backward-compatible export for older integrations; new code should use WorkspaceManager.
export const WslWorkspaceManager = WorkspaceManager;
