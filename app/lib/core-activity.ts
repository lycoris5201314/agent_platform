export type ActivityEvent = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

const relationshipEvents = new Set([
  "automation.task.created",
  "child-task.created",
  "conversation.branch.created",
  "conversation.branch.origin",
  "turn.workspace.summary",
]);

const waitingEvents = new Set([
  "task.waiting",
  "task.wait.resuming",
  "task.external.waiting",
  "task.external.resuming",
  "task.retry.scheduled",
  "task.recovered",
  "task.lease.recovered",
  "verification.repair.started",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function itemType(event: ActivityEvent): string {
  const item = event.payload.item;
  return item && typeof item === "object" && !Array.isArray(item)
    ? text((item as Record<string, unknown>).type)
    : "";
}

function itemRecord(event: ActivityEvent): Record<string, unknown> {
  const direct = event.payload.item;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const rawEvent = event.payload.event;
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return {};
  const legacyItem = (rawEvent as Record<string, unknown>).item;
  return legacyItem && typeof legacyItem === "object" && !Array.isArray(legacyItem) ? legacyItem as Record<string, unknown> : {};
}

function activityKey(event: ActivityEvent): string | null {
  const { payload, type } = event;
  if (payload.hidden === true || relationshipEvents.has(type)) return null;

  if (type === "agent.tool.output" || type === "agent.turn.usage" || type === "agent.workspace.diff") return null;
  if (/^(?:task\.(?:created|preparing|running|succeeded|updated)|memory\.|sandbox\.|workspace\.ready|turn\.workspace\.baseline|agent\.turn\.(?:started|completed))/.test(type)) return null;

  if (type === "error" || type.includes("failed") || type === "agent.runtime.error") return `error:${event.id}`;

  if (type.startsWith("approval.notification.")) return null;
  if (type.startsWith("approval.") || type === "agent.approval.resolved") {
    return `approval:${text(payload.approvalId) || text(payload.toolCallId) || event.id}`;
  }

  if (waitingEvents.has(type)) return `wait:${type}`;

  if (type === "agent.plan.updated") return "thought:latest-plan";
  if (type === "agent.plan") return "thought:latest-plan";
  if (type.startsWith("agent.step.")) {
    const kind = itemType(event);
    if (kind !== "reasoning" && kind !== "plan") return null;
    return `thought:${text(payload.stepId) || event.id}`;
  }

  if (type.startsWith("agent.tool.") || type.startsWith("terminal.command.") || type.startsWith("workspace.change.")) {
    return `tool:${text(payload.toolCallId) || text(payload.stepId) || event.id}`;
  }
  if (type === "tool.started" || type === "tool.completed") {
    return `tool:${text(payload.toolCallId) || text(payload.tool) || text(payload.command) || event.id}`;
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = itemRecord(event);
    const kind = text(item.type);
    const itemId = text(item.id);
    if (kind === "reasoning" || kind === "plan") return `thought:${itemId || kind}`;
    if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(kind)) {
      return `tool:${itemId || text(item.command) || text(item.query) || event.id}`;
    }
    if (kind === "error") return `error:${event.id}`;
    return null;
  }

  if (type.startsWith("verification.check.")) {
    return `verification:${text(payload.stepId) || text(payload.command) || event.id}`;
  }
  if (type === "verification.started" || type === "verification.completed") return "verification:overall";

  return null;
}

/**
 * Produces the Codex-style activity stream shown in the conversation. Durable
 * events stay untouched in storage; this view removes transport chatter and
 * keeps only the latest state for each command, reasoning step, approval, and
 * verification check.
 */
export function selectCoreActivityEvents<T extends ActivityEvent>(events: T[]): T[] {
  const latest = new Map<string, { event: T; index: number }>();
  events.forEach((event, index) => {
    const key = activityKey(event);
    if (key) latest.set(key, { event, index });
  });
  return [...latest.values()].sort((left, right) => left.index - right.index).map(({ event }) => event);
}
