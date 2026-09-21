import type { AutomationScheduleKind } from "./types.js";

export type AutomationSchedule = {
  scheduleKind: AutomationScheduleKind;
  onceAt?: string | null;
  intervalMinutes?: number | null;
  timeOfDay?: string | null;
  weekdays?: number[];
};

const minuteMs = 60_000;

function parseTimeOfDay(value: string | null | undefined): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) throw new Error("A valid local time is required");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error("A valid local time is required");
  return [hours, minutes];
}

function atLocalTime(base: Date, dayOffset: number, timeOfDay: string | null | undefined): Date {
  const [hours, minutes] = parseTimeOfDay(timeOfDay);
  const result = new Date(base);
  result.setSeconds(0, 0);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

export function computeNextAutomationRun(schedule: AutomationSchedule, from = new Date()): string | null {
  if (!Number.isFinite(from.getTime())) throw new Error("Invalid schedule reference time");
  if (schedule.scheduleKind === "once") {
    const once = new Date(schedule.onceAt ?? "");
    if (!Number.isFinite(once.getTime()) || once.getTime() <= from.getTime()) throw new Error("One-time execution must be in the future");
    return once.toISOString();
  }
  if (schedule.scheduleKind === "interval") {
    const minutes = Math.trunc(schedule.intervalMinutes ?? 0);
    if (minutes < 15 || minutes > 43_200) throw new Error("Interval must be between 15 minutes and 30 days");
    return new Date(from.getTime() + minutes * minuteMs).toISOString();
  }
  if (schedule.scheduleKind === "daily") {
    const today = atLocalTime(from, 0, schedule.timeOfDay);
    return (today.getTime() > from.getTime() ? today : atLocalTime(from, 1, schedule.timeOfDay)).toISOString();
  }
  const weekdays = [...new Set(schedule.weekdays ?? [])].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!weekdays.length) throw new Error("Choose at least one weekday");
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = atLocalTime(from, offset, schedule.timeOfDay);
    if (weekdays.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) return candidate.toISOString();
  }
  throw new Error("Unable to calculate the next weekly run");
}

export function describeAutomationSchedule(schedule: AutomationSchedule): string {
  if (schedule.scheduleKind === "once") return `执行一次 · ${new Date(schedule.onceAt ?? "").toLocaleString()}`;
  if (schedule.scheduleKind === "interval") return `每 ${schedule.intervalMinutes} 分钟`;
  if (schedule.scheduleKind === "daily") return `每天 ${schedule.timeOfDay}`;
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${(schedule.weekdays ?? []).map((day) => labels[day]).join("、")} ${schedule.timeOfDay}`;
}
