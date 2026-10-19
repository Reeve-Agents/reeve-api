import { boundaryValues, firingDays, type GenericCondition, type RuleCard, type Rulebook, type Schedule } from "@reeve/core";

type GRule = Extract<RuleCard, { type: "generic_rule" }>;
type GKpi = Extract<RuleCard, { type: "generic_kpi" }>;

const py = (v: unknown): string => (v === null || v === undefined ? "None" : typeof v === "string" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "True" : "False") : String(v));
const note = (c: { id: string; source_quote: string }) => `  # ${c.id}: ${c.source_quote.replace(/\s+/g, " ").slice(0, 90)}`;

/** One condition as a Python expression over `rec` and `today`, comparing against the named constant. */
function conditionPy(c: GenericCondition, constant: string): string {
  const f = JSON.stringify(c.field);
  switch (c.op) {
    case "lt":
      return `(_num(rec.get(${f})) is not None and _num(rec.get(${f})) < ${constant})`;
    case "lte":
      return `(_num(rec.get(${f})) is not None and _num(rec.get(${f})) <= ${constant})`;
    case "gt":
      return `(_num(rec.get(${f})) is not None and _num(rec.get(${f})) > ${constant})`;
    case "gte":
      return `(_num(rec.get(${f})) is not None and _num(rec.get(${f})) >= ${constant})`;
    case "eq":
      return `(_text(rec.get(${f})) == _text(${constant}))`;
    case "neq":
      return `(_text(rec.get(${f})) != _text(${constant}))`;
    case "days_until_lte":
      return `(_until(rec.get(${f}), today) is not None and 0 <= _until(rec.get(${f}), today) <= ${constant})`;
    case "days_since_gte":
      return `(_until(rec.get(${f}), today) is not None and -_until(rec.get(${f}), today) >= ${constant})`;
    case "empty":
      return `(_text(rec.get(${f})) == "")`;
    case "not_empty":
      return `(_text(rec.get(${f})) != "")`;
  }
}

function schedulePy(id: string, s: Schedule): { consts: string[]; body: string } {
  if (s.every === "week") return { consts: [`${id}_WEEKDAY = ${s.weekday}`], body: `today.weekday() == ${id}_WEEKDAY` };
  if (s.every === "month") return { consts: [`${id}_DAY = ${s.day_of_month}`], body: `today.day == ${id}_DAY` };
  return { consts: [], body: "True" };
}

function conditionsPy(id: string, match: "all" | "any", cs: GenericCondition[]): { consts: string[]; body: string } {
  const consts = cs.map((c, i) => `${id}_C${i + 1} = ${py(c.value)}  # ${c.field} ${c.op}`);
  const parts = cs.map((c, i) => conditionPy(c, `${id}_C${i + 1}`));
  return { consts, body: parts.length ? parts.join(match === "all" ? "\n        and " : "\n        or ") : "True" };
}

/** Deliberate defect for the generic pack: the Builder forgets every "never" constraint. */
export type GenericBug = "ignore_never_rules";

/** Compile a generic rulebook into a rules module for reeve_runtime.generic_engine. */
export function generateGenericRulesPy(rb: Rulebook, rulebookHash: string, bugs: GenericBug[] = []): string {
  const rules = rb.cards.filter((c): c is GRule => c.type === "generic_rule");
  const kpis = rb.cards.filter((c): c is GKpi => c.type === "generic_kpi");
  const approvals = rb.cards.flatMap((c) => (c.type === "generic_approval" ? [c] : []));
  const nevers = bugs.includes("ignore_never_rules") ? [] : rb.cards.flatMap((c) => (c.type === "generic_never" ? [c] : []));
  const out: string[] = [];

  for (const r of rules) {
    const s = schedulePy(r.id, r.schedule);
    const c = conditionsPy(r.id, r.match, r.conditions);
    const args = Object.fromEntries(r.action.args.map((a) => [a.name, a.template]));
    out.push(`# ── ${r.id}: ${r.title.replace(/\s+/g, " ").slice(0, 100)}
${note(r)}
${[...s.consts, ...c.consts].join("\n")}
${r.id}_ONCE = ${py(r.once_per_record)}
${r.id}_CONNECTOR = ${py(r.action.connector)}
${r.id}_TOOL = ${py(r.action.tool)}
${r.id}_ARGS = ${JSON.stringify(args)}
${r.id}_AMOUNT_FIELD = ${py(r.action.amount_field)}


def _${r.id}_fires(today):
    return ${s.body}


def _${r.id}_applies(rec, today):
    return (
        ${c.body}
    )
`);
  }

  approvals.forEach((a, i) => out.push(`LIMIT_${i + 1}_TOOL = ${py(a.tool)}${note(a)}\nLIMIT_${i + 1} = ${a.amount_above}\n`));
  nevers.forEach((n, i) => {
    const c = conditionsPy(`NEVER_${i + 1}`, n.match, n.conditions);
    out.push(`NEVER_${i + 1}_TOOL = ${py(n.tool)}${note(n)}
${c.consts.join("\n")}


def _never_${i + 1}(rec, today):
    return (
        ${c.body}
    )
`);
  });

  for (const k of kpis) {
    const s = schedulePy(k.id, k.schedule);
    const c = conditionsPy(k.id, k.match, k.conditions);
    out.push(`# ── ${k.id} (KPI): ${k.title.replace(/\s+/g, " ").slice(0, 100)}
${note(k)}
${[...s.consts, ...c.consts].join("\n")}
${k.id}_FIELD = ${py(k.field)}
${k.id}_THRESHOLD = ${k.threshold}


def _${k.id}_fires(today):
    return ${s.body}


def _${k.id}_counts(rec, today):
    return (
        ${c.body}
    )


def _${k.id}_value(records, today):
    chosen = [r for r in records if _${k.id}_counts(r, today)]
    return ${k.aggregate === "count" ? "len(chosen)" : `sum((_num(r.get(${k.id}_FIELD)) or 0) for r in chosen)`}


def _${k.id}_alert(value):
    return value ${k.alert_if === "below" ? "<" : ">"} ${k.id}_THRESHOLD
`);
  }

  const dispatch = (name: string, ids: string[], fn: string) => `${name} = {${ids.map((id) => `${JSON.stringify(id)}: _${id}_${fn}`).join(", ")}}`;
  return `"""Generated by Reeve Builder from rulebook ${rulebookHash.slice(0, 16)}. Do not edit by hand."""
from __future__ import annotations

import datetime as dt


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = "".join(ch for ch in v if ch.isdigit() or ch in ".-")
        try:
            return float(s) if s not in ("", "-", ".") else None
        except ValueError:
            return None
    return None


def _text(v):
    return "" if v is None else str(v).strip().lower()


def _until(v, today):
    try:
        return (dt.date.fromisoformat(str(v)[:10]) - today).days
    except ValueError:
        return None


def _render(template, rec):
    out = template
    for key, value in rec.items():
        out = out.replace("{" + str(key) + "}", "" if value is None else str(value))
    return out


${out.join("\n\n")}

RULE_IDS = ${JSON.stringify(rules.map((r) => r.id))}
KPI_IDS = ${JSON.stringify(kpis.map((k) => k.id))}
${dispatch("_FIRES", rules.map((r) => r.id), "fires")}
${dispatch("_APPLIES", rules.map((r) => r.id), "applies")}
${dispatch("_KPI_FIRES", kpis.map((k) => k.id), "fires")}
${dispatch("_KPI_VALUE", kpis.map((k) => k.id), "value")}
${dispatch("_KPI_ALERT", kpis.map((k) => k.id), "alert")}


def fires(rule_id, today):
    return _FIRES[rule_id](today)


def applies(rule_id, rec, today):
    return _APPLIES[rule_id](rec, today)


def once(rule_id):
    return globals()[rule_id + "_ONCE"]


def action(rule_id, rec):
    g = globals()
    args = {k: _render(v, rec) for k, v in g[rule_id + "_ARGS"].items()}
    field = g[rule_id + "_AMOUNT_FIELD"]
    amount = _num(rec.get(field)) if field else None
    return g[rule_id + "_CONNECTOR"], g[rule_id + "_TOOL"], args, amount


def needs_approval(tool, amount):
    if amount is None:
        return False
${approvals.length ? approvals.map((_, i) => `    if LIMIT_${i + 1}_TOOL in ("*", tool) and amount > LIMIT_${i + 1}:\n        return True`).join("\n") : "    pass"}
    return False


def blocked(tool, rec, today):
${nevers.length ? nevers.map((_, i) => `    if NEVER_${i + 1}_TOOL in ("*", tool) and _never_${i + 1}(rec, today):\n        return True`).join("\n") : "    pass"}
    return False


def kpi_fires(kpi_id, today):
    return _KPI_FIRES[kpi_id](today)


def kpi_value(kpi_id, records, today):
    return _KPI_VALUE[kpi_id](records, today)


def kpi_alert(kpi_id, value):
    return _KPI_ALERT[kpi_id](value)
`;
}

/** The Builder's own tests: each rule holds on a record built to satisfy it, and fails when one condition misses. */
export function generateGenericBuilderTestsPy(rb: Rulebook): string {
  const t: string[] = [];
  for (const r of rb.cards.filter((c): c is GRule => c.type === "generic_rule")) {
    const [day] = firingDays(r.schedule, "2026-11-02");
    const [y, m, d] = day.split("-").map(Number);
    const pass = Object.fromEntries(r.conditions.map((c) => [c.field, boundaryValues(c, day).pass]));
    t.push(`    def test_${r.id.toLowerCase()}(self):
        today = dt.date(${y}, ${m}, ${d})
        self.assertTrue(rules.fires(${JSON.stringify(r.id)}, today))
        self.assertTrue(rules.applies(${JSON.stringify(r.id)}, ${JSON.stringify(pass)}, today))
        connector, tool, args, amount = rules.action(${JSON.stringify(r.id)}, ${JSON.stringify(pass)})
        self.assertEqual(tool, ${JSON.stringify(r.action.tool)})`);
  }
  return `"""Builder's own tests for rules.py (generated, generic pack)."""
import datetime as dt
import unittest

import rules


class BuilderTests(unittest.TestCase):
${t.join("\n\n") || "    def test_loads(self):\n        self.assertIsInstance(rules.RULE_IDS, list)"}


if __name__ == "__main__":
    unittest.main()
`;
}
