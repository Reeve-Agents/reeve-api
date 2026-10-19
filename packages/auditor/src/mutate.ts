/**
 * Mutation testing: plant small, realistic defects in the Builder's rules.py and
 * check that the Auditor's spec notices every one. A mutant that survives is a
 * behaviour the spec does not pin down.
 */

export interface Mutant {
  id: string;
  description: string;
  source: string;
}

const NUMERIC_CONSTANTS = [
  "INVOICE_DAY",
  "LATE_FEE_DAYS",
  "LATE_FEE_PERCENT",
  "GRACE_MIN_MONTHS",
  "GRACE_EXTRA_DAYS",
  "NOTICE_DAYS",
  "REFUND_APPROVAL_ABOVE",
  "REVENUE_TARGET",
  "KPI_ALERT_DAY",
  // minimarket pack
  "REORDER_BELOW",
  "ORDER_UP_TO",
  "SWITCH_AFTER_LATE_DAYS",
  "SLOW_MOVER_DAYS",
  "PO_APPROVAL_ABOVE",
  "EXPIRING_WINDOW_DAYS",
  "EXPIRING_VALUE_LIMIT",
  "KPI_CHECK_WEEKDAY",
];

const SWAPS: Record<string, [string, string]> = {
  LATE_FEE_BASIS: ['"rent"', '"outstanding"'],
  OVERPAYMENT_POLICY: ['"credit_next_invoice"', '"refund_with_approval"'],
  REVENUE_BASIS: ['"collected"', '"invoiced"'],
  MARKDOWN_FLOOR: ['"cost"', "None"],
};

const SNIPPETS: { find: string; replace: string; description: string }[] = [
  { find: "today.day == INVOICE_DAY", replace: "today.day >= INVOICE_DAY", description: "invoice every day after the invoice day" },
  { find: "days_overdue >= threshold", replace: "days_overdue > threshold", description: "late fee one day late (>= → >)" },
  { find: "days_overdue >= NOTICE_DAYS", replace: "days_overdue > NOTICE_DAYS", description: "notice one day late (>= → >)" },
  { find: ">= GRACE_MIN_MONTHS", replace: "> GRACE_MIN_MONTHS", description: "grace needs one more month (>= → >)" },
  { find: "days = days + GRACE_EXTRA_DAYS", replace: "days = days", description: "drop the tenure grace" },
  { find: "if threshold is None or invoice.fee_charged:", replace: "if threshold is None:", description: "charge the late fee repeatedly" },
  { find: "amount > REFUND_APPROVAL_ABOVE", replace: "amount >= REFUND_APPROVAL_ABOVE", description: "approval threshold off by one (> → >=)" },
  { find: "return value < REVENUE_TARGET", replace: "return value <= REVENUE_TARGET", description: "KPI alert at exactly the target (< → <=)" },
  { find: "return days_overdue in REMINDER_DAYS", replace: "return days_overdue in REMINDER_DAYS[1:]", description: "drop the first reminder" },
  // minimarket pack
  { find: "on_hand + on_order < REORDER_BELOW", replace: "on_hand + on_order <= REORDER_BELOW", description: "reorder at the reorder point too (< → <=)" },
  { find: "on_hand + on_order < REORDER_BELOW", replace: "on_hand < REORDER_BELOW", description: "ignore stock already on order" },
  { find: "value > PO_APPROVAL_ABOVE", replace: "value >= PO_APPROVAL_ABOVE", description: "PO approval threshold off by one (> → >=)" },
  { find: "days_late >= SWITCH_AFTER_LATE_DAYS", replace: "days_late > SWITCH_AFTER_LATE_DAYS", description: "switch supplier one day late (>= → >)" },
  { find: "days_since_sale >= SLOW_MOVER_DAYS", replace: "days_since_sale > SLOW_MOVER_DAYS", description: "slow mover one day late (>= → >)" },
  { find: "if days_to_expiry <= days:", replace: "if days_to_expiry < days:", description: "markdown one day late (<= → <)" },
  { find: "new = max(new, cost)", replace: "new = new", description: "drop the never-below-cost floor" },
  { find: "return value > EXPIRING_VALUE_LIMIT", replace: "return value >= EXPIRING_VALUE_LIMIT", description: "KPI alert at exactly the limit (> → >=)" },
  { find: "0 <= days_to_expiry <= EXPIRING_WINDOW_DAYS", replace: "0 <= days_to_expiry < EXPIRING_WINDOW_DAYS", description: "expiring window one day short (<= → <)" },
  { find: "today.weekday() == KPI_CHECK_WEEKDAY", replace: "today.weekday() >= KPI_CHECK_WEEKDAY", description: "KPI check every day after the check day" },
];

function constantValue(src: string, name: string): string | null {
  const m = src.match(new RegExp(`^${name} = (.+?)(\\s+#.*)?$`, "m"));
  return m ? m[1]!.trim() : null;
}

function replaceConstant(src: string, name: string, value: string): string {
  return src.replace(new RegExp(`^(${name} = )(.+?)(\\s+#.*)?$`, "m"), (_all, a: string, _b: string, c: string | undefined) => `${a}${value}${c ?? ""}`);
}

export function generateMutants(rulesPy: string): Mutant[] {
  const out: Mutant[] = [];
  const add = (description: string, source: string) => {
    if (source !== rulesPy) out.push({ id: `m${String(out.length + 1).padStart(3, "0")}`, description, source });
  };
  const refundLive = constantValue(rulesPy, "OVERPAYMENT_POLICY") === '"refund_with_approval"';

  for (const name of NUMERIC_CONSTANTS) {
    const v = constantValue(rulesPy, name);
    if (v === null || v === "None") continue;
    if (name === "REFUND_APPROVAL_ABOVE" && !refundLive) continue; // dead code under a credit policy
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const isFloat = v.includes(".");
    const fmt = (x: number) => (isFloat ? x.toFixed(1) : String(x));
    add(`${name} ${v} → ${fmt(n + 1)}`, replaceConstant(rulesPy, name, fmt(n + 1)));
    if (n - 1 >= 0) add(`${name} ${v} → ${fmt(n - 1)}`, replaceConstant(rulesPy, name, fmt(n - 1)));
  }

  const rem = constantValue(rulesPy, "REMINDER_DAYS");
  if (rem) {
    const days = rem.replace(/[(),]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
    days.forEach((d, i) => {
      const shifted = days.map((x, j) => (j === i ? x + 1 : x));
      add(`reminder H+${d} → H+${d + 1}`, replaceConstant(rulesPy, "REMINDER_DAYS", `(${shifted.join(", ")}${shifted.length === 1 ? "," : ""})`));
    });
  }

  // Markdown steps: each step's day and percent, one at a time.
  const steps = constantValue(rulesPy, "MARKDOWN_STEPS");
  if (steps) {
    const pairs = [...steps.matchAll(/\((\d+), (\d+(?:\.\d+)?)\)/g)].map((m) => [Number(m[1]), m[2]!] as const);
    const render = (ps: (readonly [number, string])[]) => `(${ps.map(([d, p]) => `(${d}, ${p})`).join(", ")}${ps.length === 1 ? "," : ""})`;
    pairs.forEach(([d, p], i) => {
      add(`markdown H-${d} → H-${d + 1}`, replaceConstant(rulesPy, "MARKDOWN_STEPS", render(pairs.map((x, j) => (j === i ? [d + 1, p] : x)))));
      add(`markdown ${p}% → ${Number(p) + 1}%`, replaceConstant(rulesPy, "MARKDOWN_STEPS", render(pairs.map((x, j) => (j === i ? [d, String(Number(p) + 1)] : x)))));
    });
  }

  // Default and backup supplier swapped.
  const def = constantValue(rulesPy, "DEFAULT_SUPPLIER");
  const bak = constantValue(rulesPy, "BACKUP_SUPPLIER");
  if (def && bak && bak !== "None" && def !== bak) {
    add(`suppliers swapped (${def} ↔ ${bak})`, replaceConstant(replaceConstant(rulesPy, "DEFAULT_SUPPLIER", bak), "BACKUP_SUPPLIER", def));
  }

  for (const [name, [a, b]] of Object.entries(SWAPS)) {
    const v = constantValue(rulesPy, name);
    if (v === a) add(`${name} ${a} → ${b}`, replaceConstant(rulesPy, name, b));
    else if (v === b) add(`${name} ${b} → ${a}`, replaceConstant(rulesPy, name, a));
  }

  for (const s of SNIPPETS) {
    if (!rulesPy.includes(s.find)) continue;
    if (s.find.includes("REFUND_APPROVAL_ABOVE") && !refundLive) continue;
    if (s.find.includes("REVENUE_TARGET") && constantValue(rulesPy, "REVENUE_TARGET") === "None") continue;
    if (s.find.includes("REMINDER_DAYS") && (rem?.match(/\d+/g) ?? []).length === 0) continue;
    add(s.description, rulesPy.replace(s.find, s.replace));
  }
  return out;
}
