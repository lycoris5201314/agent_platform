import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../core/config.js";
import { EventBus } from "../core/event-bus.js";
import { TaskStore } from "../core/store.js";
import { userVisibleWorkspaceChanges } from "../core/workspace-summary.js";
import type { AgentEventPayload, AgentTask, GoalProgressReport, VerificationResult, WorkspaceHandle } from "../core/types.js";
import { CodexRuntime } from "../runtime/codex-runtime.js";
import { MockRuntime } from "../runtime/mock-runtime.js";
import type { AgentRuntime, RuntimeCompleted, RuntimeResult, RuntimeWaitingApproval, RuntimeWaitingExternal, RuntimeWaitingTimer } from "../runtime/runtime.js";
import { Verifier } from "../verification/verifier.js";
import { WorkspaceManager, runInWorkspace, runInWorkspaceEnv, toWslPath } from "../workspace/wsl-workspace.js";
import { DockerSandboxManager } from "../sandbox/docker-sandbox.js";
import type { ApprovalNotifier } from "../core/approval-notifier.js";

interface LiveContinuation {
  waiting: RuntimeWaitingApproval | RuntimeWaitingTimer | RuntimeWaitingExternal;
  repairAttempt: number;
  expiresAt: number;
}

export class TaskRunner {
  private timer?: NodeJS.Timeout;
  private readonly workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly active = new Set<string>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly continuations = new Map<string, LiveContinuation>();
  private cleanupInFlight = false;
  private lastCleanupAt = 0;
  readonly workspaceManager: WorkspaceManager;
  private readonly verifier: Verifier;
  readonly sandboxManager: DockerSandboxManager;
  private readonly runtimes: Record<"mock" | "codex", AgentRuntime>;

  constructor(private readonly store: TaskStore, private readonly bus: EventBus, private readonly config: AppConfig, resolveApiKey?: (tenantId: string, provider: import("../core/types.js").ProviderId) => string | null, private readonly notifier?: ApprovalNotifier, resolveProvider?: (tenantId: string, provider: import("../core/types.js").ProviderId) => import("../core/config.js").ProviderConfig) {
    this.workspaceManager = new WorkspaceManager(path.join(config.dataDir, "workspaces"), config.workspaceMode, config.wslDistro);
    this.verifier = new Verifier(path.join(config.dataDir, "verification-cache"), config);
    this.sandboxManager = new DockerSandboxManager(store, config);
    this.runtimes = { mock: new MockRuntime(), codex: new CodexRuntime(config, resolveApiKey, resolveProvider) };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 350);
    void this.tick();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.abortControllers.values()) controller.abort();
    for (const continuation of this.continuations.values()) continuation.waiting.close();
    for (const heartbeat of this.heartbeats.values()) clearInterval(heartbeat);
    this.heartbeats.clear();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async cancel(taskId: string): Promise<void> {
    const runtime = this.runtimes.codex as CodexRuntime;
    if (runtime.hasActive(taskId)) {
      try { await runtime.interrupt(taskId); } catch { /* process abort below is the fallback */ }
    }
    this.abortControllers.get(taskId)?.abort();
    this.continuations.get(taskId)?.waiting.close();
    this.continuations.delete(taskId);
    const deadline = Date.now() + 5_000;
    while (this.active.has(taskId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const current = this.store.getTask(taskId);
    if (current && ["preparing", "running", "verifying"].includes(current.status)) {
      this.store.transition(taskId, "cancelled", { cancelRequested: true, error: null, finishedAt: new Date().toISOString() });
    }
  }

  async steer(taskId: string, content: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.runtime !== "codex") throw new Error("Only an active Codex task can be steered");
    const runtime = this.runtimes.codex as CodexRuntime;
    await runtime.steer(taskId, content);
    const message = this.store.appendSteeringMessage(taskId, content);
    this.bus.publish(this.store.appendEvent(taskId, "turn.steered", {
      schemaVersion: 1, category: "turn", phase: "progress", turnId: `${taskId}:turn:${message.turn}`,
      title: "已向执行中的 Agent 补充指令", messageId: message.id, detail: content.slice(0, 500),
    }));
  }

  private async tick(): Promise<void> {
    this.store.wakeDueTasks();
    for (const [taskId, continuation] of this.continuations) {
      if (continuation.expiresAt > Date.now()) continue;
      continuation.waiting.close();
      this.continuations.delete(taskId);
    }
    if (!this.cleanupInFlight && Date.now() - this.lastCleanupAt >= 60_000) {
      this.cleanupInFlight = true;
      this.lastCleanupAt = Date.now();
      void this.sandboxManager.cleanupIdle().finally(() => { this.cleanupInFlight = false; });
    }
    for (const taskId of this.store.recoverExpiredLeases()) {
      this.bus.publish(this.store.appendEvent(taskId, "task.lease.recovered", {
        schemaVersion: 1, category: "task", phase: "queued", turnId: `${taskId}:recovery`,
        title: "Worker 租约过期，任务已恢复到队列",
      }));
    }
    while (this.active.size < this.config.workerConcurrency) {
      const counts = this.store.countActiveByProvider();
      const excluded = Object.entries(counts).filter(([, count]) => count >= this.config.providerConcurrency).map(([provider]) => provider);
      const task = this.store.claimNextTask(this.workerId, this.config.workerLeaseMs, excluded);
      if (!task) return;
      this.active.add(task.id);
      const heartbeat = setInterval(() => this.store.heartbeat(task.id, this.workerId, this.config.workerLeaseMs), Math.max(5_000, Math.floor(this.config.workerLeaseMs / 3)));
      this.heartbeats.set(task.id, heartbeat);
      void this.execute(task).finally(() => {
        clearInterval(heartbeat);
        this.heartbeats.delete(task.id);
        this.active.delete(task.id);
        this.store.releaseLease(task.id, this.workerId);
        void this.tick();
      });
    }
  }

  private async execute(task: AgentTask): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    const turnNumber = this.store.listMessages(task.id).filter((message) => message.role === "user").at(-1)?.turn ?? task.attempt;
    const platformTurnId = `${task.id}:turn:${turnNumber}`;
    let baselineTree: string | null = null;
    let baseWorkspace: WorkspaceHandle | null = null;
    const emit = (type: string, payload: Record<string, unknown> = {}) => {
      const eventPayload = normalizeEvent(type, platformTurnId, task.attempt, payload);
      this.bus.publish(this.store.appendEvent(task.id, type, eventPayload));
    };

    try {
      emit("task.preparing", { category: "task", phase: "started", title: "准备本轮任务", runtime: task.runtime, provider: task.provider });
      const preparedWorkspace = await this.workspaceManager.prepare(task);
      baseWorkspace = preparedWorkspace;
      preparedWorkspace.runtimeWorkspaceRoots = this.store.listWorkspaceRoots(task.id).map((root) => root.path);
      preparedWorkspace.runtimeSkillRoots = this.config.skillsExtraRoots;
      this.store.updateTask(task.id, { workspacePath: preparedWorkspace.windowsPath });
      this.store.addWorkspaceRoot(task.id, preparedWorkspace.windowsPath, path.basename(preparedWorkspace.windowsPath), "primary");
      preparedWorkspace.runtimeWorkspaceRoots = this.store.listWorkspaceRoots(task.id).map((root) => root.path);
      const prepared = await this.sandboxManager.prepare(task, preparedWorkspace);
      const workspace = prepared.workspace;
      const sandbox = prepared.sandbox;
      emit("sandbox.ready", { category: "sandbox", phase: "completed", title: sandbox.kind === "docker" ? "Docker 任务沙箱已激活" : sandbox.kind === "wsl2" ? "WSL2 任务沙箱已激活" : "Windows 原生任务环境已激活", ...sandbox });
      emit("workspace.ready", { category: "workspace", phase: "completed", title: "工作区就绪", ...workspace });

      if (task.waitSeconds > 0 && task.checkpoint?.phase !== "timer_elapsed") {
        const nextWakeupAt = new Date(Date.now() + task.waitSeconds * 1000).toISOString();
        const signal = this.store.createSignal(task.id, "timer", `${task.id}:turn:${turnNumber}:timer`, { seconds: task.waitSeconds }, nextWakeupAt);
        this.store.transition(task.id, "waiting_timer", { checkpoint: { phase: "timer_elapsed", signalId: signal.id }, nextWakeupAt });
        emit("task.waiting", { category: "task", phase: "waiting", title: "持久化定时等待", nextWakeupAt });
        this.sandboxManager.markIdle(task.id);
        emit("sandbox.idle", { category: "sandbox", phase: "completed", title: "任务沙箱已转为空闲", sandboxId: sandbox.id });
        return;
      }

      this.store.transition(task.id, "running");
      const memory = this.store.getConversationMemory(task.id);
      memory.relevant = this.store.searchMemory(task.id, task.prompt);
      emit("memory.loaded", { category: "memory", phase: "completed", title: "本对话记忆已加载（与其他对话隔离）", messageCount: memory.messageCount, recalled: memory.relevant.length, threadResumed: Boolean(task.threadId) });
      const priorBaseline = this.store.listEvents(task.id).find((event) => event.type === "turn.workspace.baseline" && event.payload.turnId === platformTurnId);
      baselineTree = typeof priorBaseline?.payload.tree === "string" ? priorBaseline.payload.tree : await this.captureWorkspaceTree(task.id, preparedWorkspace);
      if (baselineTree && !priorBaseline) emit("turn.workspace.baseline", { category: "workspace", phase: "started", title: "已记录本轮工作区起点", tree: baselineTree, hidden: true });
      const live = this.continuations.get(task.id);
      let repairAttempt = live?.repairAttempt ?? Number(task.checkpoint?.repairAttempt ?? 0);
      let result: RuntimeResult;
      if (live) {
        this.continuations.delete(task.id);
        if (live.waiting.kind === "waiting_timer") {
          emit("task.wait.resuming", { category: "task", phase: "started", title: "持久化等待结束，继续原工具调用" });
          result = await live.waiting.resume();
        } else if (live.waiting.kind === "waiting_external") {
          const signalId = String(task.checkpoint?.signalId ?? "");
          const signal = signalId ? this.store.getSignal(signalId) : null;
          if (!signal || signal.state === "pending") throw new Error("External signal resumed before it was resolved");
          emit("task.external.resuming", { category: "task", phase: "started", title: "外部信号已收到，继续原工具调用", correlationKey: live.waiting.correlationKey });
          result = await live.waiting.resume(signal.payload);
          if (signal.state === "resolved") this.store.consumeSignal(signal.id);
        } else {
          const decision = task.checkpoint?.approvalDecision === "rejected" ? "rejected" : "approved";
          emit("approval.resuming", { category: "approval", phase: "started", title: decision === "approved" ? "继续已批准的原步骤" : "把拒绝结果反馈给 Agent", decision });
          result = await live.waiting.resume(decision);
        }
      } else {
        if (task.checkpoint?.phase === "external_signal_pending") {
          const signal = this.store.getSignal(String(task.checkpoint.signalId ?? ""));
          if (signal && signal.state === "resolved") {
            task.checkpoint = { ...task.checkpoint, externalPayload: signal.payload };
            this.store.updateTask(task.id, { checkpoint: task.checkpoint });
            this.store.consumeSignal(signal.id);
          }
        }
        const prompt = recoveryPrompt(task, memoryContext(memory));
        result = await this.runtimes[task.runtime].run({
          task: this.store.getTask(task.id) ?? task, memory, workspace, prompt, platformTurnId,
          signal: abortController.signal, emit,
          saveThreadId: (threadId) => { this.store.updateTask(task.id, { threadId }); },
        });
      }

      while (true) {
        if (result.kind === "waiting_timer") {
          await this.pauseForRuntimeTimer(task.id, result, repairAttempt, emit);
          return;
        }
        if (result.kind === "waiting_approval") {
          await this.pauseForApproval(task.id, result, repairAttempt, emit);
          return;
        }
        if (result.kind === "waiting_external") {
          await this.pauseForExternalSignal(task.id, result, repairAttempt, emit);
          return;
        }
        if (abortController.signal.aborted || this.store.getTask(task.id)?.cancelRequested) {
          this.store.transition(task.id, "cancelled", { finishedAt: new Date().toISOString() });
          emit("task.cancelled", { category: "task", phase: "cancelled", title: "任务已取消" });
          return;
        }
        const verification = await this.verify(task.id, workspace, result, emit);
        if (verification.passed) {
          if (baselineTree) await this.emitTurnWorkspaceSummary(task.id, preparedWorkspace, baselineTree, emit);
          const assistantMessage = this.store.appendMessage(task.id, "assistant", result.finalResponse);
          emit("memory.updated", { category: "memory", phase: "completed", title: "会话记忆已更新", messageId: assistantMessage.id, turn: assistantMessage.turn });
          const currentTask = this.store.getTask(task.id) ?? task;
          const automaticRebase = currentTask.runtime === "codex" && currentTask.provider !== "openai" && Boolean(currentTask.threadId) && contextUsagePercent(result.usage) >= 85;
          const goalReport = currentTask.goalStatus === "active" ? result.goalReport : undefined;
          const goalCompletedTurns = currentTask.goalStatus === "active" ? currentTask.goalCompletedTurns + 1 : currentTask.goalCompletedTurns;
          const goalCanContinue = goalReport?.status === "continue" && goalCompletedTurns < currentTask.goalMaxTurns;
          const goalStatus = currentTask.goalStatus !== "active" ? currentTask.goalStatus
            : !goalReport ? "paused"
              : goalReport.status === "completed" ? "completed"
                : goalReport.status === "blocked" ? "blocked"
                  : goalCanContinue ? "active" : "limit_reached";
          if (currentTask.goalStatus === "active") {
            this.store.updateTask(task.id, {
              goalStatus, goalCompletedTurns,
              goalProgress: goalReport?.progress ?? currentTask.goalProgress,
              goalLastSummary: goalReport?.summary ?? "模型没有上报持续目标进度，已安全暂停。",
              goalNextStep: goalReport?.nextStep ?? "请检查本轮结果后手动恢复。",
            });
            emit(goalCanContinue ? "goal.continuation.queued" : goalStatus === "completed" ? "goal.completed" : "goal.paused", {
              category: "task", phase: goalCanContinue ? "progress" : goalStatus === "completed" ? "completed" : "waiting",
              title: goalCanContinue ? `持续目标将自动进入第 ${goalCompletedTurns + 1} 轮` : goalStatus === "completed" ? "持续目标已完成" : goalStatus === "limit_reached" ? "持续目标达到轮次上限" : goalStatus === "blocked" ? "持续目标遇到阻塞" : "持续目标已安全暂停",
              goalStatus, completedTurns: goalCompletedTurns, maxTurns: currentTask.goalMaxTurns,
              progress: goalReport?.progress ?? currentTask.goalProgress, summary: goalReport?.summary,
              nextStep: goalReport?.nextStep, blocker: goalReport?.blocker,
            });
          }
          this.store.transition(task.id, "succeeded", {
            result: result.finalResponse,
            checkpoint: task.parentTaskId ? task.checkpoint : null,
            threadId: automaticRebase ? null : currentTask.threadId,
            finishedAt: new Date().toISOString(),
          });
          if (automaticRebase) {
            emit("context.compaction.automatic", {
              category: "memory", phase: "completed", title: "上下文接近上限，已自动切换到本机压缩记忆",
              before: result.usage ?? null, thresholdPercent: 85, detachedThreadId: currentTask.threadId,
            });
          }
          if (goalCanContinue && goalReport) {
            this.store.transition(task.id, "queued", {
              prompt: goalContinuationPrompt(currentTask, goalReport, goalCompletedTurns),
              result: null, error: null, checkpoint: { phase: "goal_continuation", goalCompletedTurns },
              startedAt: null, finishedAt: null,
            });
            this.sandboxManager.markIdle(task.id);
            emit("sandbox.idle", { category: "sandbox", phase: "completed", title: "本轮结束，持续目标已重新排队", sandboxId: sandbox.id });
            return;
          }
          this.resolveChildSignal(task.id);
          this.sandboxManager.markIdle(task.id);
          emit("sandbox.idle", { category: "sandbox", phase: "completed", title: "任务沙箱已转为空闲", sandboxId: sandbox.id });
          emit("task.succeeded", { category: "task", phase: "completed", title: "任务与验证均已完成", result: result.finalResponse, usage: result.usage });
          return;
        }
        if (repairAttempt >= 2) throw new Error(`自动修复达到上限：${verification.summary}`);
        repairAttempt += 1;
        this.store.transition(task.id, "running", { result: result.finalResponse, checkpoint: { phase: "verification_repair", repairAttempt } });
        emit("verification.repair.started", { category: "verification", phase: "started", title: `第 ${repairAttempt}/2 次自动修复`, retry: repairAttempt, failures: verification.checks.filter((check) => check.status === "failed") });
        result = await this.runtimes[task.runtime].run({
          task: this.store.getTask(task.id) ?? task, memory, workspace,
          prompt: verificationRepairPrompt(verification, repairAttempt), platformTurnId,
          signal: abortController.signal, emit,
          saveThreadId: (threadId) => { this.store.updateTask(task.id, { threadId }); },
        });
      }
    } catch (error) {
      const failedTask = this.store.getTask(task.id);
      if (baselineTree && failedTask?.workspacePath && baseWorkspace) await this.emitTurnWorkspaceSummary(task.id, baseWorkspace, baselineTree, emit).catch(() => undefined);
      const current = this.store.getTask(task.id);
      const aborted = abortController.signal.aborted;
      if (current && !["failed", "cancelled", "succeeded", "waiting_approval", "waiting_timer", "waiting_external", "waiting_retry"].includes(current.status)) {
        const message = error instanceof Error ? error.message : String(error);
        if (aborted) this.store.transition(task.id, "cancelled", { error: null, finishedAt: new Date().toISOString() });
        else {
          if (current.provider !== "openai" && current.threadId && isContextCapacityFailure(message)) {
            this.store.updateTask(task.id, { threadId: null, checkpoint: { ...current.checkpoint, phase: "automatic_context_rebase", detachedThreadId: current.threadId } });
            emit("context.compaction.automatic", {
              category: "memory", phase: "completed", title: "模型上下文已满，自动改用本机压缩记忆重试",
              detail: message, detachedThreadId: current.threadId,
            });
          }
          this.store.scheduleRetry(task.id, message);
        }
      }
      this.resolveChildSignal(task.id);
      const afterFailure = this.store.getTask(task.id);
      const retrying = afterFailure?.status === "waiting_retry";
      emit(aborted ? "task.cancelled" : retrying ? "task.retry.scheduled" : "task.failed", { category: "task", phase: aborted ? "cancelled" : retrying ? "waiting" : "failed", title: aborted ? "任务已取消" : retrying ? "执行失败，已安排自动重试" : "任务执行失败", detail: error instanceof Error ? error.message : String(error), nextAttemptAt: afterFailure?.nextAttemptAt });
    } finally {
      this.abortControllers.delete(task.id);
    }
  }

  private async captureWorkspaceTree(taskId: string, workspace: WorkspaceHandle): Promise<string | null> {
    const indexDirectory = path.join(this.config.dataDir, "turn-indexes");
    await fs.mkdir(indexDirectory, { recursive: true });
    const indexPath = path.join(indexDirectory, `${taskId}-${randomUUID()}.index`);
    const runtimeIndex = workspace.kind === "wsl2" ? toWslPath(indexPath) : indexPath;
    try {
      const added = await runInWorkspaceEnv(workspace, { GIT_INDEX_FILE: runtimeIndex }, "git", ["add", "-A"], 120_000);
      if (added.code !== 0) return null;
      const tree = await runInWorkspaceEnv(workspace, { GIT_INDEX_FILE: runtimeIndex }, "git", ["write-tree"], 30_000);
      return tree.code === 0 && /^[0-9a-f]{40,64}$/i.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
    } catch {
      // Git is optional in native mode. The task can continue without a per-turn Git diff.
      return null;
    } finally {
      await fs.rm(indexPath, { force: true }).catch(() => undefined);
      await fs.rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
    }
  }

  private async emitTurnWorkspaceSummary(taskId: string, workspace: WorkspaceHandle, baselineTree: string, emit: (type: string, payload?: Record<string, unknown>) => void): Promise<void> {
    const already = this.store.listEvents(taskId).some((event) => event.type === "turn.workspace.summary" && event.payload.turnId === `${taskId}:turn:${this.store.listMessages(taskId).filter((message) => message.role === "user").at(-1)?.turn ?? 0}`);
    if (already) return;
    const currentTree = await this.captureWorkspaceTree(taskId, workspace);
    if (!currentTree || currentTree === baselineTree) return;
    const [names, numbers] = await Promise.all([
      runInWorkspace(workspace, "git", ["-c", "core.quotePath=false", "diff", "--name-status", "--find-renames", baselineTree, currentTree], 30_000),
      runInWorkspace(workspace, "git", ["-c", "core.quotePath=false", "diff", "--numstat", "--find-renames", baselineTree, currentTree], 30_000),
    ]);
    if (names.code !== 0) return;
    const stats = new Map(numbers.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [added, deleted, ...pathParts] = line.split("\t");
      return [pathParts.at(-1) ?? "", { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) }];
    }));
    const changes = userVisibleWorkspaceChanges(names.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...paths] = line.split("\t");
      const filePath = paths.at(-1) ?? "";
      return { status, path: filePath, ...(stats.get(filePath) ?? { additions: null, deletions: null }) };
    }));
    if (!changes.length) return;
    const diffPaths = changes.slice(0, 200).map((change) => change.path);
    const unified = await runInWorkspace(workspace, "git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--find-renames", baselineTree, currentTree, "--", ...diffPaths], 60_000);
    const additions = changes.reduce((sum, change) => sum + (change.additions ?? 0), 0);
    const deletions = changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0);
    const diff = unified.stdout.slice(0, 60_000);
    emit("turn.workspace.summary", {
      category: "workspace", phase: "completed", title: `本轮修改了 ${changes.length} 个文件`,
      changes, changeCount: changes.length, additions, deletions, diff, diffTruncated: changes.length > diffPaths.length || unified.stdout.length > diff.length,
      baselineTree, currentTree,
      outputs: changes.filter((change) => change.status.startsWith("A")).map((change) => change.path),
    });
  }

  private async pauseForRuntimeTimer(taskId: string, waiting: RuntimeWaitingTimer, repairAttempt: number, emit: (type: string, payload?: Record<string, unknown>) => void): Promise<void> {
    const availableAt = new Date(Date.now() + waiting.seconds * 1000).toISOString();
    const signal = this.store.createSignal(taskId, "timer", `${taskId}:runtime-wait:${Date.now()}`, { seconds: waiting.seconds, reason: waiting.reason }, availableAt);
    const canResumeExactRpc = waiting.seconds < this.config.docker.idleTtlMinutes * 60;
    if (canResumeExactRpc) this.continuations.set(taskId, { waiting, repairAttempt, expiresAt: Date.now() + this.config.docker.idleTtlMinutes * 60_000 });
    else waiting.close();
    this.store.transition(taskId, "waiting_timer", { threadId: waiting.threadId ?? this.store.getTask(taskId)?.threadId ?? null, checkpoint: { phase: "runtime_timer_pending", signalId: signal.id, reason: waiting.reason, repairAttempt }, nextWakeupAt: availableAt });
    this.sandboxManager.markIdle(taskId);
    emit("task.waiting", { category: "task", phase: "waiting", title: "Agent 已进入持久化等待", detail: waiting.reason, seconds: waiting.seconds, exactRpcResume: canResumeExactRpc, nextWakeupAt: availableAt });
  }

  private async pauseForExternalSignal(taskId: string, waiting: RuntimeWaitingExternal, repairAttempt: number, emit: (type: string, payload?: Record<string, unknown>) => void): Promise<void> {
    const signal = this.store.createSignal(taskId, "webhook", waiting.correlationKey, { reason: waiting.reason });
    this.continuations.set(taskId, { waiting, repairAttempt, expiresAt: Date.now() + this.config.docker.idleTtlMinutes * 60_000 });
    this.store.transition(taskId, "waiting_external", {
      threadId: waiting.threadId ?? this.store.getTask(taskId)?.threadId ?? null,
      checkpoint: { phase: "external_signal_pending", signalId: signal.id, correlationKey: waiting.correlationKey, reason: waiting.reason, repairAttempt },
      nextWakeupAt: null,
    });
    this.sandboxManager.markIdle(taskId);
    emit("task.external.waiting", { category: "task", phase: "waiting", title: "Agent 正在等待外部信号", detail: waiting.reason, correlationKey: waiting.correlationKey, signalId: signal.id });
  }

  private resolveChildSignal(taskId: string): void {
    const child = this.store.getTask(taskId);
    if (!child?.parentTaskId || !["succeeded", "failed", "cancelled"].includes(child.status)) return;
    const signal = this.store.getSignalByCorrelation(`child:${child.id}`);
    if (signal?.state === "pending") this.store.resolveSignal(signal.id, { childTaskId: child.id, state: child.status, result: child.result, error: child.error });
  }

  private async pauseForApproval(taskId: string, waiting: RuntimeWaitingApproval, repairAttempt: number, emit: (type: string, payload?: Record<string, unknown>) => void): Promise<void> {
    const approval = this.store.createApproval({ taskId, ...waiting.approval });
    void this.notifier?.notify(approval);
    const signal = this.store.createSignal(taskId, "approval", `approval:${approval.id}`, { approvalId: approval.id });
    this.continuations.set(taskId, { waiting, repairAttempt, expiresAt: Date.now() + this.config.docker.idleTtlMinutes * 60_000 });
    this.store.transition(taskId, "waiting_approval", {
      threadId: waiting.threadId ?? this.store.getTask(taskId)?.threadId ?? null,
      checkpoint: { phase: "approval_pending", approvalId: approval.id, signalId: signal.id, repairAttempt, runtimeRequest: waiting.approval.request },
    });
    emit("approval.requested", { category: "approval", phase: "waiting", title: approval.title, detail: approval.description, approvalId: approval.id, risk: approval.risk, command: approval.command, cwd: approval.cwd, path: approval.path, networkHost: approval.networkHost, scope: approval.scope });
  }

  private async verify(taskId: string, workspace: WorkspaceHandle, result: RuntimeCompleted, emit: (type: string, payload?: Record<string, unknown>) => void): Promise<VerificationResult> {
    this.store.transition(taskId, "verifying", { result: result.finalResponse, threadId: result.threadId ?? this.store.getTask(taskId)?.threadId ?? null });
    emit("verification.started", { category: "verification", phase: "started", title: "开始分层验证" });
    const sandboxMode = this.store.getTask(taskId)?.sandboxMode ?? "workspace-write";
    const verification = await this.verifier.verify(workspace, (phase, check) => {
      emit(`verification.check.${phase}`, {
        category: "verification", phase: phase === "started" ? "started" : check.status === "failed" ? "failed" : "completed",
        title: check.label, stepId: `verification:${check.id}`, command: check.args ? `${check.command} ${check.args.join(" ")}` : check.command,
        durationMs: check.durationMs, exitCode: check.exitCode, output: check.output,
      });
    }, sandboxMode);
    emit("verification.completed", { category: "verification", phase: verification.passed ? "completed" : "failed", title: verification.summary, ...verification });
    return verification;
  }
}

function normalizeEvent(type: string, turnId: string, retry: number, payload: Record<string, unknown>): AgentEventPayload {
  const category = String(payload.category ?? inferCategory(type)) as AgentEventPayload["category"];
  const phase = String(payload.phase ?? inferPhase(type)) as AgentEventPayload["phase"];
  return { schemaVersion: 1, category, phase, platformTurnId: turnId, turnId: String(payload.turnId ?? turnId), retry, ...payload } as AgentEventPayload;
}

function inferCategory(type: string): AgentEventPayload["category"] {
  for (const category of ["approval", "verification", "workspace", "terminal", "sandbox", "memory", "tool", "turn", "step"] as const) if (type.includes(category)) return category;
  return "task";
}

function inferPhase(type: string): AgentEventPayload["phase"] {
  if (type.includes("failed")) return "failed";
  if (type.includes("cancel")) return "cancelled";
  if (type.includes("waiting") || type.includes("requested")) return "waiting";
  if (type.includes("completed") || type.includes("succeeded") || type.includes("ready") || type.includes("loaded") || type.includes("updated")) return "completed";
  if (type.includes("started") || type.includes("running") || type.includes("preparing") || type.includes("resuming")) return "started";
  return "progress";
}

function recoveryPrompt(task: AgentTask, memory: string): string {
  if (task.checkpoint?.phase === "child_task" || task.checkpoint?.phase === "automatic_context_rebase") {
    const delegationContext = typeof task.checkpoint.delegationContext === "string" ? task.checkpoint.delegationContext : "";
    const remembered = memory ? `<conversation_memory>\n${memory}\n</conversation_memory>\n` : "";
    return withGoalInstructions(task, `${delegationContext}${delegationContext ? "\n" : ""}${remembered}<assigned_subtask>\n${task.prompt}\n</assigned_subtask>`);
  }
  if (task.checkpoint?.phase === "external_signal_pending") {
    return withGoalInstructions(task, `平台已收到此前等待的外部信号（${String(task.checkpoint.correlationKey ?? "unknown")}）。Payload：${JSON.stringify(task.checkpoint.externalPayload ?? {})}。应用可能在等待期间重启，因此原动态工具 RPC 已失效。请在同一线程中根据外部系统当前状态重新检查结果并继续任务；不要再次注册相同等待，除非结果仍未就绪。\n\n当前任务：${task.prompt}`);
  }
  if (task.checkpoint?.phase === "runtime_timer_pending") {
    return withGoalInstructions(task, `平台已完成一次持久化等待（原因：${String(task.checkpoint.reason ?? "等待外部结果")}）。应用可能在等待期间重启，因此原动态工具 RPC 已失效。请在同一线程中立即重新检查预期结果并继续任务；不要再次执行长时间 sleep，若仍需等待请再次调用 durable_wait。\n\n当前任务：${task.prompt}`);
  }
  if (!task.checkpoint?.approvalDecision) {
    if (task.threadId || !memory) return withGoalInstructions(task, task.prompt);
    return withGoalInstructions(task, `<conversation_memory>\n${memory}\n</conversation_memory>\n<current_user_message>\n${task.prompt}\n</current_user_message>`);
  }
  const decision = task.checkpoint.approvalDecision === "approved" ? "批准" : "拒绝";
  return withGoalInstructions(task, `应用在等待审批时重启，原 RPC 已失效。用户已经${decision}上一项工具请求。请在同一线程中检查当前工作区状态：若已批准，安全地重新规划并仅在仍必要时重试；若已拒绝，不要执行该操作，保留上下文并寻找替代方案或解释限制。\n\n当前任务：${task.prompt}`);
}

function withGoalInstructions(task: AgentTask, prompt: string): string {
  if (task.goalStatus !== "active") return prompt;
  return `<persistent_goal>\n目标：${task.goalObjective ?? task.title}\n当前为最多 ${task.goalMaxTurns} 轮中的第 ${task.goalCompletedTurns + 1} 轮。上一轮进度：${task.goalProgress}%。\n完成本轮工作并验证后，必须调用 report_goal_progress。只有确实还有无需用户输入即可推进的工作时才选择 continue；目标已验收则选择 completed；需要用户选择、授权或外部条件时选择 blocked。不要为了用完轮次而继续。\n</persistent_goal>\n\n${prompt}`;
}

function goalContinuationPrompt(task: AgentTask, report: GoalProgressReport, completedTurns: number): string {
  return `继续执行持续目标“${task.goalObjective ?? task.title}”。已完成 ${completedTurns}/${task.goalMaxTurns} 轮，当前进度 ${report.progress}%。\n上一轮摘要：${report.summary}\n计划下一步：${report.nextStep}\n请检查真实工作区状态后继续，不要重复已经完成的步骤。`;
}

function contextUsagePercent(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const total = usage.total && typeof usage.total === "object" ? usage.total as Record<string, unknown> : {};
  const tokens = Number(total.totalTokens ?? usage.totalTokens ?? NaN);
  const windowSize = Number(usage.modelContextWindow ?? NaN);
  return Number.isFinite(tokens) && Number.isFinite(windowSize) && windowSize > 0 ? tokens / windowSize * 100 : 0;
}

function isContextCapacityFailure(message: string): boolean {
  return /context (?:window|length)|maximum context|input (?:is )?too long|too many tokens|token limit|compaction|compact task|supported API model names.*but you passed gpt-/i.test(message);
}

function memoryContext(memory: import("../core/types.js").ConversationMemory): string {
  const recalled = memory.relevant?.length
    ? `\n\n<recalled_memory>\n${memory.relevant.map((entry) => `[${entry.scope}/${entry.kind}] ${entry.content}`).join("\n\n")}\n</recalled_memory>`
    : "";
  return `${memory.summary}${recalled}`;
}

function verificationRepairPrompt(result: VerificationResult, attempt: number): string {
  return `这是第 ${attempt}/2 次自动修复。以下必要验证失败，请分析日志，只修改导致失败的内容，然后停止并让我重新运行验证。不要隐藏、跳过或删除测试。\n\n${result.details}`;
}
