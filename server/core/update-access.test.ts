import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearEncryptedUpdateAccessToken,
  normalizeUpdateAccessToken,
  readEncryptedUpdateAccessToken,
  redactUpdateError,
  shouldOfferUpdate,
  writeEncryptedUpdateAccessToken,
} from "../../desktop/update-access.js";

const encrypt = (value: string) => Buffer.from(`protected:${value}`, "utf8");
const decrypt = (value: Buffer) => value.toString("utf8").replace(/^protected:/u, "");

test("stores a validated update token without exposing plaintext through the reader contract", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-update-access-"));
  const filePath = path.join(directory, "update-access.bin");
  try {
    writeEncryptedUpdateAccessToken(filePath, " github_pat_private_repo_123 ", encrypt);
    assert.equal(readEncryptedUpdateAccessToken(filePath, decrypt), "github_pat_private_repo_123");
    writeEncryptedUpdateAccessToken(filePath, "github_pat_replaced_456", encrypt);
    assert.equal(readEncryptedUpdateAccessToken(filePath, decrypt), "github_pat_replaced_456");
    assert.equal(fs.existsSync(`${filePath}.${process.pid}.tmp`), false);
    clearEncryptedUpdateAccessToken(filePath);
    assert.equal(readEncryptedUpdateAccessToken(filePath, decrypt), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe update token values and redacts updater failures", () => {
  assert.equal(normalizeUpdateAccessToken(""), null);
  assert.equal(normalizeUpdateAccessToken("token with spaces"), null);
  assert.equal(normalizeUpdateAccessToken("x".repeat(4_097)), null);
  assert.equal(normalizeUpdateAccessToken("ghp_valid123"), "ghp_valid123");
  const secret = "github_pat_never_log_this_123";
  const redacted = redactUpdateError(new Error(`request failed token=${secret}`), secret);
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /REDACTED/u);
});

test("never offers an older private release as an update", () => {
  assert.equal(shouldOfferUpdate("0.34.0", "0.33.0", false), false);
  assert.equal(shouldOfferUpdate("0.34.0", "0.34.0", true), false);
  assert.equal(shouldOfferUpdate("0.34.0", "0.35.0", true), true);
});
