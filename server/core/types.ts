export const taskStatuses = [
  "queued",
  "preparing",
  "waiting_timer",
  "waiting_external",
  "waiting_approval",
  "waiting_retry",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type RuntimeKind = "mock" | "codex";
export type ProviderId = "openai" | "deepseek" | "custom";
export type WorkspaceKind = "native" | "wsl2" | "docker";
export type TaskSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type TaskApprovalPolicy = "untrusted" | "on-request" | "never";
export type TaskApprovalsReviewer = "user" | "auto_review";
export type TaskReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";
export type GoalStatus = "inactive" | "active" | "paused" | "completed" | "blocked" | "limit_reached" | "deadline_reached" | "budget_reached";

export interface GoalProgressReport {
  status: "continue" | "completed" | "blocked";
  progress: number;
  summary: string;
  nextStep: string;
  blocker?: string | null;
}

export interface AgentTask {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  runtime: RuntimeKind;
  provider: ProviderId;
  model: string | null;
  reasoningEffort: TaskReasoningEffort | null;
  sandboxMode: TaskSandboxMode;
  approvalPolicy: TaskApprovalPolicy;
  approvalsReviewer: TaskApprovalsReviewer;
  workspacePath: string | null;
  projectWorkspacePath: string | null;
  threadId: string | null;
  result: string | null;
  error: string | null;
  checkpoint: Record<string, unknown> | null;
  waitSeconds: number;
  nextWakeupAt: string | null;
  cancelRequested: boolean;
  attempt: number;
  priority: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  nextAttemptAt: string | null;
  parentTaskId: string | null;
  rootTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  pinnedAt: string | null;
  section: string | null;
  goalStatus: GoalStatus;
  goalObjective: string | null;
  goalMaxTurns: number;
  goalCompletedTurns: number;
  goalProgress: number;
  goalLastSummary: string | null;
  goalNextStep: string | null;
  goalDeadlineAt: string | null;
  goalTokenBudget: number;
  goalTokensUsed: number;
  goalLastUsageTotal: number;
}

export interface TenantStorageSummary {
  activeTasks: number;
  archivedTasks: number;
  events: number;
  messages: number;
  artifacts: number;
  artifactBytes: number;
}

export interface DeletedTaskSummary {
  taskId: string;
  title: string;
  artifactBytes: number;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  runtime?: RuntimeKind;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: TaskReasoningEffort;
  sandboxMode?: TaskSandboxMode;
  approvalPolicy?: TaskApprovalPolicy;
  approvalsReviewer?: TaskApprovalsReviewer;
  workspacePath?: string;
  waitSeconds?: number;
  tenantId?: string;
  userId?: string;
  priority?: number;
  maxAttempts?: number;
  parentTaskId?: string;
  section?: string;
  goalMode?: boolean;
  goalObjective?: string;
  goalMaxTurns?: number;
  goalDeadlineHours?: number;
  goalTokenBudget?: number;
}

export type AutomationScheduleKind = "once" | "interval" | "daily" | "weekly";
export type AutomationStatus = "active" | "paused";

export interface TaskAutomation {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  prompt: string;
  runtime: RuntimeKind;
  provider: ProviderId;
  model: string | null;
  reasoningEffort: TaskReasoningEffort | null;
  sandboxMode: TaskSandboxMode;
  approvalPolicy: TaskApprovalPolicy;
  approvalsReviewer: TaskApprovalsReviewer;
  workspacePath: string | null;
  scheduleKind: AutomationScheduleKind;
  onceAt: string | null;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekdays: number[];
  status: AutomationStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  taskId: string | null;
  state: "queued" | "failed";
  scheduledFor: string;
  error: string | null;
  createdAt: string;
}

export interface CreateAutomationInput {
  tenantId: string;
  userId: string;
  name: string;
  prompt: string;
  runtime: RuntimeKind;
  provider: ProviderId;
  model?: string | null;
  reasoningEffort?: TaskReasoningEffort | null;
  sandboxMode: TaskSandboxMode;
  approvalPolicy: TaskApprovalPolicy;
  approvalsReviewer: TaskApprovalsReviewer;
  workspacePath?: string | null;
  scheduleKind: AutomationScheduleKind;
  onceAt?: string | null;
  intervalMinutes?: number | null;
  timeOfDay?: string | null;
  weekdays?: number[];
  status?: AutomationStatus;
}

export type TenantRole = "owner" | "admin" | "member" | "viewer";

export interface RequestIdentity {
  tenantId: string;
  userId: string;
  role: TenantRole;
}

export interface AuditEntry {
  id: number;
  tenantId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface TenantQuota {
  tenantId: string;
  maxConcurrentTasks: number;
  maxTasksPerDay: number;
  maxStorageMb: number;
  updatedAt: string;
}

export type DurableSignalKind = "timer" | "webhook" | "approval" | "child_task";
export type DurableSignalState = "pending" | "resolved" | "consumed" | "cancelled";

export interface DurableSignal {
  id: string;
  taskId: string;
  kind: DurableSignalKind;
  state: DurableSignalState;
  correlationKey: string;
  payload: Record<string, unknown>;
  availableAt: string | null;
  resolvedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface DeadLetter {
  id: string;
  taskId: string;
  attempt: number;
  reason: string;
  payload: Record<string, unknown>;
  createdAt: string;
  replayedAt: string | null;
}

export interface TaskRecoveryResult {
  taskId: string;
  outcome: "queued" | "failed";
  reason: "application_restart" | "lease_expired";
  attempt: number;
  maxAttempts: number;
}

export interface IdempotencyRecord {
  key: string;
  taskId: string;
  operation: string;
  state: "started" | "completed" | "failed";
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentEventPayload extends Record<string, unknown> {
  schemaVersion: 1;
  category: "task" | "turn" | "step" | "tool" | "approval" | "verification" | "workspace" | "terminal" | "sandbox" | "memory";
  phase: "queued" | "started" | "progress" | "waiting" | "completed" | "failed" | "cancelled";
  turnId: string;
  stepId?: string;
  toolCallId?: string;
  title?: string;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  retry?: number;
  usage?: Record<string, unknown>;
  artifactRef?: string;
}

export interface ConversationMessage {
  id: number;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  turn: number;
  createdAt: string;
}

export interface ConversationMemory {
  taskId: string;
  summary: string;
  messageCount: number;
  updatedAt: string;
  relevant?: MemoryEntry[];
}

export interface MemoryEntry {
  id: string;
  tenantId: string;
  userId: string;
  taskId: string | null;
  workspacePath: string | null;
  scope: "turn" | "conversation" | "project" | "user";
  kind: "message" | "fact" | "decision" | "summary";
  content: string;
  importance: number;
  sourceMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  kind: "command" | "file_change" | "workspace_change" | "terminal";
  risk: "low" | "medium" | "high";
  command: string | null;
  cwd: string | null;
  path: string | null;
  networkHost: string | null;
  scope: string | null;
  request: Record<string, unknown>;
  decision: Record<string, unknown> | null;
}

export interface ApprovalInput {
  taskId: string;
  title: string;
  description: string;
  kind: Approval["kind"];
  risk: Approval["risk"];
  command?: string | null;
  cwd?: string | null;
  path?: string | null;
  networkHost?: string | null;
  scope?: string | null;
  request?: Record<string, unknown>;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  kind: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface ModelChoice {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: TaskReasoningEffort[];
}

export interface SandboxRecord {
  id: string;
  taskId: string;
  kind: WorkspaceKind;
  state: "preparing" | "active" | "idle" | "released";
  windowsPath: string;
  guestPath: string;
  networkPolicy: "runtime-denied" | "model-egress-only" | "unrestricted";
  containerId?: string | null;
  image?: string | null;
  cpuLimit?: number | null;
  memoryMb?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  hasChildren: boolean;
  gitStatus?: string;
}

export interface WorkspaceRoot {
  id: string;
  taskId: string;
  path: string;
  label: string;
  kind: "primary" | "additional";
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  taskId: string;
  path: string;
  line: number;
  side: "old" | "new";
  body: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface WorkspaceHandle {
  kind: WorkspaceKind;
  windowsPath: string;
  wslPath: string;
  distro: string;
  runtimePath?: string;
  containerId?: string;
  runtimeWorkspaceRoots?: string[];
  runtimeSkillRoots?: string[];
}

export interface VerificationCheck {
  id: string;
  label: string;
  command: string;
  required: boolean;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface VerificationResult {
  passed: boolean;
  summary: string;
  details: string;
  projectTypes: string[];
  checks: VerificationCheck[];
}
