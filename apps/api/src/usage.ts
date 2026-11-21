import type { GenericOperationRecord, OperationRecord } from "@reeve/broker";
import { fxRate, PRICING_SOURCE, usdToIdr, USAGE_PHASES, type FxRate, type UsagePhase } from "@reeve/llm";
import type { UsageRecord } from "./store";

/**
 * The cost meter: what the model calls of a workspace cost, set against what plain code did without one.
 * Only measured numbers go in here: tokens from the providers' own usage blocks, prices from the price table,
 * one stated exchange rate. No estimate and no "what it would have cost otherwise".
 */

export interface Totals {
  /** Calls to a real model. */
  calls: number;
  /** Calls answered by the offline sample provider: no model ran, no tokens, no cost. */
  sampleCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** USD of the calls whose price is known. */
  usd: number;
  /** `usd` at the stated rate. */
  idr: number;
  /** Calls whose model has no known price: their tokens are counted, their cost is not (shown as "tidak diketahui"). */
  unpricedCalls: number;
}

export interface UsageQuery {
  rulebookId?: string;
  operationId?: string;
  /** "YYYY-MM" in Jakarta time; the current month by default. */
  month?: string;
}

export type ByPhase = Record<UsagePhase, Totals>;

export interface UsageSummary {
  rate: FxRate;
  prices: { source: string; checked: string };
  month: string;
  scope: { rulebookId?: string; operationId?: string };
  total: Totals;
  thisMonth: Totals;
  byPhase: ByPhase;
  thisMonthByPhase: ByPhase;
  /** Actions the approved rules decided and plain code carried out (no model involved). */
  deterministicSteps: number;
  byRulebook: { rulebookId: string | null; total: Totals; thisMonth: Totals; byPhase: ByPhase; deterministicSteps: number }[];
  byOperation: { operationId: string; rulebookId: string; steps: number; total: Totals; thisMonth: Totals }[];
}

/** The Operator's business is in Indonesia: a month starts at midnight Jakarta time (UTC+7, no daylight saving). */
export const monthOf = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 7);

/**
 * Steps plain code carried out for an operation: every action the rules decided that was done (a bill, a message
 * sent, logged or prepared, a credit applied, an exception raised for the owner). Blocked or failed ones are not counted.
 */
export function stepsOf(op: OperationRecord | GenericOperationRecord): number {
  if ("kind" in op && op.kind === "generic") return op.sent.filter((s) => s.ok).length;
  return (op as OperationRecord).actions.filter((a) => a.outcome !== "blocked").length;
}

const empty = (): Totals => ({ calls: 0, sampleCalls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0, idr: 0, unpricedCalls: 0 });

function add(t: Totals, r: UsageRecord, rate: FxRate) {
  if (r.provider === "fixture") {
    t.sampleCalls++;
    return;
  }
  t.calls++;
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  if (r.usd === null) t.unpricedCalls++;
  else {
    t.usd += r.usd;
    t.idr = usdToIdr(t.usd, rate);
  }
}

const totalsOf = (records: UsageRecord[], rate: FxRate): Totals => records.reduce((t, r) => (add(t, r, rate), t), empty());
const byPhaseOf = (records: UsageRecord[], rate: FxRate): ByPhase => Object.fromEntries(USAGE_PHASES.map((p) => [p, totalsOf(records.filter((r) => r.phase === p), rate)])) as ByPhase;

/** Every total the studio shows, for the records and operations matching the query. */
export function summarize(records: UsageRecord[], ops: (OperationRecord | GenericOperationRecord)[], q: UsageQuery = {}, now: Date = new Date(), rate: FxRate = fxRate()): UsageSummary {
  const month = q.month ?? monthOf(now.toISOString());
  const rows = records.filter((r) => (!q.rulebookId || r.rulebookId === q.rulebookId) && (!q.operationId || r.operationId === q.operationId));
  const monthRows = rows.filter((r) => monthOf(r.at) === month);
  const scoped = ops.filter((o) => (!q.rulebookId || o.rulebookId === q.rulebookId) && (!q.operationId || o.id === q.operationId));

  const ids = [...new Set([...rows.map((r) => r.rulebookId ?? null), ...scoped.map((o) => o.rulebookId)])];
  const byRulebook = ids.map((id) => {
    const mine = rows.filter((r) => (r.rulebookId ?? null) === id);
    return {
      rulebookId: id,
      total: totalsOf(mine, rate),
      thisMonth: totalsOf(mine.filter((r) => monthOf(r.at) === month), rate),
      byPhase: byPhaseOf(mine, rate),
      deterministicSteps: scoped.filter((o) => o.rulebookId === id).reduce((n, o) => n + stepsOf(o), 0),
    };
  });
  const byOperation = scoped.map((o) => {
    const mine = rows.filter((r) => r.operationId === o.id);
    return { operationId: o.id, rulebookId: o.rulebookId, steps: stepsOf(o), total: totalsOf(mine, rate), thisMonth: totalsOf(mine.filter((r) => monthOf(r.at) === month), rate) };
  });

  return {
    rate,
    prices: { source: PRICING_SOURCE.url, checked: PRICING_SOURCE.checked },
    month,
    scope: { ...(q.rulebookId ? { rulebookId: q.rulebookId } : {}), ...(q.operationId ? { operationId: q.operationId } : {}) },
    total: totalsOf(rows, rate),
    thisMonth: totalsOf(monthRows, rate),
    byPhase: byPhaseOf(rows, rate),
    thisMonthByPhase: byPhaseOf(monthRows, rate),
    deterministicSteps: scoped.reduce((n, o) => n + stepsOf(o), 0),
    byRulebook,
    byOperation,
  };
}
