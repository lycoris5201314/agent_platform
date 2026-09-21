import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertTransition } from "./state-machine.js";
import { workspaceSummaryFields } from "./workspace-summary.js";
import { computeNextAutomationRun } from "./automation-schedule.js";
import type {
  AgentTask,
  Approval,
  ApprovalInput,
  ConversationMemory,
  ConversationMessage,
  CreateTaskInput,
  TaskEvent,
  TaskArtifact,
  SandboxRecord,
  TaskStatus,
  DurableSignal,
  DurableSignalKind,
  DeadLetter,
  IdempotencyRecord,
  AuditEntry,
  RequestIdentity,
  TenantQuota,
  MemoryEntry,
  WorkspaceRoot,
  ReviewComment,
  TaskAutomation,
  AutomationRun,
  CreateAutomationInput,
  TaskRecoveryResult, TenantStorageSummary, DeletedTaskSummary, TenantTokenUsageSummary, TaskDependency, TaskListFacets, TaskStatusGroup,
} from "./types.js";

type SqlValue = string | number | null;

interface TaskRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  runtime: "mock" | "codex";
  provider: "openai" | "deepseek" | "custom";
  model: string | null;
  reasoning_effort: import("./types.js").TaskReasoningEffort | null;
  sandbox_mode: import("./types.js").TaskSandboxMode;
  approval_policy: import("./types.js").TaskApprovalPolicy;
  approvals_reviewer: import("./types.js").TaskApprovalsReviewer;
  workspace_path: string | null;
  thread_id: string | null;
  result: string | null;
  error: string | null;
  checkpoint_json: string | null;
  wait_seconds: number;
  next_wakeup_at: string | null;
  cancel_requested: number;
  attempt: number;
  priority: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  next_attempt_at: string | null;
  parent_task_id: string | null;
  root_task_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
  pinned_at: string | null;
  section: string | null;
  goal_status: import("./types.js").GoalStatus;
  goal_objective: string | null;
  goal_max_turns: number;
  goal_completed_turns: number;
  goal_progress: number;
  goal_last_summary: string | null;
  goal_next_step: string | null;
  goal_deadline_at: string | null;
  goal_token_budget: number;
  goal_tokens_used: number;
  goal_last_usage_total: number;
}

interface EventRow {
  id: number;
  task_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: Approval["status"];
  created_at: string;
  resolved_at: string | null;
  kind: Approval["kind"];
  risk: Approval["risk"];
  command: string | null;
  cwd: string | null;
  path: string | null;
  network_host: string | null;
  scope: string | null;
  request_json: string;
  decision_json: string | null;
}

interface MessageRow {
  id: number;
  task_id: string;
  role: "user" | "assistant";
  content: string;
  turn: number;
  created_at: string;
}

interface MemoryRow {
  task_id: string;
  summary_text: string;
  message_count: number;
  updated_at: string;
}

interface AutomationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prompt: string;
  runtime: "mock" | "codex";
  provider: "openai" | "deepseek" | "custom";
  model: string | null;
  reasoning_effort: import("./types.js").TaskReasoningEffort | null;
  sandbox_mode: import("./types.js").TaskSandboxMode;
  approval_policy: import("./types.js").TaskApprovalPolicy;
  approvals_reviewer: import("./types.js").TaskApprovalsReviewer;
  workspace_path: string | null;
  schedule_kind: import("./types.js").AutomationScheduleKind;
  once_at: string | null;
  interval_minutes: number | null;
  time_of_day: string | null;
  weekdays_json: string;
  status: import("./types.js").AutomationStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  task_id: string | null;
  state: "queued" | "failed";
  scheduled_for: string;
  error: string | null;
  created_at: string;
}

export class TaskStore {
  readonly db: DatabaseSync;
  private readonly artifactDir: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.artifactDir = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.artifactDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "agent-platform.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        runtime TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
        approval_policy TEXT NOT NULL DEFAULT 'on-request',
        approvals_reviewer TEXT NOT NULL DEFAULT 'user',
        workspace_path TEXT,
        thread_id TEXT,
        result TEXT,
        error TEXT,
        checkpoint_json TEXT,
        wait_seconds INTEGER NOT NULL DEFAULT 0,
        next_wakeup_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        next_attempt_at TEXT,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        root_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_wakeup ON tasks(status, next_wakeup_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_created ON tasks(tenant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id, id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        kind TEXT NOT NULL DEFAULT 'command',
        risk TEXT NOT NULL DEFAULT 'medium',
        command TEXT,
        cwd TEXT,
        path TEXT,
        network_host TEXT,
        scope TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        decision_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

      CREATE TABLE IF NOT EXISTS task_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        turn INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, turn, role)
      );
      CREATE INDEX IF NOT EXISTS idx_task_messages_task_id ON task_messages(task_id, id);

      CREATE TABLE IF NOT EXISTS task_memory (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        summary_text TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_sandboxes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        windows_path TEXT NOT NULL,
        guest_path TEXT NOT NULL,
        network_policy TEXT NOT NULL,
        container_id TEXT,
        image TEXT,
        cpu_limit REAL,
        memory_mb INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS durable_signals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('timer', 'webhook', 'approval', 'child_task')),
        state TEXT NOT NULL CHECK(state IN ('pending', 'resolved', 'consumed', 'cancelled')),
        correlation_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        available_at TEXT,
        resolved_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_due ON durable_signals(state, available_at);
      CREATE INDEX IF NOT EXISTS idx_signals_task ON durable_signals(task_id, created_at);

      CREATE TABLE IF NOT EXISTS dead_letters (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        replayed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dead_letters_open ON dead_letters(replayed_at, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK(task_id != depends_on_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_dependencies_target ON task_dependencies(depends_on_task_id, task_id);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('started', 'completed', 'failed')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_task ON idempotency_records(task_id, created_at);

      CREATE TABLE IF NOT EXISTS tenant_memberships (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS tenant_quotas (
        tenant_id TEXT PRIMARY KEY,
        max_concurrent_tasks INTEGER NOT NULL DEFAULT 2,
        max_tasks_per_day INTEGER NOT NULL DEFAULT 100,
        max_storage_mb INTEGER NOT NULL DEFAULT 10240,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_log(tenant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_path TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('turn', 'conversation', 'project', 'user')),
        kind TEXT NOT NULL CHECK(kind IN ('message', 'fact', 'decision', 'summary')),
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        source_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_task_scope ON memory_entries(task_id, scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_entries(tenant_id, workspace_path, updated_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_roots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('primary', 'additional')),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_roots_task ON workspace_roots(task_id, created_at);
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('old', 'new')),
        body TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_comments_task ON review_comments(task_id, resolved_at, created_at);
      CREATE TABLE IF NOT EXISTS task_automations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        runtime TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
        approval_policy TEXT NOT NULL DEFAULT 'on-request',
        approvals_reviewer TEXT NOT NULL DEFAULT 'user',
        workspace_path TEXT,
        schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once','interval','daily','weekly')),
        once_at TEXT,
        interval_minutes INTEGER,
        time_of_day TEXT,
        weekdays_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('active','paused')),
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automations_due ON task_automations(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_tenant ON task_automations(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES task_automations(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','failed')),
        scheduled_for TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
      );
    `);
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "archived_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
    }
    const taskMigrations: Array<[string, string]> = [
      ["priority", "INTEGER NOT NULL DEFAULT 0"], ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
      ["lease_owner", "TEXT"], ["lease_expires_at", "TEXT"], ["heartbeat_at", "TEXT"],
      ["next_attempt_at", "TEXT"], ["parent_task_id", "TEXT"], ["root_task_id", "TEXT"],
      ["pinned_at", "TEXT"], ["section", "TEXT"],
      ["reasoning_effort", "TEXT"], ["sandbox_mode", "TEXT NOT NULL DEFAULT 'workspace-write'"],
      ["approval_policy", "TEXT NOT NULL DEFAULT 'on-request'"], ["approvals_reviewer", "TEXT NOT NULL DEFAULT 'user'"],
      ["goal_status", "TEXT NOT NULL DEFAULT 'inactive'"], ["goal_objective", "TEXT"],
      ["goal_max_turns", "INTEGER NOT NULL DEFAULT 0"], ["goal_completed_turns", "INTEGER NOT NULL DEFAULT 0"],
      ["goal_progress", "INTEGER NOT NULL DEFAULT 0"], ["goal_last_summary", "TEXT"], ["goal_next_step", "TEXT"],
      ["goal_deadline_at", "TEXT"],
      ["goal_token_budget", "INTEGER NOT NULL DEFAULT 0"], ["goal_tokens_used", "INTEGER NOT NULL DEFAULT 0"],
      ["goal_last_usage_total", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of taskMigrations) {
      if (!taskColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
    const sandboxColumns = this.db.prepare("PRAGMA table_info(task_sandboxes)").all() as unknown as Array<{ name: string }>;
    for (const [name, definition] of [["container_id", "TEXT"], ["image", "TEXT"], ["cpu_limit", "REAL"], ["memory_mb", "INTEGER"]] as Array<[string, string]>) {
      if (!sandboxColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE task_sandboxes ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_queue_claim ON tasks(status, priority DESC, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease_expiry ON tasks(lease_expires_at) WHERE lease_owner IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_pinned ON tasks(tenant_id, pinned_at DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_archive_status ON tasks(tenant_id, archived_at, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_archive_provider ON tasks(tenant_id, archived_at, provider, model);
    `);
    const approvalColumns = this.db.prepare("PRAGMA table_info(approvals)").all() as unknown as Array<{ name: string }>;
    const approvalMigrations: Array<[string, string]> = [
      ["kind", "TEXT NOT NULL DEFAULT 'command'"], ["risk", "TEXT NOT NULL DEFAULT 'medium'"],
      ["command", "TEXT"], ["cwd", "TEXT"], ["path", "TEXT"], ["network_host", "TEXT"],
      ["scope", "TEXT"], ["request_json", "TEXT NOT NULL DEFAULT '{}'"], ["decision_json", "TEXT"],
    ];
    for (const [name, definition] of approvalMigrations) {
      if (!approvalColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE approvals ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
    const projectGroupingMigration = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get();
    if (!projectGroupingMigration) {
      const taskRows = this.db.prepare("SELECT id, root_task_id, checkpoint_json FROM tasks").all() as unknown as Array<{ id: string; root_task_id: string | null; checkpoint_json: string | null }>;
      const taskById = new Map(taskRows.map((row) => [row.id, row]));
      const forkSource = (row: { checkpoint_json: string | null }): string | null => {
        if (!row.checkpoint_json) return null;
        try {
          const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
          return checkpoint.phase === "thread_fork" && typeof checkpoint.sourceTaskId === "string" ? checkpoint.sourceTaskId : null;
        } catch { return null; }
      };
      const projectRoot = (taskId: string, visited = new Set<string>()): string => {
        if (visited.has(taskId)) return taskId;
        visited.add(taskId);
        const row = taskById.get(taskId);
        if (!row) return taskId;
        const sourceId = forkSource(row);
        if (sourceId) return projectRoot(sourceId, visited);
        return row.root_task_id && row.root_task_id !== row.id ? row.root_task_id : row.id;
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of taskRows) {
          if (forkSource(row)) this.db.prepare("UPDATE tasks SET root_task_id = ? WHERE id = ?").run(projectRoot(row.id), row.id);
        }
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)").run(new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)").run(new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (10, ?)").run(new Date().toISOString());
    this.db.exec(`
      INSERT OR IGNORE INTO task_messages (task_id, role, content, turn, created_at)
      SELECT id, 'user', prompt, 0, created_at FROM tasks;

      INSERT OR IGNORE INTO task_messages (task_id, role, content, turn, created_at)
      SELECT id, 'assistant', result, 0, COALESCE(finished_at, updated_at)
      FROM tasks WHERE result IS NOT NULL AND result != '';
    `);
  }

  createTask(input: CreateTaskInput, defaults: { runtime: "mock" | "codex"; model: string }): AgentTask {
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: randomUUID(),
      tenantId: input.tenantId ?? "local",
      userId: input.userId ?? "local-user",
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      runtime: input.runtime ?? defaults.runtime,
      provider: input.provider ?? "openai",
      model: input.model || defaults.model,
      reasoningEffort: input.reasoningEffort ?? null,
      sandboxMode: input.sandboxMode ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "on-request",
      approvalsReviewer: input.approvalsReviewer ?? "user",
      workspacePath: input.workspacePath || null,
      projectWorkspacePath: input.workspacePath || null,
      threadId: null,
      result: null,
      error: null,
      checkpoint: null,
      waitSeconds: Math.max(0, Math.min(input.waitSeconds ?? 0, 86_400)),
      nextWakeupAt: null,
      cancelRequested: false,
      attempt: 0,
      priority: Math.max(-100, Math.min(input.priority ?? 0, 100)),
      maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 3, 10)),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      nextAttemptAt: null,
      parentTaskId: input.parentTaskId ?? null,
      rootTaskId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      archivedAt: null,
      pinnedAt: null,
      section: input.section ?? null,
      goalStatus: input.goalMode ? "active" : "inactive",
      goalObjective: input.goalMode ? (input.goalObjective?.trim() || input.prompt) : null,
      goalMaxTurns: input.goalMode ? Math.max(2, Math.min(input.goalMaxTurns ?? 5, 20)) : 0,
      goalCompletedTurns: 0,
      goalProgress: 0,
      goalLastSummary: null,
      goalNextStep: null,
      goalDeadlineAt: input.goalMode && input.goalDeadlineHours
        ? new Date(Date.now() + Math.max(1, Math.min(input.goalDeadlineHours, 168)) * 3_600_000).toISOString()
        : null,
      goalTokenBudget: input.goalMode ? Math.max(0, Math.min(input.goalTokenBudget ?? 0, 10_000_000)) : 0,
      goalTokensUsed: 0,
      goalLastUsageTotal: 0,
    };
    this.db.prepare(`
      INSERT INTO tasks (
        id, tenant_id, user_id, title, prompt, status, runtime, provider, model, reasoning_effort, sandbox_mode, approval_policy, approvals_reviewer,
        workspace_path, thread_id, result, error, checkpoint_json, wait_seconds,
        next_wakeup_at, cancel_requested, attempt, priority, max_attempts, lease_owner,
        lease_expires_at, heartbeat_at, next_attempt_at, parent_task_id, root_task_id,
        created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.tenantId, task.userId, task.title, task.prompt, task.status,
      task.runtime, task.provider, task.model, task.reasoningEffort, task.sandboxMode, task.approvalPolicy, task.approvalsReviewer, task.workspacePath, null, null, null, null,
      task.waitSeconds, null, 0, 0, task.priority, task.maxAttempts, null, null, null, null,
      task.parentTaskId, null, now, now, null, null,
    );
    task.rootTaskId = task.parentTaskId ? (this.getTask(task.parentTaskId)?.rootTaskId ?? task.parentTaskId) : task.id;
    this.db.prepare("UPDATE tasks SET root_task_id = ? WHERE id = ?").run(task.rootTaskId, task.id);
    if (task.section) this.db.prepare("UPDATE tasks SET section = ? WHERE id = ?").run(task.section, task.id);
    if (task.goalStatus !== "inactive") this.db.prepare(`UPDATE tasks SET goal_status=?, goal_objective=?, goal_max_turns=?,
      goal_completed_turns=0, goal_progress=0, goal_deadline_at=?, goal_token_budget=?, goal_tokens_used=0,
      goal_last_usage_total=0 WHERE id=?`).run(task.goalStatus, task.goalObjective, task.goalMaxTurns, task.goalDeadlineAt, task.goalTokenBudget, task.id);
    if (task.workspacePath) this.addWorkspaceRoot(task.id, task.workspacePath, path.basename(task.workspacePath), "primary");
    this.appendMessage(task.id, "user", task.prompt, 0);
    return task;
  }

  getTask(id: string): AgentTask | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  deleteFreshTask(id: string): void {
    const task = this.requireTask(id);
    if (task.status !== "queued" || task.startedAt) throw new Error("Only a task that has not started can be rolled back");
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    fs.rmSync(path.join(this.artifactDir, id), { recursive: true, force: true });
  }

  deleteArchivedTaskFor(id: string, identity: RequestIdentity): DeletedTaskSummary {
    const task = this.getTaskFor(id, identity);
    if (!task) throw new Error("Task not found");
    if (!task.archivedAt) throw new Error("只有已归档对话才能永久删除");
    if (!["succeeded", "failed", "cancelled"].includes(task.status)) throw new Error("运行中或等待中的对话不能删除");
    const child = this.db.prepare("SELECT id FROM tasks WHERE parent_task_id = ? LIMIT 1").get(id);
    if (child) throw new Error("该对话仍有子 Agent 任务，请先分别归档并删除子任务");
    const dependent = this.db.prepare("SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? LIMIT 1").get(id);
    if (dependent) throw new Error("该目标仍被其他持续目标依赖，请先移除前置依赖");
    const artifactSize = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM task_artifacts WHERE task_id = ?")
      .get(id) as unknown as { bytes: number };
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ? AND tenant_id = ? AND archived_at IS NOT NULL")
      .run(id, identity.tenantId);
    if (Number(result.changes) !== 1) throw new Error("Task could not be deleted");
    fs.rmSync(path.join(this.artifactDir, id), { recursive: true, force: true });
    return { taskId: id, title: task.title, artifactBytes: Number(artifactSize.bytes) || 0 };
  }

  listTasks(limit = 100, archived = false): AgentTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as unknown as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  listTasksFor(identity: RequestIdentity, limit = 100, archived = false): AgentTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE tenant_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL
       ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC LIMIT ?`,
    ).all(identity.tenantId, limit) as unknown as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  queryTasksFor(identity: RequestIdentity, options: { limit?: number; archived?: boolean; query?: string; statusGroup?: TaskStatusGroup; provider?: string; model?: string; project?: string } = {}): { tasks: AgentTask[]; total: number } {
    const limit = Math.max(20, Math.min(options.limit ?? 100, 1_000));
    const archived = options.archived ?? false;
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const clauses = [`tenant_id = ?`, `archived_at IS ${archived ? "NOT " : ""}NULL`];
    const params: Array<string> = [identity.tenantId];
    const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
    if (query) {
      clauses.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(prompt) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(workspace_path, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(section, '')) LIKE ? ESCAPE '\\')");
      params.push(...Array(4).fill(`%${escapedQuery}%`));
    }
    const statusGroups: Record<TaskStatusGroup, TaskStatus[]> = {
      active: ["queued", "preparing", "running", "verifying"],
      waiting: ["waiting_timer", "waiting_external", "waiting_approval", "waiting_retry"],
      completed: ["succeeded"],
      stopped: ["failed", "cancelled"],
    };
    if (options.statusGroup) {
      const statuses = statusGroups[options.statusGroup];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (options.provider) { clauses.push("provider = ?"); params.push(options.provider); }
    if (options.model) {
      clauses.push(options.model === "__provider_default__" ? "COALESCE(model, '') = ''" : "model = ?");
      if (options.model !== "__provider_default__") params.push(options.model);
    }
    if (options.project?.startsWith("section:")) {
      clauses.push("LOWER(COALESCE(section, '')) = LOWER(?)"); params.push(options.project.slice("section:".length));
    } else if (options.project?.startsWith("workspace:")) {
      clauses.push("LOWER(COALESCE((SELECT project_root.workspace_path FROM tasks AS project_root WHERE project_root.id = tasks.root_task_id AND project_root.id != tasks.id), NULLIF(workspace_path, ''), '')) = LOWER(?)"); params.push(options.project.slice("workspace:".length));
    }
    const where = clauses.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`)
      .get(...params) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${where}
      ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRow[];
    return { tasks: rows.map((row) => this.mapTask(row)), total };
  }

  taskFacetsFor(identity: RequestIdentity, archived = false): TaskListFacets {
    const archiveClause = `archived_at IS ${archived ? "NOT " : ""}NULL`;
    const base = `tenant_id = ? AND ${archiveClause}`;
    const statusRows = this.db.prepare(`SELECT status AS value, COUNT(*) AS count FROM tasks WHERE ${base} GROUP BY status`)
      .all(identity.tenantId) as unknown as Array<{ value: TaskStatus; count: number }>;
    const statusCounts = Object.fromEntries(statusRows.map((row) => [row.value, Number(row.count)])) as Partial<Record<TaskStatus, number>>;
    const providers = this.db.prepare(`SELECT provider AS value, provider AS label, COUNT(*) AS count FROM tasks WHERE ${base} GROUP BY provider ORDER BY count DESC, provider`)
      .all(identity.tenantId) as unknown as Array<{ value: string; label: string; count: number }>;
    const models = this.db.prepare(`SELECT CASE WHEN COALESCE(model, '') = '' THEN '__provider_default__' ELSE model END AS value,
      CASE WHEN COALESCE(model, '') = '' THEN '供应商默认模型' ELSE model END AS label, COUNT(*) AS count
      FROM tasks WHERE ${base} GROUP BY value ORDER BY count DESC, label`)
      .all(identity.tenantId) as unknown as Array<{ value: string; label: string; count: number }>;
    const projects = this.db.prepare(`SELECT
      CASE WHEN TRIM(COALESCE(section, '')) != '' THEN 'section:' || section
        ELSE 'workspace:' || COALESCE((SELECT project_root.workspace_path FROM tasks AS project_root WHERE project_root.id = tasks.root_task_id AND project_root.id != tasks.id), NULLIF(workspace_path, ''), '') END AS value,
      CASE WHEN TRIM(COALESCE(section, '')) != '' THEN section
        ELSE COALESCE((SELECT project_root.workspace_path FROM tasks AS project_root WHERE project_root.id = tasks.root_task_id AND project_root.id != tasks.id), NULLIF(workspace_path, ''), '') END AS label,
      COUNT(*) AS count FROM tasks WHERE ${base} GROUP BY LOWER(value) ORDER BY count DESC, label`)
      .all(identity.tenantId) as unknown as Array<{ value: string; label: string; count: number }>;
    const sum = (...statuses: TaskStatus[]) => statuses.reduce((total, status) => total + (statusCounts[status] ?? 0), 0);
    return {
      statuses: {
        active: sum("queued", "preparing", "running", "verifying"),
        waiting: sum("waiting_timer", "waiting_external", "waiting_approval", "waiting_retry"),
        completed: sum("succeeded"),
        stopped: sum("failed", "cancelled"),
      },
      providers: providers.map((item) => ({ ...item, count: Number(item.count) })),
      models: models.map((item) => ({ ...item, count: Number(item.count) })),
      projects: projects.map((item) => ({ ...item, count: Number(item.count) })),
    };
  }

  listGoalsFor(identity: RequestIdentity, includeCompleted = true, limit = 500): AgentTask[] {
    const completedClause = includeCompleted ? "" : " AND goal_status != 'completed'";
    const rows = this.db.prepare(`SELECT * FROM tasks
      WHERE tenant_id = ? AND archived_at IS NULL AND goal_status != 'inactive'${completedClause}
      ORDER BY CASE goal_status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 WHEN 'paused' THEN 2
        WHEN 'deadline_reached' THEN 3 WHEN 'budget_reached' THEN 4 WHEN 'limit_reached' THEN 5 ELSE 6 END,
        updated_at DESC LIMIT ?`).all(identity.tenantId, Math.max(1, Math.min(limit, 1_000))) as unknown as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  addTaskDependency(taskId: string, dependsOnTaskId: string, identity: RequestIdentity): TaskDependency {
    if (taskId === dependsOnTaskId) throw new Error("目标不能依赖自身");
    const task = this.getTaskFor(taskId, identity);
    const prerequisite = this.getTaskFor(dependsOnTaskId, identity);
    if (!task || !prerequisite) throw new Error("目标不存在或不属于当前租户");
    if (task.goalStatus === "inactive" || prerequisite.goalStatus === "inactive") throw new Error("只有持续目标之间可以建立前置依赖");
    if (task.goalStatus === "completed") throw new Error("已完成目标不能新增前置依赖");
    if (["preparing", "running", "verifying", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry"].includes(task.status)) {
      throw new Error("当前轮次仍在执行或等待恢复，请先停止或等待本轮结束后再设置前置目标");
    }
    const cycle = this.db.prepare(`WITH RECURSIVE upstream(id) AS (
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
      UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN upstream u ON d.task_id = u.id
    ) SELECT 1 AS found FROM upstream WHERE id = ? LIMIT 1`).get(dependsOnTaskId, taskId);
    if (cycle) throw new Error("该依赖会形成循环，无法保存");
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)")
      .run(taskId, dependsOnTaskId, createdAt);
    const dependency = this.listTaskDependencies(taskId).find((item) => item.dependsOnTaskId === dependsOnTaskId);
    if (!dependency) throw new Error("Goal dependency could not be saved");
    return dependency;
  }

  removeTaskDependency(taskId: string, dependsOnTaskId: string, identity: RequestIdentity): boolean {
    if (!this.getTaskFor(taskId, identity) || !this.getTaskFor(dependsOnTaskId, identity)) return false;
    return Number(this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(taskId, dependsOnTaskId).changes) === 1;
  }

  listTaskDependencies(taskId: string): TaskDependency[] {
    return this.listTaskDependenciesFor([taskId])[taskId] ?? [];
  }

  listTaskDependenciesFor(taskIds: string[]): Record<string, TaskDependency[]> {
    const unique = [...new Set(taskIds)];
    const grouped: Record<string, TaskDependency[]> = Object.fromEntries(unique.map((taskId) => [taskId, [] as TaskDependency[]]));
    if (!unique.length) return grouped;
    const rows = this.db.prepare(`SELECT d.task_id, d.depends_on_task_id, d.created_at, t.title, t.status, t.goal_status
      FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id
      WHERE d.task_id IN (${unique.map(() => "?").join(",")}) ORDER BY d.created_at`)
      .all(...unique) as unknown as Array<{ task_id: string; depends_on_task_id: string; created_at: string; title: string; status: TaskStatus; goal_status: import("./types.js").GoalStatus }>;
    for (const row of rows) (grouped[row.task_id] ??= []).push({
      taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id, title: row.title, status: row.status,
      goalStatus: row.goal_status, satisfied: row.goal_status === "completed" && ["succeeded", "cancelled"].includes(row.status), createdAt: row.created_at,
    });
    return grouped;
  }

  createAutomation(input: CreateAutomationInput): TaskAutomation {
    const now = new Date();
    const id = randomUUID();
    const nextRunAt = input.status === "paused" ? null : computeNextAutomationRun(input, now);
    const createdAt = now.toISOString();
    this.db.prepare(`INSERT INTO task_automations (
      id, tenant_id, user_id, name, prompt, runtime, provider, model, reasoning_effort,
      sandbox_mode, approval_policy, approvals_reviewer, workspace_path, schedule_kind,
      once_at, interval_minutes, time_of_day, weekdays_json, status, next_run_at,
      last_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(id, input.tenantId, input.userId, input.name, input.prompt, input.runtime, input.provider,
        input.model ?? null, input.reasoningEffort ?? null, input.sandboxMode, input.approvalPolicy,
        input.approvalsReviewer, input.workspacePath ?? null, input.scheduleKind, input.onceAt ?? null,
        input.intervalMinutes ?? null, input.timeOfDay ?? null, JSON.stringify(input.weekdays ?? []),
        input.status ?? "active", nextRunAt, createdAt, createdAt);
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): TaskAutomation | null {
    const row = this.db.prepare("SELECT * FROM task_automations WHERE id = ?").get(id) as unknown as AutomationRow | undefined;
    return row ? mapAutomation(row) : null;
  }

  getAutomationFor(id: string, identity: RequestIdentity): TaskAutomation | null {
    const row = this.db.prepare("SELECT * FROM task_automations WHERE id = ? AND tenant_id = ?")
      .get(id, identity.tenantId) as unknown as AutomationRow | undefined;
    return row ? mapAutomation(row) : null;
  }

  listAutomationsFor(identity: RequestIdentity): TaskAutomation[] {
    const rows = this.db.prepare("SELECT * FROM task_automations WHERE tenant_id = ? ORDER BY updated_at DESC")
      .all(identity.tenantId) as unknown as AutomationRow[];
    return rows.map(mapAutomation);
  }

  updateAutomation(id: string, patch: Partial<Omit<CreateAutomationInput, "tenantId" | "userId">>): TaskAutomation {
    const current = this.getAutomation(id);
    if (!current) throw new Error("Automation not found");
    const merged = { ...current, ...patch };
    const status = patch.status ?? current.status;
    const nextRunAt = status === "active" ? computeNextAutomationRun(merged, new Date()) : null;
    const updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE task_automations SET name=?, prompt=?, runtime=?, provider=?, model=?, reasoning_effort=?,
      sandbox_mode=?, approval_policy=?, approvals_reviewer=?, workspace_path=?, schedule_kind=?, once_at=?,
      interval_minutes=?, time_of_day=?, weekdays_json=?, status=?, next_run_at=?, updated_at=? WHERE id=?`)
      .run(merged.name, merged.prompt, merged.runtime, merged.provider, merged.model ?? null,
        merged.reasoningEffort ?? null, merged.sandboxMode, merged.approvalPolicy, merged.approvalsReviewer,
        merged.workspacePath ?? null, merged.scheduleKind, merged.onceAt ?? null, merged.intervalMinutes ?? null,
        merged.timeOfDay ?? null, JSON.stringify(merged.weekdays ?? []), status, nextRunAt, updatedAt, id);
    return this.getAutomation(id)!;
  }

  deleteAutomation(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM task_automations WHERE id = ?").run(id).changes) === 1;
  }

  claimDueAutomations(now = new Date()): Array<{ automation: TaskAutomation; scheduledFor: string }> {
    const nowIso = now.toISOString();
    const due = this.db.prepare(`SELECT * FROM task_automations
      WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20`)
      .all(nowIso) as unknown as AutomationRow[];
    const claimed: Array<{ automation: TaskAutomation; scheduledFor: string }> = [];
    for (const row of due) {
      const automation = mapAutomation(row);
      const nextRunAt = automation.scheduleKind === "once" ? null : computeNextAutomationRun(automation, now);
      const status = automation.scheduleKind === "once" ? "paused" : "active";
      const result = this.db.prepare(`UPDATE task_automations SET status=?, last_run_at=?, next_run_at=?, updated_at=?
        WHERE id=? AND status='active' AND next_run_at=?`)
        .run(status, nowIso, nextRunAt, nowIso, automation.id, automation.nextRunAt);
      if (Number(result.changes) === 1) claimed.push({
        automation: { ...automation, status, lastRunAt: nowIso, nextRunAt, updatedAt: nowIso },
        scheduledFor: automation.nextRunAt ?? nowIso,
      });
    }
    return claimed;
  }

  recordAutomationRun(automationId: string, scheduledFor: string, taskId: string | null, error: string | null = null): AutomationRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO automation_runs (id, automation_id, task_id, state, scheduled_for, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, automationId, taskId, error ? "failed" : "queued", scheduledFor, error, createdAt);
    this.db.prepare("UPDATE task_automations SET last_run_at = ?, updated_at = ? WHERE id = ?")
      .run(createdAt, createdAt, automationId);
    return this.listAutomationRuns(automationId, 1)[0];
  }

  listAutomationRuns(automationId: string, limit = 20): AutomationRun[] {
    const rows = this.db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(automationId, limit) as unknown as AutomationRunRow[];
    return rows.map(mapAutomationRun);
  }

  getTaskFor(id: string, identity: RequestIdentity): AgentTask | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND tenant_id = ?")
      .get(id, identity.tenantId) as unknown as TaskRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  listChildTasks(parentTaskId: string): AgentTask[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at")
      .all(parentTaskId) as unknown as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  forkConversation(sourceId: string, title: string, threadId: string): AgentTask {
    const source = this.requireTask(sourceId);
    const branch = this.createTask({
      title, prompt: source.prompt, runtime: source.runtime, provider: source.provider,
      model: source.model ?? undefined, reasoningEffort: source.reasoningEffort ?? undefined,
      sandboxMode: source.sandboxMode, approvalPolicy: source.approvalPolicy,
      approvalsReviewer: source.approvalsReviewer, workspacePath: source.workspacePath ?? undefined,
      section: source.section ?? undefined,
      tenantId: source.tenantId, userId: source.userId,
    }, { runtime: source.runtime, model: source.model ?? "" });
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(branch.id);
      this.db.prepare(`INSERT INTO task_messages (task_id, role, content, turn, created_at)
        SELECT ?, role, content, turn, created_at FROM task_messages WHERE task_id = ? ORDER BY id`).run(branch.id, source.id);
      this.updateTask(branch.id, {
        status: "succeeded", threadId, result: source.result, error: null, attempt: source.attempt,
        rootTaskId: source.rootTaskId ?? source.id,
        checkpoint: { phase: "thread_fork", sourceTaskId: source.id }, startedAt: source.startedAt, finishedAt: now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.refreshMemory(branch.id);
    return this.requireTask(branch.id);
  }

  recoverInterruptedTasks(): TaskRecoveryResult[] {
    const rows = this.db.prepare(
      "SELECT id, attempt, max_attempts FROM tasks WHERE status IN ('preparing', 'running', 'verifying')",
    ).all() as unknown as Array<{ id: string; attempt: number; max_attempts: number }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const recovered: TaskRecoveryResult[] = [];
    for (const row of rows) {
      if (row.attempt + 1 >= row.max_attempts) {
        this.addDeadLetter(row.id, "应用在执行期间多次重启，已达到自动恢复上限", { recovery: true });
        this.db.prepare(`UPDATE tasks SET status='failed', attempt=attempt+1, error=?, finished_at=?, lease_owner=NULL,
          lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`).run("应用在执行期间多次重启，已达到自动恢复上限", now, now, row.id);
        recovered.push({ taskId: row.id, outcome: "failed", reason: "application_restart", attempt: row.attempt + 1, maxAttempts: row.max_attempts });
      } else {
        this.db.prepare(`UPDATE tasks SET status='queued', attempt=attempt+1, cancel_requested=0, error=NULL,
          lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`).run(now, row.id);
        recovered.push({ taskId: row.id, outcome: "queued", reason: "application_restart", attempt: row.attempt + 1, maxAttempts: row.max_attempts });
      }
    }
    return recovered;
  }

  countActiveByProvider(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT provider, COUNT(*) AS count FROM tasks
       WHERE status IN ('preparing', 'running', 'verifying') GROUP BY provider`,
    ).all() as unknown as Array<{ provider: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.provider, row.count]));
  }

  claimNextTask(workerId = "local-worker", leaseMs = 45_000, excludedProviders: string[] = []): AgentTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const providerClause = excludedProviders.length
        ? ` AND provider NOT IN (${excludedProviders.map(() => "?").join(",")})`
        : "";
      const row = this.db.prepare(
        `SELECT * FROM tasks WHERE status = 'queued' AND cancel_requested = 0
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)${providerClause}
         AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id=d.depends_on_task_id
           WHERE d.task_id=tasks.id AND NOT (prerequisite.goal_status='completed' AND prerequisite.status IN ('succeeded','cancelled')))
         AND (SELECT COUNT(*) FROM tasks active WHERE active.tenant_id = tasks.tenant_id
              AND active.status IN ('preparing','running','verifying')) <
             COALESCE((SELECT max_concurrent_tasks FROM tenant_quotas WHERE tenant_id = tasks.tenant_id), 2)
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
      ).get(now, ...excludedProviders) as unknown as TaskRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      this.db.prepare(
        `UPDATE tasks SET status = 'preparing', updated_at = ?, started_at = COALESCE(started_at, ?),
         lease_owner = ?, lease_expires_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'queued'`,
      ).run(now, now, workerId, leaseExpiresAt, now, row.id);
      this.db.exec("COMMIT");
      return this.getTask(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(id: string, to: TaskStatus, patch: Partial<AgentTask> = {}): AgentTask {
    const task = this.requireTask(id);
    assertTransition(task.status, to);
    return this.updateTask(id, { ...patch, status: to });
  }

  updateTask(id: string, patch: Partial<AgentTask>): AgentTask {
    const columns: Record<string, string> = {
      prompt: "prompt", status: "status", workspacePath: "workspace_path", threadId: "thread_id", result: "result",
      model: "model", reasoningEffort: "reasoning_effort", sandboxMode: "sandbox_mode", approvalPolicy: "approval_policy", approvalsReviewer: "approvals_reviewer",
      error: "error", checkpoint: "checkpoint_json", nextWakeupAt: "next_wakeup_at",
      waitSeconds: "wait_seconds", cancelRequested: "cancel_requested", attempt: "attempt",
      priority: "priority", maxAttempts: "max_attempts", leaseOwner: "lease_owner",
      leaseExpiresAt: "lease_expires_at", heartbeatAt: "heartbeat_at", nextAttemptAt: "next_attempt_at",
      parentTaskId: "parent_task_id", rootTaskId: "root_task_id",
      startedAt: "started_at", finishedAt: "finished_at", archivedAt: "archived_at",
      pinnedAt: "pinned_at", section: "section",
      goalStatus: "goal_status", goalObjective: "goal_objective", goalMaxTurns: "goal_max_turns",
      goalCompletedTurns: "goal_completed_turns", goalProgress: "goal_progress",
      goalLastSummary: "goal_last_summary", goalNextStep: "goal_next_step",
      goalDeadlineAt: "goal_deadline_at",
      goalTokenBudget: "goal_token_budget", goalTokensUsed: "goal_tokens_used", goalLastUsageTotal: "goal_last_usage_total",
    };
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = patch[key as keyof AgentTask];
      assignments.push(`${column} = ?`);
      if (key === "checkpoint") values.push(value == null ? null : JSON.stringify(value));
      else if (key === "cancelRequested") values.push(value ? 1 : 0);
      else values.push(value == null ? null : String(value));
    }
    if (assignments.length === 0) return this.requireTask(id);
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return this.requireTask(id);
  }

  wakeDueTasks(): number {
    const now = new Date().toISOString();
    const due = this.db.prepare(
      "SELECT id FROM tasks WHERE status = 'waiting_timer' AND next_wakeup_at <= ? AND cancel_requested = 0",
    ).all(now) as unknown as Array<{ id: string }>;
    for (const row of due) this.transition(row.id, "queued", { nextWakeupAt: null });
    const retries = this.db.prepare(
      "SELECT id FROM tasks WHERE status = 'waiting_retry' AND next_attempt_at <= ? AND cancel_requested = 0",
    ).all(now) as unknown as Array<{ id: string }>;
    for (const row of retries) this.transition(row.id, "queued", { nextAttemptAt: null });
    const timers = this.db.prepare(
      "SELECT id FROM durable_signals WHERE kind = 'timer' AND state = 'pending' AND available_at <= ?",
    ).all(now) as unknown as Array<{ id: string }>;
    for (const timer of timers) this.resolveSignal(timer.id, { firedAt: now });
    return due.length + retries.length + timers.length;
  }

  expireQueuedGoalDeadlines(now = new Date()): string[] {
    const timestamp = now.toISOString();
    const rows = this.db.prepare(`SELECT id FROM tasks
      WHERE status='queued' AND goal_status='active' AND goal_deadline_at IS NOT NULL AND goal_deadline_at <= ?`).all(timestamp) as unknown as Array<{ id: string }>;
    for (const row of rows) {
      this.db.prepare(`UPDATE tasks SET status='cancelled', goal_status='deadline_reached',
        goal_next_step='截止时间已到；可延长截止时间后恢复。', finished_at=?, lease_owner=NULL,
        lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`).run(timestamp, timestamp, row.id);
    }
    return rows.map((row) => row.id);
  }

  heartbeat(taskId: string, workerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND status IN ('preparing', 'running', 'verifying')`,
    ).run(now, new Date(Date.now() + leaseMs).toISOString(), now, taskId, workerId);
    return Number(result.changes) === 1;
  }

  releaseLease(taskId: string, workerId?: string): void {
    const where = workerId ? "id = ? AND lease_owner = ?" : "id = ?";
    this.db.prepare(`UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE ${where}`)
      .run(...(workerId ? [taskId, workerId] : [taskId]));
  }

  recoverExpiredLeases(): TaskRecoveryResult[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT id FROM tasks WHERE lease_owner IS NOT NULL AND lease_expires_at < ?
       AND status IN ('preparing', 'running', 'verifying')`,
    ).all(now) as unknown as Array<{ id: string }>;
    const recovered: TaskRecoveryResult[] = [];
    for (const row of rows) {
      const task = this.requireTask(row.id);
      if (task.attempt + 1 >= task.maxAttempts) {
        this.addDeadLetter(task.id, "Worker 多次失联，已达到自动恢复上限", { leaseOwner: task.leaseOwner });
        this.db.prepare(`UPDATE tasks SET status = 'failed', attempt = attempt + 1, error = ?, finished_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?`)
          .run("Worker 多次失联，已达到自动恢复上限", now, now, row.id);
        recovered.push({ taskId: row.id, outcome: "failed", reason: "lease_expired", attempt: task.attempt + 1, maxAttempts: task.maxAttempts });
      } else {
        this.db.prepare(
          `UPDATE tasks SET status = 'queued', attempt = attempt + 1, lease_owner = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(now, row.id);
        recovered.push({ taskId: row.id, outcome: "queued", reason: "lease_expired", attempt: task.attempt + 1, maxAttempts: task.maxAttempts });
      }
    }
    return recovered;
  }

  scheduleRetry(taskId: string, reason: string): AgentTask {
    const task = this.requireTask(taskId);
    const nextAttempt = task.attempt + 1;
    if (nextAttempt >= task.maxAttempts) {
      this.addDeadLetter(taskId, reason, { checkpoint: task.checkpoint, error: task.error });
      return this.transition(taskId, "failed", {
        error: reason,
        attempt: nextAttempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date().toISOString(),
      });
    }
    const delayMs = Math.min(60_000, 1_000 * (2 ** task.attempt));
    return this.transition(taskId, "waiting_retry", {
      error: reason,
      attempt: nextAttempt,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
  }

  createSignal(taskId: string, kind: DurableSignalKind, correlationKey: string, payload: Record<string, unknown> = {}, availableAt: string | null = null): DurableSignal {
    this.requireTask(taskId);
    const existing = this.getSignalByCorrelation(correlationKey);
    if (existing) return existing;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO durable_signals (id, task_id, kind, state, correlation_key, payload_json, available_at, resolved_at, consumed_at, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?)`,
    ).run(id, taskId, kind, correlationKey, JSON.stringify(payload), availableAt, createdAt);
    return this.getSignal(id)!;
  }

  getSignal(id: string): DurableSignal | null {
    const row = this.db.prepare("SELECT * FROM durable_signals WHERE id = ?").get(id) as unknown as Record<string, unknown> | undefined;
    return row ? mapSignal(row) : null;
  }

  getSignalByCorrelation(key: string): DurableSignal | null {
    const row = this.db.prepare("SELECT * FROM durable_signals WHERE correlation_key = ?").get(key) as unknown as Record<string, unknown> | undefined;
    return row ? mapSignal(row) : null;
  }

  listSignals(taskId?: string): DurableSignal[] {
    const rows = (taskId
      ? this.db.prepare("SELECT * FROM durable_signals WHERE task_id = ? ORDER BY created_at").all(taskId)
      : this.db.prepare("SELECT * FROM durable_signals ORDER BY created_at DESC").all()) as unknown as Record<string, unknown>[];
    return rows.map(mapSignal);
  }

  resolveSignal(id: string, payload: Record<string, unknown> = {}): DurableSignal {
    const signal = this.getSignal(id);
    if (!signal) throw new Error("Signal not found");
    if (signal.state !== "pending") return signal;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE durable_signals SET state = 'resolved', payload_json = ?, resolved_at = ? WHERE id = ? AND state = 'pending'")
      .run(JSON.stringify({ ...signal.payload, ...payload }), now, id);
    const task = this.requireTask(signal.taskId);
    if (["waiting_timer", "waiting_external"].includes(task.status)) this.transition(task.id, "queued", { nextWakeupAt: null });
    return this.getSignal(id)!;
  }

  consumeSignal(id: string): DurableSignal {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE durable_signals SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'resolved'").run(now, id);
    const signal = this.getSignal(id);
    if (!signal) throw new Error("Signal not found");
    return signal;
  }

  addDeadLetter(taskId: string, reason: string, payload: Record<string, unknown> = {}): DeadLetter {
    const task = this.requireTask(taskId);
    const row: DeadLetter = { id: randomUUID(), taskId, attempt: task.attempt + 1, reason, payload, createdAt: new Date().toISOString(), replayedAt: null };
    this.db.prepare("INSERT INTO dead_letters (id, task_id, attempt, reason, payload_json, created_at, replayed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(row.id, row.taskId, row.attempt, row.reason, JSON.stringify(row.payload), row.createdAt);
    return row;
  }

  listDeadLetters(): DeadLetter[] {
    const rows = this.db.prepare("SELECT * FROM dead_letters ORDER BY created_at DESC").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), taskId: String(row.task_id), attempt: Number(row.attempt), reason: String(row.reason), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at), replayedAt: row.replayed_at ? String(row.replayed_at) : null }));
  }

  replayDeadLetter(id: string): { letter: DeadLetter; task: AgentTask } {
    const row = this.db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error("Dead letter not found");
    const letter = this.listDeadLetters().find((item) => item.id === id)!;
    if (letter.replayedAt) throw new Error("Dead letter has already been replayed");
    const task = this.retry(letter.taskId);
    const replayedAt = new Date().toISOString();
    this.db.prepare("UPDATE dead_letters SET replayed_at = ? WHERE id = ? AND replayed_at IS NULL").run(replayedAt, id);
    return { letter: { ...letter, replayedAt }, task };
  }

  beginIdempotent(taskId: string, key: string, operation: string): { record: IdempotencyRecord; fresh: boolean } {
    this.requireTask(taskId);
    const current = this.getIdempotency(key);
    if (current) return { record: current, fresh: false };
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO idempotency_records (key, task_id, operation, state, result_json, created_at, updated_at) VALUES (?, ?, ?, 'started', NULL, ?, ?)")
      .run(key, taskId, operation, now, now);
    return { record: this.getIdempotency(key)!, fresh: true };
  }

  finishIdempotent(key: string, state: "completed" | "failed", result: Record<string, unknown>): IdempotencyRecord {
    this.db.prepare("UPDATE idempotency_records SET state = ?, result_json = ?, updated_at = ? WHERE key = ?")
      .run(state, JSON.stringify(result), new Date().toISOString(), key);
    const record = this.getIdempotency(key);
    if (!record) throw new Error("Idempotency record not found");
    return record;
  }

  getIdempotency(key: string): IdempotencyRecord | null {
    const row = this.db.prepare("SELECT * FROM idempotency_records WHERE key = ?").get(key) as unknown as Record<string, unknown> | undefined;
    return row ? { key: String(row.key), taskId: String(row.task_id), operation: String(row.operation), state: String(row.state) as IdempotencyRecord["state"], result: row.result_json ? JSON.parse(String(row.result_json)) as Record<string, unknown> : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null;
  }

  addWorkspaceRoot(taskId: string, rootPath: string, label: string, kind: WorkspaceRoot["kind"] = "additional"): WorkspaceRoot {
    this.requireTask(taskId);
    const existing = this.db.prepare("SELECT * FROM workspace_roots WHERE task_id = ? AND path = ?").get(taskId, rootPath) as unknown as Record<string, unknown> | undefined;
    if (existing) return mapWorkspaceRoot(existing);
    const root: WorkspaceRoot = { id: randomUUID(), taskId, path: rootPath, label, kind, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO workspace_roots (id, task_id, path, label, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(root.id, taskId, rootPath, label, kind, root.createdAt);
    return root;
  }

  listWorkspaceRoots(taskId: string): WorkspaceRoot[] {
    const rows = this.db.prepare("SELECT * FROM workspace_roots WHERE task_id = ? ORDER BY kind DESC, created_at")
      .all(taskId) as unknown as Record<string, unknown>[];
    return rows.map(mapWorkspaceRoot);
  }

  setPrimaryWorkspaceRoot(taskId: string, rootPath: string, label: string): WorkspaceRoot {
    this.requireTask(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workspace_roots SET kind = 'additional' WHERE task_id = ? AND kind = 'primary'").run(taskId);
      const existing = this.db.prepare("SELECT id FROM workspace_roots WHERE task_id = ? AND path = ?").get(taskId, rootPath) as unknown as { id: string } | undefined;
      if (existing) this.db.prepare("UPDATE workspace_roots SET kind = 'primary', label = ? WHERE id = ?").run(label, existing.id);
      else this.addWorkspaceRoot(taskId, rootPath, label, "primary");
      this.updateTask(taskId, { workspacePath: rootPath });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listWorkspaceRoots(taskId).find((root) => root.kind === "primary")!;
  }

  addReviewComment(taskId: string, filePath: string, line: number, side: ReviewComment["side"], body: string): ReviewComment {
    this.requireTask(taskId);
    const comment: ReviewComment = { id: randomUUID(), taskId, path: filePath, line, side, body, resolvedAt: null, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO review_comments (id, task_id, path, line, side, body, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(comment.id, taskId, filePath, line, side, body, comment.createdAt);
    return comment;
  }

  listReviewComments(taskId: string): ReviewComment[] {
    const rows = this.db.prepare("SELECT * FROM review_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), taskId: String(row.task_id), path: String(row.path), line: Number(row.line), side: String(row.side) as ReviewComment["side"], body: String(row.body), resolvedAt: row.resolved_at ? String(row.resolved_at) : null, createdAt: String(row.created_at) }));
  }

  requestCancel(id: string): AgentTask {
    const task = this.requireTask(id);
    if (["queued", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry"].includes(task.status)) {
      return this.transition(id, "cancelled", {
        cancelRequested: true,
        finishedAt: new Date().toISOString(),
      });
    }
    return this.updateTask(id, { cancelRequested: true });
  }

  retry(id: string): AgentTask {
    const task = this.requireTask(id);
    if (task.status === "waiting_retry") {
      return this.transition(id, "queued", {
        error: null,
        nextAttemptAt: null,
        cancelRequested: false,
      });
    }
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new Error("Only failed, cancelled or waiting-retry tasks can be retried");
    }
    return this.transition(id, "queued", {
      error: null,
      result: null,
      cancelRequested: false,
      checkpoint: null,
      nextWakeupAt: null,
      finishedAt: null,
      // A user-triggered retry is a new retry budget, unlike an automatic retry.
      attempt: 0,
    });
  }

  renameTask(id: string, title: string): AgentTask {
    this.requireTask(id);
    this.db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
    return this.requireTask(id);
  }

  setTaskArchived(id: string, archived: boolean): AgentTask {
    const task = this.requireTask(id);
    if (archived && ["queued", "preparing", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry", "running", "verifying"].includes(task.status)) {
      throw new Error("A running or waiting task cannot be archived");
    }
    this.db.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? new Date().toISOString() : null, new Date().toISOString(), id);
    return this.requireTask(id);
  }

  setTaskPinned(id: string, pinned: boolean): AgentTask {
    return this.updateTask(id, { pinnedAt: pinned ? new Date().toISOString() : null });
  }

  setTaskSection(id: string, section: string | null): AgentTask {
    return this.updateTask(id, { section });
  }

  ensureMembership(identity: RequestIdentity): void {
    this.db.prepare(`INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`)
      .run(identity.tenantId, identity.userId, identity.role, new Date().toISOString());
    const current = this.db.prepare("SELECT tenant_id FROM tenant_quotas WHERE tenant_id = ?").get(identity.tenantId);
    if (!current) this.db.prepare("INSERT INTO tenant_quotas (tenant_id, max_concurrent_tasks, max_tasks_per_day, max_storage_mb, updated_at) VALUES (?, 2, 100, 10240, ?)")
      .run(identity.tenantId, new Date().toISOString());
  }

  getQuota(tenantId: string): TenantQuota {
    const row = this.db.prepare("SELECT * FROM tenant_quotas WHERE tenant_id = ?").get(tenantId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error("Tenant quota not found");
    return { tenantId, maxConcurrentTasks: Number(row.max_concurrent_tasks), maxTasksPerDay: Number(row.max_tasks_per_day), maxStorageMb: Number(row.max_storage_mb), updatedAt: String(row.updated_at) };
  }

  assertQuota(identity: RequestIdentity): void {
    this.ensureMembership(identity);
    const quota = this.getQuota(identity.tenantId);
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE tenant_id = ? AND status IN ('queued','preparing','running','verifying','waiting_retry')")
      .get(identity.tenantId) as unknown as { count: number };
    if (active.count >= Math.max(20, quota.maxConcurrentTasks * 10)) throw new Error("Tenant queued task quota exceeded");
    const daily = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE tenant_id = ? AND created_at >= datetime('now','-1 day')")
      .get(identity.tenantId) as unknown as { count: number };
    if (daily.count >= quota.maxTasksPerDay) throw new Error("Tenant daily task quota exceeded");
  }

  audit(identity: RequestIdentity, action: string, resourceType: string, resourceId: string | null, detail: Record<string, unknown> = {}): AuditEntry {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(identity.tenantId, identity.userId, action, resourceType, resourceId, JSON.stringify(detail), createdAt);
    return { id: Number(result.lastInsertRowid), tenantId: identity.tenantId, userId: identity.userId, action, resourceType, resourceId, detail, createdAt };
  }

  listAudit(identity: RequestIdentity, limit = 200): AuditEntry[] {
    const rows = this.db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?")
      .all(identity.tenantId, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id), action: String(row.action), resourceType: String(row.resource_type), resourceId: row.resource_id ? String(row.resource_id) : null, detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>, createdAt: String(row.created_at) }));
  }

  continueConversation(id: string, content: string, settings: Partial<Pick<AgentTask, "provider" | "model" | "reasoningEffort" | "sandboxMode" | "approvalPolicy" | "approvalsReviewer">> = {}): { task: AgentTask; message: ConversationMessage } {
    const task = this.requireTask(id);
    if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      throw new Error("Wait for the current turn to finish before sending another message");
    }
    const hadMessages = this.db.prepare("SELECT 1 FROM task_messages WHERE task_id = ? LIMIT 1").get(id) !== undefined;
    const message = this.appendMessage(id, "user", content);
    let queued = this.transition(id, "queued", {
      prompt: content,
      result: null,
      error: null,
      cancelRequested: false,
      checkpoint: null,
      waitSeconds: 0,
      nextWakeupAt: null,
      startedAt: null,
      finishedAt: null,
      attempt: task.attempt + 1,
      ...settings,
    });
    if (!hadMessages) {
      const title = content.replace(/\n\n<attachments>[\s\S]*$/u, "").trim().split(/\r?\n/u)[0]?.slice(0, 60) || task.title;
      queued = this.renameTask(id, title);
    }
    return { task: queued, message };
  }

  retractLatestTurn(id: string): ConversationMessage {
    const task = this.requireTask(id);
    if (!["succeeded", "failed", "cancelled"].includes(task.status)) throw new Error("Stop the current turn before editing its message");
    const row = this.db.prepare(
      "SELECT * FROM task_messages WHERE task_id = ? AND role = 'user' ORDER BY turn DESC, id DESC LIMIT 1",
    ).get(id) as unknown as MessageRow | undefined;
    if (!row) throw new Error("No user message is available to edit");
    const previous = this.db.prepare(
      "SELECT content FROM task_messages WHERE task_id = ? AND role = 'user' AND turn < ? ORDER BY turn DESC LIMIT 1",
    ).get(id, row.turn) as unknown as { content: string } | undefined;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM memory_entries WHERE task_id = ? AND source_message_id IN
        (SELECT id FROM task_messages WHERE task_id = ? AND turn >= ?)`).run(id, id, row.turn);
      this.db.prepare("DELETE FROM task_messages WHERE task_id = ? AND turn >= ?").run(id, row.turn);
      this.db.prepare("DELETE FROM task_events WHERE task_id = ? AND created_at >= ?").run(id, row.created_at);
      this.db.prepare(`UPDATE approvals SET status = 'rejected', resolved_at = ?, decision_json = ?
        WHERE task_id = ? AND status = 'pending'`).run(now, JSON.stringify({ decision: "rejected", reason: "turn_retracted", resolvedAt: now }), id);
      this.db.prepare(`UPDATE durable_signals SET state = 'cancelled', resolved_at = ?
        WHERE task_id = ? AND state = 'pending' AND kind IN ('timer', 'webhook', 'approval')`).run(now, id);
      this.db.prepare(`UPDATE tasks SET status = 'cancelled', prompt = ?, result = NULL, error = NULL,
        checkpoint_json = NULL, wait_seconds = 0, next_wakeup_at = NULL, next_attempt_at = NULL,
        cancel_requested = 0, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        started_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`)
        .run(previous?.content ?? "", now, now, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.refreshMemory(id);
    return this.mapMessage(row);
  }

  appendSteeringMessage(id: string, content: string): ConversationMessage {
    const task = this.requireTask(id);
    if (!["preparing", "running", "verifying"].includes(task.status)) throw new Error("Task is not currently accepting steering input");
    return this.appendMessage(id, "user", content);
  }

  appendMessage(
    taskId: string,
    role: ConversationMessage["role"],
    content: string,
    turn?: number,
  ): ConversationMessage {
    this.requireTask(taskId);
    const latest = this.db.prepare(
      "SELECT COALESCE(MAX(turn), -1) AS turn FROM task_messages WHERE task_id = ? AND role = 'user'",
    ).get(taskId) as unknown as { turn: number };
    const resolvedTurn = turn ?? (role === "user" ? latest.turn + 1 : Math.max(0, latest.turn));
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO task_messages (task_id, role, content, turn, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, turn, role) DO UPDATE SET
        content = excluded.content,
        created_at = excluded.created_at
    `).run(taskId, role, content, resolvedTurn, createdAt);
    const row = this.db.prepare(
      "SELECT * FROM task_messages WHERE task_id = ? AND turn = ? AND role = ?",
    ).get(taskId, resolvedTurn, role) as unknown as MessageRow;
    this.refreshMemory(taskId);
    this.indexMessage(taskId, this.mapMessage(row));
    return this.mapMessage(row);
  }

  addMemoryEntry(input: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): MemoryEntry {
    const now = new Date().toISOString();
    const entry: MemoryEntry = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO memory_entries
      (id, tenant_id, user_id, task_id, workspace_path, scope, kind, content, importance, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.id, entry.tenantId, entry.userId, entry.taskId, entry.workspacePath, entry.scope, entry.kind, entry.content, entry.importance, entry.sourceMessageId, now, now);
    return entry;
  }

  searchMemory(taskId: string, query: string, limit = 12): MemoryEntry[] {
    const task = this.requireTask(taskId);
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 12);
    const rows = this.db.prepare(`SELECT * FROM memory_entries
      WHERE tenant_id = ? AND task_id = ?
      ORDER BY importance DESC, updated_at DESC LIMIT 300`)
      .all(task.tenantId, task.id) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapMemoryEntry).map((entry) => ({
      entry,
      score: terms.reduce((score, term) => score + (entry.content.toLowerCase().includes(term) ? 1 : 0), 0) + entry.importance,
    })).sort((left, right) => right.score - left.score).slice(0, limit).map(({ entry }) => entry);
  }

  listMemory(taskId: string): MemoryEntry[] {
    return this.searchMemory(taskId, "", 100);
  }

  listMessages(taskId: string, limit = 200): ConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(taskId, limit) as unknown as MessageRow[];
    return rows.map((row) => this.mapMessage(row));
  }

  listRecentTurnMessages(taskId: string, turnLimit = 30): ConversationMessage[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(turnLimit)));
    const rows = this.db.prepare(`
      WITH recent_turns AS (
        SELECT turn FROM task_messages
        WHERE task_id = ? AND role = 'user'
        ORDER BY turn DESC LIMIT ?
      )
      SELECT message.* FROM task_messages message
      JOIN recent_turns ON recent_turns.turn = message.turn
      WHERE message.task_id = ?
      ORDER BY message.id ASC
    `).all(taskId, boundedLimit, taskId) as unknown as MessageRow[];
    return rows.map((row) => this.mapMessage(row));
  }

  countConversationTurns(taskId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM task_messages WHERE task_id = ? AND role = 'user'",
    ).get(taskId) as unknown as { count: number };
    return row.count;
  }

  getConversationMemory(taskId: string): ConversationMemory {
    this.requireTask(taskId);
    let row = this.db.prepare("SELECT * FROM task_memory WHERE task_id = ?")
      .get(taskId) as unknown as MemoryRow | undefined;
    if (!row) {
      this.refreshMemory(taskId);
      row = this.db.prepare("SELECT * FROM task_memory WHERE task_id = ?")
        .get(taskId) as unknown as MemoryRow;
    }
    return {
      taskId: row.task_id,
      summary: row.summary_text,
      messageCount: row.message_count,
      updatedAt: row.updated_at,
    };
  }

  appendEvent(taskId: string, type: string, payload: Record<string, unknown> = {}): TaskEvent {
    const createdAt = new Date().toISOString();
    let storedPayload = payload;
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, "utf8") > 64_000) {
      const artifact = this.createArtifact(taskId, "event-output", encoded, "application/json");
      storedPayload = {
        ...compactPayload(payload),
        artifactRef: artifact.id,
        artifactSize: artifact.size,
        truncated: true,
      };
    }
    const result = this.db.prepare(
      "INSERT INTO task_events (task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(taskId, type, JSON.stringify(storedPayload), createdAt);
    return { id: Number(result.lastInsertRowid), taskId, type, payload: storedPayload, createdAt };
  }

  listEvents(taskId: string, afterId = 0): TaskEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT 1000",
    ).all(taskId, afterId) as unknown as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }

  listRecentEvents(taskId: string, limit = 800): TaskEvent[] {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(taskId, boundedLimit) as unknown as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }

  listAllEvents(taskId: string): TaskEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC",
    ).all(taskId) as unknown as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }

  countEvents(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?")
      .get(taskId) as unknown as { count: number };
    return row.count;
  }

  usageSummary(tenantId: string): TenantTokenUsageSummary {
    const rows = this.db.prepare(`SELECT t.provider,
      COUNT(*) AS verified_turns,
      COALESCE(SUM(CAST(json_extract(e.payload_json, '$.inputTokens') AS INTEGER)), 0) AS input_tokens,
      COALESCE(SUM(CAST(json_extract(e.payload_json, '$.cachedInputTokens') AS INTEGER)), 0) AS cached_input_tokens,
      COALESCE(SUM(CAST(json_extract(e.payload_json, '$.outputTokens') AS INTEGER)), 0) AS output_tokens,
      COALESCE(SUM(CAST(json_extract(e.payload_json, '$.reasoningOutputTokens') AS INTEGER)), 0) AS reasoning_output_tokens,
      COALESCE(SUM(CAST(json_extract(e.payload_json, '$.totalTokens') AS INTEGER)), 0) AS total_tokens
      FROM task_events e JOIN tasks t ON t.id=e.task_id
      WHERE t.tenant_id=? AND e.type='turn.usage.recorded' GROUP BY t.provider ORDER BY total_tokens DESC`)
      .all(tenantId) as unknown as Array<{ provider: string; verified_turns: number; input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number }>;
    const byProvider = rows.map((row) => ({
      provider: row.provider, verifiedTurns: Number(row.verified_turns), inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens),
      reasoningOutputTokens: Number(row.reasoning_output_tokens), totalTokens: Number(row.total_tokens),
    }));
    return byProvider.reduce<TenantTokenUsageSummary>((total, item) => ({
      verifiedTurns: total.verifiedTurns + item.verifiedTurns,
      inputTokens: total.inputTokens + item.inputTokens,
      cachedInputTokens: total.cachedInputTokens + item.cachedInputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      reasoningOutputTokens: total.reasoningOutputTokens + item.reasoningOutputTokens,
      totalTokens: total.totalTokens + item.totalTokens,
      byProvider,
    }), { verifiedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, byProvider });
  }

  storageSummary(tenantId: string): TenantStorageSummary {
    const taskCounts = this.db.prepare(`SELECT
      SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
      FROM tasks WHERE tenant_id = ?`).get(tenantId) as unknown as { active: number | null; archived: number | null };
    const related = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.tenant_id=?) AS events,
      (SELECT COUNT(*) FROM task_messages m JOIN tasks t ON t.id=m.task_id WHERE t.tenant_id=?) AS messages,
      (SELECT COUNT(*) FROM task_artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.tenant_id=?) AS artifacts,
      (SELECT COALESCE(SUM(a.size),0) FROM task_artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.tenant_id=?) AS artifact_bytes`)
      .get(tenantId, tenantId, tenantId, tenantId) as unknown as { events: number; messages: number; artifacts: number; artifact_bytes: number };
    return {
      activeTasks: Number(taskCounts.active) || 0,
      archivedTasks: Number(taskCounts.archived) || 0,
      events: Number(related.events) || 0,
      messages: Number(related.messages) || 0,
      artifacts: Number(related.artifacts) || 0,
      artifactBytes: Number(related.artifact_bytes) || 0,
    };
  }

  listApprovals(): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as unknown as ApprovalRow[];
    return rows.map((row) => this.mapApproval(row));
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as ApprovalRow | undefined;
    return row ? this.mapApproval(row) : null;
  }

  createApproval(input: ApprovalInput): Approval {
    this.requireTask(input.taskId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO approvals (
        id, task_id, title, description, status, created_at, resolved_at, kind, risk,
        command, cwd, path, network_host, scope, request_json, decision_json
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, input.taskId, input.title, input.description, now, input.kind, input.risk,
      input.command ?? null, input.cwd ?? null, input.path ?? null,
      input.networkHost ?? null, input.scope ?? null, JSON.stringify(input.request ?? {}),
    );
    return this.getApproval(id)!;
  }

  resolveApproval(id: string, decision: "approved" | "rejected"): Approval {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE approvals SET status = ?, resolved_at = ?, decision_json = ? WHERE id = ? AND status = 'pending'",
    ).run(decision, now, JSON.stringify({ decision, resolvedAt: now }), id);
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as ApprovalRow | undefined;
    if (!row) throw new Error("Approval not found");
    const approval = this.getApproval(id);
    if (!approval) throw new Error("Approval not found");
    const signal = this.getSignalByCorrelation(`approval:${id}`);
    if (signal?.state === "pending") this.resolveSignal(signal.id, { decision, resolvedAt: now });
    const task = this.requireTask(row.task_id);
    if (task.status === "waiting_approval") {
      this.transition(task.id, "queued", {
        checkpoint: { ...(task.checkpoint ?? {}), approvalId: id, approvalDecision: decision, approvalResolvedAt: now },
      });
    }
    return approval;
  }

  createArtifact(taskId: string, kind: string, content: string | Buffer, mimeType = "text/plain; charset=utf-8"): TaskArtifact {
    this.requireTask(taskId);
    const id = randomUUID();
    const taskDir = path.join(this.artifactDir, taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const extension = mimeType.includes("json") ? ".json" : ".log";
    const artifactPath = path.join(taskDir, `${id}${extension}`);
    fs.writeFileSync(artifactPath, content);
    const size = fs.statSync(artifactPath).size;
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO task_artifacts (id, task_id, kind, path, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, kind, artifactPath, mimeType, size, createdAt);
    return { id, taskId, kind, path: artifactPath, mimeType, size, createdAt };
  }

  importAttachment(taskId: string, sourcePath: string): TaskArtifact {
    const task = this.requireTask(taskId);
    const absolute = fs.realpathSync(path.resolve(sourcePath));
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error("Attachment is not a file");
    if (stat.size > 25 * 1024 * 1024) throw new Error("Attachment exceeds the 25 MB local limit");
    const quota = this.getQuota(task.tenantId);
    const used = this.db.prepare(`SELECT COALESCE(SUM(a.size),0) AS bytes FROM task_artifacts a
      JOIN tasks t ON t.id=a.task_id WHERE t.tenant_id=?`).get(task.tenantId) as unknown as { bytes: number };
    if (used.bytes + stat.size > quota.maxStorageMb * 1024 * 1024) throw new Error("Tenant artifact storage quota exceeded");
    const id = randomUUID();
    const taskDir = this.artifactDirectory(taskId);
    const safeName = path.basename(absolute).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-160) || "attachment";
    const target = path.join(taskDir, `${id}-${safeName}`);
    fs.copyFileSync(absolute, target, fs.constants.COPYFILE_EXCL);
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO task_artifacts (id, task_id, kind, path, mime_type, size, created_at) VALUES (?, ?, 'attachment', ?, 'application/octet-stream', ?, ?)")
      .run(id, taskId, target, stat.size, createdAt);
    return { id, taskId, kind: "attachment", path: target, mimeType: "application/octet-stream", size: stat.size, createdAt };
  }

  listArtifacts(taskId: string): TaskArtifact[] {
    const rows = this.db.prepare("SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as unknown as Array<{ id: string; task_id: string; kind: string; path: string; mime_type: string; size: number; created_at: string }>;
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, path: row.path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at }));
  }

  artifactDirectory(taskId: string): string {
    const directory = path.join(this.artifactDir, taskId);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  getArtifact(id: string): TaskArtifact | null {
    const row = this.db.prepare("SELECT * FROM task_artifacts WHERE id = ?").get(id) as unknown as {
      id: string; task_id: string; kind: string; path: string; mime_type: string; size: number; created_at: string;
    } | undefined;
    return row ? { id: row.id, taskId: row.task_id, kind: row.kind, path: row.path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at } : null;
  }

  upsertSandbox(taskId: string, input: Omit<SandboxRecord, "id" | "taskId" | "createdAt" | "updatedAt">): SandboxRecord {
    this.requireTask(taskId);
    const existing = this.getSandbox(taskId);
    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO task_sandboxes (id, task_id, kind, state, windows_path, guest_path, network_policy, container_id, image, cpu_limit, memory_mb, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET state=excluded.state, windows_path=excluded.windows_path,
        guest_path=excluded.guest_path, network_policy=excluded.network_policy, container_id=excluded.container_id,
        image=excluded.image, cpu_limit=excluded.cpu_limit, memory_mb=excluded.memory_mb, updated_at=excluded.updated_at
    `).run(id, taskId, input.kind, input.state, input.windowsPath, input.guestPath, input.networkPolicy,
      input.containerId ?? null, input.image ?? null, input.cpuLimit ?? null, input.memoryMb ?? null, existing?.createdAt ?? now, now);
    return this.getSandbox(taskId)!;
  }

  getSandbox(taskId: string): SandboxRecord | null {
    const row = this.db.prepare("SELECT * FROM task_sandboxes WHERE task_id = ?").get(taskId) as unknown as {
      id: string; task_id: string; kind: SandboxRecord["kind"]; state: SandboxRecord["state"]; windows_path: string;
      guest_path: string; network_policy: SandboxRecord["networkPolicy"]; container_id: string | null; image: string | null;
      cpu_limit: number | null; memory_mb: number | null; created_at: string; updated_at: string;
    } | undefined;
    return row ? { id: row.id, taskId: row.task_id, kind: row.kind, state: row.state, windowsPath: row.windows_path, guestPath: row.guest_path, networkPolicy: row.network_policy, containerId: row.container_id, image: row.image, cpuLimit: row.cpu_limit, memoryMb: row.memory_mb, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  close(): void {
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }

  private requireTask(id: string): AgentTask {
    const task = this.getTask(id);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private refreshMemory(taskId: string): void {
    const messages = this.listMessages(taskId, 16);
    const summary = messages.map((message) => {
      const label = message.role === "user" ? "用户" : "Agent";
      const content = message.content.length > 2_000
        ? `${message.content.slice(0, 2_000)}…`
        : message.content;
      return `[第 ${message.turn + 1} 轮 · ${label}] ${content}`;
    }).join("\n\n").slice(-16_000);
    const messageCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM task_messages WHERE task_id = ?",
    ).get(taskId) as unknown as { count: number };
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO task_memory (task_id, summary_text, message_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run(taskId, summary, messageCount.count, updatedAt);
  }

  private indexMessage(taskId: string, message: ConversationMessage): void {
    const exists = this.db.prepare("SELECT id FROM memory_entries WHERE task_id = ? AND source_message_id = ?")
      .get(taskId, message.id);
    if (exists) return;
    const task = this.requireTask(taskId);
    this.addMemoryEntry({
      tenantId: task.tenantId, userId: task.userId, taskId, workspacePath: task.workspacePath,
      scope: "conversation", kind: "message",
      content: message.content.slice(0, 8_000), importance: message.role === "user" ? 0.7 : 0.45,
      sourceMessageId: message.id,
    });
  }

  private mapMessage(row: MessageRow): ConversationMessage {
    return {
      id: row.id,
      taskId: row.task_id,
      role: row.role,
      content: row.content,
      turn: row.turn,
      createdAt: row.created_at,
    };
  }

  private mapEvent(row: EventRow): TaskEvent {
    let payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (row.type === "turn.workspace.summary" && payload.truncated === true && !Array.isArray(payload.changes)) {
      const artifactRef = typeof payload.artifactRef === "string" ? payload.artifactRef : "";
      const artifact = artifactRef ? this.getArtifact(artifactRef) : null;
      if (artifact?.mimeType.includes("json") && fs.existsSync(artifact.path)) {
        try {
          const original = JSON.parse(fs.readFileSync(artifact.path, "utf8")) as Record<string, unknown>;
          payload = { ...payload, ...workspaceSummaryFields(original), summaryRecovered: true };
          this.db.prepare("UPDATE task_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
        } catch {
          // Keep the compact event readable even if a legacy artifact was removed or corrupted.
        }
      }
    }
    return { id: row.id, taskId: row.task_id, type: row.type, payload, createdAt: row.created_at };
  }

  private mapApproval(row: ApprovalRow): Approval {
    return {
      id: row.id, taskId: row.task_id, title: row.title, description: row.description,
      status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at,
      kind: row.kind ?? "command", risk: row.risk ?? "medium", command: row.command ?? null,
      cwd: row.cwd ?? null, path: row.path ?? null, networkHost: row.network_host ?? null,
      scope: row.scope ?? null, request: row.request_json ? JSON.parse(row.request_json) as Record<string, unknown> : {},
      decision: row.decision_json ? JSON.parse(row.decision_json) as Record<string, unknown> : null,
    };
  }

  private mapTask(row: TaskRow): AgentTask {
    const projectRootId = row.root_task_id ?? row.id;
    const projectRoot = projectRootId === row.id ? undefined : this.db.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(projectRootId) as unknown as { workspace_path: string | null } | undefined;
    return {
      id: row.id, tenantId: row.tenant_id, userId: row.user_id, title: row.title, prompt: row.prompt,
      status: row.status, runtime: row.runtime, provider: row.provider, model: row.model,
      reasoningEffort: row.reasoning_effort, sandboxMode: row.sandbox_mode ?? "workspace-write",
      approvalPolicy: row.approval_policy ?? "on-request", approvalsReviewer: row.approvals_reviewer ?? "user",
      workspacePath: row.workspace_path, projectWorkspacePath: projectRoot?.workspace_path ?? row.workspace_path,
      threadId: row.thread_id, result: row.result, error: row.error,
      checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : null,
      waitSeconds: row.wait_seconds, nextWakeupAt: row.next_wakeup_at,
      cancelRequested: Boolean(row.cancel_requested), attempt: row.attempt,
      priority: row.priority ?? 0, maxAttempts: row.max_attempts ?? 3,
      leaseOwner: row.lease_owner ?? null, leaseExpiresAt: row.lease_expires_at ?? null,
      heartbeatAt: row.heartbeat_at ?? null, nextAttemptAt: row.next_attempt_at ?? null,
      parentTaskId: row.parent_task_id ?? null, rootTaskId: row.root_task_id ?? row.id,
      createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at,
      archivedAt: row.archived_at,
      pinnedAt: row.pinned_at ?? null, section: row.section ?? null,
      goalStatus: row.goal_status ?? "inactive", goalObjective: row.goal_objective ?? null,
      goalMaxTurns: row.goal_max_turns ?? 0, goalCompletedTurns: row.goal_completed_turns ?? 0,
      goalProgress: row.goal_progress ?? 0, goalLastSummary: row.goal_last_summary ?? null,
      goalNextStep: row.goal_next_step ?? null, goalDeadlineAt: row.goal_deadline_at ?? null,
      goalTokenBudget: row.goal_token_budget ?? 0, goalTokensUsed: row.goal_tokens_used ?? 0,
      goalLastUsageTotal: row.goal_last_usage_total ?? 0,
    };
  }
}

function mapSignal(row: Record<string, unknown>): DurableSignal {
  return {
    id: String(row.id), taskId: String(row.task_id), kind: String(row.kind) as DurableSignal["kind"],
    state: String(row.state) as DurableSignal["state"], correlationKey: String(row.correlation_key),
    payload: JSON.parse(String(row.payload_json ?? "{}")) as Record<string, unknown>,
    availableAt: row.available_at ? String(row.available_at) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    consumedAt: row.consumed_at ? String(row.consumed_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
    taskId: row.task_id ? String(row.task_id) : null, workspacePath: row.workspace_path ? String(row.workspace_path) : null,
    scope: String(row.scope) as MemoryEntry["scope"], kind: String(row.kind) as MemoryEntry["kind"],
    content: String(row.content), importance: Number(row.importance), sourceMessageId: row.source_message_id == null ? null : Number(row.source_message_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapWorkspaceRoot(row: Record<string, unknown>): WorkspaceRoot {
  return { id: String(row.id), taskId: String(row.task_id), path: String(row.path), label: String(row.label), kind: String(row.kind) as WorkspaceRoot["kind"], createdAt: String(row.created_at) };
}

function mapAutomation(row: AutomationRow): TaskAutomation {
  let weekdays: number[] = [];
  try { weekdays = JSON.parse(row.weekdays_json) as number[]; } catch { /* retain empty schedule */ }
  return {
    id: row.id, tenantId: row.tenant_id, userId: row.user_id, name: row.name, prompt: row.prompt,
    runtime: row.runtime, provider: row.provider, model: row.model, reasoningEffort: row.reasoning_effort,
    sandboxMode: row.sandbox_mode, approvalPolicy: row.approval_policy, approvalsReviewer: row.approvals_reviewer,
    workspacePath: row.workspace_path, scheduleKind: row.schedule_kind, onceAt: row.once_at,
    intervalMinutes: row.interval_minutes, timeOfDay: row.time_of_day, weekdays,
    status: row.status, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id, automationId: row.automation_id, taskId: row.task_id, state: row.state,
    scheduledFor: row.scheduled_for, error: row.error, createdAt: row.created_at,
  };
}

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") compact[key] = value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
    else if (value === null || typeof value === "number" || typeof value === "boolean") compact[key] = value;
  }
  if (payload.category === "workspace" && Array.isArray(payload.changes)) Object.assign(compact, workspaceSummaryFields(payload));
  return compact;
}
