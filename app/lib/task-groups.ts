export type ProjectGroupTask = {
  id: string;
  workspacePath: string | null;
  projectWorkspacePath?: string | null;
  section?: string | null;
};

export type ProjectTaskGroup<T extends ProjectGroupTask> = {
  key: string;
  label: string;
  path: string | null;
  tasks: T[];
};

const managedWorkspacePattern = /[\\/]\.agent-data[\\/]workspaces[\\/][0-9a-f-]{36}$/i;

export function workspaceName(workspacePath: string | null): string {
  if (!workspacePath) return "临时工作区";
  if (managedWorkspacePattern.test(workspacePath)) return "Agent Foundry Local";
  const parts = workspacePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? workspacePath;
}

function workspaceGroupKey(workspacePath: string | null): string {
  if (!workspacePath) return "workspace:temporary";
  if (managedWorkspacePattern.test(workspacePath)) return "workspace:agent-foundry-local";
  const normalized = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const caseInsensitive = /^[a-z]:\//i.test(normalized) || workspacePath.startsWith("\\\\");
  return `workspace:${caseInsensitive ? normalized.toLocaleLowerCase() : normalized}`;
}

export function groupTasksByProject<T extends ProjectGroupTask>(tasks: T[]): ProjectTaskGroup<T>[] {
  const groups = new Map<string, ProjectTaskGroup<T>>();
  for (const task of tasks) {
    const projectPath = task.projectWorkspacePath ?? task.workspacePath;
    const key = task.section ? `section:${task.section.toLocaleLowerCase()}` : workspaceGroupKey(projectPath);
    const existing = groups.get(key);
    if (existing) existing.tasks.push(task);
    else groups.set(key, { key, label: task.section || workspaceName(projectPath), path: projectPath, tasks: [task] });
  }
  return [...groups.values()];
}
