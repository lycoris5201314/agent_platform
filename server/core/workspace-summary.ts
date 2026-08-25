export interface WorkspaceChange {
  status: string;
  path: string;
  additions: number | null;
  deletions: number | null;
}

const TRANSIENT_SEGMENTS = new Set([
  "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".cache", ".npm", "npm-cache", ".pnpm-store", ".yarn", ".venv", "venv", "coverage",
]);
const TRANSIENT_ROOTS = new Set(["tmp", "temp", ".tmp", ".temp"]);

/** Decode the C-style quoting Git uses for non-ASCII paths by default. */
export function decodeGitPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  const source = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const next = source[index + 1];
    if (next && /[0-7]/.test(next)) {
      const octal = source.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const escaped: Record<string, number> = { "\\": 92, '"': 34, t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 };
    if (next && escaped[next] !== undefined) {
      bytes.push(escaped[next]);
      index += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function isUserVisibleWorkspacePath(value: string): boolean {
  const normalized = decodeGitPath(value).replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (TRANSIENT_ROOTS.has(segments[0].toLowerCase())) return false;
  return !segments.some((segment) => TRANSIENT_SEGMENTS.has(segment.toLowerCase()));
}

export function userVisibleWorkspaceChanges(values: unknown): WorkspaceChange[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const filePath = decodeGitPath(String(record.path ?? ""));
    if (!filePath || !isUserVisibleWorkspacePath(filePath)) return [];
    const additions = typeof record.additions === "number" && Number.isFinite(record.additions) ? record.additions : null;
    const deletions = typeof record.deletions === "number" && Number.isFinite(record.deletions) ? record.deletions : null;
    return [{ status: String(record.status ?? "M"), path: filePath, additions, deletions }];
  });
}

export function workspaceSummaryFields(payload: Record<string, unknown>, limit = 200): Record<string, unknown> {
  const changes = userVisibleWorkspaceChanges(payload.changes);
  const additions = changes.reduce((sum, change) => sum + (change.additions ?? 0), 0);
  const deletions = changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0);
  const outputs = changes.filter((change) => change.status.startsWith("A")).map((change) => change.path);
  return {
    title: `本轮修改了 ${changes.length} 个文件`,
    changes: changes.slice(0, limit), changeCount: changes.length, changesTruncated: changes.length > limit,
    additions, deletions, outputs: outputs.slice(0, limit), outputsTruncated: outputs.length > limit,
    diffTruncated: Boolean(payload.diffTruncated) || changes.length > limit,
  };
}
