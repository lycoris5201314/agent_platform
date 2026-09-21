import fs from "node:fs";
import path from "node:path";

export type PendingConversationDraft = {
  prompt: string;
  attachments: string[];
  runtime: string;
  provider: "openai" | "deepseek" | "custom";
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  approvalsReviewer: "user" | "auto_review";
  workspacePath: string;
  durableWait: boolean;
  goalMode: boolean;
  goalMaxTurns: number;
  goalDeadlineHours: number;
  goalTokenBudget: number;
  savedAt?: string;
};

const providers = new Set(["openai", "deepseek", "custom"]);
const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "ultra"]);
const sandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);
const approvalPolicies = new Set(["untrusted", "on-request", "on-failure", "never"]);
const reviewers = new Set(["user", "auto_review"]);

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function parsePendingConversationDraft(value: unknown): PendingConversationDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!boundedString(draft.prompt, 200_000)) return null;
  if (!Array.isArray(draft.attachments) || draft.attachments.length > 50 || !draft.attachments.every((item) => boundedString(item, 4_096))) return null;
  if (!draft.prompt.trim() && draft.attachments.length === 0) return null;
  if (!boundedString(draft.runtime, 40) || !providers.has(String(draft.provider)) || !boundedString(draft.model, 200)) return null;
  if (!efforts.has(String(draft.reasoningEffort)) || !sandboxModes.has(String(draft.sandboxMode)) || !approvalPolicies.has(String(draft.approvalPolicy)) || !reviewers.has(String(draft.approvalsReviewer))) return null;
  if (!boundedString(draft.workspacePath, 4_096) || typeof draft.durableWait !== "boolean" || typeof draft.goalMode !== "boolean") return null;
  if (![draft.goalMaxTurns, draft.goalDeadlineHours, draft.goalTokenBudget].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return null;
  return {
    prompt: draft.prompt,
    attachments: [...draft.attachments] as string[],
    runtime: draft.runtime,
    provider: draft.provider as PendingConversationDraft["provider"],
    model: draft.model,
    reasoningEffort: draft.reasoningEffort as PendingConversationDraft["reasoningEffort"],
    sandboxMode: draft.sandboxMode as PendingConversationDraft["sandboxMode"],
    approvalPolicy: draft.approvalPolicy as PendingConversationDraft["approvalPolicy"],
    approvalsReviewer: draft.approvalsReviewer as PendingConversationDraft["approvalsReviewer"],
    workspacePath: draft.workspacePath,
    durableWait: draft.durableWait,
    goalMode: draft.goalMode,
    goalMaxTurns: draft.goalMaxTurns as number,
    goalDeadlineHours: draft.goalDeadlineHours as number,
    goalTokenBudget: draft.goalTokenBudget as number,
    savedAt: boundedString(draft.savedAt, 80) ? draft.savedAt : undefined,
  };
}

export function readEncryptedDraft(filePath: string, decrypt: (value: Buffer) => string): PendingConversationDraft | null {
  try {
    const encrypted = fs.readFileSync(filePath);
    if (encrypted.byteLength > 2_000_000) return null;
    return parsePendingConversationDraft(JSON.parse(decrypt(encrypted)));
  } catch {
    return null;
  }
}

export function writeEncryptedDraft(filePath: string, value: unknown, encrypt: (value: string) => Buffer): PendingConversationDraft {
  const draft = parsePendingConversationDraft(value);
  if (!draft) throw new Error("草稿内容无效或超过本机保存上限");
  const stored = { ...draft, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encrypt(JSON.stringify(stored)));
  return stored;
}

export function clearEncryptedDraft(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }); } catch { /* absence and locked cleanup are harmless */ }
}
