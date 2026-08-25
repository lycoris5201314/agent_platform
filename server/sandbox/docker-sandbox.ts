import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../core/config.js";
import type { AgentTask, SandboxRecord, WorkspaceHandle } from "../core/types.js";
import { TaskStore } from "../core/store.js";

const DOCKERFILE = `ARG BASE_IMAGE=node:22-bookworm-slim
FROM \${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 ca-certificates procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.146.1
USER node
WORKDIR /workspace
CMD ["sh", "-lc", "while true; do sleep 3600; done"]
`;

export class DockerSandboxManager {
  private imageReady?: Promise<void>;

  constructor(private readonly store: TaskStore, private readonly config: AppConfig) {}

  async prepare(task: AgentTask, workspace: WorkspaceHandle): Promise<{ workspace: WorkspaceHandle; sandbox: SandboxRecord }> {
    if (!this.config.docker.enabled) {
      return {
        workspace,
        sandbox: this.store.upsertSandbox(task.id, {
          kind: "wsl2", state: "active", windowsPath: workspace.windowsPath, guestPath: workspace.wslPath,
          networkPolicy: "runtime-denied", containerId: null, image: null, cpuLimit: null, memoryMb: null,
        }),
      };
    }
    await this.ensureImage();
    const existing = this.store.getSandbox(task.id);
    let containerId = existing?.kind === "docker" ? existing.containerId ?? null : null;
    if (containerId && !(await this.containerExists(containerId))) containerId = null;
    if (!containerId) {
      const name = `agent-foundry-${task.id.replaceAll("-", "").slice(0, 20)}`;
      const namedContainer = await docker(["ps", "-aq", "--filter", `name=^/${name}$`], 15_000);
      const staleContainerId = namedContainer.stdout.trim();
      if (staleContainerId) {
        const labels = await docker(["inspect", "-f", "{{ index .Config.Labels \"agent-foundry.task\" }}", staleContainerId], 15_000);
        if (labels.stdout.trim() !== task.id) throw new Error(`Docker sandbox name collision for ${name}`);
        await docker(["rm", "-f", staleContainerId], 30_000);
      }
      const network = this.config.docker.networkPolicy === "none" ? "none" : "bridge";
      const codexHome = path.join(this.config.dataDir, "codex-homes", task.id);
      await fs.mkdir(codexHome, { recursive: true });
      const artifactDirectory = this.store.artifactDirectory(task.id);
      const additionalRoots = this.store.listWorkspaceRoots(task.id).filter((root) => root.kind === "additional");
      const rootMounts = additionalRoots.flatMap((root, index) => ["--mount", `type=bind,src=${root.path},dst=/workspace-roots/${index},readonly`]);
      const skillMounts = this.config.skillsExtraRoots.filter((root) => path.isAbsolute(root)).flatMap((root, index) => ["--mount", `type=bind,src=${root},dst=/agent-skills/${index},readonly`]);
      const filesystemBoundary = task.sandboxMode === "danger-full-access"
        ? []
        : ["--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m"];
      if (this.config.mcpConfigPath) {
        try { await fs.copyFile(this.config.mcpConfigPath, path.join(codexHome, "config.toml")); } catch { /* optional MCP config */ }
      }
      const result = await docker([
        "create", "--name", name, "--label", `agent-foundry.task=${task.id}`,
        "--cpus", String(this.config.docker.cpuLimit), "--memory", `${this.config.docker.memoryMb}m`,
        "--network", network, "--workdir", "/workspace", "--env", "GIT_CONFIG_GLOBAL=/home/node/.codex/gitconfig",
        ...filesystemBoundary,
        "--mount", `type=bind,src=${workspace.windowsPath},dst=/workspace${task.sandboxMode === "read-only" ? ",readonly" : ""}`,
        "--mount", `type=bind,src=${codexHome},dst=/home/node/.codex`,
        "--mount", `type=bind,src=${artifactDirectory},dst=/agent-artifacts,readonly`,
        ...rootMounts,
        ...skillMounts,
        this.config.docker.image,
      ], 60_000);
      if (result.code !== 0) throw new Error(`Docker sandbox create failed: ${result.stderr || result.stdout}`);
      containerId = result.stdout.trim();
    }
    const inspect = await docker(["inspect", "-f", "{{.State.Running}}", containerId], 15_000);
    if (inspect.stdout.trim() !== "true") {
      const started = await docker(["start", containerId], 60_000);
      if (started.code !== 0) throw new Error(`Docker sandbox start failed: ${started.stderr || started.stdout}`);
    }
    const trusted = await docker(["exec", containerId, "git", "config", "--global", "--add", "safe.directory", "/workspace"], 15_000);
    if (trusted.code !== 0) throw new Error(`Docker sandbox Git configuration failed: ${trusted.stderr || trusted.stdout}`);
    const sandbox = this.store.upsertSandbox(task.id, {
      kind: "docker", state: "active", windowsPath: workspace.windowsPath, guestPath: "/workspace",
      networkPolicy: this.config.docker.networkPolicy === "none" ? "runtime-denied" : "unrestricted",
      containerId, image: this.config.docker.image, cpuLimit: this.config.docker.cpuLimit, memoryMb: this.config.docker.memoryMb,
    });
    const runtimeWorkspaceRoots = ["/workspace", ...this.store.listWorkspaceRoots(task.id).filter((root) => root.kind === "additional").map((_, index) => `/workspace-roots/${index}`)];
    const runtimeSkillRoots = this.config.skillsExtraRoots.map((_, index) => `/agent-skills/${index}`);
    return { workspace: { ...workspace, runtimePath: "/workspace", runtimeWorkspaceRoots, runtimeSkillRoots, containerId }, sandbox };
  }

  markIdle(taskId: string): SandboxRecord | null {
    const current = this.store.getSandbox(taskId);
    if (!current) return null;
    return this.store.upsertSandbox(taskId, { ...stripRecord(current), state: "idle" });
  }

  async release(taskId: string): Promise<void> {
    const current = this.store.getSandbox(taskId);
    if (!current) return;
    if (current.containerId) await docker(["rm", "-f", current.containerId], 30_000);
    this.store.upsertSandbox(taskId, { ...stripRecord(current), state: "released", containerId: null });
  }

  async cleanupIdle(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.docker.idleTtlMinutes * 60_000).toISOString();
    const rows = this.store.db.prepare(
      "SELECT task_id FROM task_sandboxes WHERE kind = 'docker' AND state = 'idle' AND updated_at < ?",
    ).all(cutoff) as unknown as Array<{ task_id: string }>;
    for (const row of rows) await this.release(row.task_id);
    return rows.length;
  }

  async releaseIdleNow(): Promise<number> {
    const rows = this.store.db.prepare("SELECT task_id FROM task_sandboxes WHERE kind = 'docker' AND state = 'idle'")
      .all() as unknown as Array<{ task_id: string }>;
    for (const row of rows) await this.release(row.task_id);
    return rows.length;
  }

  async health(): Promise<{ available: boolean; detail: string }> {
    if (!this.config.docker.enabled) return { available: true, detail: "WSL2 mode" };
    const result = await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
    return { available: result.code === 0, detail: result.code === 0 ? `Docker ${result.stdout.trim()}` : result.stderr.trim() };
  }

  private ensureImage(): Promise<void> {
    this.imageReady ??= this.buildImage();
    return this.imageReady;
  }

  private async buildImage(): Promise<void> {
    const present = await docker(["image", "inspect", this.config.docker.image], 15_000);
    if (present.code === 0) return;
    const buildDir = path.join(this.config.dataDir, "docker-build");
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(buildDir, "Dockerfile"), DOCKERFILE, "utf8");
    let built: Awaited<ReturnType<typeof docker>> | null = null;
    const baseImages = ["node:22-bookworm-slim", "public.ecr.aws/docker/library/node:22-bookworm-slim"];
    for (const baseImage of baseImages) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        built = await docker(["build", "--pull", "--build-arg", `BASE_IMAGE=${baseImage}`, "-t", this.config.docker.image, buildDir], 600_000);
        if (built.code === 0) return;
        if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw new Error(`Docker sandbox image build failed using primary and fallback registries: ${built?.stderr || built?.stdout || "unknown error"}`);
  }

  private async containerExists(id: string): Promise<boolean> {
    return (await docker(["inspect", id], 15_000)).code === 0;
  }
}

function stripRecord(record: SandboxRecord): Omit<SandboxRecord, "id" | "taskId" | "createdAt" | "updatedAt"> {
  return {
    kind: record.kind, state: record.state, windowsPath: record.windowsPath, guestPath: record.guestPath,
    networkPolicy: record.networkPolicy, containerId: record.containerId, image: record.image,
    cpuLimit: record.cpuLimit, memoryMb: record.memoryMb,
  };
}

export function docker(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = process.env.DOCKER_PATH ?? "docker";
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Docker command timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
