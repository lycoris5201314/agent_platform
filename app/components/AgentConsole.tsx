"use client";

import { type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, FormEvent, KeyboardEvent, lazy, type PointerEvent as ReactPointerEvent, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { selectCoreActivityEvents } from "../lib/core-activity";
import { groupTasksByProject, workspaceName } from "../lib/task-groups";
import { matchingSlashCommands, type SlashCommandName } from "../lib/slash-commands";
import { isActivityTask, taskTransitionAlert } from "../lib/task-activity";
import { shouldApplyTaskResponse } from "../lib/task-requests";
import { ConfirmDialog, TextPromptDialog } from "./AppDialog";
import { AttachmentTray, isPreviewableImageAttachment } from "./AttachmentTray";

const AutomationsPanel = lazy(() => import("./AutomationsPanel").then((module) => ({ default: module.AutomationsPanel })));
const CapabilitiesPanel = lazy(() => import("./CapabilitiesPanel").then((module) => ({ default: module.CapabilitiesPanel })));
const GoalsPanel = lazy(() => import("./GoalsPanel").then((module) => ({ default: module.GoalsPanel })));
const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));
const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

type Status = "queued" | "preparing" | "waiting_timer" | "waiting_external" | "waiting_approval" | "waiting_retry" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-request" | "never";
type ApprovalsReviewer = "user" | "auto_review";
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";
type GoalStatus = "inactive" | "active" | "paused" | "completed" | "blocked" | "limit_reached" | "deadline_reached" | "budget_reached";
type Task = { id: string; title: string; prompt: string; status: Status; runtime: "mock" | "codex"; provider: string; model: string | null; reasoningEffort: ReasoningEffort | null; sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; approvalsReviewer: ApprovalsReviewer; workspacePath: string | null; projectWorkspacePath: string | null; threadId: string | null; result: string | null; error: string | null; waitSeconds: number; nextWakeupAt: string | null; nextAttemptAt: string | null; attempt: number; priority: number; maxAttempts: number; parentTaskId: string | null; rootTaskId: string | null; pinnedAt: string | null; section: string | null; createdAt: string; updatedAt: string; archivedAt: string | null; goalStatus: GoalStatus; goalObjective: string | null; goalMaxTurns: number; goalCompletedTurns: number; goalProgress: number; goalLastSummary: string | null; goalNextStep: string | null; goalDeadlineAt: string | null; goalTokenBudget: number; goalTokensUsed: number };
type TaskEvent = { id: number; taskId: string; type: string; payload: Record<string, unknown>; createdAt: string };
type ConversationMessage = { id: number; taskId: string; role: "user" | "assistant"; content: string; turn: number; createdAt: string };
type ConversationMemory = { taskId: string; summary: string; messageCount: number; updatedAt: string };
type Provider = { id: string; label: string; configured: boolean; defaultModel: string; codexCompatible: boolean };
type ProviderSecretDraft = Record<string, string>;
type AppConfig = { defaultRuntime: "mock" | "codex"; workspace: { kind: "native" | "wsl2"; distro: string | null; label: string }; providers: Provider[]; scheduler: { concurrency: number; providerConcurrency: number; leaseMs: number }; sandbox: { enabled: boolean; image: string; cpuLimit: number; memoryMb: number; networkPolicy: string } };
type WorkspaceSnapshot = { path: string | null; files: string[]; filesTruncated?: boolean; changes: Array<{ status: string; path: string }>; gitAvailable?: boolean };
type TreeEntry = { name: string; path: string; type: "file" | "directory"; hasChildren: boolean; gitStatus?: string };
type Approval = { id: string; taskId: string; title: string; description: string; status: "pending" | "approved" | "rejected"; kind: string; risk: "low" | "medium" | "high"; command: string | null; cwd: string | null; path: string | null; networkHost: string | null; scope: string | null };
type ContextTab = "files" | "changes" | "terminal" | "details";
type Preview = { kind: "file" | "diff" | "local-text" | "pdf" | "image" | "external"; path: string; content: string; absolutePath?: string; dataUrl?: string; reason?: string; rootId?: string; readOnly?: boolean; loading?: boolean; error?: string };
type LocalEntry = { name: string; path: string; type: "file" | "directory" };
type LocalBrowser = { path: string; parent: string | null; entries: LocalEntry[] };
type LocalFileResult = { path: string; kind: "text" | "pdf" | "image" | "external"; content?: string; dataUrl?: string; reason?: string };
type Signal = { id: string; kind: string; state: string; correlationKey: string; availableAt: string | null };
type Sandbox = { kind: "native" | "wsl2" | "docker"; state: string; containerId?: string | null; image?: string | null; cpuLimit?: number | null; memoryMb?: number | null; networkPolicy: string };
type WorkspaceRoot = { id: string; path: string; label: string; kind: "primary" | "additional" };
type ReviewComment = { id: string; path: string; line: number; side: "old" | "new"; body: string; resolvedAt: string | null };
type Artifact = { id: string; kind: string; path: string; size: number };
type ModelChoice = { provider: "openai" | "deepseek" | "custom"; providerLabel: string; model: string; displayName: string; isDefault: boolean; supportedReasoningEfforts: ReasoningEffort[] };
type ProviderProfile = { baseUrl: string; defaultModel: string; codexCompatible: boolean };
type PlatformSettings = { defaultRuntime: "mock" | "codex"; defaultProvider: string; defaultWorkspace: string; workerConcurrency: number; providerConcurrency: number; sandboxEnabled: boolean; sandboxImage: string; sandboxCpuLimit: number; sandboxMemoryMb: number; sandboxNetwork: "none" | "bridge"; skillsExtraRoots: string[]; mcpConfigPath: string; verificationCommands: string[]; approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted"; approvalWebhookUrl: string; providerProfiles: Record<string, ProviderProfile> };
type PlatformStatus = { worker: { concurrency: number; providerConcurrency: number; activeByProvider: Record<string, number> }; signals: Signal[]; deadLetters: Array<{ id: string; taskId: string; reason: string; replayedAt: string | null }>; quota: Record<string, number>; usage: { verifiedTurns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number; byProvider: Array<{ provider: string; verifiedTurns: number; inputTokens: number; outputTokens: number; totalTokens: number }> }; storage: { activeTasks: number; archivedTasks: number; events: number; messages: number; artifacts: number; artifactBytes: number } };
type DataSummary = { dataDir: string; databasePath: string; databaseBytes: number; schemaVersion: number; databaseHealth: string; backupDirectory: string; backupCount: number; lastBackupAt: string | null };
type RuntimeDiagnostics = { platform: string; arch: string; node: string; codexAvailable: boolean; proxyConfigured: boolean; customCaConfigured: boolean };
type AttachmentPreviewMap = Record<string, string>;
type NotificationMode = "never" | "background" | "always";
type DesktopAppInfo = { version: string; packaged: boolean; platform: string; arch: string; codexVersion: string };
type UpdateAccessStatus = { configured: boolean; encrypted: boolean; source: "environment" | "encrypted" | "none" };
type UpdateCheckResult = { status: "development" | "credentials_required" | "current" | "available" | "downloading" | "error"; currentVersion: string; availableVersion?: string; error?: string };
type TaskStatusGroup = "all" | "active" | "waiting" | "completed" | "stopped";
type TaskListFacet = { value: string; label: string; count: number };
type TaskListFacets = { statuses: Record<Exclude<TaskStatusGroup, "all">, number>; providers: TaskListFacet[]; models: TaskListFacet[]; projects: TaskListFacet[] };
type TaskFilters = { status: TaskStatusGroup; provider: string; model: string; project: string };
type NewTaskDraft = { prompt: string; attachments: string[]; runtime: string; provider: "openai" | "deepseek" | "custom"; model: string; reasoningEffort: ReasoningEffort; sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; approvalsReviewer: ApprovalsReviewer; workspacePath: string; durableWait: boolean; goalMode: boolean; goalMaxTurns: number; goalDeadlineHours: number; goalTokenBudget: number; savedAt?: string };
type FollowUpDraft = { taskId: string; content: string; attachments: string[]; savedAt?: string };

declare global {
  interface Window {
    agentDesktop?: {
      getAppInfo: () => Promise<DesktopAppInfo>;
      checkForUpdates: () => Promise<UpdateCheckResult>;
      getUpdateAccessStatus: () => Promise<UpdateAccessStatus>;
      saveUpdateAccessToken: (token: string | null) => Promise<UpdateAccessStatus>;
      openUpdateTokenPage: () => Promise<void>;
      loadNewTaskDraft: () => Promise<{ encrypted: boolean; draft: NewTaskDraft | null }>;
      saveNewTaskDraft: (draft: NewTaskDraft | null) => Promise<boolean>;
      loadFollowUpDraft: (taskId: string) => Promise<{ encrypted: boolean; draft: FollowUpDraft | null }>;
      saveFollowUpDraft: (taskId: string, draft: Omit<FollowUpDraft, "taskId" | "savedAt"> | null) => Promise<boolean>;
      selectWorkspace: () => Promise<string | null>;
      selectFiles: () => Promise<string[]>;
      openWorkspace: (workspacePath: string) => Promise<string | null>;
      browseDirectory: (directoryPath: string) => Promise<LocalBrowser>;
      readLocalFile: (filePath: string) => Promise<LocalFileResult>;
      writeLocalTextFile: (filePath: string, content: string) => Promise<string | null>;
      openPath: (filePath: string) => Promise<string | null>;
      pathForFile: (file: File) => string;
      saveClipboardImage: () => Promise<string | null>;
      prepareFeedbackBundle: () => Promise<{ directory: string; generatedAt: string; taskCount: number }>;
      setTheme: (theme: "system" | "light" | "dark") => Promise<boolean>;
      showNotification: (taskId: string, title: string, body: string) => Promise<boolean>;
      detachConversation: (taskId: string, point?: { x: number; y: number }, force?: boolean) => Promise<{ detached: boolean; existing: boolean }>;
      reattachConversation: (taskId: string) => Promise<boolean>;
      onFocusConversation: (callback: (taskId: string) => void) => void;
    };
  }
}

const statusLabels: Record<Status, string> = {
  queued: "排队中", preparing: "准备中", waiting_timer: "定时等待", waiting_external: "等待外部结果",
  waiting_approval: "等待审批", running: "执行中", verifying: "验证中", succeeded: "已完成",
  waiting_retry: "等待重试", failed: "失败", cancelled: "已取消",
};
const activeStatuses: Status[] = ["queued", "preparing", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry", "running", "verifying"];
const defaultLeftPanelWidth = 252;
const defaultRightPanelWidth = 330;
const initialVisibleTurnCount = 30;
const emptyTaskFilters: TaskFilters = { status: "all", provider: "", model: "", project: "" };
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const deadlineFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function resolveApiUrl(): string {
  const fallback = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:8788";
  if (typeof window === "undefined") return fallback;
  const requested = new URLSearchParams(window.location.search).get("api");
  return requested && /^http:\/\/127\.0\.0\.1:\d+$/.test(requested) ? requested : fallback;
}

function resolveInitialTaskId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("task");
}

function resolveDetachedMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("detached") === "1";
}

function shortTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return timeFormatter.format(date);
  }
  return dateFormatter.format(date);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function concise(value: unknown, maxLength = 520): string {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function editableMessageContent(content: string): string {
  return content.replace(/\n\n<attachments>[\s\S]*?<\/attachments>\s*$/u, "").trimEnd();
}

function commandCopy(item: Record<string, unknown>, completed: boolean): [string, string] {
  const command = String(item.command ?? "");
  const lower = command.toLowerCase();
  let title = "执行命令";
  if (/set-content|add-content|out-file|apply_patch|new-item|copy-item|move-item/.test(lower)) title = "修改文件";
  else if (/get-content|select-string|\brg(?:\.exe)?\b|\bcat\b|\btype\b/.test(lower)) title = "读取文件";
  else if (/get-childitem|\bdir\b|\bls\b/.test(lower)) title = "查看目录";
  else if (/npm (run )?(test|lint|build)|pytest|cargo test|dotnet test/.test(lower)) title = "运行验证";
  const exitCode = item.exit_code;
  const state = completed ? (typeof exitCode === "number" && exitCode !== 0 ? `退出码 ${exitCode}` : "已完成") : "进行中";
  return [`${title}${completed ? "" : "…"}`, `${state}${command ? ` · ${concise(command, 360)}` : ""}`];
}

function eventCopy(event: TaskEvent): [string, string] {
  const payload = event.payload;
  if (payload.schemaVersion === 1 && typeof payload.title === "string") {
    const item = asRecord(payload.item);
    const reasoning = item.type === "reasoning";
    const facts = [
      typeof payload.detail === "string" ? reasoning ? payload.detail.trim().slice(0, 6_000) : concise(payload.detail, 700) : "",
      typeof payload.command === "string" ? `$ ${concise(payload.command, 420)}` : "",
      typeof payload.durationMs === "number" ? `${payload.durationMs} ms` : "",
      typeof payload.exitCode === "number" ? `退出码 ${payload.exitCode}` : "",
      typeof payload.artifactRef === "string" ? `完整输出已保存 · ${payload.artifactRef.slice(0, 8)}` : "",
    ].filter(Boolean);
    return [payload.title, facts.join(" · ") || String(payload.phase ?? "状态更新")];
  }
  const rawEvent = asRecord(payload.event);
  const item = asRecord(rawEvent.item);
  const itemType = String(item.type ?? "");
  if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
    const completed = event.type === "item.completed";
    if (itemType === "command_execution") return commandCopy(item, completed);
    if (itemType === "agent_message") return ["Agent 更新", concise(item.text, 900) || "正在整理回复"];
    if (itemType === "reasoning") return ["分析与规划", concise(item.text ?? item.summary, 650) || "正在判断下一步操作"];
    if (itemType === "web_search") return [completed ? "搜索完成" : "搜索资料…", concise(item.query ?? item.action, 500)];
    if (itemType === "file_change") return [completed ? "文件修改完成" : "正在修改文件…", concise(item.changes ?? item.path, 500)];
    if (itemType === "mcp_tool_call") return [completed ? "工具调用完成" : "正在调用工具…", concise(item.tool ?? item.server, 500)];
    if (itemType === "error") return ["运行提示", concise(item.message, 700)];
    return [completed ? "操作完成" : "正在操作…", concise(item, 600) || itemType || "等待详细信息"];
  }
  if (event.type === "error") {
    const message = concise(rawEvent.message ?? payload.message, 800);
    if (message.includes("Falling back from WebSockets")) return ["已切换到 HTTPS", "WebSocket 不可用，任务将继续执行"];
    if (message.includes("Reconnecting")) return ["正在重新连接模型", message];
    return ["运行提示", message || "运行时报告了一条信息"];
  }
  const copies: Record<string, [string, string]> = {
    "task.created": ["任务已加入队列", `${String(payload.runtime ?? "-")} · ${String(payload.provider ?? "-")}`],
    "task.preparing": ["准备执行环境", `第 ${Number(payload.attempt ?? 0) + 1} 次执行`],
    "workspace.ready": [payload.kind === "native" ? "Windows 原生工作区就绪" : "WSL2 工作区就绪", String(payload.runtimePath ?? payload.wslPath ?? payload.windowsPath ?? "")],
    "task.waiting": ["进入持久化等待", String(payload.message ?? "等待调度器唤醒")],
    "task.running": ["Agent 开始执行", `使用 ${String(payload.runtime ?? "runtime")}`],
    "conversation.message": ["收到新的对话指令", `第 ${Number(payload.turn ?? 0) + 1} 轮 · ${String(payload.preview ?? "")}`],
    "memory.loaded": ["已加载会话记忆", `${String(payload.messageCount ?? 0)} 条消息 · ${payload.threadResumed ? "继续原 Codex Thread" : "从本地记忆恢复"}`],
    "memory.updated": ["会话记忆已更新", `已持久化 ${String(payload.messageCount ?? 0)} 条消息`],
    "agent.plan": ["生成执行计划", String(payload.summary ?? "")],
    "tool.started": ["调用工具", `${String(payload.tool ?? "tool")} · ${String(payload.command ?? "")}`],
    "tool.completed": ["工具执行完成", String(payload.output ?? "")],
    "agent.message": ["Agent 消息", String(payload.text ?? "")],
    "verification.started": ["开始验证", "检查工作区与执行结果"],
    "verification.completed": ["验证完成", String(payload.summary ?? "")],
    "task.succeeded": ["本轮任务完成", concise(payload.result, 900) || "结果已持久化"],
    "task.failed": [payload.phase === "failed" ? "本轮执行未完成" : "本轮执行失败", String(payload.detail ?? payload.message ?? "任务可能正在等待自动重试，请查看状态")],
    "task.cancelled": ["任务已取消", "执行资源已释放"],
    "task.retried": ["任务重新入队", `当前尝试次数 ${String(payload.attempt ?? 0)}`],
    "task.recovered": ["任务已从中断中恢复", String(payload.message ?? "已重新进入持久化队列")],
    "task.lease.recovered": ["任务已从 Worker 失联中恢复", String(payload.detail ?? "已重新进入持久化队列")],
    "task.shutdown.queued": ["应用退出时已安全暂停", String(payload.detail ?? "下次启动后从持久队列继续")],
    "task.recovery.failed": ["任务恢复次数已用尽", String(payload.detail ?? "已进入死信，等待人工重放")],
    "task.lease.failed": ["Worker 多次失联，任务已停止", String(payload.detail ?? "已进入死信，等待人工重放")],
    "goal.dependency.added": ["已设置前置目标", String(payload.title ?? "调度器将在前置目标完成后自动继续")],
    "goal.dependency.removed": ["已移除前置目标", "当前目标已重新交由调度器判定是否运行"],
    "task.updated": ["任务信息已更新", payload.archived ? "已归档" : "标题或归档状态已更新"],
    "turn.started": ["Agent 开始处理", "正在理解目标并规划下一步"],
    "turn.completed": ["Agent 执行完成", "正在进入验证闭环"],
    "turn.failed": ["Agent 执行失败", concise(asRecord(rawEvent.error).message ?? payload.message, 800)],
  };
  return copies[event.type] ?? ["执行状态更新", concise(rawEvent.message ?? payload.message ?? event.type, 600)];
}

function isReasoningEvent(event: TaskEvent): boolean {
  const item = asRecord(event.payload.item);
  if (item.type === "reasoning") return true;
  const raw = asRecord(event.payload.event);
  return asRecord(raw.item).type === "reasoning";
}

function DeferredMarkdown({ content }: { content: string }) {
  return <Suspense fallback={<div className="message-content markdown-body markdown-loading">正在渲染内容…</div>}><MarkdownContent content={content} /></Suspense>;
}

export function AgentConsole() {
  const [api] = useState(resolveApiUrl);
  const [detachedMode] = useState(resolveDetachedMode);
  const [detachedTaskId] = useState(resolveInitialTaskId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(resolveInitialTaskId);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [turnWindow, setTurnWindow] = useState(() => ({ taskId: resolveInitialTaskId(), count: initialVisibleTurnCount }));
  const detailTurnLimit = turnWindow.taskId === selectedId ? turnWindow.count : initialVisibleTurnCount;
  const detailEventLimit = Math.min(10_000, Math.max(800, detailTurnLimit * 20));
  const [turnTotal, setTurnTotal] = useState(0);
  const [memory, setMemory] = useState<ConversationMemory | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({ path: null, files: [], changes: [] });
  const [tree, setTree] = useState<Record<string, TreeEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<"checking" | "online" | "offline">("checking");
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activityOnly, setActivityOnly] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [unreadTaskIds, setUnreadTaskIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(window.localStorage.getItem("agent-foundry:unread-tasks") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const [notificationMode, setNotificationMode] = useState<NotificationMode>(() => {
    if (typeof window === "undefined") return "background";
    const saved = window.localStorage.getItem("agent-foundry:notification-mode");
    return saved === "never" || saved === "always" ? saved : "background";
  });
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [taskListLimit, setTaskListLimit] = useState(100);
  const [taskListTotal, setTaskListTotal] = useState(0);
  const [taskListLoaded, setTaskListLoaded] = useState(0);
  const [taskFiltersOpen, setTaskFiltersOpen] = useState(false);
  const [taskFilters, setTaskFilters] = useState<TaskFilters>(emptyTaskFilters);
  const [taskFacets, setTaskFacets] = useState<TaskListFacets>({ statuses: { active: 0, waiting: 0, completed: 0, stopped: 0 }, providers: [], models: [], projects: [] });
  const [contextTab, setContextTab] = useState<ContextTab>("files");
  const [contextOpen, setContextOpen] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [localBrowser, setLocalBrowser] = useState<LocalBrowser | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [compactionState, setCompactionState] = useState<{ phase: "idle" | "running" | "completed" | "failed"; before?: number | null; after?: number | null; error?: string }>({ phase: "idle" });
  const [followUp, setFollowUp] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandTasks, setCommandTasks] = useState<Task[]>([]);
  const [commandTasksLoading, setCommandTasksLoading] = useState(false);
  const [commandSelection, setCommandSelection] = useState(0);
  const [draftProtection, setDraftProtection] = useState<"loading" | "encrypted" | "session">("loading");
  const [followUpProtection, setFollowUpProtection] = useState<"loading" | "encrypted" | "session">("loading");
  const [slashSelection, setSlashSelection] = useState(0);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [providerSecrets, setProviderSecrets] = useState<ProviderSecretDraft>({});
  const [draftAttachments, setDraftAttachments] = useState<string[]>([]);
  const [followUpAttachments, setFollowUpAttachments] = useState<string[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<AttachmentPreviewMap>({});
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [children, setChildren] = useState<Task[]>([]);
  const [childOpen, setChildOpen] = useState(false);
  const [childForm, setChildForm] = useState({ title: "子 Agent 任务", prompt: "", isolation: "worktree" });
  const [editing, setEditing] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolMatches, setSymbolMatches] = useState<Array<{ path: string; line: number; preview: string }>>([]);
  const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceRoot[]>([]);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
  const [dataSummary, setDataSummary] = useState<DataSummary | null>(null);
  const [auditEntries, setAuditEntries] = useState<Array<Record<string, unknown>>>([]);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [updateAccess, setUpdateAccess] = useState<UpdateAccessStatus | null>(null);
  const [updateToken, setUpdateToken] = useState("");
  const [updateTokenBusy, setUpdateTokenBusy] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(defaultLeftPanelWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(defaultRightPanelWidth);
  const [panelWidthsLoaded, setPanelWidthsLoaded] = useState(false);
  const [resizingPanel, setResizingPanel] = useState<"left" | "right" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [editingLastMessage, setEditingLastMessage] = useState(false);
  const [deleteTaskConfirmOpen, setDeleteTaskConfirmOpen] = useState(false);
  const [reviewCommentTarget, setReviewCommentTarget] = useState<{ filePath: string; line: number; side: "old" | "new" } | null>(null);
  const [reviewCommentBusy, setReviewCommentBusy] = useState(false);
  const [form, setForm] = useState({ title: "", prompt: "", runtime: "codex", provider: "openai", model: "", reasoningEffort: "medium" as ReasoningEffort, sandboxMode: "workspace-write" as SandboxMode, approvalPolicy: "on-request" as ApprovalPolicy, approvalsReviewer: "user" as ApprovalsReviewer, workspacePath: "", durableWait: false, goalMode: false, goalMaxTurns: 5, goalDeadlineHours: 0, goalTokenBudget: 0 });
  const [turnSettings, setTurnSettings] = useState({ provider: "openai" as "openai" | "deepseek" | "custom", model: "", reasoningEffort: "medium" as ReasoningEffort, sandboxMode: "workspace-write" as SandboxMode, approvalPolicy: "on-request" as ApprovalPolicy, approvalsReviewer: "user" as ApprovalsReviewer });
  const threadEnd = useRef<HTMLDivElement>(null);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const historyScrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const followUpInput = useRef<HTMLTextAreaElement>(null);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const reasoningSelect = useRef<HTMLSelectElement>(null);
  const selectedIdSnapshot = useRef<string | null>(null);
  const activeRootIdSnapshot = useRef<string | null>(null);
  const taskStatusSnapshot = useRef<Map<string, Status>>(new Map());
  const taskListInitialized = useRef(false);
  const tasksSnapshot = useRef<Task[]>([]);
  const taskListRequestSequence = useRef(0);
  const taskFacetRequestSequence = useRef(0);
  const resizeStart = useRef<{ side: "left" | "right"; x: number; width: number } | null>(null);
  const draftReturnTaskId = useRef<string | null>(null);
  const draftTouched = useRef(false);
  const followUpDraftOwner = useRef<string | null>(null);
  const followUpDraftReady = useRef(false);
  const followUpDraftTouched = useRef(false);
  const followUpValueSnapshot = useRef("");
  const followUpAttachmentsSnapshot = useRef<string[]>([]);
  const sessionFollowUpDrafts = useRef(new Map<string, Omit<FollowUpDraft, "taskId">>());
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const activeRoot = workspaceRoots.find((root) => root.id === activeRootId) ?? workspaceRoots.find((root) => root.kind === "primary") ?? null;
  const sharedWorkspaceTaskCount = selected?.workspacePath ? tasks.filter((task) => task.workspacePath === selected.workspacePath).length : 0;
  const hasDraftContent = Boolean(form.prompt.trim() || draftAttachments.length);
  const activeAttachments = composerOpen ? draftAttachments : followUpAttachments;

  const resetDraftContent = useCallback(() => {
    setForm((current) => ({ ...current, title: "", prompt: "", goalMode: false, goalMaxTurns: 5, goalDeadlineHours: 0, goalTokenBudget: 0 }));
    setDraftAttachments([]);
    setAttachmentPreviews({});
  }, []);

  const openNewConversation = useCallback(() => {
    setAutomationOpen(false);
    setGoalsOpen(false);
    if (!composerOpen) draftReturnTaskId.current = selectedId;
    setComposerOpen(true);
    setSelectedId(null);
    setNotice(hasDraftContent ? "已恢复本次应用会话中尚未发送的草稿。" : null);
    if (!hasDraftContent) resetDraftContent();
  }, [composerOpen, hasDraftContent, resetDraftContent, selectedId]);

  const hideDraftConversation = useCallback(() => {
    setComposerOpen(false);
    if (!hasDraftContent) resetDraftContent();
    setSelectedId(draftReturnTaskId.current);
    draftReturnTaskId.current = null;
  }, [hasDraftContent, resetDraftContent]);

  const discardDraftConversation = useCallback(() => {
    void window.agentDesktop?.saveNewTaskDraft?.(null).catch(() => undefined);
    draftTouched.current = false;
    resetDraftContent();
    setComposerOpen(false);
    setSelectedId(draftReturnTaskId.current);
    draftReturnTaskId.current = null;
    setNotice(null);
  }, [resetDraftContent]);

  const openCommandPalette = useCallback(() => {
    setCommandQuery("");
    setCommandTasks([]);
    setCommandTasksLoading(false);
    setCommandSelection(0);
    setCommandOpen(true);
  }, []);

  const markTaskRead = useCallback((taskId: string) => {
    setUnreadTaskIds((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current); next.delete(taskId); return next;
    });
  }, []);

  const refreshTaskFacets = useCallback(async () => {
    if (detachedMode) return;
    const requestSequence = ++taskFacetRequestSequence.current;
    try {
      const response = await fetch(`${api}/api/tasks/facets?archived=${showArchived}`, { cache: "no-store" });
      const data = await response.json() as { facets?: TaskListFacets };
      if (requestSequence === taskFacetRequestSequence.current && response.ok && data.facets) setTaskFacets(data.facets);
    } catch { /* The task list remains usable if optional facets are unavailable. */ }
  }, [api, detachedMode, showArchived]);

  useEffect(() => {
    if (!commandOpen || detachedMode) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ archived: "false", limit: "8" });
      if (commandQuery.trim()) query.set("query", commandQuery.trim());
      setCommandTasksLoading(true);
      void fetch(`${api}/api/tasks?${query}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("任务搜索不可用");
          const data = await response.json() as { tasks: Task[] };
          setCommandTasks(data.tasks);
        })
        .catch((error) => { if (error instanceof Error && error.name !== "AbortError") setCommandTasks([]); })
        .finally(() => { if (!controller.signal.aborted) setCommandTasksLoading(false); });
    }, commandQuery ? 120 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [api, commandOpen, commandQuery, detachedMode]);

  const refresh = useCallback(async () => {
    const requestSequence = ++taskListRequestSequence.current;
    try {
      if (detachedMode && detachedTaskId) {
        const detailResponse = await fetch(`${api}/api/tasks/${detachedTaskId}`, { cache: "no-store" });
        if (!detailResponse.ok) throw new Error("对话不存在");
        const detail = await detailResponse.json() as { task: Task };
        if (requestSequence !== taskListRequestSequence.current) return;
        setTasks([detail.task]);
        setTaskListTotal(1); setTaskListLoaded(1);
        setHealth("online");
        setSelectedId(detachedTaskId);
        return;
      }
      const query = new URLSearchParams({ archived: String(showArchived), limit: String(taskListLimit) });
      if (deferredSearch.trim()) query.set("query", deferredSearch.trim());
      if (taskFilters.status !== "all") query.set("status", taskFilters.status);
      if (taskFilters.provider) query.set("provider", taskFilters.provider);
      if (taskFilters.model) query.set("model", taskFilters.model);
      if (taskFilters.project) query.set("project", taskFilters.project);
      const hasTaskFilters = taskFilters.status !== "all" || Boolean(taskFilters.provider || taskFilters.model || taskFilters.project);
      const taskResponse = await fetch(`${api}/api/tasks?${query}`, { cache: "no-store" });
      if (!taskResponse.ok) throw new Error("服务不可用");
      const data = await taskResponse.json() as { tasks: Task[]; total: number };
      if (requestSequence !== taskListRequestSequence.current) return;
      if (!showArchived) {
        const previousStatuses = taskStatusSnapshot.current;
        if (taskListInitialized.current) {
          for (const task of data.tasks) {
            const alert = taskTransitionAlert(previousStatuses.get(task.id), task);
            if (!alert) continue;
            const currentlyReading = selectedIdSnapshot.current === task.id && document.visibilityState === "visible";
            if (!currentlyReading) setUnreadTaskIds((current) => new Set(current).add(task.id));
            const shouldNotify = notificationMode === "always" || (notificationMode === "background" && (!currentlyReading || document.visibilityState !== "visible"));
            if (shouldNotify) void window.agentDesktop?.showNotification(task.id, alert.title, alert.body).catch(() => undefined);
          }
        }
        if (!deferredSearch.trim() && !hasTaskFilters && data.tasks.length >= data.total) {
          const knownTaskIds = new Set(data.tasks.map((task) => task.id));
          setUnreadTaskIds((current) => {
            const next = new Set([...current].filter((taskId) => knownTaskIds.has(taskId)));
            return next.size === current.size ? current : next;
          });
        }
        taskStatusSnapshot.current = new Map(data.tasks.map((task) => [task.id, task.status]));
        taskListInitialized.current = true;
      }
      const retained = tasksSnapshot.current.find((task) => task.id === selectedIdSnapshot.current && Boolean(task.archivedAt) === showArchived);
      const nextTasks = !hasTaskFilters && retained && !data.tasks.some((task) => task.id === retained.id) ? [...data.tasks, retained] : data.tasks;
      setTasks(nextTasks); setTaskListTotal(data.total); setTaskListLoaded(data.tasks.length);
      setHealth("online");
      setSelectedId((current) => composerOpen ? null : nextTasks.some((task) => task.id === current) ? current : data.tasks[0]?.id ?? null);
    } catch { if (requestSequence === taskListRequestSequence.current) setHealth("offline"); }
  }, [api, composerOpen, deferredSearch, detachedMode, detachedTaskId, notificationMode, showArchived, taskFilters, taskListLimit]);

  const refreshEnvironment = useCallback(async () => {
    try {
      const [configResponse, healthResponse] = await Promise.all([fetch(`${api}/api/config`, { cache: "no-store" }), fetch(`${api}/api/health`, { cache: "no-store" })]);
      if (!configResponse.ok || !healthResponse.ok) throw new Error("服务不可用");
      const configData = await configResponse.json() as AppConfig;
      const healthData = await healthResponse.json() as { runtime?: RuntimeDiagnostics };
      setConfig(configData); setHealth("online");
      setRuntimeDiagnostics(healthData.runtime ?? null);
      setForm((current) => {
        const provider = configData.providers.find((item) => item.id === current.provider);
        const configured = configData.providers.find((item) => item.configured && item.codexCompatible);
        return !provider?.configured && configured ? { ...current, provider: configured.id, model: "" } : current;
      });
    } catch { setHealth("offline"); }
  }, [api]);

  useEffect(() => {
    const initial = window.setTimeout(() => void Promise.all([refresh(), refreshEnvironment(), refreshTaskFacets()]), 0);
    const tasksTimer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const environmentTimer = window.setInterval(() => { if (document.visibilityState === "visible") void Promise.all([refreshEnvironment(), refreshTaskFacets()]); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") { if (selectedIdSnapshot.current) markTaskRead(selectedIdSnapshot.current); void Promise.all([refresh(), refreshTaskFacets()]); } };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearTimeout(initial); window.clearInterval(tasksTimer); window.clearInterval(environmentTimer); document.removeEventListener("visibilitychange", visible); };
  }, [markTaskRead, refresh, refreshEnvironment, refreshTaskFacets]);

  useEffect(() => {
    if (detachedMode) return;
    let refreshTimer: number | null = null;
    let reconnecting = false;
    const stream = new EventSource(`${api}/api/task-activity/stream`);
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void Promise.all([refresh(), refreshTaskFacets()]);
      }, 500);
    };
    stream.onmessage = scheduleRefresh;
    stream.onerror = () => { reconnecting = true; };
    stream.onopen = () => {
      if (!reconnecting) return;
      reconnecting = false;
      scheduleRefresh();
    };
    return () => {
      stream.close();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [api, detachedMode, refresh, refreshTaskFacets]);

  useEffect(() => {
    selectedIdSnapshot.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    tasksSnapshot.current = tasks;
  }, [tasks]);

  useEffect(() => {
    activeRootIdSnapshot.current = activeRootId;
  }, [activeRootId]);

  useEffect(() => { window.localStorage.setItem("agent-foundry:unread-tasks", JSON.stringify([...unreadTaskIds])); }, [unreadTaskIds]);
  useEffect(() => { window.localStorage.setItem("agent-foundry:notification-mode", notificationMode); }, [notificationMode]);

  useEffect(() => {
    let cancelled = false;
    if (detachedMode || !window.agentDesktop?.loadNewTaskDraft) {
      void Promise.resolve().then(() => { if (!cancelled) setDraftProtection("session"); });
      return () => { cancelled = true; };
    }
    void window.agentDesktop.loadNewTaskDraft().then((result) => {
      if (cancelled) return;
      setDraftProtection(result.encrypted ? "encrypted" : "session");
      if (!result.draft || draftTouched.current) return;
      const draft = result.draft;
      setForm((current) => ({ ...current, ...draft, title: "" }));
      setDraftAttachments(draft.attachments);
    }).catch(() => { if (!cancelled) setDraftProtection("session"); });
    return () => { cancelled = true; };
  }, [detachedMode]);

  useEffect(() => {
    if (detachedMode || draftProtection !== "encrypted" || !window.agentDesktop?.saveNewTaskDraft) return;
    const timer = window.setTimeout(() => {
      const draft: NewTaskDraft | null = hasDraftContent ? {
        prompt: form.prompt, attachments: draftAttachments, runtime: form.runtime, provider: form.provider as NewTaskDraft["provider"], model: form.model,
        reasoningEffort: form.reasoningEffort, sandboxMode: form.sandboxMode, approvalPolicy: form.approvalPolicy, approvalsReviewer: form.approvalsReviewer,
        workspacePath: form.workspacePath, durableWait: form.durableWait, goalMode: form.goalMode, goalMaxTurns: form.goalMaxTurns,
        goalDeadlineHours: form.goalDeadlineHours, goalTokenBudget: form.goalTokenBudget,
      } : null;
      void window.agentDesktop!.saveNewTaskDraft(draft).then((saved) => { if (!saved) setDraftProtection("session"); }).catch(() => setDraftProtection("session"));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draftAttachments, detachedMode, draftProtection, form, hasDraftContent]);

  useEffect(() => { followUpValueSnapshot.current = followUp; }, [followUp]);
  useEffect(() => { followUpAttachmentsSnapshot.current = followUpAttachments; }, [followUpAttachments]);

  useEffect(() => {
    const previousTaskId = followUpDraftOwner.current;
    if (previousTaskId && followUpDraftReady.current) {
      const previousContent = followUpValueSnapshot.current;
      const previousAttachments = followUpAttachmentsSnapshot.current;
      const previousDraft = previousContent.trim() || previousAttachments.length ? { content: previousContent, attachments: previousAttachments } : null;
      if (previousDraft) sessionFollowUpDrafts.current.set(previousTaskId, previousDraft); else sessionFollowUpDrafts.current.delete(previousTaskId);
      void window.agentDesktop?.saveFollowUpDraft?.(previousTaskId, previousDraft).catch(() => undefined);
    }

    followUpDraftOwner.current = selectedId;
    followUpDraftReady.current = false;
    followUpDraftTouched.current = false;
    const sessionDraft = selectedId ? sessionFollowUpDrafts.current.get(selectedId) : null;
    setFollowUp(sessionDraft?.content ?? "");
    setFollowUpAttachments(sessionDraft?.attachments ?? []);
    if (!selectedId) return;
    if (!window.agentDesktop?.loadFollowUpDraft) {
      setFollowUpProtection("session");
      followUpDraftReady.current = true;
      return;
    }
    const taskId = selectedId;
    void window.agentDesktop.loadFollowUpDraft(taskId).then((result) => {
      if (followUpDraftOwner.current !== taskId) return;
      setFollowUpProtection(result.encrypted ? "encrypted" : "session");
      if (!sessionDraft && !followUpDraftTouched.current && result.draft) {
        setFollowUp(result.draft.content);
        setFollowUpAttachments(result.draft.attachments);
        sessionFollowUpDrafts.current.set(taskId, { content: result.draft.content, attachments: result.draft.attachments, savedAt: result.draft.savedAt });
      }
      followUpDraftReady.current = true;
    }).catch(() => {
      if (followUpDraftOwner.current !== taskId) return;
      setFollowUpProtection("session");
      followUpDraftReady.current = true;
    });
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || followUpDraftOwner.current !== selectedId || !followUpDraftReady.current) return;
    const timer = window.setTimeout(() => {
      const draft = followUp.trim() || followUpAttachments.length ? { content: followUp, attachments: followUpAttachments } : null;
      if (draft) sessionFollowUpDrafts.current.set(selectedId, draft); else sessionFollowUpDrafts.current.delete(selectedId);
      if (followUpProtection === "encrypted") {
        void window.agentDesktop?.saveFollowUpDraft?.(selectedId, draft).then((saved) => { if (!saved) setFollowUpProtection("session"); }).catch(() => setFollowUpProtection("session"));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [followUp, followUpAttachments, followUpProtection, selectedId]);

  useEffect(() => {
    if (detachedMode || !window.agentDesktop?.onFocusConversation) return;
    window.agentDesktop.onFocusConversation((taskId) => {
      markTaskRead(taskId);
      setComposerOpen(false);
      setShowArchived(false);
      setNotice(null);
      setSelectedId(taskId);
      void fetch(`${api}/api/tasks/${taskId}`, { cache: "no-store" }).then(async (response) => {
        if (!response.ok) return;
        const detail = await response.json() as { task: Task };
        setTasks((current) => [detail.task, ...current.filter((task) => task.id !== detail.task.id)]);
      });
    });
  }, [api, detachedMode, markTaskRead]);

  useEffect(() => {
    if (!detachedMode) return;
    document.title = selected ? `${selected.title} · Agent Foundry` : "独立对话 · Agent Foundry";
  }, [detachedMode, selected]);

  const loadWorkspace = useCallback(async (taskId: string, rootId?: string | null) => {
    const rootQuery = rootId ? `&rootId=${encodeURIComponent(rootId)}` : "";
    const [response, treeResponse] = await Promise.all([
      fetch(`${api}/api/tasks/${taskId}/workspace`, { cache: "no-store" }),
      fetch(`${api}/api/tasks/${taskId}/workspace/tree?path=${rootQuery}`, { cache: "no-store" }),
    ]);
    const [snapshot, treeData] = await Promise.all([
      response.ok ? response.json() as Promise<WorkspaceSnapshot> : Promise.resolve(null),
      treeResponse.ok ? treeResponse.json() as Promise<{ entries: TreeEntry[] }> : Promise.resolve(null),
    ]);
    if (!shouldApplyTaskResponse(selectedIdSnapshot.current, taskId)) return;
    if (snapshot) setWorkspace(snapshot);
    if (treeResponse.ok) {
      setTree((current) => ({ ...current, "": treeData?.entries ?? [] }));
    }
  }, [api]);

  useEffect(() => {
    if (!selectedId) return;
    let closed = false;
    let stream: EventSource | null = null;
    let detailTimer: number | null = null;
    let detailRequest: Promise<TaskEvent[]> | null = null;
    let detailPending = false;
    let latestEventId = 0;
    const performDetailLoad = () => fetch(`${api}/api/tasks/${selectedId}?turnLimit=${detailTurnLimit}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok || closed) return [] as TaskEvent[];
      const detail = await response.json() as { task: Task; events: TaskEvent[]; eventTotal?: number; messages: ConversationMessage[]; turnTotal?: number; memory: ConversationMemory; approvals: Approval[]; signals: Signal[]; sandbox: Sandbox | null; children: Task[]; workspaceRoots: WorkspaceRoot[]; reviewComments: ReviewComment[]; artifacts: Artifact[] };
      if (closed || !shouldApplyTaskResponse(selectedIdSnapshot.current, selectedId)) return [] as TaskEvent[];
      setTasks((current) => current.map((task) => task.id === detail.task.id ? detail.task : task));
      const detailLatestEventId = detail.events.at(-1)?.id ?? 0;
      latestEventId = Math.max(latestEventId, detailLatestEventId);
      setEvents((current) => (current.at(-1)?.id ?? 0) <= detailLatestEventId
        ? detail.events
        : [...detail.events, ...current.filter((event) => event.id > detailLatestEventId)].slice(-detailEventLimit));
      setEventTotal((current) => Math.max(current, detail.eventTotal ?? detail.events.length)); setMessages(detail.messages); setTurnTotal(detail.turnTotal ?? detail.messages.filter((message) => message.role === "user").length); setMemory(detail.memory); setApprovals(detail.approvals);
      setSignals(detail.signals ?? []); setSandbox(detail.sandbox); setChildren(detail.children ?? []);
      const roots = detail.workspaceRoots ?? [];
      const initialRoot = roots.find((root) => root.kind === "primary") ?? roots[0] ?? null;
      const requestedRoot = roots.find((root) => root.id === activeRootIdSnapshot.current) ?? initialRoot;
      setWorkspaceRoots(roots); setActiveRootId((current) => roots.some((root) => root.id === current) ? current : initialRoot?.id ?? null); setReviewComments(detail.reviewComments ?? []); setArtifacts(detail.artifacts ?? []);
      if (requestedRoot) void loadWorkspace(selectedId, requestedRoot.id);
      return detail.events;
    }).catch(() => [] as TaskEvent[]);
    const loadDetail = () => {
      if (detailRequest) { detailPending = true; return detailRequest; }
      detailRequest = performDetailLoad().finally(() => {
        detailRequest = null;
        if (detailPending && !closed) { detailPending = false; scheduleDetail(); }
      });
      return detailRequest;
    };
    function scheduleDetail() {
      if (detailTimer !== null) return;
      detailTimer = window.setTimeout(() => { detailTimer = null; void loadDetail(); }, 220);
    }
    void loadDetail().then((initialEvents) => {
      if (closed) return;
      const after = initialEvents.at(-1)?.id ?? 0;
      stream = new EventSource(`${api}/api/tasks/${selectedId}/stream?after=${after}`);
      stream.onmessage = (message) => {
        if (closed || !shouldApplyTaskResponse(selectedIdSnapshot.current, selectedId)) return;
        let incoming: TaskEvent;
        try { incoming = JSON.parse(message.data) as TaskEvent; }
        catch { return; }
        if (incoming.id <= latestEventId) return;
        latestEventId = incoming.id;
        setEvents((current) => current.some((item) => item.id === incoming.id)
          ? current
          : [...current, incoming].slice(-detailEventLimit));
        setEventTotal((total) => total + 1);
        if (["conversation.message", "memory.updated", "task.succeeded", "task.failed", "task.cancelled", "approval.requested", "approval.resolved", "turn.workspace.summary", "conversation.branch.created", "conversation.branch.origin", "child-task.created", "context.compaction.started", "context.compaction.completed"].includes(incoming.type) || incoming.type.startsWith("goal.")) scheduleDetail();
        if (["agent.tool.completed", "workspace.change.completed", "verification.completed", "task.succeeded"].includes(incoming.type)) void loadWorkspace(selectedId, activeRootIdSnapshot.current);
        if (["task.succeeded", "task.failed", "task.cancelled", "task.running", "task.preparing"].includes(incoming.type) || incoming.type.startsWith("goal.")) void refresh();
      };
    });
    return () => { closed = true; stream?.close(); if (detailTimer !== null) window.clearTimeout(detailTimer); };
  }, [api, selectedId, detailTurnLimit, detailEventLimit, loadWorkspace, refresh]);

  useEffect(() => {
    const anchor = historyScrollAnchor.current;
    if (anchor && conversationScroll.current) {
      conversationScroll.current.scrollTop = anchor.top + conversationScroll.current.scrollHeight - anchor.height;
      historyScrollAnchor.current = null;
      return;
    }
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, selectedId]);
  const selectedSettingsId = selected?.id ?? null;
  const selectedSettingsProvider = (selected?.provider ?? "openai") as "openai" | "deepseek" | "custom";
  const selectedSettingsModel = selected?.model ?? "";
  const selectedSettingsEffort = selected?.reasoningEffort ?? "medium";
  const selectedSettingsSandbox = selected?.sandboxMode ?? "workspace-write";
  const selectedSettingsApproval = selected?.approvalPolicy ?? "on-request";
  const selectedSettingsReviewer = selected?.approvalsReviewer ?? "user";
  useEffect(() => {
    if (!selectedSettingsId) return;
    const frame = window.requestAnimationFrame(() => setTurnSettings({
      model: selectedSettingsModel,
      provider: selectedSettingsProvider,
      reasoningEffort: selectedSettingsEffort,
      sandboxMode: selectedSettingsSandbox,
      approvalPolicy: selectedSettingsApproval,
      approvalsReviewer: selectedSettingsReviewer,
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSettingsId, selectedSettingsProvider, selectedSettingsModel, selectedSettingsEffort, selectedSettingsSandbox, selectedSettingsApproval, selectedSettingsReviewer]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const left = Number(window.localStorage.getItem("agent-foundry:left-panel-width"));
      const right = Number(window.localStorage.getItem("agent-foundry:right-panel-width"));
      if (Number.isFinite(left) && left > 0) setLeftPanelWidth(left);
      if (Number.isFinite(right) && right > 0) setRightPanelWidth(right);
      setPanelWidthsLoaded(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent); window.addEventListener("drop", prevent);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", prevent); };
  }, []);
  useEffect(() => {
    if (!window.agentDesktop) return;
    let cancelled = false;
    void Promise.all(activeAttachments.filter(isPreviewableImageAttachment).map(async (filePath) => {
      try {
        const result = await window.agentDesktop!.readLocalFile(filePath);
        return result.kind === "image" && result.dataUrl ? [filePath, result.dataUrl] as const : null;
      } catch { return null; }
    })).then((entries) => {
      if (cancelled) return;
      setAttachmentPreviews(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => { cancelled = true; };
  }, [activeAttachments]);
  useEffect(() => { if (panelWidthsLoaded) window.localStorage.setItem("agent-foundry:left-panel-width", String(leftPanelWidth)); }, [leftPanelWidth, panelWidthsLoaded]);
  useEffect(() => { if (panelWidthsLoaded) window.localStorage.setItem("agent-foundry:right-panel-width", String(rightPanelWidth)); }, [rightPanelWidth, panelWidthsLoaded]);
  useEffect(() => {
    if (!resizingPanel) return;
    const move = (event: globalThis.PointerEvent) => {
      const start = resizeStart.current; if (!start) return;
      if (start.side === "left") {
        const maximum = Math.max(280, Math.min(520, window.innerWidth - (contextOpen ? rightPanelWidth : 0) - 520));
        setLeftPanelWidth(Math.max(180, Math.min(maximum, start.width + event.clientX - start.x)));
      } else {
        const maximum = Math.max(320, Math.min(760, window.innerWidth - (detachedMode ? 0 : leftPanelWidth) - 520));
        setRightPanelWidth(Math.max(260, Math.min(maximum, start.width - event.clientX + start.x)));
      }
    };
    const stop = () => { resizeStart.current = null; setResizingPanel(null); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, [resizingPanel, contextOpen, detachedMode, leftPanelWidth, rightPanelWidth]);
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        if (!detachedMode) { event.preventDefault(); openNewConversation(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); openCommandPalette();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault(); setContextOpen(true); setContextTab("terminal");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault(); setContextOpen((current) => !current);
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "u" && !detachedMode) {
        event.preventDefault(); setAutomationOpen(false); setGoalsOpen(false); setShowArchived(false); setActivityOnly((current) => !current);
      }
      if (event.key === "Escape") { if (composerOpen) hideDraftConversation(); setCommandOpen(false); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [composerOpen, detachedMode, hideDraftConversation, openCommandPalette, openNewConversation]);

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    const matchesSearch = !query || `${task.title} ${task.prompt} ${task.workspacePath ?? ""} ${task.projectWorkspacePath ?? ""}`.toLocaleLowerCase().includes(query);
    return matchesSearch && (!activityOnly || isActivityTask(task, unreadTaskIds));
  }), [tasks, deferredSearch, activityOnly, unreadTaskIds]);
  const taskGroups = useMemo(() => {
    return groupTasksByProject(filteredTasks);
  }, [filteredTasks]);
  const activeTaskFilterCount = useMemo(() => Object.entries(taskFilters).filter(([key, value]) => key === "status" ? value !== "all" : Boolean(value)).length, [taskFilters]);
  const coreEvents = useMemo(() => selectCoreActivityEvents(events), [events]);
  const latestRecovery = useMemo(() => [...events].reverse().find((event) => event.type === "task.recovered" || event.type === "task.lease.recovered" || event.type === "task.shutdown.queued"), [events]);
  const recoveryStillActive = Boolean(latestRecovery && activeStatuses.includes(selected?.status ?? "succeeded") && !events.some((event) => event.id > latestRecovery.id && ["task.succeeded", "task.failed", "task.cancelled"].includes(event.type)));
  const latestActivity = coreEvents.length ? eventCopy(coreEvents.at(-1)!) : ["等待开始", "关键操作将在这里实时显示"];
  const isActive = selected ? activeStatuses.includes(selected.status) : false;
  const slashCommands = useMemo(() => matchingSlashCommands(followUp, {
    hasTask: Boolean(selected), hasThread: Boolean(selected?.threadId), active: isActive, detached: detachedMode,
  }), [detachedMode, followUp, isActive, selected]);
  const draftSlashCommands = useMemo(() => matchingSlashCommands(form.prompt, {
    hasTask: false, hasThread: false, active: false, detached: detachedMode,
  }).filter((command) => command.name !== "new"), [detachedMode, form.prompt]);
  const conversationTurns = useMemo(() => {
    const users = messages.filter((message) => message.role === "user");
    const assistants = new Map(messages.filter((message) => message.role === "assistant").map((message) => [message.turn, message]));
    const buckets = users.map(() => [] as TaskEvent[]);
    let userIndex = 0;
    for (const event of events) {
      const timestamp = new Date(event.createdAt).getTime();
      while (userIndex + 1 < users.length && new Date(users[userIndex + 1].createdAt).getTime() <= timestamp) userIndex += 1;
      if (users[userIndex] && timestamp >= new Date(users[userIndex].createdAt).getTime() && event.payload.hidden !== true) buckets[userIndex].push(event);
    }
    return users.map((user, index) => ({ user, assistant: assistants.get(user.turn), events: buckets[index], displayEvents: selectCoreActivityEvents(buckets[index]) }));
  }, [messages, events]);
  const visibleTurnCount = detailTurnLimit;
  const hiddenTurnCount = Math.max(0, turnTotal - visibleTurnCount);
  const visibleConversationTurns = useMemo(() => conversationTurns.slice(-visibleTurnCount), [conversationTurns, visibleTurnCount]);

  function loadEarlierTurns() {
    const scroller = conversationScroll.current;
    if (scroller) historyScrollAnchor.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
    setTurnWindow({ taskId: selectedId, count: Math.min(turnTotal, visibleTurnCount + 30) });
  }

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const response = await fetch(`${api}/api/models`, { cache: "no-store" });
      const data = await response.json() as { models?: ModelChoice[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "模型目录加载失败");
      const available = data.models ?? [];
      setModelChoices(available);
      setForm((current) => {
        if (current.model || !available.length) return current;
        const preferred = available.find((choice) => choice.provider === current.provider && choice.isDefault) ?? available.find((choice) => choice.provider === current.provider) ?? available[0];
        return { ...current, provider: preferred.provider, model: preferred.model, reasoningEffort: preferred.supportedReasoningEfforts.length && !preferred.supportedReasoningEfforts.includes(current.reasoningEffort) ? preferred.supportedReasoningEfforts[0] : current.reasoningEffort };
      });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setModelsLoading(false); }
  }, [api]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(initial);
  }, [loadModels]);

  function usagePercent(value: unknown): number | null {
    const usage = asRecord(value);
    const total = asRecord(usage.total);
    const tokens = Number(total.totalTokens ?? usage.totalTokens ?? NaN);
    const windowSize = Number(usage.modelContextWindow ?? NaN);
    return Number.isFinite(tokens) && Number.isFinite(windowSize) && windowSize > 0 ? Math.min(100, Math.round(tokens / windowSize * 1000) / 10) : null;
  }

  function tokenCountLabel(value: number): string {
    return value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : value >= 1_000 ? `${Math.round(value / 100) / 10}K` : String(value);
  }

  function byteCountLabel(value: number): string {
    if (value < 1_024) return `${value} B`;
    if (value < 1_048_576) return `${Math.round(value / 102.4) / 10} KB`;
    if (value < 1_073_741_824) return `${Math.round(value / 104_857.6) / 10} MB`;
    return `${Math.round(value / 107_374_182.4) / 10} GB`;
  }

  function turnSummary(turnNumber: number, turnEvents: TaskEvent[]) {
    const summary = [...turnEvents].reverse().find((event) => event.type === "turn.workspace.summary");
    const outputs = summary && Array.isArray(summary.payload.outputs) ? summary.payload.outputs.map(String) : [];
    return { summary, outputs, turnNumber };
  }

  function summaryChangeCount(summary: TaskEvent | undefined): number {
    const explicit = Number(summary?.payload.changeCount);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    return Array.isArray(summary?.payload.changes) ? summary.payload.changes.length : 0;
  }

  async function chooseWorkspace() {
    setNotice(null);
    if (!window.agentDesktop) { setNotice("文件夹选择器仅在 Agent Foundry 桌面版中可用。"); return; }
    const selectedPath = await window.agentDesktop.selectWorkspace();
    if (selectedPath) setForm((current) => ({ ...current, workspacePath: selectedPath }));
  }

  async function addSkillRoot() {
    if (!window.agentDesktop || !settings) { setNotice("目录选择器仅在桌面版中可用。"); return; }
    const selectedPath = await window.agentDesktop.selectWorkspace();
    if (selectedPath) setSettings({ ...settings, skillsExtraRoots: [...new Set([...settings.skillsExtraRoots, selectedPath])] });
  }

  async function chooseMcpConfig() {
    if (!window.agentDesktop || !settings) { setNotice("文件选择器仅在桌面版中可用。"); return; }
    const selectedFiles = await window.agentDesktop.selectFiles();
    const selectedPath = selectedFiles[0];
    if (!selectedPath) return;
    if (!/(^|[\\/])config\.toml$/i.test(selectedPath)) {
      setNotice("请选择名为 config.toml 的 Codex 配置文件。");
      return;
    }
    setSettings({ ...settings, mcpConfigPath: selectedPath });
    setNotice("已选择 Codex 配置文件；保存后会用于新的模型、Skill 与 MCP 进程。");
  }

  async function chooseAttachments(target: "new" | "follow-up") {
    if (!window.agentDesktop) { setNotice("附件选择器仅在桌面版中可用。"); return; }
    const selectedFiles = await window.agentDesktop.selectFiles();
    addAttachments(selectedFiles, "已添加附件", target);
  }

  function addAttachments(paths: string[], noticeText: string, target: "new" | "follow-up"): void {
    const validPaths = paths.filter(Boolean);
    if (!validPaths.length) return;
    if (target === "new") {
      draftTouched.current = true;
      setDraftAttachments((current) => [...new Set([...current, ...validPaths])].slice(0, 20));
    } else {
      followUpDraftTouched.current = true;
      setFollowUpAttachments((current) => {
        const next = [...new Set([...current, ...validPaths])].slice(0, 20);
        followUpAttachmentsSnapshot.current = next;
        return next;
      });
    }
    setNotice(`${noticeText}：${validPaths.length} 个文件。`);
  }

  function removeAttachment(filePath: string, target: "new" | "follow-up"): void {
    if (target === "new") setDraftAttachments((current) => current.filter((item) => item !== filePath));
    else {
      followUpDraftTouched.current = true;
      setFollowUpAttachments((current) => {
        const next = current.filter((item) => item !== filePath);
        followUpAttachmentsSnapshot.current = next;
        return next;
      });
    }
    setAttachmentPreviews((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
  }

  function attachmentDragEnter(event: ReactDragEvent<HTMLElement>, enabled = true): void {
    event.preventDefault(); event.stopPropagation();
    if (enabled && event.dataTransfer.types.includes("Files")) setAttachmentDragActive(true);
  }

  function attachmentDragLeave(event: ReactDragEvent<HTMLElement>): void {
    event.preventDefault(); event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setAttachmentDragActive(false);
  }

  function attachmentDrop(event: ReactDragEvent<HTMLElement>, enabled = true, target: "new" | "follow-up" = "follow-up"): void {
    event.preventDefault(); event.stopPropagation(); setAttachmentDragActive(false);
    if (!enabled || !window.agentDesktop || !event.dataTransfer.files.length) return;
    const paths = [...event.dataTransfer.files].map((file) => window.agentDesktop!.pathForFile(file)).filter(Boolean);
    addAttachments(paths, "已拖入", target);
  }

  function pasteImage(event: ReactClipboardEvent<HTMLTextAreaElement>, enabled = true, target: "new" | "follow-up" = "follow-up"): void {
    if (!enabled || ![...event.clipboardData.items].some((item) => item.type.startsWith("image/"))) return;
    event.preventDefault();
    void attachClipboardImage(target);
  }

  async function attachClipboardImage(target: "new" | "follow-up") {
    if (!window.agentDesktop) { setNotice("剪贴板图片仅在桌面版中可用。"); return; }
    const imagePath = await window.agentDesktop.saveClipboardImage();
    if (!imagePath) { setNotice("剪贴板中没有图片。"); return; }
    addAttachments([imagePath], "已粘贴图片", target);
  }

  async function openWorkspace() {
    const workspacePath = activeRoot?.path ?? selected?.workspacePath;
    if (!workspacePath || !window.agentDesktop) return;
    const error = await window.agentDesktop.openWorkspace(workspacePath);
    if (error) setNotice(error);
  }

  async function openSystemPath(filePath: string) {
    if (!window.agentDesktop) return;
    const error = await window.agentDesktop.openPath(filePath);
    if (error) setNotice(error);
  }

  async function browseLocalDirectory(directoryPath?: string) {
    if (!window.agentDesktop) { setNotice("本机文件浏览器仅在 Agent Foundry 桌面版中可用。"); return; }
    let target = directoryPath;
    if (!target) target = await window.agentDesktop.selectWorkspace() ?? undefined;
    if (!target) return;
    try {
      const listing = await window.agentDesktop.browseDirectory(target);
      setLocalBrowser(listing); setPreview(null); setEditing(false); setContextTab("files");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function returnToCurrentWorkspace() {
    setLocalBrowser(null); setPreview(null); setEditing(false); setTree({}); setExpandedDirectories(new Set());
    const primary = workspaceRoots.find((root) => root.kind === "primary");
    if (selected && primary) { setActiveRootId(primary.id); await loadWorkspace(selected.id, primary.id); }
  }

  async function setCurrentWorkspace() {
    if (!selected || !localBrowser) return;
    setWorkspaceSwitching(true); setNotice("正在切换当前工作区…");
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/current`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: localBrowser.path }) });
      const data = await response.json() as { task?: Task; root?: WorkspaceRoot; workspaceRoots?: WorkspaceRoot[]; error?: string };
      if (!response.ok || !data.task || !data.root) throw new Error(data.error ?? "无法切换当前工作区");
      setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task));
      setWorkspaceRoots(data.workspaceRoots ?? [data.root]); setActiveRootId(data.root.id); setLocalBrowser(null); setPreview(null); setTree({}); setExpandedDirectories(new Set());
      setNotice(`当前工作区已切换到 ${data.root.path}`); await loadWorkspace(selected.id, data.root.id);
    } catch (error) { setNotice(`切换工作区失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setWorkspaceSwitching(false); }
  }

  async function openLocalFile(absolutePath: string, displayPath = absolutePath) {
    if (!window.agentDesktop) return;
    setPreview({ kind: "local-text", path: displayPath, absolutePath, content: "", loading: true });
    try {
      const result = await window.agentDesktop.readLocalFile(absolutePath);
      const kind = result.kind === "text" ? "local-text" : result.kind;
      setPreview({ kind, path: displayPath, absolutePath, content: result.content ?? "", dataUrl: result.dataUrl, reason: result.reason });
    } catch (error) { setPreview({ kind: "local-text", path: displayPath, absolutePath, content: "", error: error instanceof Error ? error.message : String(error) }); }
  }

  async function openFileEntry(filePath: string) {
    if (window.agentDesktop && activeRoot) {
      const separator = activeRoot.path.includes("\\") ? "\\" : "/";
      const absolutePath = `${activeRoot.path.replace(/[\\/]$/, "")}${separator}${filePath.replaceAll("/", separator)}`;
      await openLocalFile(absolutePath, filePath); return;
    }
    await openPreview("file", filePath);
  }

  function switchWorkspaceRoot(rootId: string) {
    setTree({}); setExpandedDirectories(new Set()); setPreview(null); setSymbolMatches([]); setActiveRootId(rootId);
    if (selectedId) void loadWorkspace(selectedId, rootId);
  }

  async function openPreview(kind: Preview["kind"], filePath: string, turn?: number) {
    if (!selected) return;
    const rootId = activeRoot?.kind === "additional" ? activeRoot.id : undefined;
    if (kind === "diff" && rootId) { setNotice("附加工作区为只读引用，Git 变更仅显示主工作区。"); return; }
    setPreview({ kind, path: filePath, rootId, readOnly: Boolean(rootId), content: "", loading: true });
    try {
      const endpoint = kind === "file" ? "file" : "diff";
      const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/${endpoint}?path=${encodeURIComponent(filePath)}${rootId ? `&rootId=${encodeURIComponent(rootId)}` : ""}${kind === "diff" && turn !== undefined ? `&turn=${turn}` : ""}`, { cache: "no-store" });
      const data = await response.json() as { content?: string; diff?: string; error?: string; readOnly?: boolean };
      if (!response.ok) throw new Error(data.error ?? "无法加载预览");
      setPreview({ kind, path: filePath, rootId, readOnly: data.readOnly ?? Boolean(rootId), content: data.content ?? data.diff ?? "" });
    } catch (error) {
      setPreview({ kind, path: filePath, content: "", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function toggleDirectory(directory: string) {
    if (!selected) return;
    if (expandedDirectories.has(directory)) {
      setExpandedDirectories((current) => { const next = new Set(current); next.delete(directory); return next; });
      return;
    }
    if (!tree[directory]) {
      const rootQuery = activeRoot?.kind === "additional" ? `&rootId=${encodeURIComponent(activeRoot.id)}` : "";
      const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/tree?path=${encodeURIComponent(directory)}${rootQuery}`, { cache: "no-store" });
      const data = await response.json() as { entries?: TreeEntry[]; error?: string };
      if (!response.ok) { setNotice(data.error ?? "无法读取目录"); return; }
      setTree((current) => ({ ...current, [directory]: data.entries ?? [] }));
    }
    setExpandedDirectories((current) => new Set(current).add(directory));
  }

  async function savePreview() {
    if (preview?.kind === "local-text" && preview.absolutePath && window.agentDesktop) {
      const error = await window.agentDesktop.writeLocalTextFile(preview.absolutePath, preview.content);
      if (error) setNotice(error); else { setEditing(false); setNotice("文件已保存到本机磁盘。"); if (selected) await loadWorkspace(selected.id, activeRootId); }
      return;
    }
    if (!selected || !preview || preview.kind !== "file" || preview.readOnly) return;
    const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: preview.path, content: preview.content }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) setNotice(data.error ?? "保存文件失败");
    else { setEditing(false); setNotice("文件已保存，变更可在 Git 面板审阅。"); await loadWorkspace(selected.id); }
  }

  async function searchSymbols(event: FormEvent) {
    event.preventDefault(); if (!selected || !symbolQuery.trim()) return;
    const rootQuery = activeRoot?.kind === "additional" ? `&rootId=${encodeURIComponent(activeRoot.id)}` : "";
    const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/symbols?q=${encodeURIComponent(symbolQuery)}${rootQuery}`, { cache: "no-store" });
    const data = await response.json() as { matches?: Array<{ path: string; line: number; preview: string }>; error?: string };
    if (!response.ok) setNotice(data.error ?? "搜索失败"); else setSymbolMatches(data.matches ?? []);
  }

  async function addReviewComment(body: string) {
    if (!selected || !reviewCommentTarget) return;
    setReviewCommentBusy(true);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/review-comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: reviewCommentTarget.filePath, line: reviewCommentTarget.line, side: reviewCommentTarget.side, body }) });
      const data = await response.json() as { comment?: ReviewComment; error?: string };
      if (!response.ok || !data.comment) setNotice(data.error ?? "添加评论失败");
      else { setReviewComments((current) => [...current, data.comment!]); setReviewCommentTarget(null); }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setReviewCommentBusy(false); }
  }

  async function addWorkspaceRoot() {
    if (!selected || !window.agentDesktop) return;
    const selectedPath = await window.agentDesktop.selectWorkspace(); if (!selectedPath) return;
    const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/roots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selectedPath }) });
    const data = await response.json() as { root?: WorkspaceRoot; error?: string };
    if (!response.ok || !data.root) setNotice(data.error ?? "添加工作区根目录失败");
    else setWorkspaceRoots((current) => [...current, data.root!]);
  }

  async function mergeChild(childId: string) {
    if (!selected) return;
    const response = await fetch(`${api}/api/tasks/${selected.id}/children/${childId}/merge`, { method: "POST" });
    const data = await response.json() as { error?: string };
    setNotice(response.ok ? "合并请求已进入审批队列。" : data.error ?? "无法合并子任务");
  }

  async function handoffChildren() {
    if (!selected) return;
    const response = await fetch(`${api}/api/tasks/${selected.id}/handoff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "请汇总已完成子 Agent 的结果，并继续完成父任务。" }) });
    const data = await response.json() as { error?: string };
    setNotice(response.ok ? "子 Agent 结果已交回父任务。" : data.error ?? "Handoff 失败"); await refresh();
  }

  async function decideApproval(id: string, decision: "approved" | "rejected") {
    const response = await fetch(`${api}/api/approvals/${id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) setNotice(data.error ?? "审批失败");
    else { setNotice(decision === "approved" ? "已批准，原步骤将继续执行。" : "已拒绝，结果会反馈给 Agent。"); await refresh(); if (selected) await loadWorkspace(selected.id); }
  }


  function renderTree(directory = "", depth = 0): React.ReactNode {
    return (tree[directory] ?? []).map((entry) => <div key={entry.path}>
      <button className="file-row tree-row" style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => entry.type === "directory" ? void toggleDirectory(entry.path) : void openFileEntry(entry.path)}>
        <span>{entry.type === "directory" ? expandedDirectories.has(entry.path) ? "⌄" : "›" : "·"}</span><code>{entry.name}</code>{entry.gitStatus && <em>{entry.gitStatus}</em>}
      </button>
      {entry.type === "directory" && expandedDirectories.has(entry.path) ? renderTree(entry.path, depth + 1) : null}
    </div>);
  }

  function renderFilesPanel(): React.ReactNode {
    if (localBrowser) return <>
      <div className="local-browser-toolbar">
        <div><span>本机浏览位置</span><code title={localBrowser.path}>{localBrowser.path}</code></div>
        <div className="local-browser-actions">
          <button onClick={() => localBrowser.parent && void browseLocalDirectory(localBrowser.parent)} disabled={!localBrowser.parent}>↑ 上级</button>
          <button onClick={() => void browseLocalDirectory()}>选择目录</button>
          <button onClick={() => void returnToCurrentWorkspace()}>⌂ 当前工作区</button>
          <button className="primary" onClick={() => void setCurrentWorkspace()} disabled={isActive || workspaceSwitching}>{workspaceSwitching ? "正在切换…" : "设为当前工作区"}</button>
        </div>
        {isActive && <small>任务执行或等待期间不能切换 Agent 工作区，但仍可浏览和打开文件。</small>}
      </div>
      <div className="file-list local-file-list">
        {localBrowser.entries.map((entry) => <button className="file-row" key={entry.path} onClick={() => entry.type === "directory" ? void browseLocalDirectory(entry.path) : void openLocalFile(entry.path, entry.name)} title={entry.path}>
          <span>{entry.type === "directory" ? "▸" : "·"}</span><code>{entry.name}</code>
        </button>)}
        {!localBrowser.entries.length && <div className="panel-empty">此目录为空</div>}
      </div>
    </>;
    return <>
      <div className="panel-path">
        <span>当前 Agent 工作区</span>
        {workspaceRoots.length > 1 && <select value={activeRootId ?? ""} onChange={(event) => switchWorkspaceRoot(event.target.value)}>{workspaceRoots.map((root) => <option key={root.id} value={root.id}>{root.label}{root.kind === "additional" ? "（附加）" : "（当前）"}</option>)}</select>}
        <button onClick={() => void openWorkspace()} disabled={!selected?.workspacePath} title={activeRoot?.path}>{activeRoot?.path ?? selected?.workspacePath ?? "未指定工作区"}</button>
      </div>
      <div className="workspace-browser-actions"><button onClick={() => void browseLocalDirectory(activeRoot?.path ?? selected?.workspacePath ?? undefined)}>浏览磁盘</button><button onClick={() => void browseLocalDirectory()}>选择其他目录</button></div>
      <form className="symbol-search" onSubmit={searchSymbols}><input value={symbolQuery} onChange={(event) => setSymbolQuery(event.target.value)} placeholder="搜索符号或文本" /><button>搜索</button></form>
      {symbolMatches.length > 0 && <div className="symbol-results">{symbolMatches.map((match, index) => <button key={`${match.path}:${match.line}:${index}`} onClick={() => void openFileEntry(match.path)}><code>{match.path}:{match.line}</code><span>{match.preview}</span></button>)}</div>}
      <div className="file-list">{tree[""]?.length ? renderTree() : <div className="panel-empty">工作区中暂无可显示的文件</div>}</div>
    </>;
  }

  function renderPreviewContent(): React.ReactNode {
    if (!preview) return null;
    if (preview.loading) return <div className="panel-empty">正在加载…</div>;
    if (preview.error) return <div className="preview-error">{preview.error}</div>;
    if (preview.kind === "pdf" && preview.dataUrl) return <iframe className="document-preview" src={preview.dataUrl} title={preview.path} />;
    if (preview.kind === "image" && preview.dataUrl) return <div className="image-preview"><object data={preview.dataUrl} type="image/*" aria-label={preview.path} /></div>;
    if (preview.kind === "external") return <div className="external-preview"><strong>此文件需要使用本机应用打开</strong><p>{preview.reason}</p>{preview.absolutePath && <button className="primary" onClick={() => void openSystemPath(preview.absolutePath!)}>使用 Windows 默认程序打开</button>}</div>;
    if (editing && (preview.kind === "file" || preview.kind === "local-text")) return <textarea className="code-editor" value={preview.content} onChange={(event) => setPreview({ ...preview, content: event.target.value })} spellCheck={false} />;
    return <pre className={`code-preview ${preview.kind}`}>{preview.content.split("\n").map((line, index) => { const side = line.startsWith("-") ? "old" : "new"; const comments = reviewComments.filter((comment) => comment.path === preview.path && comment.line === index + 1 && !comment.resolvedAt); return <span className={preview.kind === "diff" ? line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "" : ""} key={index} onDoubleClick={() => { if (preview.kind === "diff") setReviewCommentTarget({ filePath: preview.path, line: index + 1, side }); }} title={preview.kind === "diff" ? "双击添加行级审阅意见" : undefined}><i>{index + 1}</i><code>{line || " "}</code>{comments.map((comment) => <em className="line-comment" key={comment.id}>{comment.body}</em>)}</span>; })}</pre>;
  }

  function beginPanelResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStart.current = { side, x: event.clientX, width: side === "left" ? leftPanelWidth : rightPanelWidth };
    setResizingPanel(side);
  }

  function resetPanelWidth(side: "left" | "right") {
    if (side === "left") setLeftPanelWidth(defaultLeftPanelWidth); else setRightPanelWidth(defaultRightPanelWidth);
  }

  async function createTask(event?: FormEvent) {
    event?.preventDefault();
    if (!form.prompt.trim() && !draftAttachments.length) return;
    setBusy(true); setNotice(null);
    try {
      const explicitPrompt = form.prompt.trim();
      const prompt = explicitPrompt || "请查看我发送的图片或附件。";
      const title = form.title.trim() || explicitPrompt.split(/\r?\n/)[0]?.slice(0, 60) || "图片任务";
      const defaultModel = config?.providers.find((provider) => provider.id === form.provider)?.defaultModel;
      const response = await fetch(`${api}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, prompt, runtime: form.runtime, provider: form.provider, model: form.model || defaultModel, reasoningEffort: form.reasoningEffort, sandboxMode: form.sandboxMode, approvalPolicy: form.approvalPolicy, approvalsReviewer: form.approvalsReviewer, workspacePath: form.workspacePath || undefined, waitSeconds: form.durableWait ? 8 : 0, goalMode: form.goalMode, goalObjective: form.goalMode ? prompt : undefined, goalMaxTurns: form.goalMode ? form.goalMaxTurns : undefined, goalDeadlineHours: form.goalMode && form.goalDeadlineHours > 0 ? form.goalDeadlineHours : undefined, goalTokenBudget: form.goalMode && form.goalTokenBudget > 0 ? form.goalTokenBudget : undefined, attachments: draftAttachments }) });
      const data = await response.json() as { task?: Task; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "创建任务失败");
      draftReturnTaskId.current = null; draftTouched.current = false; setShowArchived(false); setSelectedId(data.task.id); setComposerOpen(false); void window.agentDesktop?.saveNewTaskDraft?.(null).catch(() => undefined); resetDraftContent(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function sendFollowUp(event?: FormEvent) {
    event?.preventDefault();
    if (!selected || (!followUp.trim() && (!followUpAttachments.length || isActive))) return;
    setBusy(true); setNotice(null);
    try {
      const content = followUp.trim() || "请查看我发送的图片或附件。";
      const response = await fetch(`${api}/api/tasks/${selected.id}/${isActive ? "steer" : "messages"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, attachments: isActive ? undefined : followUpAttachments, ...(isActive ? {} : { ...turnSettings, model: turnSettings.model.trim() || null }) }) });
      const data = await response.json() as { error?: string; task?: Task; messages?: ConversationMessage[]; memory?: ConversationMemory };
      if (!response.ok || !data.task) throw new Error(data.error ?? "发送消息失败");
      setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task));
      if (data.messages) setMessages(data.messages);
      if (data.memory) setMemory(data.memory);
      followUpValueSnapshot.current = ""; followUpAttachmentsSnapshot.current = []; followUpDraftTouched.current = false;
      sessionFollowUpDrafts.current.delete(selected.id);
      void window.agentDesktop?.saveFollowUpDraft?.(selected.id, null).catch(() => undefined);
      setFollowUp(""); setFollowUpAttachments([]);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function editLastMessage() {
    if (!selected || editingLastMessage) return;
    setEditingLastMessage(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/messages/last/retract`, { method: "POST" });
      const data = await response.json() as { error?: string; task?: Task; message?: ConversationMessage; messages?: ConversationMessage[]; events?: TaskEvent[]; memory?: ConversationMemory; threadContext?: "rolled_back" | "detached" | "not_needed" };
      if (!response.ok || !data.task || !data.message) throw new Error(data.error ?? "无法撤回上一条消息");
      setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task));
      setMessages(data.messages ?? []); setEvents(data.events ?? []); setMemory(data.memory ?? null);
      followUpDraftTouched.current = true;
      setFollowUp(editableMessageContent(data.message.content)); setFollowUpAttachments([]);
      setNotice(data.threadContext === "detached"
        ? "上一条消息已撤回。当前模型不支持线程回退，将从本地对话记忆继续；附件需要重新添加。"
        : "上一条消息已撤回并放回输入框；修改后重新发送即可。文件修改不会自动撤销，附件需要重新添加。");
      window.setTimeout(() => {
        followUpInput.current?.focus();
        followUpInput.current?.setSelectionRange(followUpInput.current.value.length, followUpInput.current.value.length);
      }, 0);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setEditingLastMessage(false); }
  }

  async function saveTurnSettings() {
    if (!selected || isActive) return;
    const response = await fetch(`${api}/api/tasks/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...turnSettings, model: turnSettings.model.trim() || null }) });
    const data = await response.json() as { task?: Task; error?: string };
    if (!response.ok || !data.task) { setNotice(data.error ?? "运行配置保存失败"); return; }
    setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task)); setNotice("模型、推理深度和权限已保存，将从下一轮生效。");
  }

  async function goalAction(action: "pause" | "resume" | "complete") {
    if (!selected) return;
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/goal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, additionalTurns: action === "resume" && selected.goalStatus === "limit_reached" ? 3 : undefined, additionalHours: action === "resume" && selected.goalStatus === "deadline_reached" ? 4 : undefined, additionalTokens: action === "resume" && selected.goalStatus === "budget_reached" ? 100_000 : undefined }) });
      const data = await response.json() as { task?: Task; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "持续目标操作失败");
      setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task));
      setNotice(action === "pause" ? "持续目标会在当前轮结束后暂停。" : action === "complete" ? "持续目标已结束。" : "持续目标已恢复并进入队列。");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function runSlashCommand(name: SlashCommandName) {
    if (composerOpen) setForm((current) => ({ ...current, prompt: "" })); else { followUpDraftTouched.current = true; setFollowUp(""); }
    setSlashSelection(0);
    if (name === "automations") { setAutomationOpen(true); setGoalsOpen(false); setComposerOpen(false); return; }
    if (name === "goals") { setGoalsOpen(true); setAutomationOpen(false); setComposerOpen(false); return; }
    if (name === "status") { setContextOpen(true); setContextTab("details"); return; }
    if (name === "files") { setPreview(null); setContextOpen(true); setContextTab("files"); return; }
    if (name === "changes") { setPreview(null); setContextOpen(true); setContextTab("changes"); return; }
    if (name === "terminal") { setPreview(null); setContextOpen(true); setContextTab("terminal"); return; }
    if (name === "model") { window.setTimeout(() => modelSelect.current?.focus(), 0); return; }
    if (name === "reasoning") { window.setTimeout(() => reasoningSelect.current?.focus(), 0); return; }
    if (name === "compact") { void codexAction("compact"); return; }
    if (name === "fork") { void codexAction("fork"); return; }
    if (name === "review") { void startReview(); return; }
    if (name === "delegate") { setChildError(null); setChildOpen(true); return; }
    if (name === "stop") { void stopTask(); return; }
    if (name === "new") { openNewConversation(); return; }
    if (name === "settings") { void openSettings(); return; }
    if (name === "feedback") void prepareFeedbackBundle();
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashCommands.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashSelection((current) => (current + 1) % slashCommands.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashSelection((current) => (current - 1 + slashCommands.length) % slashCommands.length); return; }
      if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && !event.nativeEvent.isComposing) {
        event.preventDefault(); runSlashCommand(slashCommands[Math.min(slashSelection, slashCommands.length - 1)].name); return;
      }
      if (event.key === "Escape") { event.preventDefault(); followUpDraftTouched.current = true; setFollowUp(""); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void sendFollowUp();
    }
  }

  function draftComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (draftSlashCommands.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashSelection((current) => (current + 1) % draftSlashCommands.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashSelection((current) => (current - 1 + draftSlashCommands.length) % draftSlashCommands.length); return; }
      if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && !event.nativeEvent.isComposing) {
        event.preventDefault(); runSlashCommand(draftSlashCommands[Math.min(slashSelection, draftSlashCommands.length - 1)].name); return;
      }
      if (event.key === "Escape") { event.preventDefault(); setForm((current) => ({ ...current, prompt: "" })); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void createTask();
    }
  }

  async function prepareFeedbackBundle() {
    if (!window.agentDesktop?.prepareFeedbackBundle) { setNotice("问题反馈资料仅在桌面版中可用。"); return; }
    setBusy(true); setNotice(null);
    try {
      const result = await window.agentDesktop.prepareFeedbackBundle();
      setNotice(`已生成 ${result.taskCount} 个对话的脱敏反馈资料，并已打开文件夹。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function backupConversationData() {
    setBackupBusy(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/platform/backup`, { method: "POST" });
      const data = await response.json() as { error?: string; backup?: { directory: string; path: string; bytes: number; createdAt: string; integrity: string } };
      if (!response.ok || !data.backup) throw new Error(data.error ?? "备份失败");
      const settingsResponse = await fetch(`${api}/api/settings`, { cache: "no-store" });
      if (settingsResponse.ok) setDataSummary((await settingsResponse.json() as { data: DataSummary }).data);
      const openError = window.agentDesktop ? await window.agentDesktop.openPath(data.backup.directory) : null;
      setNotice(openError ? `备份已完成，但无法打开目录：${openError}` : `数据库备份已完成并校验通过：${byteCountLabel(data.backup.bytes)}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBackupBusy(false); }
  }

  async function checkDesktopUpdates() {
    if (!window.agentDesktop?.checkForUpdates) { setNotice("检查更新仅在桌面版中可用。"); return; }
    setUpdateChecking(true); setNotice(null);
    try {
      const result = await window.agentDesktop.checkForUpdates();
      if (result.status === "current") setNotice(`当前已是最新版 ${result.currentVersion}。`);
      else if (result.status === "available") setNotice(`发现版本 ${result.availableVersion}，本次选择了稍后更新。`);
      else if (result.status === "downloading") setNotice(`版本 ${result.availableVersion} 正在下载，完成后会提示重启安装。`);
      else if (result.status === "development") setNotice("当前是开发模式，不执行自动更新。");
      else if (result.status === "credentials_required") setNotice("请先在应用更新区域保存对此私有仓库具有只读访问权限的 GitHub 令牌。");
      else setNotice(result.error ?? "检查更新失败，可从 GitHub Release 手动下载。");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setUpdateChecking(false); }
  }

  async function saveUpdateAccessToken(remove = false) {
    if (!window.agentDesktop?.saveUpdateAccessToken) { setNotice("更新权限仅在桌面版中可配置。"); return; }
    if (!remove && !updateToken.trim()) { setNotice("请输入 GitHub 更新令牌。"); return; }
    setUpdateTokenBusy(true); setNotice(null);
    try {
      const status = await window.agentDesktop.saveUpdateAccessToken(remove ? null : updateToken);
      setUpdateAccess(status); setUpdateToken("");
      setNotice(remove ? (status.configured ? "已删除本机令牌；当前仍由环境变量提供更新权限。" : "已删除本机加密的 GitHub 更新令牌。") : "GitHub 更新令牌已使用 Windows 本机加密保存。");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setUpdateTokenBusy(false); }
  }

  async function updateTask(patch: { title?: string; archived?: boolean; pinned?: boolean; section?: string | null }) {
    if (!selected) return;
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await response.json() as { task?: Task; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "更新任务失败");
      setRenaming(false);
      if (patch.archived !== undefined) setNotice(patch.archived ? "任务已归档；底层 Codex 状态将在后台同步。" : "任务已恢复；底层 Codex 状态将在后台同步。");
      else setNotice(patch.title !== undefined ? "任务名称已更新。" : patch.pinned !== undefined ? "置顶状态已更新。" : "任务已更新。");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function selectTurnModel(value: string) {
    const choice = modelChoices.find((item) => `${item.provider}:${item.model}` === value);
    if (!choice) return;
    const effort = choice.supportedReasoningEfforts.length && !choice.supportedReasoningEfforts.includes(turnSettings.reasoningEffort) ? choice.supportedReasoningEfforts[0] : turnSettings.reasoningEffort;
    setTurnSettings({ ...turnSettings, provider: choice.provider, model: choice.model, reasoningEffort: effort });
  }

  function selectCreateModel(value: string) {
    const choice = modelChoices.find((item) => `${item.provider}:${item.model}` === value);
    if (!choice) return;
    const effort = choice.supportedReasoningEfforts.length && !choice.supportedReasoningEfforts.includes(form.reasoningEffort) ? choice.supportedReasoningEfforts[0] : form.reasoningEffort;
    setForm({ ...form, provider: choice.provider, model: choice.model, reasoningEffort: effort });
  }

  async function taskAction(kind: "cancel" | "retry") {
    if (!selected) return;
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/${kind}`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "操作失败");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function stopTask() {
    if (!selected || !isActive || stopping) return;
    setStopping(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/cancel`, { method: "POST" });
      const data = await response.json() as { error?: string; task?: Task };
      if (!response.ok || !data.task) throw new Error(data.error ?? "停止任务失败");
      setTasks((current) => current.map((task) => task.id === data.task!.id ? data.task! : task));
      setNotice("已停止当前模型执行。你可以修改消息后重新发送，工作区中已经产生的文件修改会保留。");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setStopping(false); }
  }

  async function openSettings() {
    setSettingsOpen(true); setNotice(null);
    if (window.agentDesktop?.getAppInfo) {
      void window.agentDesktop.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
    }
    if (window.agentDesktop?.getUpdateAccessStatus) {
      void window.agentDesktop.getUpdateAccessStatus().then(setUpdateAccess).catch(() => setUpdateAccess(null));
    }
    try {
      const [settingsResponse, statusResponse, auditResponse] = await Promise.all([
        fetch(`${api}/api/settings`, { cache: "no-store" }),
        fetch(`${api}/api/platform/status`, { cache: "no-store" }),
        fetch(`${api}/api/audit`, { cache: "no-store" }),
      ]);
      if (settingsResponse.ok) {
        const payload = await settingsResponse.json() as { settings: PlatformSettings; data: DataSummary };
        setSettings(payload.settings); setDataSummary(payload.data);
      }
      if (statusResponse.ok) setPlatformStatus(await statusResponse.json() as PlatformStatus);
      if (auditResponse.ok) setAuditEntries((await auditResponse.json() as { entries: Array<Record<string, unknown>> }).entries);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function deleteArchivedTask() {
    if (!selected?.archivedAt || busy) return;
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string; deleted?: { title: string; artifactBytes: number } };
      if (!response.ok || !data.deleted) throw new Error(data.error ?? "永久删除失败");
      const removedId = selected.id;
      sessionFollowUpDrafts.current.delete(removedId);
      followUpDraftReady.current = false;
      void window.agentDesktop?.saveFollowUpDraft?.(removedId, null).catch(() => undefined);
      setTasks((current) => current.filter((task) => task.id !== removedId));
      setSelectedId(null);
      if (detachedMode) window.close();
      else { setDeleteTaskConfirmOpen(false); setNotice(`已永久删除“${data.deleted.title}”，工作区文件未受影响。`); await refresh(); }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    const response = await fetch(`${api}/api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    const data = await response.json() as { error?: string; settings?: PlatformSettings };
    if (!response.ok) { setNotice(data.error ?? "保存设置失败"); return; }
    setSettings(data.settings ?? settings); setSettingsOpen(false); await Promise.all([refresh(), loadModels()]);
  }

  async function replayDeadLetter(id: string) {
    const response = await fetch(`${api}/api/dead-letters/${id}/replay`, { method: "POST" });
    const data = await response.json() as { error?: string };
    setNotice(response.ok ? "死信任务已重新进入队列。" : data.error ?? "死信重放失败");
    if (response.ok) { const status = await fetch(`${api}/api/platform/status`, { cache: "no-store" }); if (status.ok) setPlatformStatus(await status.json() as PlatformStatus); await refresh(); }
  }

  async function saveProviderSecret(provider: string, remove = false) {
    const apiKey = providerSecrets[provider]?.trim();
    if (!apiKey && !remove) return;
    const response = await fetch(`${api}/api/providers/${provider}/secret`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: remove ? null : apiKey }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setNotice(data.error ?? "保存 API key 失败"); return; }
    setProviderSecrets((current) => ({ ...current, [provider]: "" })); setNotice(remove ? "已删除加密 API key（agent.env 中的 key 如存在仍会生效）。" : "API key 已使用 Windows DPAPI 加密保存。"); await Promise.all([refresh(), loadModels()]);
  }

  async function submitChild(): Promise<boolean> {
    if (!selected || !childForm.prompt.trim()) return false;
    setChildBusy(true); setChildError(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/children`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childForm) });
      const data = await response.json() as { task?: Task; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "创建子 Agent 失败");
      setChildOpen(false); setChildForm({ title: "子 Agent 任务", prompt: "", isolation: "worktree" }); setNotice(`已委派子 Agent：${data.task.title}`); await refresh();
      return true;
    } catch (error) { setChildError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setChildBusy(false); }
  }

  async function createChild(event: FormEvent) { event.preventDefault(); await submitChild(); }

  async function initializeGitAndRetry() {
    if (!selected) return;
    setChildBusy(true); setChildError(null);
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/workspace/git/initialize`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Git 初始化失败");
    } catch (error) {
      setChildError(error instanceof Error ? error.message : String(error)); setChildBusy(false); return;
    }
    setChildBusy(false);
    await submitChild();
  }

  async function codexAction(kind: "fork" | "compact") {
    if (!selected) return;
    if (kind === "compact") {
      const usageEvent = [...events].reverse().find((event) => event.type === "agent.turn.usage");
      setCompactionState({ phase: "running", before: usagePercent(usageEvent?.payload.usage) });
    }
    try {
      const response = await fetch(`${api}/api/tasks/${selected.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json() as { task?: Task; error?: string; before?: unknown; after?: unknown };
      if (!response.ok) throw new Error(data.error ?? `${kind} 失败`);
      if (data.task) {
        if (detachedMode && kind === "fork") void popOutConversation(data.task.id);
        else setSelectedId(data.task.id);
      }
      if (kind === "compact") setCompactionState({ phase: "completed", before: usagePercent(data.before), after: usagePercent(data.after) });
      else setNotice("已创建对话分支。");
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (kind === "compact") setCompactionState((current) => ({ ...current, phase: "failed", error: message })); else setNotice(message);
    }
  }

  async function startReview() {
    if (!selected) return;
    setBusy(true); setNotice("Codex 正在审阅未提交变更…");
    const response = await fetch(`${api}/api/tasks/${selected.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await response.json() as { error?: string; result?: { summary?: string } };
    setNotice(response.ok ? data.result?.summary ? `Codex 审阅完成：${data.result.summary}` : "Codex 审阅完成。" : data.error ?? "启动审阅失败");
    setBusy(false); await refresh();
  }

  function startConversationDrag(event: ReactDragEvent<HTMLButtonElement>, task: Task): void {
    setDraggingTaskId(task.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-agent-foundry-conversation", task.id);
    event.dataTransfer.setData("text/plain", task.title);
  }

  async function finishConversationDrag(event: ReactDragEvent<HTMLButtonElement>, task: Task): Promise<void> {
    const point = { x: event.screenX, y: event.screenY };
    setDraggingTaskId(null);
    if (!window.agentDesktop?.detachConversation) return;
    try {
      await window.agentDesktop.detachConversation(task.id, point, false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function popOutConversation(taskId: string): Promise<void> {
    if (!window.agentDesktop?.detachConversation) { setNotice("独立对话窗口仅在 Agent Foundry 桌面版中可用。"); return; }
    try {
      const result = await window.agentDesktop.detachConversation(taskId, undefined, true);
      setNotice(result.existing ? "这个对话已经在独立窗口中，已为你切换过去。" : "对话已弹出；两个窗口可以同时处理不同任务。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function reattachConversation(taskId: string): Promise<void> {
    if (!window.agentDesktop?.reattachConversation) return;
    try {
      await window.agentDesktop.reattachConversation(taskId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function openAutomationTask(taskId: string) {
    try {
      taskListRequestSequence.current += 1;
      const response = await fetch(`${api}/api/tasks/${taskId}`, { cache: "no-store" });
      const data = await response.json() as { task?: Task; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "任务不存在");
      setTasks((current) => [data.task!, ...current.filter((task) => task.id !== taskId)]);
      setSearch(""); setTaskFilters(emptyTaskFilters); setTaskListLimit(100);
      setAutomationOpen(false); setGoalsOpen(false); setComposerOpen(false); setShowArchived(false); setActivityOnly(false); setSelectedId(taskId);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function openCommandTask(taskId: string) {
    setCommandOpen(false);
    setCommandQuery("");
    markTaskRead(taskId);
    await openAutomationTask(taskId);
  }

  const commandActions: Array<{ key: string; label: string; keywords: string; shortcut?: string; disabled?: boolean; run: () => void }> = [];
  if (!detachedMode) {
    commandActions.push(
      { key: "new", label: "新建对话", keywords: "new task conversation", shortcut: "Ctrl N", run: () => { setCommandOpen(false); openNewConversation(); } },
      { key: "automations", label: "自动化任务", keywords: "automation schedule", run: () => { setCommandOpen(false); setAutomationOpen(true); setGoalsOpen(false); setComposerOpen(false); } },
      { key: "goals", label: "持续目标看板", keywords: "goal progress", run: () => { setCommandOpen(false); setGoalsOpen(true); setAutomationOpen(false); setComposerOpen(false); } },
      { key: "activity", label: "查看任务活动", keywords: "activity unread active", shortcut: "Ctrl Alt U", run: () => { setCommandOpen(false); setAutomationOpen(false); setGoalsOpen(false); setShowArchived(false); setActivityOnly(true); } },
    );
  }
  commandActions.push(
    { key: "terminal", label: "打开交互终端", keywords: "terminal shell", shortcut: "Ctrl `", disabled: !selected, run: () => { setCommandOpen(false); setContextOpen(true); setContextTab("terminal"); } },
    { key: "workspace", label: "在资源管理器中打开工作区", keywords: "workspace explorer folder", disabled: !selected?.workspacePath, run: () => { setCommandOpen(false); void openWorkspace(); } },
  );
  if (detachedMode && selected) commandActions.push({ key: "reattach", label: "放回主窗口", keywords: "reattach main window", run: () => { setCommandOpen(false); void reattachConversation(selected.id); } });
  commandActions.push({ key: "settings", label: "平台设置与诊断", keywords: "settings diagnostics config", run: () => { setCommandOpen(false); void openSettings(); } });
  const normalizedCommandQuery = commandQuery.trim().toLocaleLowerCase();
  const visibleCommandActions = commandActions.filter((action) => !normalizedCommandQuery || `${action.label} ${action.keywords}`.toLocaleLowerCase().includes(normalizedCommandQuery));
  const commandEntries = [
    ...visibleCommandActions.map((action) => ({ ...action, kind: "action" as const, meta: action.shortcut ?? "" })),
    ...(!detachedMode ? commandTasks.map((task) => ({ key: `task:${task.id}`, label: task.title, keywords: "", kind: "task" as const, meta: `${workspaceName(task.projectWorkspacePath ?? task.workspacePath)} · ${statusLabels[task.status]}`, disabled: false, run: () => { void openCommandTask(task.id); } })) : []),
  ];

  const shellStyle = { "--left-panel-width": `${leftPanelWidth}px`, "--right-panel-width": `${rightPanelWidth}px` } as CSSProperties;
  return <main className={`app-shell ${detachedMode ? "detached" : ""} ${selected && !composerOpen && !automationOpen && !goalsOpen && contextOpen ? "with-context" : ""} ${resizingPanel ? "is-resizing" : ""}`} style={shellStyle}>
    {notice && !selected && !composerOpen && <div className="global-notice">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
    {!detachedMode && <><aside className="sidebar">
      <div className="sidebar-top">
        <div className="product"><span className="product-mark">A</span><strong>Agent Foundry</strong></div>
        <button className="icon-button" title="新建对话" onClick={openNewConversation}>＋</button>
      </div>
      <button className="new-task-button" onClick={openNewConversation}><span>＋</span> 新建对话 <kbd>Ctrl N</kbd></button>
      <button className={`automation-nav-button ${automationOpen ? "active" : ""}`} onClick={() => { setAutomationOpen(true); setGoalsOpen(false); setComposerOpen(false); setNotice(null); }}>◷ <span>自动化</span><small>按计划运行</small></button>
      <button className={`automation-nav-button goal-nav-button ${goalsOpen ? "active" : ""}`} onClick={() => { setGoalsOpen(true); setAutomationOpen(false); setComposerOpen(false); setNotice(null); }}>◎ <span>持续目标</span><small>进度与预算</small></button>
      <div className="search-filter-row"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setTaskListLimit(100); }} placeholder="搜索全部任务" /></label><button type="button" className={`task-filter-toggle ${taskFiltersOpen || activeTaskFilterCount ? "active" : ""}`} aria-expanded={taskFiltersOpen} aria-label="按状态、模型和项目筛选任务" onClick={() => setTaskFiltersOpen((current) => !current)}>≡{activeTaskFilterCount > 0 && <i>{activeTaskFilterCount}</i>}</button></div>
      <div className="sidebar-filter">
        <button className={!showArchived && !activityOnly && !automationOpen && !goalsOpen ? "active" : ""} onClick={() => { setAutomationOpen(false); setGoalsOpen(false); setShowArchived(false); setActivityOnly(false); setTaskListLimit(100); }}>任务</button>
        <button className={!showArchived && activityOnly && !automationOpen && !goalsOpen ? "active" : ""} onClick={() => { setAutomationOpen(false); setGoalsOpen(false); setShowArchived(false); setActivityOnly(true); setTaskListLimit(100); }}>活动{unreadTaskIds.size > 0 && <span className="filter-badge">{unreadTaskIds.size}</span>}</button>
        <button className={showArchived && !automationOpen && !goalsOpen ? "active" : ""} onClick={() => { setAutomationOpen(false); setGoalsOpen(false); setShowArchived(true); setActivityOnly(false); setTaskFilters(emptyTaskFilters); setTaskListLimit(100); }}>已归档</button>
      </div>
      {taskFiltersOpen && <div className="task-filter-panel">
        <label><span>状态</span><select value={taskFilters.status} onChange={(event) => { setTaskFilters((current) => ({ ...current, status: event.target.value as TaskStatusGroup })); setTaskListLimit(100); }}><option value="all">全部状态</option><option value="active">进行中 · {taskFacets.statuses.active}</option><option value="waiting">等待中 · {taskFacets.statuses.waiting}</option><option value="completed">已完成 · {taskFacets.statuses.completed}</option><option value="stopped">失败/已取消 · {taskFacets.statuses.stopped}</option></select></label>
        <label><span>供应商</span><select value={taskFilters.provider} onChange={(event) => { setTaskFilters((current) => ({ ...current, provider: event.target.value })); setTaskListLimit(100); }}><option value="">全部供应商</option>{taskFacets.providers.map((facet) => <option key={facet.value} value={facet.value}>{facet.label} · {facet.count}</option>)}</select></label>
        <label><span>模型</span><select value={taskFilters.model} onChange={(event) => { setTaskFilters((current) => ({ ...current, model: event.target.value })); setTaskListLimit(100); }}><option value="">全部模型</option>{taskFacets.models.map((facet) => <option key={facet.value} value={facet.value}>{facet.label} · {facet.count}</option>)}</select></label>
        <label><span>项目</span><select value={taskFilters.project} onChange={(event) => { setTaskFilters((current) => ({ ...current, project: event.target.value })); setTaskListLimit(100); }}><option value="">全部项目</option>{taskFacets.projects.map((facet) => <option key={facet.value.toLocaleLowerCase()} value={facet.value} title={facet.label}>{facet.value.startsWith("section:") ? facet.label : workspaceName(facet.label || null)} · {facet.count}</option>)}</select></label>
        <footer><span>{activeTaskFilterCount ? `已启用 ${activeTaskFilterCount} 项筛选` : "筛选整个本地任务库"}</span><button type="button" disabled={!activeTaskFilterCount} onClick={() => { setTaskFilters(emptyTaskFilters); setTaskListLimit(100); }}>清除</button></footer>
      </div>}
      <p className="history-note">{activeTaskFilterCount ? `正在数据库全量筛选；命中 ${taskListTotal} 个对话。` : activityOnly ? "活动视图显示运行中、等待处理和未读结果；打开任务即标为已读。" : "对话上下文彼此独立；把任一对话拖到窗口外，可弹出并同时处理。"}</p>
      <div className="thread-list">
        {taskGroups.length === 0 && <div className="sidebar-empty">{search ? "没有匹配的任务" : showArchived ? "暂无已归档任务" : activityOnly ? "暂时没有需要关注的任务" : "还没有任务"}</div>}
        {taskGroups.map((group) => { const collapsed = collapsedProjectKeys.has(group.key) && !search.trim(); return <section className="project-group" key={group.key}>
          <button className={`project-name ${collapsed ? "collapsed" : ""}`} type="button" title={group.path ?? group.label} aria-expanded={!collapsed} onClick={() => setCollapsedProjectKeys((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><span>⌄</span><strong>{group.label}</strong><small>{group.tasks.length}</small></button>
          {!collapsed && group.tasks.map((task) => <button draggable className={`thread-row ${selectedId === task.id && !automationOpen && !goalsOpen ? "selected" : ""} ${draggingTaskId === task.id ? "dragging" : ""} ${unreadTaskIds.has(task.id) ? "unread" : ""}`} key={task.id} title="拖到主窗口外，弹出为独立对话窗口" onDragStart={(event) => startConversationDrag(event, task)} onDragEnd={(event) => void finishConversationDrag(event, task)} onClick={() => { markTaskRead(task.id); setAutomationOpen(false); setGoalsOpen(false); setComposerOpen(false); draftReturnTaskId.current = null; setEvents([]); setEventTotal(0); setMessages([]); setTurnTotal(0); setMemory(null); setWorkspace({ path: null, files: [], changes: [] }); setTree({}); setExpandedDirectories(new Set()); setApprovals([]); setPreview(null); setSelectedId(task.id); }}>
            <span className={`task-status ${task.status}`} />
            <span className="thread-copy"><strong>{task.title}{unreadTaskIds.has(task.id) && <i>新</i>}</strong><small>{statusLabels[task.status]} · {shortTime(task.updatedAt ?? task.createdAt)}</small></span>
          </button>)}
        </section>; })}
        {taskListLoaded < taskListTotal && <button type="button" className="load-more-tasks" onClick={() => setTaskListLimit((current) => Math.min(current + 100, 1_000))}>再显示 {Math.min(100, taskListTotal - taskListLoaded)} 个对话 <small>{taskListLoaded} / {taskListTotal}</small></button>}
      </div>
      <button className="settings-button" onClick={() => void openSettings()}>⚙ 设置与运行时</button>
      <div className="sidebar-bottom"><span className={`health-indicator ${health}`} /><div><strong>{health === "online" ? "本地服务已连接" : health === "offline" ? "本地服务未连接" : "正在连接"}</strong><small>{config?.sandbox.enabled ? "Docker" : config?.workspace.label ?? "检测中"}</small></div></div>
    </aside>
    <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧任务栏宽度" aria-orientation="vertical" title="拖拽调整左侧栏宽度；双击恢复默认" onPointerDown={(event) => beginPanelResize("left", event)} onDoubleClick={() => resetPanelWidth("left")} /></>}

    <section className="conversation-pane">
      {goalsOpen && !detachedMode ? <Suspense fallback={<div className="panel-loading">正在打开持续目标…</div>}><GoalsPanel api={api} onOpenTask={(taskId) => void openAutomationTask(taskId)} onClose={() => setGoalsOpen(false)} /></Suspense> : automationOpen && !detachedMode ? <Suspense fallback={<div className="panel-loading">正在打开自动化任务…</div>}><AutomationsPanel api={api} modelChoices={modelChoices} onOpenTask={(taskId) => void openAutomationTask(taskId)} onClose={() => setAutomationOpen(false)} /></Suspense> : composerOpen ? <>
        <header className="conversation-header draft-conversation-header">
          <div className="title-area"><span className="draft-title">新对话</span><div className="header-meta"><span className="status-dot queued" />{hasDraftContent ? draftProtection === "encrypted" ? "加密草稿 · 已自动保存在本机" : "临时草稿 · 本次应用会话内已保留" : "临时草稿 · 发送后才会保存为任务"}</div></div>
          <div className="header-actions">{hasDraftContent && <button onClick={hideDraftConversation}>稍后继续</button>}<button onClick={discardDraftConversation}>丢弃草稿</button></div>
        </header>
        <div className="conversation-scroll draft-scroll"><div className="draft-welcome"><div className="empty-logo">A</div><h1>交给 Agent 一项工作</h1><p>这里暂时不会出现在任务列表中。输入内容并发送后，才会创建正式任务。</p>{notice && <div className="notice">{notice}<button onClick={() => setNotice(null)}>×</button></div>}</div></div>
        <div className="composer-dock draft-composer-dock">
          <form className={`message-composer draft-message-composer ${attachmentDragActive ? "dragging-file" : ""}`} onSubmit={createTask} onChangeCapture={() => { draftTouched.current = true; }} onPointerDown={() => { draftTouched.current = true; }} onDragEnter={(event) => attachmentDragEnter(event)} onDragOver={(event) => attachmentDragEnter(event)} onDragLeave={attachmentDragLeave} onDrop={(event) => attachmentDrop(event, true, "new")}>
            {attachmentDragActive && <div className="attachment-drop-hint"><strong>释放即可添加</strong><span>支持图片和其他本机文件</span></div>}
            {draftSlashCommands.length > 0 && <div className="slash-command-menu" role="listbox" aria-label="快捷命令">
              <header><strong>快捷命令</strong><span>↑↓ 选择 · Enter 执行 · Esc 关闭</span></header>
              {draftSlashCommands.slice(0, 8).map((command, index) => <button type="button" role="option" aria-selected={index === slashSelection} className={index === slashSelection ? "active" : ""} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => runSlashCommand(command.name)}>
                <code>/{command.name}</code><span><strong>{command.label}</strong><small>{command.description}</small></span>
              </button>)}
            </div>}
            <textarea autoFocus value={form.prompt} onChange={(event) => { setForm({ ...form, prompt: event.target.value }); setSlashSelection(0); }} onPaste={(event) => pasteImage(event, true, "new")} onKeyDown={draftComposerKeyDown} placeholder="输入消息，或粘贴 / 拖入图片…" rows={3} />
            <AttachmentTray files={draftAttachments} previews={attachmentPreviews} onRemove={(filePath) => removeAttachment(filePath, "new")} />
            <div className="composer-runtime-bar"><label>模型<select ref={modelSelect} value={form.model ? `${form.provider}:${form.model}` : ""} onChange={(event) => selectCreateModel(event.target.value)} disabled={modelsLoading || form.runtime === "mock"}><option value="" disabled>{modelsLoading ? "正在搜索已配置模型…" : "请选择模型"}</option>{modelChoices.map((choice) => <option key={`${choice.provider}:${choice.model}`} value={`${choice.provider}:${choice.model}`}>{choice.providerLabel} · {choice.displayName}</option>)}</select></label><label>运行<select value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value })}><option value="codex">Codex</option><option value="mock">Mock 演示</option></select></label><label>推理<select ref={reasoningSelect} value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as ReasoningEffort })}><option value="minimal">最少</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="ultra">Ultra</option></select></label><label>沙箱<select value={form.sandboxMode} onChange={(event) => setForm({ ...form, sandboxMode: event.target.value as SandboxMode })}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">完全访问</option></select></label><label>审批<select value={form.approvalPolicy} onChange={(event) => setForm({ ...form, approvalPolicy: event.target.value as ApprovalPolicy })}><option value="untrusted">非可信操作询问</option><option value="on-request">请求批准</option><option value="never">无需批准</option></select></label><label>批准人<select value={form.approvalsReviewer} onChange={(event) => setForm({ ...form, approvalsReviewer: event.target.value as ApprovalsReviewer })}><option value="user">我批准</option><option value="auto_review">帮我批准</option></select></label><label className="goal-mode-control"><span>持续目标</span><input type="checkbox" checked={form.goalMode} onChange={(event) => setForm({ ...form, goalMode: event.target.checked })} /></label>{form.goalMode && <><label><span>最多轮次</span><select value={form.goalMaxTurns} onChange={(event) => setForm({ ...form, goalMaxTurns: Number(event.target.value) })}><option value="3">3 轮</option><option value="5">5 轮</option><option value="8">8 轮</option><option value="12">12 轮</option><option value="20">20 轮</option></select></label><label><span>截止时间</span><select value={form.goalDeadlineHours} onChange={(event) => setForm({ ...form, goalDeadlineHours: Number(event.target.value) })}><option value="0">不限制</option><option value="1">1 小时后</option><option value="4">4 小时后</option><option value="12">12 小时后</option><option value="24">24 小时后</option><option value="72">3 天后</option></select></label><label><span>Token 预算</span><select value={form.goalTokenBudget} onChange={(event) => setForm({ ...form, goalTokenBudget: Number(event.target.value) })}><option value="0">不限制</option><option value="50000">50K</option><option value="100000">100K</option><option value="250000">250K</option><option value="500000">500K</option><option value="1000000">1M</option></select></label></>}</div>
            <div className="composer-toolbar"><div><button type="button" className="composer-icon" title="添加附件或拖入文件" onClick={() => void chooseAttachments("new")}>＋</button><button type="button" className="composer-icon" title="粘贴剪贴板图片" onClick={() => void attachClipboardImage("new")}>▣</button><button type="button" className="workspace-chip workspace-picker-chip" onClick={() => void chooseWorkspace()}>⌁ {workspaceName(form.workspacePath || null)}</button></div><button className="send-button" disabled={busy || (!form.prompt.trim() && !draftAttachments.length) || (form.runtime === "codex" && !form.model)} title="发送并创建任务">↑</button></div>
          </form>
          <small className="composer-hint">Enter 发送并创建任务 · Shift + Enter 换行 · Esc 稍后继续 · {draftProtection === "encrypted" ? "未发送内容由 Windows 加密，重启后可恢复" : "未发送内容仅保留到本次应用退出"}</small>
        </div>
      </> : !selected ? <div className="empty-workspace">
        <div className="empty-logo">A</div><h1>{detachedMode ? "无法打开这个对话" : "今天想完成什么？"}</h1><p>{detachedMode ? "对话可能已被删除，或本地服务暂时不可用。" : "选择一个已有任务，或创建新的 Agent 任务。"}</p>
        {detachedMode && detachedTaskId ? <button className="primary" onClick={() => void reattachConversation(detachedTaskId)}>返回主窗口</button> : <button className="primary" onClick={openNewConversation}>新建对话</button>}
      </div> : <>
        <header className="conversation-header">
          <div className="title-area">
            {renaming ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); if (draftTitle.trim()) void updateTask({ title: draftTitle.trim() }); }}>
              <input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onBlur={() => setRenaming(false)} />
            </form> : <button className="task-title" onDoubleClick={() => { setDraftTitle(selected.title); setRenaming(true); }} title="双击重命名">{selected.title}</button>}
            <div className="header-meta"><span className={`status-dot ${selected.status}`} />{statusLabels[selected.status]}{detachedMode && <><span>·</span><span>独立窗口</span></>}<span>·</span><span>{workspaceName(selected.workspacePath)}</span><span>·</span><span>{selected.model ?? selected.runtime}</span></div>
          </div>
          <div className="header-actions">
            {isActive && <button onClick={() => void stopTask()} disabled={stopping}>{stopping ? "停止中…" : "停止"}</button>}
            {(selected.status === "failed" || selected.status === "cancelled") && <button onClick={() => void taskAction("retry")} disabled={busy}>重试</button>}
            {selected.status === "waiting_retry" && <button onClick={() => void taskAction("retry")} disabled={busy}>立即重试</button>}
            <button className={contextOpen ? "active" : ""} onClick={() => setContextOpen((value) => !value)}>上下文</button>
            <details className="header-more" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.removeAttribute("open"); }}>
              <summary title="更多对话操作" aria-label="更多对话操作">•••</summary>
              <div className="header-more-menu">
                {detachedMode ? <button onClick={() => void reattachConversation(selected.id)}>放回主窗口</button> : <button onClick={() => void popOutConversation(selected.id)}>弹出窗口</button>}
                <button onClick={() => { setDraftTitle(selected.title); setRenaming(true); }}>重命名</button>
                <button onClick={() => void updateTask({ pinned: !selected.pinnedAt })}>{selected.pinnedAt ? "取消置顶" : "置顶"}</button>
                <button onClick={() => { setChildError(null); setChildOpen(true); }}>委派子 Agent</button>
                {selected.threadId && <button onClick={() => void codexAction("fork")}>创建对话分支</button>}
                {selected.threadId && <button onClick={() => void codexAction("compact")} disabled={isActive || compactionState.phase === "running"}>{compactionState.phase === "running" ? "正在压缩…" : "压缩上下文"}</button>}
                {selected.threadId && <button onClick={() => void startReview()} disabled={isActive}>审阅工作区变更</button>}
                <button onClick={() => void updateTask({ archived: !selected.archivedAt })} disabled={isActive || busy}>{busy ? selected.archivedAt ? "正在恢复…" : "正在归档…" : selected.archivedAt ? "恢复对话" : "归档对话"}</button>
                {selected.archivedAt && <button className="danger-text" onClick={() => setDeleteTaskConfirmOpen(true)} disabled={busy}>永久删除…</button>}
              </div>
            </details>
          </div>
        </header>

        <div className="conversation-scroll" ref={conversationScroll}>
          <div className="conversation-content">
            {notice && <div className="notice">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
            {selected.goalStatus !== "inactive" && <section className={`goal-card ${selected.goalStatus}`}>
              <header><div><span>持续目标</span><strong>{selected.goalObjective ?? selected.title}</strong></div><b>{selected.goalProgress}%</b></header>
              <div className="goal-progress"><i style={{ width: `${selected.goalProgress}%` }} /></div>
              <p>{selected.goalLastSummary ?? "Agent 将在每轮验证后上报进度，并在安全边界内自动继续。"}</p>
              <small>{selected.goalCompletedTurns} / {selected.goalMaxTurns} 轮{selected.goalDeadlineAt ? ` · 截止 ${deadlineFormatter.format(new Date(selected.goalDeadlineAt))}` : " · 无截止时间"}{selected.goalTokenBudget > 0 ? ` · ${tokenCountLabel(selected.goalTokensUsed)} / ${tokenCountLabel(selected.goalTokenBudget)} Token` : " · Token 不限"} · 下一步：{selected.goalNextStep ?? "完成当前轮后更新"}</small>
              <footer><span>{selected.goalStatus === "active" ? "自动推进中" : selected.goalStatus === "completed" ? "目标已完成" : selected.goalStatus === "deadline_reached" ? "已到截止时间" : selected.goalStatus === "budget_reached" ? "已达到 Token 预算" : selected.goalStatus === "limit_reached" ? "已达到轮次上限" : selected.goalStatus === "blocked" ? "等待处理阻塞" : "已暂停"}</span><div>{selected.goalStatus === "active" ? <button disabled={busy} onClick={() => void goalAction("pause")}>暂停目标</button> : !["completed"].includes(selected.goalStatus) ? <button disabled={busy} onClick={() => void goalAction("resume")}>{selected.goalStatus === "limit_reached" ? "追加 3 轮" : selected.goalStatus === "deadline_reached" ? "延长 4 小时" : selected.goalStatus === "budget_reached" ? "增加 100K Token" : "恢复目标"}</button> : null}{selected.goalStatus !== "completed" && <button disabled={busy} onClick={() => void goalAction("complete")}>结束目标</button>}</div></footer>
            </section>}
            {compactionState.phase !== "idle" && <div className={`compaction-card ${compactionState.phase}`}><span>{compactionState.phase === "running" ? "◌" : compactionState.phase === "completed" ? "✓" : "!"}</span><div><strong>{compactionState.phase === "running" ? "正在压缩上下文…" : compactionState.phase === "completed" ? "上下文压缩完成" : "上下文压缩失败"}</strong><p>{compactionState.phase === "running" ? `压缩前约占 ${compactionState.before ?? "未知"}%` : compactionState.phase === "completed" ? `压缩前 ${compactionState.before ?? "未知"}% → 压缩后 ${compactionState.after ?? "等待下一次用量更新"}%` : compactionState.error}</p></div>{compactionState.phase !== "running" && <button onClick={() => setCompactionState({ phase: "idle" })}>×</button>}</div>}
            {selected.status === "waiting_timer" && <div className="wait-card"><span>◷</span><div><strong>任务正在持久化等待</strong><p>可以关闭窗口；调度器将在 {selected.nextWakeupAt ? shortTime(selected.nextWakeupAt) : "计划时间"} 自动唤醒。</p></div></div>}
            {selected.status === "waiting_retry" && <div className="wait-card retry-wait-card"><span>↻</span><div><strong>执行失败，正在等待自动重试</strong><p>{selected.error ?? "暂时性错误"}</p><small>{selected.nextAttemptAt ? `${deadlineFormatter.format(new Date(selected.nextAttemptAt))} 自动重试` : "即将重新进入队列"} · 第 {selected.attempt + 1} / {selected.maxAttempts} 次机会</small><footer><button onClick={() => void stopTask()} disabled={stopping}>{stopping ? "停止中…" : "停止重试"}</button><button className="primary" onClick={() => void taskAction("retry")} disabled={busy}>{busy ? "正在入队…" : "立即重试"}</button></footer></div></div>}
            {recoveryStillActive && latestRecovery && <div className="wait-card recovery-card"><span>↺</span><div><strong>{String(latestRecovery.payload.title ?? "任务已从异常中恢复")}</strong><p>{String(latestRecovery.payload.detail ?? latestRecovery.payload.message ?? "平台已将任务安全放回持久队列，并会先检查当前工作区再继续。")}</p><small>恢复尝试 {String(latestRecovery.payload.attempt ?? selected.attempt)} / {String(latestRecovery.payload.maxAttempts ?? selected.maxAttempts)}</small></div></div>}
            {approvals.filter((approval) => approval.status === "pending").map((approval) => <div className={`approval-card risk-${approval.risk}`} key={approval.id}>
              <div><strong>{approval.title}</strong><span>{approval.risk === "high" ? "高风险" : approval.risk === "medium" ? "中风险" : "低风险"}</span></div>
              <p>{approval.description}</p>
              {approval.command && <code>$ {approval.command}</code>}{approval.path && <code>路径：{approval.path}</code>}
              <small>目录：{approval.cwd ?? "-"} · 网络：{approval.networkHost ?? "无"} · 范围：{approval.scope ?? "单次"}</small>
              <footer><button onClick={() => void decideApproval(approval.id, "rejected")}>拒绝</button><button className="primary" onClick={() => void decideApproval(approval.id, "approved")}>批准并继续</button></footer>
            </div>)}
            {hiddenTurnCount > 0 && <button className="load-earlier-turns" onClick={loadEarlierTurns}>加载更早的 {Math.min(30, hiddenTurnCount)} 轮对话 <small>还有 {hiddenTurnCount} 轮</small></button>}
            {visibleConversationTurns.map((turn, index) => {
              const isLatest = index === visibleConversationTurns.length - 1;
              const turnActivity = turn.displayEvents.length ? eventCopy(turn.displayEvents.at(-1)!) : latestActivity;
              const turnResult = turnSummary(turn.user.turn, turn.events);
              return <section className="conversation-turn" key={turn.user.id}>
                <article className="message user">
                  <div className="message-avatar">你</div>
                  <div className="message-body"><div className="message-author">你<time>{shortTime(turn.user.createdAt)}</time>{isLatest && <button className="message-action" disabled={editingLastMessage} onClick={() => void editLastMessage()}>{editingLastMessage ? "正在撤回…" : "编辑"}</button>}</div><DeferredMarkdown content={turn.user.content} /></div>
                </article>
                {turn.displayEvents.length > 0 && <details className="execution-card" open={isLatest && isActive}>
                  <summary><span className={`activity-pulse ${isLatest && isActive ? "live" : ""}`} /><div><strong>{turnActivity[0]}</strong><small>{turnActivity[1]}</small></div><span className="event-count">{turn.displayEvents.length} 项关键操作</span><span className="chevron">⌄</span></summary>
                  <div className="execution-list">{turn.displayEvents.map((event) => { const copy = eventCopy(event); const failed = event.payload.phase === "failed" || event.type.includes("failed") || event.type === "error"; const reasoning = isReasoningEvent(event); return <div className={`execution-row ${reasoning ? "reasoning-row" : ""}`} key={event.id}><span className="execution-symbol">{failed ? "!" : reasoning ? "◇" : event.type.includes("completed") || event.type.includes("succeeded") ? "✓" : "·"}</span><div><strong>{copy[0]}</strong>{reasoning ? <div className="reasoning-summary"><DeferredMarkdown content={copy[1]} /></div> : <p>{copy[1]}</p>}</div><time>{shortTime(event.createdAt)}</time></div>; })}</div>
                </details>}
                {turn.assistant && <article className="message assistant">
                  <div className="message-avatar">A</div>
                  <div className="message-body"><div className="message-author">Agent Foundry<time>{shortTime(turn.assistant.createdAt)}</time></div><DeferredMarkdown content={turn.assistant.content} /></div>
                </article>}
                {turnResult.summary && <div className="turn-change-card"><header><div><strong>已编辑 {String(summaryChangeCount(turnResult.summary))} 个文件</strong><small><b>+{String(turnResult.summary.payload.additions ?? 0)}</b> <em>-{String(turnResult.summary.payload.deletions ?? 0)}</em></small></div><button onClick={() => { setContextTab("changes"); setContextOpen(true); }}>查看本轮</button></header><div>{(Array.isArray(turnResult.summary.payload.changes) ? turnResult.summary.payload.changes : []).slice(0, 8).map((value, changeIndex) => { const change = asRecord(value); return <button key={`${String(change.path)}:${changeIndex}`} onClick={() => void openPreview("diff", String(change.path), turn.user.turn)}><span>{String(change.path)}</span><small><b>+{String(change.additions ?? "-")}</b> <em>-{String(change.deletions ?? "-")}</em></small></button>; })}</div>{turnResult.outputs.length > 0 && <footer><strong>本轮产物</strong>{turnResult.outputs.map((output) => <button key={output} onClick={() => void openFileEntry(output)}>↗ {output}</button>)}</footer>}</div>}
                {turn.events.filter((event) => event.type === "automation.task.created" || event.type === "conversation.branch.created" || event.type === "conversation.branch.origin" || event.type === "child-task.created").map((event) => <button className="conversation-system-note" key={event.id} onClick={() => { const linked = String(event.payload.branchTaskId ?? event.payload.sourceTaskId ?? event.payload.childTaskId ?? ""); if (linked) setSelectedId(linked); }}>{String(event.payload.title ?? "对话关系已更新")}</button>)}
              </section>;
            })}
            {selected.error && selected.status !== "waiting_retry" && <div className="error-card"><strong>执行遇到问题</strong><p>{selected.error}</p></div>}
            <div ref={threadEnd} />
          </div>
        </div>

        <div className="composer-dock">
          <form className={`message-composer ${isActive ? "disabled" : ""} ${attachmentDragActive ? "dragging-file" : ""}`} onSubmit={(event) => void sendFollowUp(event)} onDragEnter={(event) => attachmentDragEnter(event, !isActive && !showArchived)} onDragOver={(event) => attachmentDragEnter(event, !isActive && !showArchived)} onDragLeave={attachmentDragLeave} onDrop={(event) => attachmentDrop(event, !isActive && !showArchived, "follow-up")}>
            {attachmentDragActive && <div className="attachment-drop-hint"><strong>释放即可添加</strong><span>支持图片和其他本机文件</span></div>}
            {slashCommands.length > 0 && <div className="slash-command-menu" role="listbox" aria-label="快捷命令">
              <header><strong>快捷命令</strong><span>↑↓ 选择 · Enter 执行 · Esc 关闭</span></header>
              {slashCommands.slice(0, 8).map((command, index) => <button type="button" role="option" aria-selected={index === slashSelection} className={index === slashSelection ? "active" : ""} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => runSlashCommand(command.name)}>
                <code>/{command.name}</code><span><strong>{command.label}</strong><small>{command.description}</small></span>
              </button>)}
            </div>}
            <textarea ref={followUpInput} value={followUp} onChange={(event) => { followUpDraftTouched.current = true; followUpValueSnapshot.current = event.target.value; setFollowUp(event.target.value); setSlashSelection(0); }} onPaste={(event) => pasteImage(event, !isActive && !showArchived, "follow-up")} onKeyDown={composerKeyDown} disabled={busy || showArchived || (isActive && selected.runtime !== "codex")} placeholder={showArchived ? "恢复任务后可继续对话" : isActive ? "向执行中的 Agent 补充指令…" : "输入消息，或粘贴 / 拖入图片…"} rows={2} />
            <AttachmentTray files={followUpAttachments} previews={attachmentPreviews} onRemove={(filePath) => removeAttachment(filePath, "follow-up")} />
            <div className="composer-runtime-bar"><label>模型<select ref={modelSelect} value={`${turnSettings.provider}:${turnSettings.model}`} onChange={(event) => selectTurnModel(event.target.value)} disabled={isActive || modelsLoading}>{modelsLoading && <option value="">正在搜索已配置模型…</option>}{modelChoices.map((choice) => <option key={`${choice.provider}:${choice.model}`} value={`${choice.provider}:${choice.model}`}>{choice.providerLabel} · {choice.displayName}</option>)}</select></label><label>推理<select ref={reasoningSelect} value={turnSettings.reasoningEffort} onChange={(event) => setTurnSettings({ ...turnSettings, reasoningEffort: event.target.value as ReasoningEffort })} disabled={isActive}><option value="minimal">最少</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="ultra">Ultra</option></select></label><label>沙箱<select value={turnSettings.sandboxMode} onChange={(event) => setTurnSettings({ ...turnSettings, sandboxMode: event.target.value as SandboxMode })} disabled={isActive}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">完全访问</option></select></label><label>审批<select value={turnSettings.approvalPolicy} onChange={(event) => setTurnSettings({ ...turnSettings, approvalPolicy: event.target.value as ApprovalPolicy })} disabled={isActive}><option value="untrusted">非可信操作询问</option><option value="on-request">请求批准</option><option value="never">无需批准</option></select></label><label>批准人<select value={turnSettings.approvalsReviewer} onChange={(event) => setTurnSettings({ ...turnSettings, approvalsReviewer: event.target.value as ApprovalsReviewer })} disabled={isActive}><option value="user">我批准</option><option value="auto_review">帮我批准</option></select></label><button type="button" onClick={() => void saveTurnSettings()} disabled={isActive}>应用</button></div>
            <div className="composer-toolbar"><div><button type="button" className="composer-icon" title={isActive ? "执行中暂不支持添加附件" : "添加附件或拖入文件"} disabled={isActive} onClick={() => void chooseAttachments("follow-up")}>＋</button><button type="button" className="composer-icon" title="粘贴剪贴板图片" disabled={isActive} onClick={() => void attachClipboardImage("follow-up")}>▣</button><span>{selected.provider} · {turnSettings.model || selected.model || selected.runtime}</span><span className="workspace-chip">⌁ {workspaceName(selected.workspacePath)}</span></div><div className="composer-actions">{isActive && <button type="button" className="stop-button" disabled={stopping} onClick={() => void stopTask()} aria-label="停止模型执行" title="停止当前模型执行"><span /></button>}<button className="send-button" disabled={(!followUp.trim() && (!followUpAttachments.length || isActive)) || busy || showArchived || (isActive && selected.runtime !== "codex")} title={isActive ? "补充到当前执行" : "发送"}>↑</button></div></div>
          </form>
          <small className="composer-hint">Enter 发送 · Shift + Enter 换行 · 输入 / 使用快捷命令 · 可粘贴或拖入图片{(followUp.trim() || followUpAttachments.length) ? followUpProtection === "encrypted" ? " · 草稿已加密保存" : " · 草稿仅在本次会话保留" : ""}</small>
        </div>
      </>}
    </section>

    {selected && !composerOpen && !automationOpen && contextOpen && <><div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧工作区栏宽度" aria-orientation="vertical" title="拖拽调整右侧栏宽度；双击恢复默认" onPointerDown={(event) => beginPanelResize("right", event)} onDoubleClick={() => resetPanelWidth("right")} /><aside className="context-panel">
      <div className="context-header"><div><strong>当前任务工作区</strong><small>{sharedWorkspaceTaskCount > 1 ? `磁盘目录由 ${sharedWorkspaceTaskCount} 个任务共享；对话记忆仍独立` : "磁盘文件，不是其他对话的聊天上下文"}</small></div><button onClick={() => setContextOpen(false)}>×</button></div>
      <div className="context-tabs">
        <button className={contextTab === "files" ? "active" : ""} title="当前任务所选磁盘工作区中的文件" onClick={() => setContextTab("files")}>文件 <span>{workspace.files.length}{workspace.filesTruncated ? "+" : ""}</span></button>
        <button className={contextTab === "changes" ? "active" : ""} title="当前对话最近一轮由 Agent 产生的文件变更" onClick={() => setContextTab("changes")}>本轮变更 <span>{String(summaryChangeCount(conversationTurns.at(-1)?.events.findLast((event) => event.type === "turn.workspace.summary")))}</span></button>
        <button className={contextTab === "terminal" ? "active" : ""} onClick={() => setContextTab("terminal")}>终端</button>
        <button className={contextTab === "details" ? "active" : ""} onClick={() => setContextTab("details")}>详情</button>
      </div>
      <div className="context-body">
        {preview ? <div className="preview-pane">
          <div className="preview-header"><button onClick={() => { setPreview(null); setEditing(false); }}>←</button><div><strong>{preview.path}</strong><small>{preview.kind === "diff" ? "Git 变更" : preview.kind === "pdf" ? "PDF 文档" : preview.kind === "image" ? "图片预览" : preview.kind === "external" ? "本机文件" : editing ? "应用内编辑" : "文本预览"}</small></div><div className="preview-actions">{preview.absolutePath && <button onClick={() => void openSystemPath(preview.absolutePath!)}>系统打开</button>}{(preview.kind === "file" && !preview.readOnly || preview.kind === "local-text") && <><button onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button>{editing && <button onClick={() => void savePreview()}>保存</button>}</>}</div></div>
          {renderPreviewContent()}
        </div> : contextTab === "files" ? renderFilesPanel() : null}
        {!preview && contextTab === "changes" && (() => { const latestTurn = conversationTurns.at(-1); const summary = latestTurn?.events.findLast((event) => event.type === "turn.workspace.summary"); const changes = Array.isArray(summary?.payload.changes) ? summary.payload.changes.map(asRecord) : []; return <div className="change-list">{changes.length ? <><div className="turn-change-summary">最近一轮 · +{String(summary?.payload.additions ?? 0)} -{String(summary?.payload.deletions ?? 0)}</div>{changes.map((change, index) => <div className="change-entry" key={`${String(change.status)}-${String(change.path)}-${index}`}><button className="change-row" onClick={() => void openPreview("diff", String(change.path), latestTurn?.user.turn)}><span className={`change-status status-${String(change.status)[0]?.toLowerCase()}`}>{String(change.status)}</span><code>{String(change.path)}</code><small>+{String(change.additions ?? "-")} -{String(change.deletions ?? "-")}</small></button></div>)}</> : <div className="panel-empty">当前对话最近一轮没有文件变更</div>}</div>; })()}
        {!preview && contextTab === "terminal" && <Suspense fallback={<div className="panel-loading">正在加载交互终端…</div>}><TerminalPanel api={api} taskId={selected.id} /></Suspense>}
        {contextTab === "details" && <div className="detail-list">
          <div><span>运行时</span><strong>{selected.runtime}</strong></div><div><span>模型服务</span><strong>{selected.provider}</strong></div><div><span>模型</span><strong>{selected.model ?? "默认"}</strong></div><div><span>推理深度</span><strong>{selected.reasoningEffort ?? "模型默认"}</strong></div><div><span>Codex 沙箱权限</span><strong>{selected.sandboxMode}</strong></div><div><span>审批策略</span><strong>{selected.approvalPolicy} · {selected.approvalsReviewer}</strong></div><div><span>会话消息</span><strong>{memory?.messageCount ?? messages.length}</strong></div><div><span>对话轮次</span><strong>{Math.min(conversationTurns.length, turnTotal)} / {turnTotal}（已加载）</strong></div><div><span>运行事件</span><strong>{events.length === eventTotal ? eventTotal : `${events.length} / ${eventTotal}（最近）`}</strong></div><div><span>执行次数</span><strong>{selected.attempt + 1} / {selected.maxAttempts}</strong></div><div><span>持续目标</span><strong>{selected.goalStatus === "inactive" ? "关闭" : `${selected.goalStatus} · ${selected.goalCompletedTurns}/${selected.goalMaxTurns}${selected.goalDeadlineAt ? ` · ${deadlineFormatter.format(new Date(selected.goalDeadlineAt))}` : ""}${selected.goalTokenBudget > 0 ? ` · ${tokenCountLabel(selected.goalTokensUsed)}/${tokenCountLabel(selected.goalTokenBudget)} Token` : ""}`}</strong></div><div><span>Codex Thread</span><code>{selected.threadId ? selected.threadId.slice(0, 14) : "未创建"}</code></div>
          <div><span>优先级</span><strong>{selected.priority}</strong></div><div><span>父任务</span><code>{selected.parentTaskId?.slice(0, 12) ?? "无"}</code></div><div><span>外层沙箱</span><strong>{sandbox ? `${sandbox.kind} · ${sandbox.state}` : "准备中"}</strong></div>
          {sandbox?.kind === "docker" && <><div><span>容器</span><code>{sandbox.containerId?.slice(0, 12) ?? "-"}</code></div><div><span>资源限制</span><strong>{sandbox.cpuLimit} CPU · {sandbox.memoryMb} MB · {sandbox.networkPolicy}</strong></div></>}
          <details className="memory-preview"><summary>沙箱与审批分别有什么作用？</summary><pre>{sandbox?.kind === "docker" ? "Docker：每任务独立容器，仅挂载任务工作区和必要配置，并限制 CPU/内存。只读会把工作区和容器根文件系统都设为只读；工作区写入仅开放工作区与必要状态目录；完全访问才开放容器根文件系统，但仍不能越出容器访问未挂载的宿主机目录。当前 App Server 和命令共享 bridge 网络，工具网络尚未与模型 API 网络彻底拆分。\n\n审批：在命令或文件操作越权/高风险时暂停，交给你或自动风险审查器判断。它不是文件隔离，不能替代沙箱。" : sandbox?.kind === "wsl2" ? "WSL2：Codex 的 read-only / workspace-write / danger-full-access 直接控制命令可访问的文件范围。danger-full-access 可能访问 WSL 中可见的其他 Windows 磁盘，请谨慎使用。\n\n审批：决定操作何时暂停以及由你还是自动风险审查器批准；它不能替代沙箱。" : "Windows 原生：Codex Windows 沙箱直接在本机工作区运行，不需要 WSL2。read-only 只读，workspace-write 仅允许工作区写入，danger-full-access 会取消 Codex 文件隔离并可能访问其他本机目录，请谨慎使用。终端命令由 Windows PowerShell 执行。\n\n审批：决定操作何时暂停以及由你还是自动风险审查器批准；它不能替代沙箱。"}</pre></details>
          <div><span>持久信号</span><strong>{signals.length}</strong></div><div><span>附件/产物</span><strong>{artifacts.length}</strong></div><div><span>工作区根</span><button className="link-button" onClick={() => void addWorkspaceRoot()}>{workspaceRoots.length} · 添加</button></div><div><span>子 Agent</span><button className="link-button" onClick={() => void handoffChildren()}>{children.length} · 汇总</button></div>
          {runtimeDiagnostics && <><div><span>Windows 运行时</span><strong>{runtimeDiagnostics.platform} {runtimeDiagnostics.arch} · {runtimeDiagnostics.node}</strong></div><div><span>连接诊断</span><strong>Codex {runtimeDiagnostics.codexAvailable ? "正常" : "缺失"} · 代理 {runtimeDiagnostics.proxyConfigured ? "已配置" : "未配置"} · 自定义证书 {runtimeDiagnostics.customCaConfigured ? "已配置" : "未配置"}</strong></div></>}
          {children.map((child) => <div key={child.id}><span>{child.title}</span><span><button className="link-button" onClick={() => setSelectedId(child.id)}>{statusLabels[child.status]}</button>{child.status === "succeeded" && <button className="link-button" onClick={() => void mergeChild(child.id)}>合并</button>}</span></div>)}
          <details className="memory-preview"><summary>本对话上下文（仅当前对话）</summary><pre>{memory?.summary || "当前对话暂无记忆。其他对话不会自动注入。"}</pre></details>
        </div>}
      </div>
    </aside></>}

    {childOpen && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !childBusy) setChildOpen(false); }}><form className="new-task-modal compact-modal" onSubmit={createChild}>
      <header><div><span>多 Agent</span><h2>委派子任务</h2></div><button type="button" onClick={() => setChildOpen(false)}>×</button></header>
      {childError && <div className="modal-error"><strong>委派未完成</strong><p>{childError}</p>{childForm.isolation === "worktree" && <div className="modal-error-actions"><button type="button" disabled={childBusy} onClick={() => void initializeGitAndRetry()}>创建初始 Git 提交并重试</button><button type="button" onClick={() => { setChildForm({ ...childForm, isolation: "shared" }); setChildError(null); }}>改用共享工作区</button></div>}</div>}
      <label className="field"><span>子任务名称</span><input value={childForm.title} onChange={(event) => setChildForm({ ...childForm, title: event.target.value })} /></label>
      <label className="field"><span>要完成的工作</span><textarea autoFocus rows={6} value={childForm.prompt} onChange={(event) => setChildForm({ ...childForm, prompt: event.target.value })} /></label>
      <label className="field"><span>工作区隔离</span><select value={childForm.isolation} onChange={(event) => setChildForm({ ...childForm, isolation: event.target.value })}><option value="worktree">独立 Git worktree（需要至少一次提交）</option><option value="shared">共享当前工作区</option></select><small>创建初始提交会把当前未忽略文件加入 Git，作为子 Agent 分支的基线。</small></label>
      <footer><button type="button" onClick={() => setChildOpen(false)} disabled={childBusy}>取消</button><button className="primary" disabled={childBusy || !childForm.prompt.trim()}>{childBusy ? "正在创建…" : "创建子 Agent"}</button></footer>
    </form></div>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false); }}><form className="new-task-modal settings-modal" onSubmit={saveSettings}>
      <header><div><span>平台设置</span><h2>运行时与沙箱</h2></div><button type="button" onClick={() => setSettingsOpen(false)}>×</button></header>
      {!settings ? <div className="panel-empty">正在读取设置…</div> : <>
        <div className="form-grid"><label className="field"><span>默认运行时</span><select value={settings.defaultRuntime} onChange={(event) => setSettings({ ...settings, defaultRuntime: event.target.value as "mock" | "codex" })}><option value="codex">Codex</option><option value="mock">Mock</option></select></label><label className="field"><span>Worker 并发</span><input type="number" min="1" max="8" value={settings.workerConcurrency} onChange={(event) => setSettings({ ...settings, workerConcurrency: Number(event.target.value) })} /></label><label className="field"><span>Provider 并发</span><input type="number" min="1" max="8" value={settings.providerConcurrency} onChange={(event) => setSettings({ ...settings, providerConcurrency: Number(event.target.value) })} /></label></div>
        <label className="toggle-row"><input type="checkbox" checked={settings.sandboxEnabled} onChange={(event) => setSettings({ ...settings, sandboxEnabled: event.target.checked })} /><span><strong>每任务 Docker 沙箱（可选）</strong><small>关闭时直接使用 Windows 原生 Codex，无需 WSL2；开启后增加容器资源与挂载隔离</small></span></label>
        <div className="form-grid"><label className="field"><span>CPU</span><input type="number" step="0.25" value={settings.sandboxCpuLimit} onChange={(event) => setSettings({ ...settings, sandboxCpuLimit: Number(event.target.value) })} /></label><label className="field"><span>内存 MB</span><input type="number" value={settings.sandboxMemoryMb} onChange={(event) => setSettings({ ...settings, sandboxMemoryMb: Number(event.target.value) })} /></label><label className="field"><span>网络</span><select value={settings.sandboxNetwork} onChange={(event) => setSettings({ ...settings, sandboxNetwork: event.target.value as "none" | "bridge" })}><option value="none">默认断网</option><option value="bridge">允许联网</option></select></label></div>
        <label className="field"><span>沙箱镜像</span><input value={settings.sandboxImage} onChange={(event) => setSettings({ ...settings, sandboxImage: event.target.value })} /></label>
        <div className="form-grid"><label className="field"><span>默认 Provider</span><select value={settings.defaultProvider} onChange={(event) => setSettings({ ...settings, defaultProvider: event.target.value })}>{config?.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label className="field"><span>默认工作区</span><input value={settings.defaultWorkspace} onChange={(event) => setSettings({ ...settings, defaultWorkspace: event.target.value })} placeholder="留空则自动创建" /></label></div>
        <div className="settings-path-field"><label className="field"><span>Skills 额外目录（每行一个）</span><textarea rows={3} value={settings.skillsExtraRoots.join("\n")} onChange={(event) => setSettings({ ...settings, skillsExtraRoots: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })} /></label><button type="button" onClick={() => void addSkillRoot()}>选择目录</button></div>
        <div className="settings-path-field"><label className="field"><span>Codex / MCP config.toml</span><input value={settings.mcpConfigPath} onChange={(event) => setSettings({ ...settings, mcpConfigPath: event.target.value })} /><small>保存后，Windows 原生运行时会使用该文件所在目录作为独立 Codex 配置目录。</small></label><button type="button" onClick={() => void chooseMcpConfig()}>选择文件</button></div>
        <label className="field"><span>全局验证命令（每行一个）</span><textarea rows={3} value={settings.verificationCommands.join("\n")} onChange={(event) => setSettings({ ...settings, verificationCommands: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })} /></label>
        <div className="form-grid"><label className="field"><span>审批策略</span><select value={settings.approvalPolicy} onChange={(event) => setSettings({ ...settings, approvalPolicy: event.target.value as PlatformSettings["approvalPolicy"] })}><option value="on-request">按需审批（推荐）</option><option value="untrusted">仅不可信操作</option><option value="on-failure">失败后审批</option><option value="never">从不审批</option></select></label><label className="field"><span>审批通知 Webhook（可选）</span><input value={settings.approvalWebhookUrl} onChange={(event) => setSettings({ ...settings, approvalWebhookUrl: event.target.value })} placeholder="https://…" /></label></div>
        <label className="field"><span>Windows 桌面提醒</span><select value={notificationMode} onChange={(event) => setNotificationMode(event.target.value as NotificationMode)}><option value="background">仅在后台或查看其他任务时提醒（推荐）</option><option value="always">始终提醒</option><option value="never">不提醒</option></select><small>任务完成、失败、等待批准或等待外部输入时提醒；点击通知会返回对应任务。</small></label>
        <section className="provider-settings"><h3>Provider 连接（按租户保存）</h3>{config?.providers.map((provider) => { const profile = settings.providerProfiles[provider.id]; return profile ? <div className="provider-profile" key={provider.id}><span>{provider.label}<small>{provider.configured ? "Key 已配置" : "Key 未配置"}</small></span><input value={profile.baseUrl} onChange={(event) => setSettings({ ...settings, providerProfiles: { ...settings.providerProfiles, [provider.id]: { ...profile, baseUrl: event.target.value } } })} placeholder="Responses API Base URL" /><input value={profile.defaultModel} onChange={(event) => setSettings({ ...settings, providerProfiles: { ...settings.providerProfiles, [provider.id]: { ...profile, defaultModel: event.target.value } } })} placeholder="默认模型" /><label className="mini-check"><input type="checkbox" checked={profile.codexCompatible} onChange={(event) => setSettings({ ...settings, providerProfiles: { ...settings.providerProfiles, [provider.id]: { ...profile, codexCompatible: event.target.checked } } })} />Responses/Codex 兼容</label><input type="password" autoComplete="new-password" value={providerSecrets[provider.id] ?? ""} onChange={(event) => setProviderSecrets({ ...providerSecrets, [provider.id]: event.target.value })} placeholder="输入新 key（Windows 加密）" /><span className="setting-actions"><button type="button" onClick={() => void saveProviderSecret(provider.id)} disabled={!providerSecrets[provider.id]?.trim()}>保存 Key</button><button type="button" onClick={() => void saveProviderSecret(provider.id, true)} disabled={!provider.configured}>删除</button></span></div> : null; })}</section>
        <Suspense fallback={<div className="capability-loading">正在加载能力中心…</div>}><CapabilitiesPanel api={api} cwd={selected?.workspacePath ?? settings.defaultWorkspace ?? "."} provider={selected?.provider ?? settings.defaultProvider} taskId={selected?.id} onNotice={setNotice} /></Suspense>
        {platformStatus && <section className="platform-status"><h3>平台运行状态</h3><div><span>Worker</span><strong>{Object.values(platformStatus.worker.activeByProvider).reduce((sum, count) => sum + count, 0)} / {platformStatus.worker.concurrency}</strong></div><div><span>待处理信号</span><strong>{platformStatus.signals.filter((signal) => signal.state === "pending").length}</strong></div><div><span>未重放死信</span><strong>{platformStatus.deadLetters.filter((letter) => !letter.replayedAt).length}</strong></div><div><span>审计记录</span><strong>{auditEntries.length}</strong></div>{platformStatus.deadLetters.filter((letter) => !letter.replayedAt).slice(0, 5).map((letter) => <div className="dead-letter" key={letter.id}><span>{letter.reason}</span><button type="button" onClick={() => void replayDeadLetter(letter.id)}>重放</button></div>)}<h3 className="usage-heading">已验证回合 Token</h3><div><span>总用量</span><strong>{tokenCountLabel(platformStatus.usage.totalTokens)}</strong></div><div><span>输入 / 输出</span><strong>{tokenCountLabel(platformStatus.usage.inputTokens)} / {tokenCountLabel(platformStatus.usage.outputTokens)}</strong></div><div><span>缓存输入</span><strong>{tokenCountLabel(platformStatus.usage.cachedInputTokens)}</strong></div><div><span>已验证回合</span><strong>{platformStatus.usage.verifiedTurns}</strong></div>{platformStatus.usage.byProvider.length > 0 && <div className="usage-providers">{platformStatus.usage.byProvider.map((provider) => <span key={provider.provider}><b>{provider.provider}</b><small>{provider.verifiedTurns} 回合 · {tokenCountLabel(provider.totalTokens)} Token</small></span>)}</div>}<h3 className="storage-heading">本机数据</h3><div><span>使用中 / 已归档</span><strong>{platformStatus.storage.activeTasks} / {platformStatus.storage.archivedTasks}</strong></div><div><span>消息 / 事件</span><strong>{platformStatus.storage.messages} / {platformStatus.storage.events}</strong></div><div><span>平台附件</span><strong>{platformStatus.storage.artifacts}</strong></div><div><span>附件 / 数据库</span><strong>{byteCountLabel(platformStatus.storage.artifactBytes)} / {byteCountLabel(dataSummary?.databaseBytes ?? 0)}</strong></div>{dataSummary && <p className="storage-path" title={dataSummary.dataDir}>保存位置：{dataSummary.dataDir}</p>}<details><summary>租户配额</summary><pre>{JSON.stringify(platformStatus.quota, null, 2)}</pre></details></section>}
        <section className="support-settings"><div><h3>对话数据库备份</h3><p>{dataSummary ? `数据库${dataSummary.databaseHealth === "ok" ? "健康" : `异常：${dataSummary.databaseHealth}`} · ${dataSummary.backupCount} 个备份${dataSummary.lastBackupAt ? ` · 最近 ${shortTime(dataSummary.lastBackupAt)}` : ""} · 不复制工作区和附件正文` : "正在检查数据库…"}</p></div><button type="button" onClick={() => void backupConversationData()} disabled={backupBusy || !dataSummary}>{backupBusy ? "正在备份并校验…" : "立即备份"}</button></section>
        <section className="support-settings app-update-settings"><div className="app-update-copy"><h3>应用更新</h3><p>{appInfo ? `当前版本 ${appInfo.version} · Codex ${appInfo.codexVersion} · ${appInfo.platform} ${appInfo.arch}${appInfo.packaged ? "" : " · 开发模式"}` : "正在读取桌面版本…"}</p><div className="update-token-row"><input className="update-token-input" type="password" autoComplete="new-password" value={updateToken} onChange={(event) => setUpdateToken(event.target.value)} placeholder={updateAccess?.configured ? "更新令牌已配置；输入新令牌可替换" : "私有 GitHub 仓库只读令牌"} /><button type="button" onClick={() => void saveUpdateAccessToken()} disabled={updateTokenBusy || !updateToken.trim()}>{updateTokenBusy ? "保存中…" : "加密保存"}</button>{updateAccess?.source === "encrypted" && <button type="button" onClick={() => void saveUpdateAccessToken(true)} disabled={updateTokenBusy}>删除令牌</button>}<button type="button" onClick={() => void window.agentDesktop?.openUpdateTokenPage()}>获取令牌</button></div><small className="update-token-status">{updateAccess?.configured ? updateAccess.source === "environment" ? "已由环境变量提供更新权限；不会显示或回传令牌。" : "已使用 Windows 本机加密保存；前端只能读取已配置状态。" : updateAccess?.encrypted === false ? "当前系统加密不可用，无法安全保存令牌。" : "发布仓库为私有仓库，自动更新前需要只读访问令牌。"}</small></div><button type="button" onClick={() => void checkDesktopUpdates()} disabled={updateChecking || !appInfo?.packaged}>{updateChecking ? "正在检查…" : appInfo?.packaged ? "检查更新" : "开发模式"}</button></section>
        <section className="support-settings"><div><h3>问题反馈资料</h3><p>一键导出全部对话、任务事件、审批记录、运行环境摘要和脱敏日志。不会复制 API Key、agent.env、数据库、附件正文或工作区文件正文；发送前仍请检查其中的对话和本机路径。</p></div><button type="button" onClick={() => void prepareFeedbackBundle()} disabled={busy || typeof window === "undefined" || !window.agentDesktop}>{busy ? "正在生成…" : "生成并打开文件夹"}</button></section>
      </>}
      <footer><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" disabled={!settings}>保存设置</button></footer>
    </form></div>}
    {commandOpen && <div className="modal-backdrop command-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandOpen(false); }}><div className="command-palette" role="dialog" aria-label="快速切换与命令面板">
      <header><span>快速切换</span><kbd>↑↓ 选择 · Enter 打开 · Esc 关闭</kbd></header>
      <label className="command-search"><span>⌕</span><input autoFocus value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandTasks([]); setCommandTasksLoading(!detachedMode); setCommandSelection(0); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" && commandEntries.length) { event.preventDefault(); setCommandSelection((current) => (current + 1) % commandEntries.length); }
        if (event.key === "ArrowUp" && commandEntries.length) { event.preventDefault(); setCommandSelection((current) => (current - 1 + commandEntries.length) % commandEntries.length); }
        if (event.key === "Enter") { event.preventDefault(); const entry = commandEntries[commandSelection]; if (entry && !entry.disabled) entry.run(); }
      }} placeholder={detachedMode ? "搜索命令" : "搜索全部对话或命令"} /></label>
      <div className="command-results">
        {visibleCommandActions.length > 0 && <div className="command-section-label">操作</div>}
        {visibleCommandActions.map((action, index) => <button className={commandSelection === index ? "active" : ""} key={action.key} disabled={action.disabled} onMouseEnter={() => setCommandSelection(index)} onClick={action.run}><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>)}
        {!detachedMode && <div className="command-section-label"><span>{normalizedCommandQuery ? "匹配对话" : "最近对话"}</span>{commandTasksLoading && <small>搜索中…</small>}</div>}
        {!detachedMode && commandTasks.map((task, taskIndex) => { const index = visibleCommandActions.length + taskIndex; return <button className={`command-task ${commandSelection === index ? "active" : ""}`} key={task.id} onMouseEnter={() => setCommandSelection(index)} onClick={() => void openCommandTask(task.id)}><span><strong>{task.title}</strong><small>{workspaceName(task.projectWorkspacePath ?? task.workspacePath)} · {statusLabels[task.status]}</small></span>{unreadTaskIds.has(task.id) && <i>新</i>}</button>; })}
        {commandEntries.length === 0 && !commandTasksLoading && <div className="command-empty">没有匹配的对话或操作</div>}
      </div>
    </div></div>}
    <ConfirmDialog open={deleteTaskConfirmOpen && Boolean(selected?.archivedAt)} title="永久删除这个对话？" description={<>将删除 <strong>{selected?.title}</strong> 的本机对话、执行记录、审批和平台附件副本，且无法恢复。工作区中的文件不会被删除。</>} confirmLabel="永久删除" danger busy={busy} onCancel={() => setDeleteTaskConfirmOpen(false)} onConfirm={() => void deleteArchivedTask()} />
    <TextPromptDialog open={Boolean(reviewCommentTarget)} title="添加行级审阅意见" description={reviewCommentTarget ? <><strong>{reviewCommentTarget.filePath}:{reviewCommentTarget.line}</strong> · {reviewCommentTarget.side === "old" ? "原始行" : "修改后行"}</> : null} confirmLabel="添加评论" busy={reviewCommentBusy} placeholder="说明这里需要修改什么，或记录审阅结论…" onCancel={() => setReviewCommentTarget(null)} onConfirm={(value) => void addReviewComment(value)} />
  </main>;
}
