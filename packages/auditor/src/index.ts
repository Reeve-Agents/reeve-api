import { findCard, packOf, validateRulebook, type Finding, type JobResults, type Rulebook, type Verdict } from "@reeve/core";
import { generateMutants, type Mutant } from "./mutate";
import { buildSpecCases, type SpecCase } from "./spec";
import { buildStockSpecCases, orderSizeFor, type StockSpecCase } from "./spec-stock";
import { buildGenericSpecCases, generateGenericMutants, type GenericSpecCase } from "./spec-generic";

export { buildSpecCases, roundHalfEven, type SpecCase } from "./spec";
export { buildStockSpecCases, orderSizeFor, type StockSpecCase } from "./spec-stock";
export { buildGenericSpecCases, generateGenericMutants, type GenericSpecCase } from "./spec-generic";
export { generateMutants, countByKind, MUTANT_KINDS, type Mutant, type MutantKind } from "./mutate";
export { generateStructuralMutants } from "./operators";

/** Every planted defect must be caught: one survivor means the spec cannot tell that bug from the real rule. */
export const MIN_MUTATION_SCORE = 1;

/**
 * One file for every planted defect, sources inline: the sandbox upload costs a round trip per file,
 * so 60+ separate mutant files would multiply the upload time. The job writes each one locally.
 */
const manifest = (mutants: Mutant[]) =>
  JSON.stringify(mutants.map((m) => ({ id: m.id, file: `${m.id}.py`, kind: m.kind, description: m.description, source: m.source })));

export interface AuditPlan {
  cases: (SpecCase | StockSpecCase | GenericSpecCase)[];
  skipped: string[];
  mutants: Mutant[];
  /** Mutants no possible input can tell apart from the real code (left out, reported as info). */
  equivalent: string[];
  /** Owner safety cards that can never take effect under this rulebook. */
  guards: { severity: "warning" | "info"; message: string }[];
  constraints: Record<string, unknown>;
  /** Files to add to the job bundle under job/ */
  files: Record<string, string>;
}

/** Everything the Auditor needs inside the sandbox, derived from the rulebook and the Builder's code. */
export function prepareAudit(rb: Rulebook, rulesPy: string): AuditPlan {
  if (packOf(rb) === "generic") return prepareGenericAudit(rb, rulesPy);
  const stock = packOf(rb) === "minimarket";
  const { cases, skipped } = stock ? buildStockSpecCases(rb) : buildSpecCases(rb);
  let mutants = generateMutants(rulesPy);
  const equivalent: string[] = [];
  let constraints: Record<string, unknown>;
  if (stock) {
    const po = findCard(rb, "po_approval_threshold");
    const floor = findCard(rb, "markdown_floor");
    const reorder = findCard(rb, "reorder_point");
    constraints = {
      ...(floor ? { markdown_floor: floor.floor, floor_card: floor.id } : {}),
      ...(po ? { po_approval_above: po.po_above, po_card: po.id } : {}),
    };
    // A PO is always qty × cost with qty in [U-T+1, U]. If no such order can be worth exactly the
    // value a threshold mutant moves to, no input can tell that mutant apart: it is equivalent.
    if (po && reorder) {
      const L = po.po_above;
      const reachable = (v: number) => v >= 0 && orderSizeFor(v, reorder.below_units, reorder.order_up_to_units) !== null;
      const drop = new Map<string, boolean>([
        [`PO_APPROVAL_ABOVE ${L} → ${L + 1}`, !reachable(L + 1)],
        [`PO_APPROVAL_ABOVE ${L} → ${L - 1}`, !reachable(L)],
        ["PO approval threshold off by one (> → >=)", !reachable(L)],
      ]);
      mutants = mutants.filter((m) => {
        if (drop.get(m.description)) {
          equivalent.push(`${m.description}: no order size can be worth exactly the boundary value, so no input tells it apart`);
          return false;
        }
        return true;
      });
    }
    // Every order (a backup re-order reuses the late order's size) is at least U-T+1 units. When that
    // alone keeps shelf plus order at or above T, nothing is ever on order at the moment a reorder
    // fires, so the sign of on_order inside the order size cannot change any order.
    if (reorder && reorder.order_up_to_units - reorder.below_units + 1 >= reorder.below_units) {
      const minOrder = reorder.order_up_to_units - reorder.below_units + 1;
      mutants = mutants.filter((m) => {
        if (m.kind === "formula" && m.description.startsWith("order_quantity:") && m.source.includes("ORDER_UP_TO - on_hand + on_order")) {
          equivalent.push(`${m.description}: every order is at least ${minOrder} units, so nothing is on order when a reorder fires`);
          return false;
        }
        return true;
      });
    }
    mutants = mutants.map((m, i) => ({ ...m, id: `m${String(i + 1).padStart(3, "0")}` }));
  } else {
    const maxFee = findCard(rb, "max_fee");
    const approval = findCard(rb, "approval_threshold");
    constraints = {
      ...(maxFee ? { max_fee_percent_of_rent: maxFee.max_percent_of_rent, max_fee_card: maxFee.id } : {}),
      ...(approval ? { refund_approval_above: approval.refund_above, approval_card: approval.id } : {}),
    };
  }
  const files: Record<string, string> = {
    "audit_cases.json": JSON.stringify(cases, null, 2),
    "constraints.json": JSON.stringify(constraints, null, 2),
    "mutants/manifest.json": manifest(mutants),
  };
  return { cases, skipped, mutants, equivalent, guards: [], constraints, files };
}

/** Index → card id for LIMIT_k / NEVER_k, read from the generated comment ("LIMIT_1_TOOL = ...  # R5: ..."). */
function guardIds(rulesPy: string, prefix: "LIMIT" | "NEVER", ordered: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of rulesPy.matchAll(new RegExp(`^${prefix}_(\\d+)_TOOL = [^#\\n]*#\\s*([^:\\n]+):`, "gm"))) out.set(Number(m[1]), m[2]!.trim());
  if (out.size === 0) ordered.forEach((id, i) => out.set(i + 1, id));
  return out;
}

function prepareGenericAudit(rb: Rulebook, rulesPy: string): AuditPlan {
  const { cases, skipped, reachedNevers } = buildGenericSpecCases(rb);
  let mutants = generateGenericMutants(rulesPy);

  // Guards the rulebook can never reach. Defects planted only inside them cannot change any outcome,
  // so they are equivalent; the guard itself is reported, because the owner believes it protects them.
  const rules = rb.cards.flatMap((c) => (c.type === "generic_rule" ? [c] : []));
  const approvals = rb.cards.flatMap((c) => (c.type === "generic_approval" ? [c] : []));
  const nevers = rb.cards.flatMap((c) => (c.type === "generic_never" ? [c] : []));
  const anyAmount = rules.some((r) => !!r.action.amount_field);
  const equivalent: string[] = [];
  const guards: AuditPlan["guards"] = [];
  const drop = (test: (m: Mutant) => boolean, why: string) => {
    mutants = mutants.filter((m) => {
      if (!test(m)) return true;
      equivalent.push(`${m.description}: ${why}`);
      return false;
    });
  };
  for (const [k, id] of guardIds(rulesPy, "LIMIT", approvals.map((a) => a.id))) {
    const a = approvals.find((x) => x.id === id);
    if (!a || rules.some((r) => (a.tool === "*" || a.tool === r.action.tool) && !!r.action.amount_field)) continue;
    // validateRulebook already blocks such a limit (RULEBOOK_INVALID); here only its mutants are settled.
    const mentions = new RegExp(`\\bLIMIT_${k}(?!\\d)`);
    if (!anyAmount) drop((m) => mentions.test(m.description), "no rule sends an amount, so this limit never sees one");
    else drop((m) => m.kind === "boundary" && mentions.test(m.description), "no rule using this tool sends an amount");
  }
  if (approvals.length && !anyAmount) {
    drop(
      (m) => m.description === "needs_approval switched off (always False)" || m.description === "action: amount hidden from the approval limit",
      "no rule sends an amount, so the approval check always answers no",
    );
  }
  const reached = new Set(reachedNevers);
  for (const [k, id] of guardIds(rulesPy, "NEVER", nevers.map((n) => n.id))) {
    if (reached.has(id) || !nevers.some((n) => n.id === id)) continue;
    guards.push({ severity: "info", message: `${id}: this "never" rule can never trigger, because every rule already leaves out the records it forbids` });
    drop((m) => m.description === `_never_${k} never true (step skipped)`, "no record can meet both a rule and this never card");
  }
  if (nevers.length && nevers.every((n) => !reached.has(n.id))) {
    drop((m) => m.description === "blocked switched off (always False)", "no record can meet both a rule and any never card");
  }
  mutants = mutants.map((m, i) => ({ ...m, id: `m${String(i + 1).padStart(3, "0")}` }));
  const constraints = {
    approvals: rb.cards.flatMap((c) => (c.type === "generic_approval" ? [{ tool: c.tool, above: c.amount_above, card: c.id }] : [])),
    never: rb.cards.flatMap((c) => (c.type === "generic_never" ? [{ tool: c.tool, match: c.match, conditions: c.conditions, card: c.id }] : [])),
  };
  const files: Record<string, string> = {
    "audit_cases.json": JSON.stringify(cases, null, 2),
    "constraints.json": JSON.stringify(constraints, null, 2),
    "mutants/manifest.json": manifest(mutants),
  };
  return { cases, skipped, mutants, equivalent, guards, constraints, files };
}

/** The Auditor's judgement. Blockers fail the verdict; the Owner sees every finding. */
export function decide(rb: Rulebook, plan: AuditPlan, results: JobResults | null): Verdict {
  const findings: Finding[] = [];
  for (const issue of validateRulebook(rb)) findings.push({ severity: "blocker", code: "RULEBOOK_INVALID", message: `${issue.card}: ${issue.message}` });

  if (!results) {
    findings.push({ severity: "blocker", code: "JOB_FAILED", message: "the sandbox job produced no results" });
    return { status: "fail", mutation_score: 0, findings };
  }

  for (const f of results.builder_tests.failures) findings.push({ severity: "blocker", code: "BUILDER_TEST_FAILED", message: f });
  for (const f of results.audit_spec.failures) findings.push({ severity: "blocker", code: "SPEC_MISMATCH", message: f });
  for (const v of results.constraints.violations) findings.push({ severity: "blocker", code: "CONSTRAINT_VIOLATION", message: v });

  // Mutant sources travel inside the manifest. A sandbox runtime older than that cannot find them and
  // counts every load error as a caught defect, which would be a false PASS. It must confirm it read them.
  if (plan.mutants.length && (results.mutation as { inline_sources?: boolean }).inline_sources !== true) {
    findings.push({
      severity: "blocker",
      code: "JOB_FAILED",
      message: "the sandbox runtime did not read the planted defects (it predates inline mutant sources); deploy reeve-runtime main and run again",
    });
  }
  const score = results.mutation.total ? results.mutation.killed / results.mutation.total : 1;
  if (score < MIN_MUTATION_SCORE) {
    findings.push({
      severity: "blocker",
      code: "WEAK_SPEC",
      message: `only ${results.mutation.killed}/${results.mutation.total} planted defects were caught; every one must be caught before the Owner can approve`,
    });
  }
  for (const s of results.mutation.survivors) findings.push({ severity: "blocker", code: "MUTANT_SURVIVED", message: `${s.id}: ${s.description}` });
  for (const g of plan.guards ?? []) findings.push({ severity: g.severity, code: "GUARD_UNREACHABLE", message: g.message });
  for (const s of plan.skipped) findings.push({ severity: "warning", code: "NOT_TESTED", message: s });
  for (const e of plan.equivalent) findings.push({ severity: "info", code: "EQUIVALENT_MUTANT", message: e });
  for (const q of rb.questions) findings.push({ severity: "info", code: "OPEN_QUESTION", message: q });

  return { status: findings.some((f) => f.severity === "blocker") ? "fail" : "pass", mutation_score: score, findings };
}
