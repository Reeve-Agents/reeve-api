// Rent tick on Kos Melati, traced on Meko: the approved rulebook's reminder, late fee and notice
// cards applied by code, after a context_search for owner exceptions. This is the decision a
// tenant asks about ("kenapa saya didenda?").
import type { MekoRun } from "@reeve/meko";
import type { ExecResult, Gate } from "./crew";

export interface RentCards {
  reminder_days: number[];
  late_fee: { days_after_due: number; percent: number; tenure_grace: { min_months: number; extra_days: number }; source_quote: string };
  notice_days: number;
  rent_idr: number;
}

/** From the Kos Melati rulebook (fixtures/kos-melati/rulebook.json, cards R2, R3, R4). */
export const KOS_RENT_CARDS: RentCards = {
  reminder_days: [3, 10],
  late_fee: { days_after_due: 7, percent: 5, tenure_grace: { min_months: 12, extra_days: 3 }, source_quote: "H+7 belum lunas kena denda 5% dari harga sewa, cuma sekali per tagihan. Penghuni yang sudah tinggal minimal 12 bulan dapat toleransi 3 hari tambahan" },
  notice_days: 14,
  rent_idr: 1_500_000,
};

/** The late fee in rupiah, from the rule: percent of the rent, once per bill. rentTick charges exactly this. */
export function lateFeeIdr(cards: RentCards = KOS_RENT_CARDS): number {
  return Math.round((cards.rent_idr * cards.late_fee.percent) / 100);
}

/** The contract's late-fee sentences, generated from the rule so they cannot disagree with what rentTick charges. */
export function lateFeeContractClause(cards: RentCards = KOS_RENT_CARDS): string {
  const lf = cards.late_fee;
  return `Belum lunas pada H+${lf.days_after_due} sesudah jatuh tempo dikenai denda ${lf.percent}% dari sewa (Rp${lateFeeIdr(cards).toLocaleString("id-ID")}), cuma sekali per tagihan, kecuali ada izin pemilik. Penghuni yang sudah tinggal minimal ${lf.tenure_grace.min_months} bulan dapat toleransi ${lf.tenure_grace.extra_days} hari tambahan.`;
}

export interface TenantBill {
  /** Pseudonymous id ("K03"); the name never leaves Reeve. */
  id: string;
  room: string;
  due: string;
  paid: boolean;
  tenure_months: number;
  fee_charged?: boolean;
}

export interface RentDecision {
  id: string;
  action: "remind" | "charge_fee" | "hold" | "notice" | "none";
  days_late: number;
  amount?: number;
  receipt?: string;
}

function daysLate(due: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000);
}

/**
 * An owner exception in memory: "Kamar 3 boleh telat sampai 10 hari". Only the owner's wording counts ("boleh telat"):
 * Meko Cloud also distils facts from the Operator's own traces ("kamar 5 ... telat 10 hari"), and those are not permission.
 */
export function exceptionDays(text: string, room: string): number | null {
  const m = text.match(new RegExp(`kamar ${room}\\b[^.]*?boleh telat (?:sampai |hingga )?(\\d+) hari`, "i"));
  return m ? Number(m[1]) : null;
}

export async function rentTick(run: MekoRun, bills: TenantBill[], today: string, opts: { cards?: RentCards; execute: (tool: string, args: Record<string, unknown>) => Promise<ExecResult>; gate?: Gate }): Promise<RentDecision[]> {
  const cards = opts.cards ?? KOS_RENT_CARDS;
  const op = await run.agent("operator", `Tick ${today}: tagihan sewa`);
  const out: RentDecision[] = [];
  for (const b of bills) {
    if (b.paid) continue;
    const late = daysLate(b.due, today);
    const grace = b.tenure_months >= cards.late_fee.tenure_grace.min_months ? cards.late_fee.tenure_grace.extra_days : 0;
    const feeDay = cards.late_fee.days_after_due + grace;
    const wantsFee = late >= feeDay && !b.fee_charged;
    const wantsNotice = late === cards.notice_days;
    const wantsReminder = cards.reminder_days.includes(late);
    if (!wantsFee && !wantsNotice && !wantsReminder) {
      out.push({ id: b.id, action: "none", days_late: late });
      continue;
    }
    const seen = await op.search(`kamar ${b.room} telat bayar izin pemilik`);
    const exc = seen.memory.map((m) => ({ m, days: exceptionDays(m.text, b.room) })).find((x) => x.days !== null);
    if (wantsFee && exc && late <= exc.days!) {
      const d = await op.decide({
        input: `${b.id} kamar ${b.room}: jatuh tempo ${b.due}, hari ini ${today}, telat ${late} hari`,
        output: { action: "hold", rule: "R3 late_fee" },
        reasoning: `Rule R3 would charge (${late} days late >= day ${feeDay}), but shared memory holds an owner exception for kamar ${b.room} up to ${exc.days} days ("${exc.m.text}"), so the Operator holds and charges nothing.`,
        action: "hold",
        action_class: "late_fee",
        subject: b.id,
      });
      out.push({ id: b.id, action: "hold", days_late: late, receipt: d.receipt_hash });
      continue;
    }
    if (wantsFee) {
      const amount = lateFeeIdr(cards);
      const d = await op.decide({
        input: `${b.id} kamar ${b.room}: jatuh tempo ${b.due}, hari ini ${today}, telat ${late} hari, tinggal ${b.tenure_months} bulan`,
        output: { action: "charge_fee", amount_idr: amount, rule: "R3 late_fee" },
        reasoning: `Rule R3 ("${cards.late_fee.source_quote}"): ${late} days late >= day ${feeDay}${grace ? ` (7 + ${grace} for tenure >= 12 months)` : ""}, fee ${cards.late_fee.percent}% of Rp${cards.rent_idr} = Rp${amount}, once per bill. Memory checked for an owner exception on kamar ${b.room}: none found.`,
        action: "charge_fee",
        action_class: "late_fee",
        subject: b.id,
      });
      b.fee_charged = true;
      out.push({ id: b.id, action: "charge_fee", days_late: late, amount, receipt: d.receipt_hash });
      continue;
    }
    const action = wantsNotice ? "notice" : "remind";
    const gate = opts.gate?.("reminder", false) ?? "auto";
    const res = gate === "ask" ? { ok: false, via: "owner_queue" } : await opts.execute("TELEGRAM_SEND_MESSAGE", { to: b.id, template: action, days_late: late });
    const d = await op.decide({
      input: `${b.id} kamar ${b.room}: telat ${late} hari`,
      output: { action, via: res.via, autonomy: gate },
      reasoning: wantsNotice ? `Rule R4: day ${late} late is the notice day.` : `Rule R2: reminders on day ${cards.reminder_days.join(" and ")}; today is day ${late}.${gate === "ask" ? " The reminder class is still at 'ask', so it waits for the owner." : res.via === "staged" ? " The message is staged for the 10-minute undo window; it counts as a clean run only once it has run." : ""}`,
      action: gate === "ask" ? "ask_owner" : res.via === "staged" ? "remind_staged" : action,
      action_class: action === "notice" ? "notice" : "reminder",
      subject: b.id,
    });
    out.push({ id: b.id, action, days_late: late, receipt: d.receipt_hash });
  }
  return out;
}
