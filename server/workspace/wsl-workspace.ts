import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTask, WorkspaceHandle } from "../core/types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runOnHost(
  workingDirectory: string,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const useCmd = process.platform === "win32" && command === "npm";
    const executable = useCmd ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : command;
    const commandArgs = useCmd ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    const child = spawn(executable, commandArgs, {
      cwd: workingDirectory,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Host command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
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
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", distro, "--cd", toWslPath(workingDirectory), "--", command, ...args], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`WSL command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function runInWslPty(
  distro: string,
  workingDirectory: string,
  command: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return runInWsl(distro, workingDirectory, "script", ["-qefc", command, "/dev/null"], timeoutMs);
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
  return runInWslPty(workspace.distro, workspace.windowsPath, command, timeoutMs);
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
  return runInWsl(workspace.distro, workspace.windowsPath, command, args, timeoutMs);
}

export class WslWorkspaceManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly distro: string,
  ) {}

  async prepare(task: AgentTask): Promise<WorkspaceHandle> {
    const windowsPath = path.resolve(task.workspacePath ?? path.join(this.workspaceRoot, task.id));
    await fs.mkdir(windowsPath, { recursive: true });
    try {
      await fs.access(path.join(windowsPath, ".git"));
    } catch {
      const result = await runInWsl(this.distro, windowsPath, "git", ["init", "--quiet"]);
      if (result.code !== 0) throw new Error(`WSL git init failed: ${result.stderr.trim()}`);
    }
    return { windowsPath, wslPath: toWslPath(windowsPath), distro: this.distro };
  }

  async health(): Promise<{ available: boolean; detail: string }> {
    try {
      const result = await runInWsl(this.distro, process.cwd(), "sh", ["-lc", "printf ready"], 5_000);
      return { available: result.code === 0, detail: result.stdout.trim() || result.stderr.trim() };
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
