import type { AppConfig } from "./config.js";
import type { Approval } from "./types.js";
import { EventBus } from "./event-bus.js";
import { TaskStore } from "./store.js";

export class ApprovalNotifier {
  constructor(private readonly store: TaskStore, private readonly bus: EventBus, private readonly config: AppConfig) {}

  async notify(approval: Approval): Promise<void> {
    const url = this.config.approvalWebhookUrl;
    if (!url) return;
    const key = `approval-webhook:${approval.id}`;
    const operation = this.store.beginIdempotent(approval.taskId, key, "approval.webhook");
    if (!operation.fresh) return;
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ event: "approval.requested", approval: { id: approval.id, taskId: approval.taskId, title: approval.title, description: approval.description, risk: approval.risk, kind: approval.kind, command: approval.command, cwd: approval.cwd, path: approval.path, networkHost: approval.networkHost, scope: approval.scope, createdAt: approval.createdAt } }),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      this.store.finishIdempotent(key, "completed", { status: response.status });
      this.bus.publish(this.store.appendEvent(approval.taskId, "approval.notification.sent", { schemaVersion: 1, category: "approval", phase: "completed", turnId: `${approval.taskId}:notification`, title: "审批通知已发送", approvalId: approval.id }));
    } catch (error) {
      this.store.finishIdempotent(key, "failed", { error: error instanceof Error ? error.message : String(error) });
      this.bus.publish(this.store.appendEvent(approval.taskId, "approval.notification.failed", { schemaVersion: 1, category: "approval", phase: "failed", turnId: `${approval.taskId}:notification`, title: "审批通知发送失败", approvalId: approval.id, detail: error instanceof Error ? error.message : String(error) }));
    }
  }
}
