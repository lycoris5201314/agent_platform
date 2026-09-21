import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DatabaseBackupInspection = {
  path: string;
  bytes: number;
  integrity: "ok";
  schemaVersion: number;
  taskCount: number;
};

function scalarNumber(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as unknown as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? {})[0] ?? 0);
}

export function inspectDatabaseBackup(filePath: string): DatabaseBackupInspection {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error("所选备份不是有效的数据库文件");
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA quick_check").all() as unknown as Array<Record<string, unknown>>;
    const integrity = integrityRows.flatMap((row) => Object.values(row).map(String)).join("; ");
    if (integrity.toLowerCase() !== "ok") throw new Error(`备份完整性检查失败：${integrity || "没有检查结果"}`);
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const required of ["tasks", "task_messages", "schema_migrations"]) {
      if (!tables.has(required)) throw new Error(`所选文件不是 Agent Foundry 对话备份：缺少 ${required} 表`);
    }
    return {
      path: resolved,
      bytes: stat.size,
      integrity: "ok",
      schemaVersion: scalarNumber(database, "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"),
      taskCount: scalarNumber(database, "SELECT COUNT(*) FROM tasks"),
    };
  } finally {
    database.close();
  }
}

export function stageDatabaseRestore(sourcePath: string, dataDirectory: string): { stagedPath: string; inspection: DatabaseBackupInspection } {
  const inspection = inspectDatabaseBackup(sourcePath);
  const resolvedDataDirectory = path.resolve(dataDirectory);
  fs.mkdirSync(resolvedDataDirectory, { recursive: true });
  const stagedPath = path.join(resolvedDataDirectory, `.restore-${randomUUID()}.db`);
  fs.copyFileSync(inspection.path, stagedPath, fs.constants.COPYFILE_EXCL);
  try {
    const stagedInspection = inspectDatabaseBackup(stagedPath);
    return { stagedPath, inspection: stagedInspection };
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw error;
  }
}

export function applyStagedDatabaseRestore(stagedPath: string, databasePath: string): void {
  const resolvedDatabasePath = path.resolve(databasePath);
  const dataDirectory = path.dirname(resolvedDatabasePath);
  const resolvedStagedPath = path.resolve(stagedPath);
  if (path.dirname(resolvedStagedPath) !== dataDirectory || !/^\.restore-[a-f0-9-]+\.db$/iu.test(path.basename(resolvedStagedPath))) {
    throw new Error("待恢复数据库不在受控数据目录中");
  }
  inspectDatabaseBackup(resolvedStagedPath);
  const replacementPath = `${resolvedDatabasePath}.restore-new`;
  const previousPath = `${resolvedDatabasePath}.restore-previous`;
  fs.rmSync(replacementPath, { force: true });
  fs.rmSync(previousPath, { force: true });
  fs.copyFileSync(resolvedStagedPath, replacementPath, fs.constants.COPYFILE_EXCL);
  inspectDatabaseBackup(replacementPath);
  const hadCurrent = fs.existsSync(resolvedDatabasePath);
  if (hadCurrent) fs.renameSync(resolvedDatabasePath, previousPath);
  try {
    fs.renameSync(replacementPath, resolvedDatabasePath);
    fs.rmSync(`${resolvedDatabasePath}-wal`, { force: true });
    fs.rmSync(`${resolvedDatabasePath}-shm`, { force: true });
    if (hadCurrent) fs.rmSync(previousPath, { force: true });
    fs.rmSync(resolvedStagedPath, { force: true });
  } catch (error) {
    fs.rmSync(replacementPath, { force: true });
    if (hadCurrent && fs.existsSync(previousPath) && !fs.existsSync(resolvedDatabasePath)) fs.renameSync(previousPath, resolvedDatabasePath);
    throw error;
  }
}
