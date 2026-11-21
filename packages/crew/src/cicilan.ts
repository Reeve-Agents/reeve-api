// One owner-approved payment-plan bound ("bounded negotiation"). The bound is a rule card: compiled,
// audited with planted bad offers, approved with a passkey. Offers inside it go out with a receipt
// citing the bound; anything outside goes to the owner with a suggested reply.
import type { MekoRun } from "@reeve/meko";
import { canonicalJson, sha256 } from "@reeve/receipts";
import type { PasskeyProof } from "./crew";
import { AI_LABEL } from "./validator";

export interface PlanBound {
  id: string;
  max_installments: number;
  /** Last day of the bill's month by which everything is paid. */
  finish_by_day: number;
  waive_fee_if_on_time: boolean;
  source_quote: string;
}

export const KOS_PLAN_BOUND: PlanBound = {
  id: "bound_cicilan",
  max_installments: 2,
  finish_by_day: 25,
  waive_fee_if_on_time: true,
  source_quote: "Kalau penghuni minta mundur bayar: boleh dicicil maksimal 2 kali, lunas sebelum tanggal 25, tanpa denda kalau tepat waktu.",
};

export interface Bill {
  subject: string;
  amount: number;
  /** YYYY-MM */
  month: string;
}

export interface PlanOffer {
  installments: { date: string; amount: number }[];
  waive_fee: boolean;
}

export type OfferViolation = "TOO_MANY_INSTALLMENTS" | "AFTER_DEADLINE" | "WRONG_TOTAL" | "BAD_AMOUNT" | "WAIVE_NOT_ALLOWED";

export function checkOffer(bound: PlanBound, bill: Bill, offer: PlanOffer): OfferViolation[] {
  const v: OfferViolation[] = [];
  if (offer.installments.length === 0 || offer.installments.length > bound.max_installments) v.push("TOO_MANY_INSTALLMENTS");
  for (const i of offer.installments) {
    const [y, m, d] = i.date.split("-").map(Number) as [number, number, number];
    if (`${y}-${String(m).padStart(2, "0")}` !== bill.month || d > bound.finish_by_day) v.push("AFTER_DEADLINE");
    if (!(i.amount > 0) || !Number.isInteger(i.amount)) v.push("BAD_AMOUNT");
  }
  if (offer.installments.reduce((s, i) => s + i.amount, 0) !== bill.amount) v.push("WRONG_TOTAL");
  if (offer.waive_fee && !bound.waive_fee_if_on_time) v.push("WAIVE_NOT_ALLOWED");
  return [...new Set(v)];
}

/** "saya baru bisa bayar tanggal 20" -> 20 */
export function requestedDay(text: string): number | null {
  const m = text.match(/tanggal\s+(\d{1,2})|tgl\.?\s*(\d{1,2})/i);
  const d = m ? Number(m[1] ?? m[2]) : NaN;
  return d >= 1 && d <= 31 ? d : null;
}

const iso = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

/** What code would offer for a requested day; null when the bound cannot cover it. */
export function proposeOffer(bound: PlanBound, bill: Bill, day: number): PlanOffer | null {
  const offer = { installments: [{ date: iso(bill.month, day), amount: bill.amount }], waive_fee: bound.waive_fee_if_on_time };
  return checkOffer(bound, bill, offer).length ? null : offer;
}

/** The closest offer the bound allows, for the owner to send if they want. */
export function suggestInBound(bound: PlanBound, bill: Bill): PlanOffer {
  const half = Math.floor(bill.amount / 2);
  return { installments: [{ date: iso(bill.month, 20), amount: half }, { date: iso(bill.month, bound.finish_by_day), amount: bill.amount - half }], waive_fee: bound.waive_fee_if_on_time };
}

export interface BoundAudit {
  bound_hash: string;
  status: "pass" | "fail";
  spec: { total: number; passed: number };
  planted: { total: number; caught: number; survivors: string[] };
}

/** Spec offers must pass; planted offers (3 installments, fee waived after the 25th, ...) must fail. */
export function auditBound(bound: PlanBound, bill: Bill): BoundAudit {
  const a = bill.amount;
  const spec: PlanOffer[] = [
    { installments: [{ date: iso(bill.month, 20), amount: a }], waive_fee: true },
    { installments: [{ date: iso(bill.month, 10), amount: a / 2 }, { date: iso(bill.month, bound.finish_by_day), amount: a / 2 }], waive_fee: true },
    { installments: [{ date: iso(bill.month, bound.finish_by_day), amount: a }], waive_fee: false },
  ];
  const planted: { id: string; offer: PlanOffer }[] = [
    { id: "three_installments", offer: { installments: [10, 15, 20].map((d) => ({ date: iso(bill.month, d), amount: a / 3 })), waive_fee: true } },
    { id: "waive_after_25th", offer: { installments: [{ date: iso(bill.month, bound.finish_by_day + 2), amount: a }], waive_fee: true } },
    { id: "day_26", offer: { installments: [{ date: iso(bill.month, 20), amount: a / 2 }, { date: iso(bill.month, bound.finish_by_day + 1), amount: a / 2 }], waive_fee: false } },
    { id: "short_by_one", offer: { installments: [{ date: iso(bill.month, 20), amount: a - 1 }], waive_fee: true } },
    { id: "next_month", offer: { installments: [{ date: `${bill.month.slice(0, 5)}${String(Number(bill.month.slice(5)) % 12 + 1).padStart(2, "0")}-05`, amount: a }], waive_fee: true } },
    { id: "zero_installment", offer: { installments: [{ date: iso(bill.month, 20), amount: a }, { date: iso(bill.month, 21), amount: 0 }], waive_fee: true } },
  ];
  const passed = spec.filter((o) => checkOffer(bound, bill, o).length === 0).length;
  const survivors = planted.filter((p) => checkOffer(bound, bill, p.offer).length === 0).map((p) => p.id);
  if (!bound.waive_fee_if_on_time && checkOffer(bound, bill, { ...spec[0]!, waive_fee: true }).length === 0) survivors.push("waive_not_allowed");
  return {
    bound_hash: sha256(canonicalJson(bound)),
    status: passed === spec.length && survivors.length === 0 ? "pass" : "fail",
    spec: { total: spec.length, passed },
    planted: { total: planted.length, caught: planted.length - survivors.length, survivors },
  };
}

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

export function offerText(offer: PlanOffer): string {
  const parts = offer.installments.map((i) => `${rp(i.amount)} paling lambat ${i.date}`);
  return `Boleh. ${parts.join(", lalu ")}${offer.waive_fee ? ", tanpa denda kalau tepat waktu" : ""}. (${AI_LABEL})`;
}

/** Builder, Auditor and owner turns for the bound, like any rule card. */
export async function approveBound(run: MekoRun, bound: PlanBound, bill: Bill, passkey: PasskeyProof): Promise<BoundAudit> {
  const builder = await run.agent("builder", "Compile bound: cicilan");
  await builder.decide({ input: bound.source_quote, output: bound, reasoning: `The owner's sentence sets at most ${bound.max_installments} installments, paid by day ${bound.finish_by_day}, fee waived only if on time.`, action: "compile_bound" });
  const audit = auditBound(bound, bill);
  const auditor = await run.agent("auditor", "Audit bound: cicilan");
  await auditor.decide({
    input: `bound ${bound.id}`,
    output: audit,
    reasoning: `${audit.spec.passed}/${audit.spec.total} valid offers pass and ${audit.planted.caught}/${audit.planted.total} planted bad offers (3 installments, fee waived after the 25th, ...) are refused.`,
    action: audit.status === "pass" ? "audit_pass" : "audit_fail",
  });
  if (audit.status !== "pass") return audit;
  const owner = await run.agent("owner", "Approve bound: cicilan");
  await owner.decide({ input: `approve ${bound.id}`, output: { approved: true, binds: audit.bound_hash, method: passkey.method }, reasoning: "The owner approved the payment-plan bound once; every offer inside it cites this approval.", action: "approve_bound" });
  return audit;
}

export interface Negotiation {
  action: "offer_plan" | "ask_owner";
  reply?: string;
  suggested?: string;
  receipt: string;
}

/** Tenant asks to pay later. Inside the bound: offer with a receipt. Outside: owner, with a suggestion. */
export async function negotiate(run: MekoRun, bound: PlanBound, bill: Bill, text: string): Promise<Negotiation> {
  const op = await run.agent("operator", `Cicilan: ${bill.subject}`);
  await op.search(`${bill.subject} cicilan bayar mundur riwayat`);
  const day = requestedDay(text);
  const offer = day ? proposeOffer(bound, bill, day) : null;
  if (offer) {
    const reply = offerText(offer);
    const d = await op.decide({
      input: `${bill.subject}: "${text}" (tagihan ${rp(bill.amount)} ${bill.month})`,
      output: { action: "offer_plan", offer, bound: bound.id },
      reasoning: `Day ${day} is on or before day ${bound.finish_by_day} and one payment fits the ${bound.max_installments}-installment limit, so the offer is inside bound ${bound.id} ("${bound.source_quote}").`,
      action: "offer_plan",
      action_class: "payment_plan",
      subject: bill.subject,
    });
    return { action: "offer_plan", reply, receipt: d.receipt_hash };
  }
  const suggested = offerText(suggestInBound(bound, bill));
  const d = await op.decide({
    input: `${bill.subject}: "${text}" (tagihan ${rp(bill.amount)} ${bill.month})`,
    output: { action: "ask_owner", suggested },
    reasoning: day ? `Day ${day} is after day ${bound.finish_by_day}, outside bound ${bound.id}; the owner decides, with an in-bound suggestion ready.` : "No date found in the request; the owner decides.",
    action: "ask_owner",
    action_class: "payment_plan",
    subject: bill.subject,
  });
  return { action: "ask_owner", suggested, receipt: d.receipt_hash };
}
