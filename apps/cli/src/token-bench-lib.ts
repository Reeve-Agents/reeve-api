// Pure parts of the token benchmark (apps/cli/src/token-bench.ts): the shared events, the ground
// truth, the prompts, scoring and aggregation. No network and no model here, so they are testable.
import { billsOf, buildHistory, exceptionDays, KOS_RENT_CARDS, kosDiscoverySample, parseChatExport, parsePaymentsCsv, type History, type RentCards } from "@reeve/crew";
import { Pseudonymiser } from "@reeve/meko";

export type Action = "remind" | "charge_fee" | "hold" | "notice" | "none";
export const ACTIONS: Action[] = ["remind", "charge_fee", "hold", "notice", "none"];

export interface Decision {
  action: Action;
  amount_idr?: number;
}

/** One decision point: a bill still unpaid on a checkpoint day (H+3, H+7, H+10, H+14), or the day it was paid when that is before H+3. */
export interface BenchEvent {
  id: string;
  subject: string;
  room: string;
  month: string;
  due: string;
  today: string;
  tenure_months: number;
  /** The late fee was already charged on this bill (by the rules, at an earlier checkpoint). */
  fee_charged: boolean;
  expected: Decision;
  days_late: number;
}

const dayMs = 86_400_000;
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

/** What the approved rules decide for one unpaid bill: the same logic as `rentTick` (packages/crew/src/tagihan.ts), without Meko. */
export function decideRent(bill: { due: string; tenure_months: number; fee_charged: boolean }, today: string, exceptionUntilDays: number | null, cards: RentCards = KOS_RENT_CARDS): Decision & { days_late: number } {
  const late = daysBetween(bill.due, today);
  const grace = bill.tenure_months >= cards.late_fee.tenure_grace.min_months ? cards.late_fee.tenure_grace.extra_days : 0;
  const feeDay = cards.late_fee.days_after_due + grace;
  const wantsFee = late >= feeDay && !bill.fee_charged;
  const wantsNotice = late === cards.notice_days;
  const wantsReminder = cards.reminder_days.includes(late);
  if (!wantsFee && !wantsNotice && !wantsReminder) return { action: "none", days_late: late };
  if (wantsFee && exceptionUntilDays !== null && late <= exceptionUntilDays) return { action: "hold", days_late: late };
  if (wantsFee) return { action: "charge_fee", amount_idr: Math.round((cards.rent_idr * cards.late_fee.percent) / 100), days_late: late };
  return { action: wantsNotice ? "notice" : "remind", days_late: late };
}

/** The owner's latest "kamar N boleh telat sampai X hari" before `today`, read by code from the pseudonymised chat. */
export function exceptionFor(h: History, room: string, today: string): number | null {
  let found: number | null = null;
  for (const e of h.events) {
    if (e.role !== "Pemilik" || e.at.slice(0, 10) >= today) continue;
    const d = exceptionDays(e.text, room);
    if (d !== null) found = d;
  }
  return found;
}

export const CHECKPOINTS = [3, 7, 10, 14];

/** Events for every bill of a history: one decision per checkpoint the bill was still unpaid on. Ground truth is the rules' own decision. */
export function buildEvents(h: History, cards: RentCards = KOS_RENT_CARDS): BenchEvent[] {
  const out: BenchEvent[] = [];
  for (const b of billsOf(h, 1)) {
    const late = Number.isFinite(b.late) ? b.late : 14;
    let days = CHECKPOINTS.filter((c) => c <= late);
    if (!days.length) days = [Math.min(late, 2)];
    let feeCharged = false;
    for (const c of days) {
      const today = addDays(b.due, c);
      const exp = decideRent({ due: b.due, tenure_months: b.tenure, fee_charged: feeCharged }, today, exceptionFor(h, b.room, today), cards);
      out.push({ id: `${b.subject}@${today}`, subject: b.subject, room: b.room, month: b.month, due: b.due, today, tenure_months: b.tenure, fee_charged: feeCharged, expected: { action: exp.action, ...(exp.amount_idr !== undefined ? { amount_idr: exp.amount_idr } : {}) }, days_late: exp.days_late });
      if (exp.action === "charge_fee") feeCharged = true;
    }
  }
  return out;
}

/** The pseudonymised Kos Melati history (3 months, 12 tenants, 36 bills). */
export function sampleHistory(): History {
  const s = kosDiscoverySample();
  return buildHistory(parseChatExport(s.chat), parsePaymentsCsv(s.payments), new Pseudonymiser(), { business: "Kos Melati" });
}

const dmy = (at: string) => `${at.slice(8, 10)}/${at.slice(5, 7)}/${at.slice(2, 4)} ${at.slice(11, 16)}`;

/** Everything the chat and the sheet held before `today`, pseudonymised: what a naive prompt would paste in. */
export function historyText(h: History, today: string): string {
  const chat = h.events.filter((e) => e.at.slice(0, 10) < today).map((e) => `${dmy(e.at)} ${e.role}: ${e.text}`);
  const pay = h.payments.filter((p) => p.date < today).map((p) => [p.date, p.subject, p.kind, p.amount, p.note].join(","));
  return `CHAT (WhatsApp group, pseudonymised):\n${chat.join("\n")}\n\nPAYMENTS (tanggal,penghuni,jenis,jumlah,catatan):\n${pay.join("\n")}`;
}

export const BASELINE_SYSTEM = [
  "You run rent collection for a boarding house (kos). You get the owner's SOP, the whole chat and payments history so far (names are pseudonymised), and one unpaid bill. Decide what to do today.",
  'Reply with ONE JSON object and nothing else: {"action":"remind"|"charge_fee"|"hold"|"escalate"|"none","amount_idr":number|null,"message":string|null}.',
  "remind = send a payment reminder. charge_fee = charge the late fee (give the amount in rupiah). hold = a fee would be due but the owner gave this tenant permission to be late, so charge nothing. escalate = send the warning letter to leave. none = do nothing today.",
  "message = a short Indonesian message to the tenant for remind, charge_fee and escalate, else null. Follow the SOP and the owner's exceptions in the chat.",
].join("\n");

export function baselineUser(sop: string, h: History, e: BenchEvent, rent = KOS_RENT_CARDS.rent_idr): string {
  return [
    `SOP:\n${sop}`,
    historyText(h, e.today),
    `BILL TO DECIDE:\nToday: ${e.today}\nTenant: ${e.subject}, kamar ${e.room}\nDue date: ${e.due}\nRent: Rp${rent.toLocaleString("id-ID")}\nTenure: ${e.tenure_months} months\nStatus: unpaid\nLate fee already charged on this bill: ${e.fee_charged ? "yes" : "no"}`,
  ].join("\n\n");
}

/** Reads the model's reply as a decision; null when it is not strict JSON with a known action. */
export function parseDecision(text: string): Decision | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: { action?: unknown; amount_idr?: unknown };
  try {
    j = JSON.parse(m[0]) as typeof j;
  } catch {
    return null;
  }
  const raw = String(j.action ?? "").toLowerCase().trim();
  const action: Action | null = raw === "escalate" || raw === "notice" ? "notice" : (ACTIONS as string[]).includes(raw) ? (raw as Action) : null;
  if (!action) return null;
  let amount: number | undefined;
  if (typeof j.amount_idr === "number" && Number.isFinite(j.amount_idr)) amount = Math.round(j.amount_idr);
  else if (typeof j.amount_idr === "string" && /\d/.test(j.amount_idr)) amount = Number(j.amount_idr.replace(/\D/g, ""));
  return action === "charge_fee" && amount !== undefined ? { action, amount_idr: amount } : { action };
}

/** A decision is right when the action matches and, for a fee, the amount matches. */
export function isCorrect(expected: Decision, got: Decision | null): boolean {
  if (!got || got.action !== expected.action) return false;
  return expected.action !== "charge_fee" || got.amount_idr === expected.amount_idr;
}

export interface Scored {
  total: number;
  correct: number;
  accuracy: number;
  invalid: number;
  /** Per expected action: [correct, total]. */
  byAction: Record<Action, [number, number]>;
}

export function scoreRun(pairs: { expected: Decision; got: Decision | null }[]): Scored {
  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, [0, 0]])) as Scored["byAction"];
  let correct = 0;
  let invalid = 0;
  for (const p of pairs) {
    byAction[p.expected.action][1]++;
    if (!p.got) invalid++;
    if (isCorrect(p.expected, p.got)) {
      correct++;
      byAction[p.expected.action][0]++;
    }
  }
  return { total: pairs.length, correct, accuracy: pairs.length ? (100 * correct) / pairs.length : 0, invalid, byAction };
}

export interface Stat {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function stat(xs: number[]): Stat {
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, min: s[0]!, max: s[s.length - 1]! };
}

export interface RunRow {
  arm: "baseline" | "reeve";
  run: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  wall_ms: number;
  scored: Scored;
}

export function aggregate(rows: RunRow[]) {
  return {
    runs: rows.length,
    calls: stat(rows.map((r) => r.calls)),
    input_tokens: stat(rows.map((r) => r.input_tokens)),
    output_tokens: stat(rows.map((r) => r.output_tokens)),
    cost_usd: stat(rows.map((r) => r.cost_usd)),
    wall_ms: stat(rows.map((r) => r.wall_ms)),
    accuracy: stat(rows.map((r) => r.scored.accuracy)),
  };
}

/** Reeve over `months` of repeated use: the compile is paid once, each month costs what was measured. Extrapolated, not measured. */
export function projectReeve(compile: { input: number; output: number; usd: number }, month: { input: number; output: number; usd: number }, months: number) {
  return { months, input: compile.input + month.input * months, output: compile.output + month.output * months, usd: compile.usd + month.usd * months };
}

export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Offline token counter for --fake: about 4 characters per token. Not a measurement. */
export const fakeTokens = (text: string) => Math.ceil(text.length / 4);

/** Names of the sample's people; none may appear in a prompt. */
export const SAMPLE_NAMES = ["Dimas", "Rina", "Sinta", "Bagus", "Nadia", "Fajar", "Wulan", "Andi", "Laras", "Yoga", "Citra", "Rizky", "Ratna", "Joko", "Kusuma", "Maharani", "Pratama"];
export function assertPseudonymised(text: string): void {
  const hit = SAMPLE_NAMES.find((n) => new RegExp(`\\b${n}\\b`, "i").test(text));
  if (hit) throw new Error(`a real name (${hit}) is in a prompt; refusing to call the model`);
}
