import type { AgentTask, ApprovalInput, ConversationMemory, GoalProgressReport, WorkspaceHandle } from "../core/types.js";

export interface RuntimeCompleted {
  kind: "completed";
  finalResponse: string;
  threadId?: string;
  usage?: Record<string, unknown>;
  goalReport?: GoalProgressReport;
}

export interface RuntimeWaitingApproval {
  kind: "waiting_approval";
  threadId?: string;
  approval: Omit<ApprovalInput, "taskId">;
  resume: (decision: "approved" | "rejected") => Promise<RuntimeResult>;
  close: () => void;
}

export interface RuntimeWaitingTimer {
  kind: "waiting_timer";
  threadId?: string;
  seconds: number;
  reason: string;
  resume: () => Promise<RuntimeResult>;
  close: () => void;
}

export interface RuntimeWaitingExternal {
  kind: "waiting_external";
  threadId?: string;
  correlationKey: string;
  reason: string;
  resume: (payload: Record<string, unknown>) => Promise<RuntimeResult>;
  close: () => void;
}

export type RuntimeResult = RuntimeCompleted | RuntimeWaitingApproval | RuntimeWaitingTimer | RuntimeWaitingExternal;

export interface RuntimeContext {
  task: AgentTask;
  memory: ConversationMemory;
  workspace: WorkspaceHandle;
  prompt: string;
  platformTurnId: string;
  signal: AbortSignal;
  emit: (type: string, payload?: Record<string, unknown>) => void;
  saveThreadId: (threadId: string) => void;
}

export interface AgentRuntime {
  readonly id: "mock" | "codex";
  run(context: RuntimeContext): Promise<RuntimeResult>;
}
