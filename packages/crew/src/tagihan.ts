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

/** Day of the month the rent is due (SOP "Tagihan Kos Melati" step 1: bills go out on the 1st). The live bills and the contract both read this. */
export const KOS_DUE_DAY = 1;

/** The due date of the bill for one billing month ("2026-12" -> "2026-12-01"). */
export const kosDueDate = (period: string): string => `${period.slice(0, 7)}-${String(KOS_DUE_DAY).padStart(2, "0")}`;

/** The contract's due-date sentence, from the same constant the live bills use. The fee clause counts H+N from this date. */
export function rentDueContractClause(cards: RentCards = KOS_RENT_CARDS): string {
  return `Sewa Rp${cards.rent_idr.toLocaleString("id-ID")} per bulan, jatuh tempo setiap tanggal ${KOS_DUE_DAY} (dibayar paling lambat pada tanggal itu).`;
}

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
  /** The Jakarta date this bill was last processed by the live tick; a retry the same day skips it (see liveTick). */
  last_tick?: string;
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

export interface RentTickOpts {
  cards?: RentCards;
  execute: (tool: string, args: Record<string, unknown>) => Promise<ExecResult>;
  gate?: Gate;
  /** A bill to leave out entirely (already handled today). Paid bills are always left out. */
  skip?: (b: TenantBill) => boolean;
  /** Called after each bill's decision is recorded, before the next bill starts (the live tick saves its progress here). */
  onBill?: (b: TenantBill, d: RentDecision) => void | Promise<void>;
}

export async function rentTick(run: MekoRun, bills: TenantBill[], today: string, opts: RentTickOpts): Promise<RentDecision[]> {
  const cards = opts.cards ?? KOS_RENT_CARDS;
  const op = await run.agent("operator", `Tick ${today}: tagihan sewa`);
  const out: RentDecision[] = [];
  const emit = async (b: TenantBill, d: RentDecision) => {
    out.push(d);
    await opts.onBill?.(b, d);
  };
  for (const b of bills) {
    if (b.paid || opts.skip?.(b)) continue;
    const late = daysLate(b.due, today);
    const grace = b.tenure_months >= cards.late_fee.tenure_grace.min_months ? cards.late_fee.tenure_grace.extra_days : 0;
    const feeDay = cards.late_fee.days_after_due + grace;
    const wantsFee = late >= feeDay && !b.fee_charged;
    const wantsNotice = late === cards.notice_days;
    const wantsReminder = cards.reminder_days.includes(late);
    if (!wantsFee && !wantsNotice && !wantsReminder) {
      await emit(b, { id: b.id, action: "none", days_late: late });
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
      await emit(b, { id: b.id, action: "hold", days_late: late, receipt: d.receipt_hash });
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
      await emit(b, { id: b.id, action: "charge_fee", days_late: late, amount, receipt: d.receipt_hash });
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
    await emit(b, { id: b.id, action, days_late: late, receipt: d.receipt_hash });
  }
  return out;
}
