"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ModelChoice = { provider: string; providerLabel: string; model: string; displayName: string; supportedReasoningEfforts: string[] };
type Automation = {
  id: string; name: string; prompt: string; runtime: "mock" | "codex"; provider: string; model: string | null;
  reasoningEffort: string | null; sandboxMode: string; approvalPolicy: string; approvalsReviewer: string;
  workspacePath: string | null; scheduleKind: "once" | "interval" | "daily" | "weekly";
  onceAt: string | null; intervalMinutes: number | null; timeOfDay: string | null; weekdays: number[];
  status: "active" | "paused"; nextRunAt: string | null; lastRunAt: string | null; updatedAt: string;
};
type AutomationRun = { id: string; automationId: string; taskId: string | null; state: "queued" | "failed"; taskStatus?: string | null; scheduledFor: string; error: string | null; createdAt: string };

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

function localDateTimeValue(date = new Date(Date.now() + 3_600_000)): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function dateLabel(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function scheduleLabel(automation: Automation): string {
  if (automation.scheduleKind === "once") return `执行一次 · ${dateLabel(automation.onceAt)}`;
  if (automation.scheduleKind === "interval") return `每 ${automation.intervalMinutes} 分钟`;
  if (automation.scheduleKind === "daily") return `每天 ${automation.timeOfDay}`;
  return `${automation.weekdays.map((day) => `周${weekdayLabels[day]}`).join("、")} ${automation.timeOfDay}`;
}

const initialForm = {
  name: "", prompt: "", runtime: "codex" as "mock" | "codex", provider: "openai", model: "",
  reasoningEffort: "medium", sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
  workspacePath: "", scheduleKind: "daily" as Automation["scheduleKind"], onceAt: localDateTimeValue(),
  intervalMinutes: 60, timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] as number[],
};

export function AutomationsPanel({ api, modelChoices, onOpenTask, onClose }: { api: string; modelChoices: ModelChoice[]; onOpenTask: (taskId: string) => void; onClose: () => void }) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`${api}/api/automations`, { cache: "no-store" });
    const data = await response.json() as { automations?: Automation[]; runs?: AutomationRun[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "无法读取自动化任务");
    setAutomations(data.automations ?? []); setRuns(data.runs ?? []);
  }, [api]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error))), 0);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const runsByAutomation = useMemo(() => new Map(automations.map((automation) => [automation.id, runs.filter((run) => run.automationId === automation.id)])), [automations, runs]);

  function resetForm() {
    const choice = modelChoices[0];
    setForm({ ...initialForm, onceAt: localDateTimeValue(), provider: choice?.provider ?? "openai", model: choice?.model ?? "" });
    setEditingId(null); setFormOpen(false); setMessage(null);
  }

  function openCreateForm() {
    const choice = modelChoices[0];
    setForm({ ...initialForm, onceAt: localDateTimeValue(), provider: choice?.provider ?? "openai", model: choice?.model ?? "" });
    setEditingId(null); setFormOpen(true); setMessage(null);
  }

  function editAutomation(automation: Automation) {
    setEditingId(automation.id); setFormOpen(true); setMessage(null);
    setForm({
      name: automation.name, prompt: automation.prompt, runtime: automation.runtime, provider: automation.provider,
      model: automation.model ?? "", reasoningEffort: automation.reasoningEffort ?? "medium", sandboxMode: automation.sandboxMode,
      approvalPolicy: automation.approvalPolicy, approvalsReviewer: automation.approvalsReviewer,
      workspacePath: automation.workspacePath ?? "", scheduleKind: automation.scheduleKind,
      onceAt: automation.onceAt ? localDateTimeValue(new Date(automation.onceAt)) : localDateTimeValue(),
      intervalMinutes: automation.intervalMinutes ?? 60, timeOfDay: automation.timeOfDay ?? "09:00",
      weekdays: automation.weekdays.length ? automation.weekdays : [1, 2, 3, 4, 5],
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      const payload = {
        ...form, model: form.runtime === "mock" ? "mock" : form.model || null,
        workspacePath: form.workspacePath || null,
        onceAt: form.scheduleKind === "once" ? new Date(form.onceAt).toISOString() : null,
        intervalMinutes: form.scheduleKind === "interval" ? form.intervalMinutes : null,
        timeOfDay: form.scheduleKind === "daily" || form.scheduleKind === "weekly" ? form.timeOfDay : null,
        weekdays: form.scheduleKind === "weekly" ? form.weekdays : [], status: "active",
      };
      const response = await fetch(editingId ? `${api}/api/automations/${editingId}` : `${api}/api/automations`, {
        method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存自动化失败");
      resetForm(); await refresh(); setMessage(editingId ? "自动化已更新。" : "自动化已创建，关闭应用后计划仍会保留。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function chooseWorkspace() {
    const selected = await window.agentDesktop?.selectWorkspace();
    if (selected) setForm({ ...form, workspacePath: selected });
  }

  async function action(automation: Automation, operation: "toggle" | "run" | "delete") {
    setBusy(true); setMessage(null);
    try {
      const response = operation === "toggle"
        ? await fetch(`${api}/api/automations/${automation.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: automation.status === "active" ? "paused" : "active" }) })
        : operation === "run"
          ? await fetch(`${api}/api/automations/${automation.id}/run`, { method: "POST" })
          : await fetch(`${api}/api/automations/${automation.id}`, { method: "DELETE" });
      const data = response.status === 204 ? {} : await response.json() as { error?: string; task?: { id: string } };
      if (!response.ok) throw new Error(data.error ?? "操作失败");
      await refresh();
      if (operation === "run" && data.task?.id) { setMessage("已立即创建一次运行。"); onOpenTask(data.task.id); }
      else setMessage(operation === "delete" ? "自动化已删除。" : automation.status === "active" ? "自动化已暂停。" : "自动化已恢复。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <div className="automations-page">
    <header className="conversation-header"><div className="title-area"><strong className="draft-title">自动化</strong><div className="header-meta">按计划创建独立 Agent 任务，重启后继续生效</div></div><div className="header-actions"><button onClick={onClose}>返回对话</button><button className="primary" onClick={openCreateForm}>新建自动化</button></div></header>
    <div className="automations-scroll"><div className="automations-content">
      {message && <div className="notice">{message}<button onClick={() => setMessage(null)}>×</button></div>}
      <div className="automation-summary"><div><strong>{automations.filter((item) => item.status === "active").length}</strong><span>正在运行</span></div><div><strong>{automations.length}</strong><span>全部计划</span></div><div><strong>{runs.length}</strong><span>最近运行</span></div></div>
      {automations.length === 0 ? <div className="automation-empty"><span>◷</span><h2>让 Agent 按计划工作</h2><p>可以定时整理资料、检查项目或生成报告。每次执行都会创建独立对话，保留完整事件和文件变更。</p><button className="primary" onClick={openCreateForm}>创建第一个自动化</button></div> : <div className="automation-list">{automations.map((automation) => <article className={`automation-card ${automation.status}`} key={automation.id}>
        <div className="automation-card-head"><div><span className={`status-dot ${automation.status === "active" ? "succeeded" : "cancelled"}`} /><strong>{automation.name}</strong><small>{automation.status === "active" ? "运行中" : "已暂停"}</small></div><div><button onClick={() => editAutomation(automation)}>编辑</button><button disabled={busy} onClick={() => void action(automation, "run")}>立即运行</button><button disabled={busy} onClick={() => void action(automation, "toggle")}>{automation.status === "active" ? "暂停" : "恢复"}</button><button className="danger-text" disabled={busy} onClick={() => { if (window.confirm(`删除自动化“${automation.name}”？已创建的任务不会删除。`)) void action(automation, "delete"); }}>删除</button></div></div>
        <p>{automation.prompt}</p><div className="automation-meta"><span>◷ {scheduleLabel(automation)}</span><span>⌁ {automation.workspacePath || "自动工作区"}</span><span>{automation.provider} · {automation.model ?? automation.runtime}</span></div>
        <div className="automation-next"><span>下次运行 <strong>{automation.status === "active" ? dateLabel(automation.nextRunAt) : "已暂停"}</strong></span><span>上次运行 <strong>{dateLabel(automation.lastRunAt)}</strong></span></div>
        {(runsByAutomation.get(automation.id)?.length ?? 0) > 0 && <details className="automation-runs"><summary>最近运行</summary>{runsByAutomation.get(automation.id)!.map((run) => <button key={run.id} disabled={!run.taskId} onClick={() => run.taskId && onOpenTask(run.taskId)}><span>{run.state === "failed" ? "启动失败" : run.taskStatus === "succeeded" ? "已完成" : run.taskStatus === "failed" ? "执行失败" : run.taskStatus === "cancelled" ? "已停止" : "正在执行"}</span><time>{dateLabel(run.createdAt)}</time><small>{run.error ?? (run.taskId ? `任务 ${run.taskId.slice(0, 8)}` : "")}</small></button>)}</details>}
      </article>)}</div>}
    </div></div>
    {formOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) resetForm(); }}><form className="new-task-modal automation-modal" onSubmit={save}>
      <header><div><span>自动化任务</span><h2>{editingId ? "编辑计划" : "新建计划"}</h2></div><button type="button" onClick={resetForm}>×</button></header>
      <label className="field"><span>名称</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：每天整理项目进度" /></label>
      <label className="field"><span>每次交给 Agent 的任务</span><textarea rows={5} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="明确说明需要检查什么、产出什么以及完成标准" /></label>
      <div className="form-grid"><label className="field"><span>频率</span><select value={form.scheduleKind} onChange={(event) => setForm({ ...form, scheduleKind: event.target.value as Automation["scheduleKind"] })}><option value="once">执行一次</option><option value="interval">固定间隔</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {form.scheduleKind === "once" && <label className="field"><span>执行时间</span><input type="datetime-local" value={form.onceAt} onChange={(event) => setForm({ ...form, onceAt: event.target.value })} /></label>}
        {form.scheduleKind === "interval" && <label className="field"><span>间隔分钟</span><input type="number" min="15" max="43200" value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })} /></label>}
        {(form.scheduleKind === "daily" || form.scheduleKind === "weekly") && <label className="field"><span>本机时间</span><input type="time" value={form.timeOfDay} onChange={(event) => setForm({ ...form, timeOfDay: event.target.value })} /></label>}
      </div>
      {form.scheduleKind === "weekly" && <div className="weekday-picker">{weekdayLabels.map((label, day) => <button type="button" className={form.weekdays.includes(day) ? "active" : ""} key={day} onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(day) ? form.weekdays.filter((value) => value !== day) : [...form.weekdays, day].sort() })}>周{label}</button>)}</div>}
      <label className="field"><span>工作区</span><div className="path-picker"><input value={form.workspacePath} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} placeholder="留空则自动创建工作区" /><button type="button" onClick={() => void chooseWorkspace()}>选择文件夹</button></div></label>
      <div className="form-grid"><label className="field"><span>运行时</span><select value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value as "mock" | "codex" })}><option value="codex">Codex</option><option value="mock">Mock 演示</option></select></label><label className="field"><span>模型</span><select disabled={form.runtime === "mock"} value={form.model ? `${form.provider}:${form.model}` : ""} onChange={(event) => { const [provider, ...model] = event.target.value.split(":"); setForm({ ...form, provider, model: model.join(":") }); }}><option value="" disabled>请选择模型</option>{modelChoices.map((choice) => <option key={`${choice.provider}:${choice.model}`} value={`${choice.provider}:${choice.model}`}>{choice.providerLabel} · {choice.displayName}</option>)}</select></label><label className="field"><span>推理深度</span><select value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value })}><option value="minimal">最少</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="ultra">Ultra</option></select></label></div>
      <div className="form-grid"><label className="field"><span>沙箱</span><select value={form.sandboxMode} onChange={(event) => setForm({ ...form, sandboxMode: event.target.value })}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">完全访问</option></select></label><label className="field"><span>审批</span><select value={form.approvalPolicy} onChange={(event) => setForm({ ...form, approvalPolicy: event.target.value })}><option value="untrusted">非可信操作询问</option><option value="on-request">请求批准</option><option value="never">无需批准</option></select></label><label className="field"><span>批准人</span><select value={form.approvalsReviewer} onChange={(event) => setForm({ ...form, approvalsReviewer: event.target.value })}><option value="user">我批准</option><option value="auto_review">帮我批准</option></select></label></div>
      <footer><button type="button" onClick={resetForm} disabled={busy}>取消</button><button className="primary" disabled={busy || !form.name.trim() || !form.prompt.trim() || (form.runtime === "codex" && !form.model)}>{busy ? "正在保存…" : editingId ? "保存修改" : "创建自动化"}</button></footer>
    </form></div>}
  </div>;
}
