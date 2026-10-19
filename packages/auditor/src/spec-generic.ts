import {
  boundaryValues,
  conditionsHold,
  firingDays,
  shiftDate,
  type GenericCondition,
  type GenericScenario,
  type RuleCard,
  type Rulebook,
  type SimEvent,
} from "@reeve/core";
import type { Mutant } from "./mutate";

/**
 * The Auditor's independent specification for the generic pack. Every case is a tiny scenario built
 * from the cards alone: one record on each side of every condition's boundary, the schedule, the
 * once-per-record promise, approval limits, "never" constraints and KPI thresholds. Expectations
 * use the core's own reading of the conditions (TypeScript), never the Builder's Python.
 */

export interface GenericSpecCase {
  name: string;
  card: string;
  scenario: GenericScenario;
  types: SimEvent["type"][];
  rules: string[];
  expect: Partial<SimEvent>[];
}

type GRule = Extract<RuleCard, { type: "generic_rule" }>;
type GKpi = Extract<RuleCard, { type: "generic_kpi" }>;
type Rec = Record<string, string | number | null>;

const START = "2026-11-02"; // a Monday
const KEY = "__key";

/** Values that make every condition hold, or every one fail, at the boundary. */
const satisfying = (cs: GenericCondition[], today: string) => Object.fromEntries(cs.map((c) => [c.field, boundaryValues(c, today).pass]));
const failing = (cs: GenericCondition[], today: string) => Object.fromEntries(cs.map((c) => [c.field, boundaryValues(c, today).fail]));

function scenario(start: string, days: number, records: Rec[]): GenericScenario {
  return { pack: "generic", start_date: start, days, key_field: KEY, records, updates: [] };
}

export function buildGenericSpecCases(rb: Rulebook): { cases: GenericSpecCase[]; skipped: string[] } {
  const cases: GenericSpecCase[] = [];
  const skipped: string[] = [];
  const approvals = rb.cards.flatMap((c) => (c.type === "generic_approval" ? [c] : []));
  const nevers = rb.cards.flatMap((c) => (c.type === "generic_never" ? [c] : []));

  /** What the rulebook says should happen when rule r meets record rec today. */
  const outcome = (r: GRule, rec: Rec, today: string): Partial<SimEvent> | null => {
    if (!conditionsHold(r.match, r.conditions, rec, today)) return null;
    const raw = r.action.amount_field ? rec[r.action.amount_field] : null;
    const amount = raw === null || raw === undefined || raw === "" ? undefined : Number(raw);
    const blocked = nevers.some((n) => (n.tool === "*" || n.tool === r.action.tool) && conditionsHold(n.match, n.conditions, rec, today));
    const approval = amount !== undefined && approvals.some((a) => (a.tool === "*" || a.tool === r.action.tool) && amount > a.amount_above);
    return { date: today, tenant_id: String(rec[KEY]), type: blocked ? "blocked" : approval ? "approval_request" : "action", amount, note: r.action.tool };
  };

  for (const r of rb.cards.filter((c): c is GRule => c.type === "generic_rule")) {
    const [day, next] = firingDays(r.schedule, START);
    const types: SimEvent["type"][] = ["action", "approval_request", "blocked"];
    // Keep amounts under every limit unless a case is about the limit.
    const safeAmount = r.action.amount_field ? { [r.action.amount_field]: Math.max(0, Math.min(...approvals.map((a) => a.amount_above), 1_000)) } : {};
    const base: Rec = { ...safeAmount, ...satisfying(r.conditions, day) };
    // Records far from every "never" card unless the case is about one.
    const clean = (rec: Rec): Rec => {
      let out = { ...rec };
      for (const n of nevers) if (conditionsHold(n.match, n.conditions, out, day)) out = { ...out, ...failing(n.conditions, day), ...rec };
      return out;
    };

    // Boundaries: one record that should act, one per condition just past its boundary.
    const records: Rec[] = [{ ...clean(base), [KEY]: "pass" }];
    r.conditions.forEach((c, i) => {
      const values = r.match === "all" ? { ...base, [c.field]: boundaryValues(c, day).fail } : { ...failing(r.conditions, day), ...safeAmount, [c.field]: boundaryValues(c, day).pass };
      records.push({ ...clean(values), [KEY]: `c${i + 1}` });
    });
    if (r.match === "any" && r.conditions.length) records.push({ ...failing(r.conditions, day), ...safeAmount, [KEY]: "none" });
    const expect = records.map((rec) => outcome(r, rec, day)).filter((e): e is Partial<SimEvent> => e !== null);
    cases.push({ name: `${r.id} boundaries`, card: r.id, scenario: scenario(day, 1, records), types, rules: [r.id], expect });

    // Schedule and once-per-record: a record seen over two firing days (and, for weekly or monthly
    // rules, the non-firing day before). Each day's expectation is worked out on that day's date.
    {
      const startEarly = r.schedule.every === "day" ? day : shiftDate(day, -1);
      const span = Math.round((Date.parse(next) - Date.parse(startEarly)) / 86_400_000) + 1;
      const rec = { ...clean(base), [KEY]: "steady" };
      const hits = [day, next].map((d) => outcome(r, rec, d)).filter((e): e is Partial<SimEvent> => e !== null);
      if (hits.length < 2) skipped.push(`${r.id}: once-per-record not pinned; the record no longer qualifies on the second firing day`);
      cases.push({
        name: `${r.id} ${r.once_per_record ? "once per record" : "every time it fires"}`,
        card: r.id,
        scenario: scenario(startEarly, span, [rec]),
        types,
        rules: [r.id],
        expect: r.once_per_record ? hits.slice(0, 1) : hits,
      });
    }

    // Approval limits that cover this rule's tool.
    for (const a of approvals.filter((a) => a.tool === "*" || a.tool === r.action.tool)) {
      if (!r.action.amount_field) {
        skipped.push(`${a.id}: limit not tested on ${r.id}, which sends no amount`);
        continue;
      }
      const at = { ...clean(base), [r.action.amount_field]: a.amount_above, [KEY]: "at-limit" };
      const over = { ...clean(base), [r.action.amount_field]: a.amount_above + 1, [KEY]: "over-limit" };
      cases.push({ name: `${a.id} limit on ${r.id}`, card: a.id, scenario: scenario(day, 1, [at, over]), types, rules: [r.id], expect: [at, over].map((x) => outcome(r, x, day)!) });
    }

    // "Never" constraints on this rule's tool.
    for (const n of nevers.filter((n) => n.tool === "*" || n.tool === r.action.tool)) {
      const hit: Rec = { ...base, ...satisfying(n.conditions, day), [KEY]: "forbidden" };
      if (!conditionsHold(r.match, r.conditions, hit, day)) {
        skipped.push(`${n.id}: cannot be tested on ${r.id}; no record can meet both`);
        continue;
      }
      cases.push({ name: `${n.id} on ${r.id}`, card: n.id, scenario: scenario(day, 1, [hit]), types, rules: [r.id], expect: [outcome(r, hit, day)!] });
    }
  }

  for (const k of rb.cards.filter((c): c is GKpi => c.type === "generic_kpi")) {
    const [day] = firingDays(k.schedule, START);
    const row = (n: number, key: string): Rec => ({ ...satisfying(k.conditions, day), ...(k.field ? { [k.field]: n } : {}), [KEY]: key });
    // At the threshold: no alert. One step past it: alert.
    const past = k.alert_if === "below" ? k.threshold - 1 : k.threshold + 1;
    for (const [label, target] of [
      ["at threshold", k.threshold],
      ["past threshold", past],
    ] as const) {
      let records: Rec[];
      if (k.aggregate === "count") {
        if (target < 0 || target > 200 || !Number.isInteger(target)) {
          skipped.push(`${k.id}: count threshold ${k.threshold} too large to build`);
          continue;
        }
        records = Array.from({ length: target }, (_, i) => row(1, `k${i + 1}`));
      } else records = [row(target, "k1")];
      const value = k.aggregate === "count" ? records.length : target;
      const alert = k.alert_if === "below" ? value < k.threshold : value > k.threshold;
      cases.push({
        name: `${k.id} ${label}`,
        card: k.id,
        scenario: scenario(day, 1, records),
        types: ["kpi_alert"],
        rules: [k.id],
        expect: alert ? [{ date: day, tenant_id: "-", type: "kpi_alert", amount: value, note: k.id }] : [],
      });
    }
  }
  return { cases, skipped };
}

/** Planted defects for generated generic rules: every threshold, operator, schedule and limit. */
export function generateGenericMutants(rulesPy: string): Mutant[] {
  const lines = rulesPy.split("\n");
  const out: Mutant[] = [];
  const add = (i: number, replacement: string, description: string) => {
    const copy = [...lines];
    copy[i] = replacement;
    out.push({ id: "", description, source: copy.join("\n") });
  };
  const FLIP: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "==": "!=", "!=": "==" };
  lines.forEach((line, i) => {
    const constant = line.match(/^((?:R|K)\w*?_C\d+|LIMIT_\d+|NEVER_\d+_C\d+|\w+_THRESHOLD|\w+_WEEKDAY|\w+_DAY) = (-?\d+(?:\.\d+)?)\b/);
    if (constant) {
      const [, name, value] = constant;
      const v = Number(value);
      add(i, line.replace(`= ${value}`, `= ${v + 1}`), `${name} ${v} → ${v + 1}`);
      add(i, line.replace(`= ${value}`, `= ${v - 1}`), `${name} ${v} → ${v - 1}`);
    }
    const once = line.match(/^(\w+_ONCE) = (True|False)/);
    if (once) add(i, line.replace(once[2]!, once[2] === "True" ? "False" : "True"), `${once[1]} flipped`);
    // Comparisons against a named constant: off by one, or the wrong way round.
    const cmp = line.match(/ (<=|>=|==|!=|<|>) ((?:R|K)\w*?_C\d+|LIMIT_\d+|NEVER_\d+_C\d+|\w+_THRESHOLD|_text\((?:R|K)\w*?_C\d+\)|_text\(NEVER_\d+_C\d+\))/);
    if (cmp) add(i, line.replace(` ${cmp[1]} ${cmp[2]}`, ` ${FLIP[cmp[1]!]} ${cmp[2]}`), `${cmp[2]} comparison ${cmp[1]} → ${FLIP[cmp[1]!]}`);
  });
  return out.map((m, n) => ({ ...m, id: `m${String(n + 1).padStart(3, "0")}` }));
}
