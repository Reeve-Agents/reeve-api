// Auditor for playbooks: code, no LLM. Checks budget math, review on risky steps, a stop condition
// and reachability, then plants broken copies and bad drafts that must all be caught.
import { canonicalJson, sha256 } from "@reeve/receipts";
import { daysBetween, type Playbook, type PlaybookStep } from "./playbook";
import { plantedDrafts, validate, type ValidatorFacts } from "./validator";

export type PlaybookFindingCode = "BUDGET_EXCEEDED" | "CALLS_EXCEEDED" | "PAYMENT_ABOVE_BOUND" | "UNREVIEWED_PUBLISH" | "UNREVIEWED_PAYMENT" | "AUTO_INTENT_NOT_ALLOWED" | "NO_STOP" | "NO_TARGET" | "UNREACHABLE_STEP" | "UNKNOWN_CHECK";

export interface PlaybookFinding {
  code: PlaybookFindingCode;
  step?: string;
  message: string;
}

/** Worst case: every step uses its full daily Worker budget on every day until the goal date. */
export function worstCase(pb: Playbook): { cost_idr: number; worker_calls: number; days: number } {
  const days = daysBetween(pb.starts_on, pb.goal.by);
  let cost = 0;
  let calls = 0;
  for (const s of pb.steps) {
    calls += s.budget.max_worker_calls_per_day * days;
    cost += s.budget.max_worker_calls_per_day * s.budget.cost_idr_per_call * days;
  }
  return { cost_idr: cost, worker_calls: calls, days };
}

export function reachable(pb: Playbook): Set<string> {
  const events = new Set(pb.starts);
  const fired = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of pb.steps)
      if (!fired.has(s.id) && events.has(s.when)) {
        fired.add(s.id);
        s.emits.forEach((e) => events.add(e));
        grew = true;
      }
  }
  return fired;
}

const KNOWN_CHECKS = /^R\d\d$/;

export function checkPlaybook(pb: Playbook, opts: { whitelist: readonly string[] }): PlaybookFinding[] {
  const out: PlaybookFinding[] = [];
  const wc = worstCase(pb);
  if (wc.cost_idr > pb.budget.max_cost_idr)
    out.push({ code: "BUDGET_EXCEEDED", message: `Biaya terburuk Rp${wc.cost_idr.toLocaleString("id-ID")} (${wc.days} hari) melebihi anggaran Rp${pb.budget.max_cost_idr.toLocaleString("id-ID")}.` });
  if (wc.worker_calls > pb.budget.max_worker_calls) out.push({ code: "CALLS_EXCEEDED", message: `${wc.worker_calls} panggilan Worker > batas ${pb.budget.max_worker_calls}.` });
  if (!(pb.goal.target > 0) || !pb.goal.metric) out.push({ code: "NO_TARGET", message: "Playbook tidak punya target yang bisa diukur." });
  if (!pb.stop.on_target && !pb.stop.by_date) out.push({ code: "NO_STOP", message: "Playbook tidak pernah berhenti sendiri (tanpa target atau tanggal)." });
  const fired = reachable(pb);
  for (const s of pb.steps) {
    if (!fired.has(s.id)) out.push({ code: "UNREACHABLE_STEP", step: s.id, message: `Langkah ${s.id} tidak pernah jalan: tidak ada yang memicu "${s.when}".` });
    if (s.payment && s.payment.amount_idr > pb.budget.max_payment_idr)
      out.push({ code: "PAYMENT_ABOVE_BOUND", step: s.id, message: `Tagihan Rp${s.payment.amount_idr.toLocaleString("id-ID")} > batas Rp${pb.budget.max_payment_idr.toLocaleString("id-ID")}.` });
    if (s.review === "auto_within_bound" && !s.payment) out.push({ code: "UNREVIEWED_PUBLISH", step: s.id, message: `Langkah ${s.id} memakai "auto_within_bound" padahal bukan tagihan.` });
    if (s.publish && s.review === "none") out.push({ code: "UNREVIEWED_PUBLISH", step: s.id, message: `Langkah ${s.id} menerbitkan tanpa review.` });
    if (s.publish && s.review === "auto_if_whitelisted_intent" && s.recipe.skill !== "cs_reply" && s.recipe.skill !== "book_viewing")
      out.push({ code: "UNREVIEWED_PUBLISH", step: s.id, message: `Hanya balasan CS yang boleh terkirim sendiri, bukan ${s.recipe.skill}.` });
    if (s.payment && s.review === "none") out.push({ code: "UNREVIEWED_PAYMENT", step: s.id, message: `Langkah ${s.id} menagih uang tanpa aturan yang disetujui.` });
    for (const intent of s.whitelisted_intents ?? [])
      if (!opts.whitelist.includes(intent)) out.push({ code: "AUTO_INTENT_NOT_ALLOWED", step: s.id, message: `Intent "${intent}" tidak boleh dijawab otomatis.` });
    for (const c of s.checks) if (!KNOWN_CHECKS.test(c)) out.push({ code: "UNKNOWN_CHECK", step: s.id, message: `Cek ${c} tidak dikenal.` });
  }
  return out;
}

export interface PlantedPlaybook {
  id: string;
  expect: PlaybookFindingCode;
  playbook: Playbook;
}

function edit(pb: Playbook, f: (copy: Playbook) => void): Playbook {
  const copy = structuredClone(pb);
  f(copy);
  return copy;
}

/** Broken copies of the playbook. Each must produce the finding it was planted for. */
export function plantedPlaybooks(pb: Playbook): PlantedPlaybook[] {
  const out: PlantedPlaybook[] = [];
  const add = (id: string, expect: PlaybookFindingCode, f: (c: Playbook) => void) => out.push({ id, expect, playbook: edit(pb, f) });
  const firstWorker = pb.steps.findIndex((s) => s.budget.max_worker_calls_per_day > 0);
  if (firstWorker >= 0) {
    add("cost_x10", "BUDGET_EXCEEDED", (c) => (c.steps[firstWorker]!.budget.cost_idr_per_call *= 10_000));
    add("calls_x100", "CALLS_EXCEEDED", (c) => (c.steps[firstWorker]!.budget.max_worker_calls_per_day *= 1000));
  }
  add("budget_zero", "BUDGET_EXCEEDED", (c) => (c.budget.max_cost_idr = 0));
  pb.steps.forEach((s, i) => {
    if (s.payment) {
      add(`${s.id}:no_review`, "UNREVIEWED_PAYMENT", (c) => (c.steps[i]!.review = "none"));
      add(`${s.id}:above_bound`, "PAYMENT_ABOVE_BOUND", (c) => (c.steps[i]!.payment!.amount_idr = c.budget.max_payment_idr + 1));
    }
    if (s.publish) add(`${s.id}:no_review`, "UNREVIEWED_PUBLISH", (c) => (c.steps[i]!.review = "none"));
    if (s.publish && s.recipe.skill !== "cs_reply" && s.recipe.skill !== "book_viewing")
      add(`${s.id}:auto_publish`, "UNREVIEWED_PUBLISH", (c) => (c.steps[i]!.review = "auto_if_whitelisted_intent"));
    if (s.whitelisted_intents) add(`${s.id}:auto_refund`, "AUTO_INTENT_NOT_ALLOWED", (c) => c.steps[i]!.whitelisted_intents!.push("refund"));
    add(`${s.id}:never_fires`, "UNREACHABLE_STEP", (c) => (c.steps[i]!.when = `${s.when}_typo`));
  });
  add("no_stop", "NO_STOP", (c) => {
    c.stop.on_target = false;
    delete c.stop.by_date;
  });
  add("no_target", "NO_TARGET", (c) => (c.goal.target = 0));
  add("orphan_step", "UNREACHABLE_STEP", (c) => c.steps.push({ ...structuredClone(c.steps[0]!), id: "orphan", when: "never_emitted", emits: [] }));
  return out;
}

export interface PlaybookAudit {
  playbook_id: string;
  playbook_hash: string;
  status: "pass" | "fail";
  findings: PlaybookFinding[];
  worst_case: ReturnType<typeof worstCase>;
  planted: { total: number; caught: number; survivors: string[] };
  drafts: { total: number; caught: number; survivors: string[]; good_draft_clean: boolean };
}

/** Full playbook audit. One survivor (planted copy or bad draft that passes) blocks approval. */
export function auditPlaybook(pb: Playbook, opts: { whitelist: readonly string[]; facts: ValidatorFacts; good_draft: string }): PlaybookAudit {
  const findings = checkPlaybook(pb, opts);
  const planted = plantedPlaybooks(pb);
  const survivors = planted.filter((p) => !checkPlaybook(p.playbook, opts).some((f) => f.code === p.expect)).map((p) => p.id);
  const drafts = plantedDrafts(opts.good_draft, opts.facts);
  const draftSurvivors = drafts.filter((d) => !validate(d.draft, opts.facts).some((h) => h.rule === d.rule)).map((d) => d.rule);
  const goodClean = validate(opts.good_draft, opts.facts).length === 0;
  const pass = findings.length === 0 && survivors.length === 0 && draftSurvivors.length === 0 && goodClean;
  return {
    playbook_id: pb.id,
    playbook_hash: sha256(canonicalJson(pb)),
    status: pass ? "pass" : "fail",
    findings,
    worst_case: worstCase(pb),
    planted: { total: planted.length, caught: planted.length - survivors.length, survivors },
    drafts: { total: drafts.length, caught: drafts.length - draftSurvivors.length, survivors: draftSurvivors, good_draft_clean: goodClean },
  };
}
