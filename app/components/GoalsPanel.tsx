"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type GoalStatus = "active" | "paused" | "completed" | "blocked" | "limit_reached" | "deadline_reached" | "budget_reached";
type GoalTask = {
  id: string; title: string; status: string; goalStatus: GoalStatus; goalObjective: string | null;
  goalProgress: number; goalCompletedTurns: number; goalMaxTurns: number; goalLastSummary: string | null;
  goalNextStep: string | null; goalDeadlineAt: string | null; goalTokenBudget: number; goalTokensUsed: number;
  workspacePath: string | null; updatedAt: string;
};

const labels: Record<GoalStatus, string> = {
  active: "自动推进中", paused: "已暂停", completed: "已完成", blocked: "等待处理",
  limit_reached: "轮次已用完", deadline_reached: "已到截止时间", budget_reached: "Token 已用完",
};

function tokens(value: number): string {
  return value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : value >= 1_000 ? `${Math.round(value / 100) / 10}K` : String(value);
}

function workspaceName(value: string | null): string {
  if (!value) return "临时工作区";
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? value;
}

export function GoalsPanel({ api, onOpenTask, onClose }: { api: string; onOpenTask: (taskId: string) => void; onClose: () => void }) {
  const [goals, setGoals] = useState<GoalTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}/api/goals?includeCompleted=true`, { cache: "no-store" });
      const data = await response.json() as { goals?: GoalTask[]; error?: string };
      if (!response.ok || !data.goals) throw new Error(data.error ?? "目标列表加载失败");
      setGoals(data.goals);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => goals.filter((goal) => showCompleted || goal.goalStatus !== "completed"), [goals, showCompleted]);
  const summary = useMemo(() => ({
    active: goals.filter((goal) => goal.goalStatus === "active").length,
    attention: goals.filter((goal) => ["blocked", "limit_reached", "deadline_reached", "budget_reached"].includes(goal.goalStatus)).length,
    completed: goals.filter((goal) => goal.goalStatus === "completed").length,
  }), [goals]);

  async function action(goal: GoalTask, operation: "pause" | "resume" | "complete") {
    setBusyId(goal.id); setMessage(null);
    try {
      const response = await fetch(`${api}/api/tasks/${goal.id}/goal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: operation,
          additionalTurns: operation === "resume" && goal.goalStatus === "limit_reached" ? 3 : undefined,
          additionalHours: operation === "resume" && goal.goalStatus === "deadline_reached" ? 4 : undefined,
          additionalTokens: operation === "resume" && goal.goalStatus === "budget_reached" ? 100_000 : undefined }),
      });
      const data = await response.json() as { task?: GoalTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "目标操作失败");
      setMessage(operation === "pause" ? "目标会在安全边界暂停。" : operation === "complete" ? "目标已结束。" : "目标已恢复并进入持久队列。");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(null); }
  }

  return <section className="automations-page goals-page">
    <header className="conversation-header"><div className="title-area"><strong className="draft-title">持续目标</strong><div className="header-meta">跨对话查看长期任务进度与资源边界</div></div><div className="header-actions"><label className="goal-completed-toggle"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />显示已完成</label><button onClick={onClose}>返回对话</button></div></header>
    <div className="automations-scroll"><div className="automations-content">
      {message && <div className="notice">{message}<button onClick={() => setMessage(null)}>×</button></div>}
      <div className="automation-summary"><div><strong>{summary.active}</strong><span>自动推进</span></div><div><strong>{summary.attention}</strong><span>需要处理</span></div><div><strong>{summary.completed}</strong><span>已经完成</span></div></div>
      {loading ? <div className="panel-loading">正在读取持续目标…</div> : visible.length === 0 ? <div className="automation-empty"><span>◎</span><h2>{goals.length ? "没有待处理目标" : "还没有持续目标"}</h2><p>{goals.length ? "已完成目标可通过右上角开关查看。" : "新建对话时开启“持续目标”，Agent 会在每轮验证后按预算和截止时间安全续跑。"}</p></div> : <div className="goals-list">{visible.map((goal) => {
        const resumeLabel = goal.goalStatus === "limit_reached" ? "追加 3 轮" : goal.goalStatus === "deadline_reached" ? "延长 4 小时" : goal.goalStatus === "budget_reached" ? "增加 100K Token" : "恢复";
        return <article className={`goal-overview-card ${goal.goalStatus}`} key={goal.id}>
          <header><div><span className={`status-dot ${goal.status}`} /><div><strong>{goal.goalObjective ?? goal.title}</strong><small>{workspaceName(goal.workspacePath)} · {labels[goal.goalStatus]}</small></div></div><b>{goal.goalProgress}%</b></header>
          <div className="goal-progress"><i style={{ width: `${goal.goalProgress}%` }} /></div>
          <p>{goal.goalLastSummary ?? "等待 Agent 完成第一轮并上报进度。"}</p>
          <dl><div><dt>轮次</dt><dd>{goal.goalCompletedTurns} / {goal.goalMaxTurns}</dd></div><div><dt>截止</dt><dd>{goal.goalDeadlineAt ? new Date(goal.goalDeadlineAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "不限"}</dd></div><div><dt>Token</dt><dd>{goal.goalTokenBudget ? `${tokens(goal.goalTokensUsed)} / ${tokens(goal.goalTokenBudget)}` : "不限"}</dd></div></dl>
          {goal.goalNextStep && <div className="goal-next-step"><span>下一步</span><p>{goal.goalNextStep}</p></div>}
          <footer><button onClick={() => onOpenTask(goal.id)}>打开对话</button><div>{goal.goalStatus === "active" ? <button disabled={busyId === goal.id} onClick={() => void action(goal, "pause")}>暂停</button> : goal.goalStatus !== "completed" ? <button className="primary" disabled={busyId === goal.id} onClick={() => void action(goal, "resume")}>{resumeLabel}</button> : null}{goal.goalStatus !== "completed" && <button disabled={busyId === goal.id} onClick={() => void action(goal, "complete")}>结束</button>}</div></footer>
        </article>;
      })}</div>}
    </div></div>
  </section>;
}
