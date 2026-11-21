import { addDays } from "@reeve/broker";

/**
 * The business clock. Each operation has a business date: its start date plus the whole business days
 * that have passed since it was created. At real speed a business day is 24 hours; at demo speed
 * (REEVE_SCHEDULER_DAY_SECONDS=30, say) one business day passes every 30 seconds, so a month of rent
 * can be shown live. On every tick the scheduler advances each idle operation up to its business date;
 * the approved rules.py decides what each day does (bills, reminders, late fees, rule-card schedules).
 */

export interface SchedulerConfig {
  enabled: boolean;
  /** Real seconds per business day (86400 = real time). */
  daySeconds: number;
  /** How often the scheduler looks for operations that are due. */
  tickMs: number;
  /** An operation that fails this many times in a row is paused until someone advances it by hand. */
  maxFailures: number;
}

export const REAL_DAY_SECONDS = 86_400;

export function schedulerFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const enabled = /^(1|on|true|yes)$/i.test(env.REEVE_SCHEDULER?.trim() ?? "");
  const day = Number(env.REEVE_SCHEDULER_DAY_SECONDS);
  const daySeconds = Number.isFinite(day) && day >= 1 ? Math.floor(day) : REAL_DAY_SECONDS;
  const tick = Number(env.REEVE_SCHEDULER_TICK_MS);
  // Look at least twice per business day, never faster than once a second, never slower than once a minute.
  const tickMs = Number.isFinite(tick) && tick >= 250 ? Math.floor(tick) : Math.min(60_000, Math.max(1_000, (daySeconds * 1000) / 2));
  return { enabled, daySeconds, tickMs, maxFailures: 3 };
}

/** What the scheduler remembers about one operation (saved with it). */
export interface SchedulerMemo {
  failures: number;
  lastAdvanceAt?: string;
  lastTarget?: string;
  lastError?: string;
  /** Too many failures in a row: the scheduler leaves it alone until the owner advances it by hand. */
  paused?: boolean;
  /** The clock when it was paused; if the clock moves (a manual advance), the pause ends. */
  pausedAt?: string | null;
}

export type Scheduled<T> = T & { scheduler?: SchedulerMemo };

/** What the operation's JSON shows: the memo plus the live schedule. */
export interface SchedulerView extends SchedulerMemo {
  enabled: boolean;
  daySeconds: number;
  /** The business date the clock should be at now. */
  targetDate: string;
  /** When the next business day starts (ISO time). */
  nextDayAt: string;
}

export const businessDate = (op: { startDate: string; createdAt: string }, nowMs: number, daySeconds: number) => {
  const elapsed = Math.max(0, nowMs - Date.parse(op.createdAt));
  return addDays(op.startDate, Math.floor(elapsed / (daySeconds * 1000)));
};

export function schedulerView(op: Scheduled<{ startDate: string; createdAt: string }>, cfg: SchedulerConfig, nowMs: number): SchedulerView {
  const dayMs = cfg.daySeconds * 1000;
  const elapsed = Math.max(0, nowMs - Date.parse(op.createdAt));
  return {
    failures: 0,
    ...op.scheduler,
    enabled: cfg.enabled,
    daySeconds: cfg.daySeconds,
    targetDate: businessDate(op, nowMs, cfg.daySeconds),
    nextDayAt: new Date(Date.parse(op.createdAt) + (Math.floor(elapsed / dayMs) + 1) * dayMs).toISOString(),
  };
}

export const memoOf = (op: Scheduled<object>): SchedulerMemo => (op.scheduler ??= { failures: 0 });

/** Whether this operation should be advanced now, and to which date. */
export function dueTarget(op: Scheduled<{ startDate: string; createdAt: string; clock: string | null; status: string }>, cfg: SchedulerConfig, nowMs: number): string | null {
  if (op.status === "running") return null;
  if (op.scheduler?.paused) return null;
  const target = businessDate(op, nowMs, cfg.daySeconds);
  if (op.clock !== null && target <= op.clock) return null;
  return target;
}
