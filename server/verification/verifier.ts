import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { VerificationCheck, VerificationResult, WorkspaceHandle } from "../core/types.js";
import { runInWorkspace, runOnHost } from "../workspace/wsl-workspace.js";
import type { AppConfig } from "../core/config.js";

interface PlannedCheck {
  id: string;
  label: string;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
  executor: "wsl" | "host";
  retries?: number;
}

export class Verifier {
  constructor(private readonly cacheDirectory?: string, private readonly config?: AppConfig) {}

  async verify(
    workspace: WorkspaceHandle,
    onCheck?: (phase: "started" | "completed", check: Partial<VerificationCheck> & Pick<PlannedCheck, "id" | "label" | "command" | "args" | "required" | "executor">) => void,
  ): Promise<VerificationResult> {
    const { projectTypes, checks: planned } = await this.plan(workspace.windowsPath, workspace.kind);
    const fingerprint = await workspaceFingerprint(workspace);
    const checks: VerificationCheck[] = [];
    for (const check of planned) {
      onCheck?.("started", check);
      const started = Date.now();
      try {
        const cached = await this.readCache(fingerprint, check);
        if (cached) {
          const completed = { ...cached, durationMs: 0, output: `[cache] ${cached.output}` };
          checks.push(completed); onCheck?.("completed", { ...completed, args: check.args, executor: check.executor });
          continue;
        }
        const useHost = check.executor === "host" && !workspace.containerId;
        let result = useHost
          ? await runOnHost(workspace.windowsPath, check.command, check.args, check.timeoutMs)
          : await runInWorkspace(workspace, check.command, check.args, check.timeoutMs);
        let flaky = false;
        for (let retry = 0; result.code !== 0 && retry < (check.retries ?? 0); retry += 1) {
          const retried = useHost
            ? await runOnHost(workspace.windowsPath, check.command, check.args, check.timeoutMs)
            : await runInWorkspace(workspace, check.command, check.args, check.timeoutMs);
          if (retried.code === 0) flaky = true;
          result = retried;
        }
        const output = clean([result.stdout, result.stderr].filter(Boolean).join("\n"));
        const completed: VerificationCheck & { args: string[]; executor: PlannedCheck["executor"] } = {
          id: check.id, label: check.label, command: `${check.command} ${check.args.join(" ")}`.trim(), required: check.required,
          args: check.args,
          executor: check.executor,
          status: result.code === 0 ? "passed" : "failed",
          exitCode: result.code,
          durationMs: Date.now() - started,
          output: `${flaky ? "[flaky] 首次失败、重跑通过。\n" : ""}${output || (result.code === 0 ? "检查通过，无额外输出。" : "检查失败，无输出。")}`,
        };
        checks.push(completed);
        if (completed.status === "passed") await this.writeCache(fingerprint, check, completed);
        onCheck?.("completed", completed);
      } catch (error) {
        const completed: VerificationCheck & { args: string[]; executor: PlannedCheck["executor"] } = {
          id: check.id, label: check.label, command: `${check.command} ${check.args.join(" ")}`.trim(), required: check.required,
          args: check.args,
          executor: check.executor,
          status: "failed",
          exitCode: null,
          durationMs: Date.now() - started,
          output: error instanceof Error ? error.message : String(error),
        };
        checks.push(completed);
        onCheck?.("completed", completed);
      }
    }
    const failed = checks.filter((check) => check.required && check.status === "failed");
    return {
      passed: failed.length === 0,
      summary: failed.length ? `${failed.length} 项必要检查未通过` : `${checks.length} 项分层检查全部通过`,
      details: checks.map((check) => `[${check.status}] ${check.label}\n$ ${check.command}\n${check.output}`).join("\n\n"),
      projectTypes,
      checks,
    };
  }

  private cachePath(fingerprint: string, check: PlannedCheck): string | null {
    if (!this.cacheDirectory) return null;
    const key = createHash("sha256").update(`${fingerprint}\0${check.command}\0${check.args.join("\0")}`).digest("hex");
    return path.join(this.cacheDirectory, `${key}.json`);
  }

  private async readCache(fingerprint: string, check: PlannedCheck): Promise<VerificationCheck | null> {
    const target = this.cachePath(fingerprint, check); if (!target) return null;
    try {
      const value = JSON.parse(await fs.readFile(target, "utf8")) as VerificationCheck;
      return value.status === "passed" ? value : null;
    } catch { return null; }
  }

  private async writeCache(fingerprint: string, check: PlannedCheck, value: VerificationCheck): Promise<void> {
    const target = this.cachePath(fingerprint, check); if (!target) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value), "utf8");
  }

  private async plan(root: string, workspaceKind: WorkspaceHandle["kind"]): Promise<{ projectTypes: string[]; checks: PlannedCheck[] }> {
    const exists = async (name: string) => fs.stat(path.join(root, name)).then(() => true).catch(() => false);
    const projectTypes: string[] = [];
    const checks: PlannedCheck[] = [{
      id: "git-diff-check", label: "Git 差异格式", command: "git", args: ["diff", "--check"], required: true, timeoutMs: 20_000, executor: "wsl",
    }];
    for (const [index, commandLine] of (this.config?.verificationCommands ?? []).entries()) {
      const [command, ...args] = splitCommand(commandLine);
      if (command) checks.push({ id: `platform-${index}`, label: `平台验证：${commandLine}`, command, args, required: true, timeoutMs: 180_000, executor: "wsl", retries: 0 });
    }
    const policyPath = path.join(root, ".agent", "verification.json");
    try {
      const policy = JSON.parse(await fs.readFile(policyPath, "utf8")) as { commands?: Array<{ id?: string; label?: string; command: string; args?: string[]; required?: boolean; timeoutMs?: number; executor?: "wsl" | "host"; retries?: number }> };
      for (const [index, custom] of (policy.commands ?? []).entries()) {
        checks.push({ id: custom.id ?? `custom-${index}`, label: custom.label ?? custom.command, command: custom.command, args: custom.args ?? [], required: custom.required ?? true, timeoutMs: Math.min(custom.timeoutMs ?? 120_000, 600_000), executor: custom.executor ?? "wsl", retries: Math.min(custom.retries ?? 0, 2) });
      }
    } catch { /* optional repository policy */ }
    if (await exists("package.json")) {
      projectTypes.push("node");
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
        for (const [script, label] of [["typecheck", "TypeScript 类型"], ["lint", "代码规范"], ["test:unit", "单元测试"], ["test", "测试"], ["build", "构建"]] as const) {
          if (!pkg.scripts?.[script]) continue;
          if (script === "test" && pkg.scripts["test:unit"]) continue;
          checks.push({ id: `npm-${script}`, label, command: "npm", args: ["run", script], required: true, timeoutMs: script === "build" || script === "test" ? 180_000 : 120_000, executor: "host", retries: script.includes("test") ? 1 : 0 });
        }
      } catch {
        checks.push({ id: "package-json", label: "package.json 语法", command: process.execPath, args: ["-e", "JSON.parse(require('fs').readFileSync('package.json','utf8'))"], required: true, timeoutMs: 10_000, executor: "host" });
      }
    }
    if (await exists("pyproject.toml") || await exists("requirements.txt")) {
      projectTypes.push("python");
      const python = workspaceKind === "native" && process.platform === "win32" ? "python" : "python3";
      checks.push({ id: "python-compile", label: "Python 语法", command: python, args: ["-m", "compileall", "-q", "."], required: true, timeoutMs: 120_000, executor: "wsl" });
      if (await exists("pytest.ini") || await exists("tests")) checks.push({ id: "pytest", label: "Python 测试", command: python, args: ["-m", "pytest", "-q"], required: true, timeoutMs: 180_000, executor: "wsl" });
    }
    if (await exists("Cargo.toml")) {
      projectTypes.push("rust");
      checks.push({ id: "cargo-check", label: "Rust 检查", command: "cargo", args: ["check"], required: true, timeoutMs: 180_000, executor: "wsl" });
      checks.push({ id: "cargo-test", label: "Rust 测试", command: "cargo", args: ["test", "--quiet"], required: true, timeoutMs: 180_000, executor: "wsl" });
    }
    if (!projectTypes.length) projectTypes.push("generic");
    checks.push({ id: "git-status", label: "Git 工作区状态", command: "git", args: ["status", "--short"], required: true, timeoutMs: 20_000, executor: "wsl" });
    return { projectTypes, checks };
  }
}

async function workspaceFingerprint(workspace: WorkspaceHandle): Promise<string> {
  const [head, diff, untracked] = await Promise.all([
    runInWorkspace(workspace, "git", ["rev-parse", "HEAD"], 20_000),
    runInWorkspace(workspace, "git", ["diff", "--binary", "HEAD"], 30_000),
    runInWorkspace(workspace, "git", ["ls-files", "--others", "--exclude-standard"], 20_000),
  ]).catch(() => [{ stdout: "" }, { stdout: "" }, { stdout: "" }] as Array<{ stdout: string }>);
  const hash = createHash("sha256").update(`${head.stdout}\0${diff.stdout}`);
  for (const relative of untracked.stdout.split(/\r?\n/).filter(Boolean).sort()) {
    hash.update(`\0${relative}`);
    try { const stat = await fs.stat(path.join(workspace.windowsPath, relative)); if (stat.size <= 2_000_000) hash.update(await fs.readFile(path.join(workspace.windowsPath, relative))); }
    catch { /* file changed during fingerprinting */ }
  }
  return hash.digest("hex");
}

function clean(value: string): string {
  return value.replaceAll("\u0000", "").trim().slice(-64_000);
}

function splitCommand(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])|(["'])$/g, "")) ?? [];
}
