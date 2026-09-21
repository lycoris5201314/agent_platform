import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearEncryptedDraft, parsePendingConversationDraft, parsePendingFollowUpDraft, readEncryptedDraft, readEncryptedFollowUpDraft, writeEncryptedDraft, writeEncryptedFollowUpDraft } from "../../desktop/draft-store.js";

const validDraft = {
  prompt: "不要丢失这条未发送消息",
  attachments: ["E:\\workspace\\screen.png"],
  runtime: "codex",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  reasoningEffort: "medium",
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  workspacePath: "E:\\workspace",
  durableWait: false,
  goalMode: false,
  goalMaxTurns: 5,
  goalDeadlineHours: 0,
  goalTokenBudget: 0,
};

test("validates and round-trips an encrypted pending conversation draft", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-draft-store-"));
  const filePath = path.join(directory, "pending-draft.bin");
  const encrypt = (value: string) => Buffer.from(value.split("").reverse().join(""), "utf8");
  const decrypt = (value: Buffer) => {
    return value.toString("utf8").split("").reverse().join("");
  };
  try {
    const stored = writeEncryptedDraft(filePath, validDraft, encrypt);
    assert.match(stored.savedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.readFileSync(filePath, "utf8").includes(validDraft.prompt), false, "stored bytes must not expose the prompt directly");
    assert.deepEqual(readEncryptedDraft(filePath, decrypt), stored);
    clearEncryptedDraft(filePath);
    assert.equal(readEncryptedDraft(filePath, decrypt), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects empty, oversized and malformed draft payloads", () => {
  assert.equal(parsePendingConversationDraft({ ...validDraft, prompt: "", attachments: [] }), null);
  assert.equal(parsePendingConversationDraft({ ...validDraft, prompt: "x".repeat(200_001) }), null);
  assert.equal(parsePendingConversationDraft({ ...validDraft, provider: "spoofed" }), null);
  assert.equal(parsePendingConversationDraft({ ...validDraft, goalMaxTurns: Number.NaN }), null);
  assert.ok(parsePendingConversationDraft({ ...validDraft, prompt: "", attachments: ["E:\\only-image.png"] }));
});

test("keeps encrypted follow-up drafts isolated by task and clears them independently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-follow-up-drafts-"));
  const filePath = path.join(directory, "follow-up-drafts.bin");
  const encrypt = (value: string) => Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 91));
  const decrypt = (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 91)).toString("utf8");
  const firstId = "019ffb81-04ab-77e0-addf-1062e81349cf";
  const secondId = "029ffb81-04ab-77e0-addf-1062e81349cf";
  try {
    writeEncryptedFollowUpDraft(filePath, firstId, { content: "第一条未发送追问", attachments: [] }, encrypt, decrypt);
    writeEncryptedFollowUpDraft(filePath, secondId, { content: "", attachments: ["E:\\second.png"] }, encrypt, decrypt);
    assert.equal(readEncryptedFollowUpDraft(filePath, firstId, decrypt)?.content, "第一条未发送追问");
    assert.deepEqual(readEncryptedFollowUpDraft(filePath, secondId, decrypt)?.attachments, ["E:\\second.png"]);
    assert.equal(fs.readFileSync(filePath, "utf8").includes("第一条未发送追问"), false);
    writeEncryptedFollowUpDraft(filePath, firstId, null, encrypt, decrypt);
    assert.equal(readEncryptedFollowUpDraft(filePath, firstId, decrypt), null);
    assert.ok(readEncryptedFollowUpDraft(filePath, secondId, decrypt));
    writeEncryptedFollowUpDraft(filePath, secondId, null, encrypt, decrypt);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed follow-up drafts and task identifier spoofing", () => {
  const taskId = "019ffb81-04ab-77e0-addf-1062e81349cf";
  assert.equal(parsePendingFollowUpDraft({ taskId, content: "", attachments: [] }), null);
  assert.equal(parsePendingFollowUpDraft({ taskId: "../escape", content: "hello", attachments: [] }), null);
  assert.equal(parsePendingFollowUpDraft({ taskId, content: "x".repeat(200_001), attachments: [] }), null);
  assert.ok(parsePendingFollowUpDraft({ taskId, content: "hello", attachments: [] }));
});
