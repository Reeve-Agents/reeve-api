import { findCard, packOf, validateRulebook, type Finding, type JobResults, type Rulebook, type Verdict } from "@reeve/core";
import { generateMutants, type Mutant } from "./mutate";
import { buildSpecCases, type SpecCase } from "./spec";
import { buildStockSpecCases, orderSizeFor, type StockSpecCase } from "./spec-stock";
import { buildGenericSpecCases, generateGenericMutants, type GenericSpecCase } from "./spec-generic";

export { buildSpecCases, roundHalfEven, type SpecCase } from "./spec";
export { buildStockSpecCases, orderSizeFor, type StockSpecCase } from "./spec-stock";
export { buildGenericSpecCases, generateGenericMutants, type GenericSpecCase } from "./spec-generic";
export { generateMutants, type Mutant } from "./mutate";

export const MIN_MUTATION_SCORE = 0.8;

export interface AuditPlan {
  cases: (SpecCase | StockSpecCase | GenericSpecCase)[];
  skipped: string[];
  mutants: Mutant[];
  /** Mutants no possible input can tell apart from the real code (left out, reported as info). */
  equivalent: string[];
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
      mutants = mutants.map((m, i) => ({ ...m, id: `m${String(i + 1).padStart(3, "0")}` }));
    }
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
    "mutants/manifest.json": JSON.stringify(
      mutants.map((m) => ({ id: m.id, file: `${m.id}.py`, description: m.description })),
      null,
      2,
    ),
  };
  for (const m of mutants) files[`mutants/${m.id}.py`] = m.source;
  return { cases, skipped, mutants, equivalent, constraints, files };
}

function prepareGenericAudit(rb: Rulebook, rulesPy: string): AuditPlan {
  const { cases, skipped } = buildGenericSpecCases(rb);
  const mutants = generateGenericMutants(rulesPy);
  const constraints = {
    approvals: rb.cards.flatMap((c) => (c.type === "generic_approval" ? [{ tool: c.tool, above: c.amount_above, card: c.id }] : [])),
    never: rb.cards.flatMap((c) => (c.type === "generic_never" ? [{ tool: c.tool, match: c.match, conditions: c.conditions, card: c.id }] : [])),
  };
  const files: Record<string, string> = {
    "audit_cases.json": JSON.stringify(cases, null, 2),
    "constraints.json": JSON.stringify(constraints, null, 2),
    "mutants/manifest.json": JSON.stringify(
      mutants.map((m) => ({ id: m.id, file: `${m.id}.py`, description: m.description })),
      null,
      2,
    ),
  };
  for (const m of mutants) files[`mutants/${m.id}.py`] = m.source;
  return { cases, skipped, mutants, equivalent: [], constraints, files };
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

  const score = results.mutation.total ? results.mutation.killed / results.mutation.total : 1;
  if (score < MIN_MUTATION_SCORE) {
    findings.push({
      severity: "blocker",
      code: "WEAK_SPEC",
      message: `only ${results.mutation.killed}/${results.mutation.total} planted defects were caught (< ${MIN_MUTATION_SCORE * 100}%)`,
    });
  }
  for (const s of results.mutation.survivors) findings.push({ severity: "warning", code: "MUTANT_SURVIVED", message: `${s.id}: ${s.description}` });
  for (const s of plan.skipped) findings.push({ severity: "warning", code: "NOT_TESTED", message: s });
  for (const e of plan.equivalent) findings.push({ severity: "info", code: "EQUIVALENT_MUTANT", message: e });
  for (const q of rb.questions) findings.push({ severity: "info", code: "OPEN_QUESTION", message: q });

  return { status: findings.some((f) => f.severity === "blocker") ? "fail" : "pass", mutation_score: score, findings };
}
