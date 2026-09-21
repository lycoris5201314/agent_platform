export type SlashCommandName =
  | "compact"
  | "delegate"
  | "feedback"
  | "files"
  | "fork"
  | "model"
  | "new"
  | "reasoning"
  | "review"
  | "settings"
  | "status"
  | "stop"
  | "terminal"
  | "changes";

export type SlashCommand = {
  name: SlashCommandName;
  label: string;
  description: string;
  keywords: string;
  requiresTask?: boolean;
  requiresThread?: boolean;
  requiresActive?: boolean;
  requiresIdle?: boolean;
  mainWindowOnly?: boolean;
};

export type SlashCommandContext = {
  hasTask: boolean;
  hasThread: boolean;
  active: boolean;
  detached: boolean;
};

export const slashCommandCatalog: SlashCommand[] = [
  { name: "status", label: "任务状态", description: "查看模型、权限、上下文与运行状态", keywords: "detail info 状态 详情", requiresTask: true },
  { name: "files", label: "工作区文件", description: "打开右侧文件浏览器", keywords: "workspace file 文件 工作区", requiresTask: true },
  { name: "changes", label: "本轮变更", description: "查看最近一轮修改的文件", keywords: "diff git change 变更", requiresTask: true },
  { name: "terminal", label: "终端", description: "打开当前任务的交互终端", keywords: "shell powershell 命令行", requiresTask: true },
  { name: "model", label: "选择模型", description: "聚焦当前对话的模型选择器", keywords: "provider 模型 服务", requiresIdle: true },
  { name: "reasoning", label: "推理深度", description: "聚焦推理深度选择器", keywords: "effort thinking 推理 思考", requiresIdle: true },
  { name: "compact", label: "压缩上下文", description: "压缩当前 Codex 对话上下文", keywords: "context 压缩 上下文", requiresTask: true, requiresThread: true, requiresIdle: true },
  { name: "fork", label: "创建分支", description: "从当前对话创建独立分支", keywords: "branch worktree 分支", requiresTask: true, requiresThread: true },
  { name: "review", label: "审阅变更", description: "审阅当前工作区的未提交修改", keywords: "review diff 审查 审阅", requiresTask: true, requiresThread: true, requiresIdle: true },
  { name: "delegate", label: "委派子 Agent", description: "把一个独立子任务交给并行 Agent", keywords: "subagent child 委派 子任务", requiresTask: true },
  { name: "stop", label: "停止执行", description: "中断当前模型回合", keywords: "cancel interrupt 停止 中断", requiresTask: true, requiresActive: true },
  { name: "new", label: "新建对话", description: "打开一个不会立即保存的临时对话", keywords: "task chat 新建 对话", mainWindowOnly: true },
  { name: "settings", label: "平台设置", description: "打开模型服务、沙箱与诊断设置", keywords: "config 设置 配置" },
  { name: "feedback", label: "导出反馈资料", description: "生成脱敏诊断包并打开所在文件夹", keywords: "diagnostic logs bug 反馈 日志" },
];

function available(command: SlashCommand, context: SlashCommandContext): boolean {
  if (command.requiresTask && !context.hasTask) return false;
  if (command.requiresThread && !context.hasThread) return false;
  if (command.requiresActive && !context.active) return false;
  if (command.requiresIdle && context.active) return false;
  if (command.mainWindowOnly && context.detached) return false;
  return true;
}

export function matchingSlashCommands(input: string, context: SlashCommandContext): SlashCommand[] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const query = input.slice(1).toLocaleLowerCase();
  return slashCommandCatalog.filter((command) => available(command, context) && (
    !query || command.name.includes(query) || command.label.toLocaleLowerCase().includes(query) || command.keywords.toLocaleLowerCase().includes(query)
  ));
}
