import fs from "node:fs";
import path from "node:path";

const maximumTokenLength = 4_096;

export function normalizeUpdateAccessToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > maximumTokenLength || /\s/u.test(token)) return null;
  return token;
}

export function readEncryptedUpdateAccessToken(filePath: string, decrypt: (value: Buffer) => string): string | null {
  try {
    const encrypted = fs.readFileSync(filePath);
    if (encrypted.byteLength === 0 || encrypted.byteLength > 64_000) return null;
    return normalizeUpdateAccessToken(decrypt(encrypted));
  } catch {
    return null;
  }
}

export function writeEncryptedUpdateAccessToken(filePath: string, value: unknown, encrypt: (value: string) => Buffer): void {
  const token = normalizeUpdateAccessToken(value);
  if (!token) throw new Error("GitHub 更新令牌为空、包含空白字符或超过保存上限");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, encrypt(token), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function clearEncryptedUpdateAccessToken(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }); } catch { /* absence and locked cleanup are harmless */ }
}

export function redactUpdateError(error: unknown, token?: string | null): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.replaceAll(token, "[REDACTED]");
  return message
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gu, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gu, "[REDACTED]")
    .replace(/((?:authorization|token)\s*[:=]\s*)(?:bearer\s+|token\s+)?[^\s,;]+/giu, "$1[REDACTED]");
}

export function shouldOfferUpdate(currentVersion: string, nextVersion: string | null | undefined, isUpdateAvailable: boolean): nextVersion is string {
  return isUpdateAvailable && Boolean(nextVersion) && nextVersion !== currentVersion;
}
