// The live billing loop of the Kos Melati demo. The seed stores the demo tenants' bills in the
// workspace store (`data.meko_bills`); a tick (the API route, the in-process scheduler or an outside
// cron) runs `rentTick` over them for today's date in Asia/Jakarta, saves the bill state, and does it
// once per day. The autonomy ladder decides whether a reminder runs by itself; one that does is STAGED
// in the outbox for the 10-minute undo window, and only then goes out through the executor: Telegram
// when the bot token and the tenant's chat are known, otherwise the Log connector (recorded, not sent).
// Fees are decisions in the ledger; nothing is charged or collected.
// A tick that fails midway is resumable: each bill's progress (`last_tick`) is saved right after the bill is
// processed, so a retry the same day continues with the rest and nothing is staged twice. A bill leaves the
// loop when the owner records the payment (markBillPaid); the next month starts it unpaid again.
// The scheduler assumes ONE API instance: the claim for a day lives in this process's copy of the store, so
// two instances ticking the same day would both run it (the store is not re-read between them).
import type { MekoWorkspace } from "@reeve/meko";
import type { ExecResult } from "./crew";
import { wibDate } from "./digest";
import { Ladder } from "./ladder";
import { Outbox, type OutboxItem } from "./outbox";
import { kosDueDate, rentTick, type RentDecision, type TenantBill } from "./tagihan";
import { AI_LABEL } from "./validator";

export const TICK_TOOL = "TELEGRAM_SEND_MESSAGE";
/** How many finished days a bill book remembers (a tick is idempotent per day). */
const KEEP_DAYS = 14;

export interface TickBillResult {
  id: string;
  /** What rentTick decided: remind, notice, charge_fee, hold or none. */
  action: RentDecision["action"];
  /** What was recorded: ask_owner (class still at "ask"), remind_staged, hold, charge_fee ... */
  decision?: string;
  days_late: number;
  amount_idr?: number;
  receipt?: string;
  /** The outbox item that will send the reminder after the undo window. */
  outbox_item?: string;
}

export interface TickReport {
  /** Today in Asia/Jakarta. */
  date: string;
  ran_at: string;
  /** Billing month of the bills, "2026-12". */
  period: string;
  /** Set when a new month began and the bills were rolled to its due date. */
  rolled_from?: string;
  /** True when this date had already been ticked: nothing new was recorded for the bills. */
  repeated?: boolean;
  bills: TickBillResult[];
  /** Every decision this tick recorded (bills and staged reminders). */
  receipts: string[];
  staged: string[];
  /** Staged reminders whose 10-minute window had passed and that ran now (the executor decides how they travel). */
  flushed: { id: string; via?: string; status: string; receipt?: string }[];
  note: string;
}

/** A tick that has started but not finished: what the bills done so far produced (resumed by a retry the same day). */
export interface PartialTick {
  date: string;
  rolled_from?: string;
  bills: TickBillResult[];
  staged: { id: string; stage_receipt: string }[];
}

export interface BillBook {
  /** Billing month, "2026-12". */
  period: string;
  bills: TenantBill[];
  seeded_at: string;
  ticks: Record<string, TickReport>;
  /** Set while today's tick is unfinished; cleared when every bill is done and `ticks[today]` is written. */
  partial?: PartialTick;
}

type Data = Record<string, unknown>;
type StoreLike = { data: object; save(): void };

/** The 1st of the month that `at` falls in, in Asia/Jakarta. */
export const monthStartWib = (at: string | number | Date): string => `${wibDate(at).slice(0, 7)}-01`;

/** The due date of the bill for the month `at` falls in, in Asia/Jakarta (KOS_DUE_DAY, the same day the contract states). */
export const dueDateWib = (at: string | number | Date): string => kosDueDate(wibDate(at));

/** The five Kos Melati demo tenants (pseudonyms, tenure in months, paid or not) for one due date. */
export function demoBills(due: string): TenantBill[] {
  return [
    { id: "K03", room: "3", due, paid: false, tenure_months: 5 },
    { id: "K05", room: "5", due, paid: false, tenure_months: 3 },
    { id: "K08", room: "8", due, paid: false, tenure_months: 14 },
    { id: "K12", room: "12", due, paid: true, tenure_months: 8 },
    { id: "K17", room: "17", due, paid: false, tenure_months: 2 },
  ];
}

export function loadBillBook(data: object): BillBook | null {
  return ((data as Data).meko_bills as BillBook | undefined) ?? null;
}

/** Writes a fresh live bill set (what the seed does) and forgets earlier ticks. */
export function saveBillBook(data: object, bills: TenantBill[], now: string | number | Date = Date.now()): BillBook {
  const book: BillBook = { period: wibDate(now).slice(0, 7), bills, seeded_at: new Date(now).toISOString(), ticks: {} };
  (data as Data).meko_bills = book;
  return book;
}

const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));

/** A new month starts a new bill: due on the due day (KOS_DUE_DAY), nobody has paid yet (rent is monthly), no fee charged, tenure one month longer per month passed. */
function rollBook(book: BillBook, today: string): string | undefined {
  const period = today.slice(0, 7);
  const passed = monthsBetween(book.period, period);
  if (passed <= 0) return undefined;
  const from = book.period;
  book.bills = book.bills.map((b) => ({ id: b.id, room: b.room, due: kosDueDate(period), paid: false, tenure_months: b.tenure_months + passed }));
  book.period = period;
  return from;
}

export class NoBills extends Error {
  constructor() {
    super("Belum ada tagihan hidup: jalankan seed (npm run meko:seed) untuk menulis tagihan penghuni demo.");
  }
}

export interface LiveTickDeps {
  ws: MekoWorkspace;
  store: StoreLike;
  ladder: Ladder;
  outbox: Outbox;
  /** Runs a staged reminder after its window: Telegram or the Log connector (see liveExecutor). */
  execute: (tool: string, args: Record<string, unknown>) => Promise<ExecResult>;
  now?: () => number;
}

const flushedView = (items: OutboxItem[]) => items.map((i) => ({ id: i.id, via: i.via, status: i.status, receipt: i.done_receipt }));

/**
 * One tick for today (Asia/Jakarta) over the stored bills. The first call of a day records the day's
 * decisions and saves the bill state; a second call the same day returns that report with
 * `repeated: true` and records nothing new for the bills. Either way, reminders staged earlier whose
 * 10-minute window has passed are run (once each) first.
 *
 * Resumable: each bill's progress is saved as soon as it is done (`last_tick`, plus its result in
 * `book.partial`). If the tick throws midway, the day is NOT marked done; a retry skips the bills
 * already done today, picks up the rest, and reuses a reminder that was staged but not yet recorded,
 * so no tenant gets two reminders. The day is complete only when every unpaid bill is done.
 */
export async function liveTick(deps: LiveTickDeps): Promise<TickReport> {
  const now = deps.now?.() ?? Date.now();
  const today = wibDate(now);
  const book = loadBillBook(deps.store.data);
  if (!book) throw new NoBills();
  const flushed = flushedView(await deps.outbox.flush(now, deps.execute));
  const done = book.ticks[today];
  if (done) return { ...done, repeated: true, flushed, note: `Sudah dijalankan untuk ${today}: tidak ada yang dicatat lagi.` };

  // Continue today's unfinished tick, or start one (a partial from an earlier day is dropped: its bills carry an older last_tick).
  let partial = book.partial?.date === today ? book.partial : undefined;
  if (!partial) {
    const rolled_from = rollBook(book, today);
    partial = book.partial = { date: today, ...(rolled_from ? { rolled_from } : {}), bills: [], staged: [] };
    deps.store.save();
  }
  const part = partial;
  const stagedBy = new Map<string, OutboxItem>();
  const stage = async (tool: string, args: Record<string, unknown>): Promise<ExecResult> => {
    // A reminder staged by an earlier, failed attempt today (staged, but its bill was not recorded) is reused, never staged again.
    const prior = deps.outbox.items().find((i) => i.tool === tool && i.args.to === args.to && i.args.template === args.template && i.args.days_late === args.days_late && wibDate(i.staged_at) === today);
    const item = prior ?? (await deps.outbox.stage({ action_class: "reminder", tool, args, subject: String(args.to) }, now));
    stagedBy.set(String(args.to), item);
    return { ok: true, via: "staged" };
  };
  const todo = book.bills.filter((b) => !b.paid && b.last_tick !== today);
  if (todo.length) {
    const run = deps.ws.run(`run_live_tick_${today.replaceAll("-", "")}_${Date.now().toString(36)}`);
    await rentTick(run, book.bills, today, {
      execute: stage,
      gate: (cls, unusual) => deps.ladder.gate(cls, unusual),
      skip: (b) => b.last_tick === today,
      onBill: (b, o) => {
        const item = stagedBy.get(o.id);
        part.bills.push({
          id: o.id,
          action: o.action,
          decision: o.receipt ? deps.ws.decisions().find((d) => d.entry_hash === o.receipt)?.action : undefined,
          days_late: o.days_late,
          ...(o.amount !== undefined ? { amount_idr: o.amount } : {}),
          ...(o.receipt ? { receipt: o.receipt } : {}),
          ...(item ? { outbox_item: item.id } : {}),
        });
        if (item) part.staged.push({ id: item.id, stage_receipt: item.stage_receipt });
        b.last_tick = today;
        deps.store.save();
      },
    });
  }

  const acted = part.bills.filter((b) => b.action !== "none").length;
  const report: TickReport = {
    date: today,
    ran_at: new Date(now).toISOString(),
    period: book.period,
    ...(part.rolled_from ? { rolled_from: part.rolled_from } : {}),
    bills: part.bills,
    receipts: [...part.bills.flatMap((b) => (b.receipt ? [b.receipt] : [])), ...part.staged.map((s) => s.stage_receipt)],
    staged: part.staged.map((s) => s.id),
    flushed,
    note: acted
      ? `${acted} tagihan ada tindakan hari ini; ${part.staged.length} pengingat dijadwalkan (bisa dibatalkan 10 menit), denda hanya dicatat, tidak ditagih.`
      : "Tidak ada tagihan yang jatuh pada hari pengingat, denda atau pemberitahuan hari ini.",
  };
  book.ticks[today] = report;
  delete book.partial;
  for (const d of Object.keys(book.ticks).sort().slice(0, -KEEP_DAYS)) delete book.ticks[d];
  deps.store.save();
  return report;
}

export class UnknownBill extends Error {
  constructor(id: string) {
    super(`Tagihan ${id} tidak ada di tagihan hidup.`);
  }
}

export interface MarkPaidDeps {
  ws: MekoWorkspace;
  store: StoreLike;
  outbox: Outbox;
  now?: () => number;
}

export interface MarkPaidResult {
  id: string;
  period: string;
  paid: true;
  /** True when the bill was already marked paid: nothing new was recorded. */
  already?: boolean;
  /** The recorded decision (action "mark_paid"). */
  receipt?: string;
  /** Reminders of this bill still inside their 10-minute window, cancelled because the rent is paid. */
  cancelled: string[];
  note: string;
}

/**
 * The owner records that one tenant paid this month's rent (no payment rail is read: this is the owner's word).
 * The bill leaves the loop (no reminder, notice or fee until the next month rolls it back to unpaid), the
 * decision is a traced `mark_paid` turn in the ledger, and a reminder of this bill that is still waiting in its
 * undo window is cancelled (not demoted: the owner did not disagree with Reeve, the tenant just paid).
 */
export async function markBillPaid(deps: MarkPaidDeps, id: string, by: string): Promise<MarkPaidResult> {
  const book = loadBillBook(deps.store.data);
  if (!book) throw new NoBills();
  const bill = book.bills.find((b) => b.id === id);
  if (!bill) throw new UnknownBill(id);
  if (bill.paid) return { id, period: book.period, paid: true, already: true, cancelled: [], note: `${id} sudah ditandai lunas untuk ${book.period}: tidak ada yang dicatat lagi.` };
  const at = deps.now?.() ?? Date.now();
  const owner = await deps.ws.run(`run_mark_paid_${Date.now().toString(36)}`).agent("owner", `Tandai lunas: ${id}`);
  const d = await owner.decide({
    input: `${id} kamar ${bill.room}: ditandai sudah bayar untuk tagihan ${book.period} oleh ${by}`,
    output: { action: "mark_paid", bill: id, period: book.period, due: bill.due, paid: true },
    reasoning: `The owner (${by}) recorded that ${id} paid the rent for ${book.period}. From now on the tick sends no reminder, notice or late fee for this bill this month; the next month starts it unpaid again. No payment rail was read: this is the owner's word.`,
    action: "mark_paid",
    action_class: "payment",
    subject: id,
  });
  bill.paid = true;
  const cancelled: string[] = [];
  for (const i of deps.outbox.items()) {
    if (i.status !== "staged" || i.args.to !== id) continue;
    i.status = "undone";
    i.undone_at = new Date(at).toISOString();
    i.undo_receipt = d.receipt_hash;
    cancelled.push(i.id);
  }
  deps.store.save();
  return { id, period: book.period, paid: true, receipt: d.receipt_hash, cancelled, note: `${id} ditandai lunas untuk ${book.period}.${cancelled.length ? ` ${cancelled.length} pengingat yang masih menunggu dibatalkan.` : ""}` };
}

/** What a tenant reads. Indonesian, no name, no amount; the AI label is the Validator's rule R15. */
export function tenantMessage(template: unknown, daysLate: number): string {
  const late = Number.isFinite(daysLate) ? Math.max(0, Math.round(daysLate)) : 0;
  if (template === "notice") return `Pemberitahuan dari Kos Melati: tagihan sewa kamar Anda sudah terlambat ${late} hari. Mohon hubungi pemilik kos hari ini supaya bisa dicari jalan keluarnya. (${AI_LABEL}; pesan otomatis dari Reeve)`;
  return `Pengingat dari Kos Melati: tagihan sewa kamar Anda sudah lewat jatuh tempo ${late} hari. Mohon dibayar secepatnya. Kalau ada kendala, balas pesan ini. (${AI_LABEL}; pesan otomatis dari Reeve)`;
}

/**
 * The connector for staged reminders. Telegram `sendMessage` when a bot token is set and the tenant's
 * chat id is known (`via: "telegram"`); otherwise the Log connector (`via: "log"`, recorded, not sent).
 * A Telegram refusal or network error is `ok: false`, which the outbox records as a failed run.
 */
export function liveExecutor(opts: { token?: string; chatOf: (subject: string) => string | null | undefined; fetchFn?: typeof fetch }): (tool: string, args: Record<string, unknown>) => Promise<ExecResult> {
  return async (tool, args) => {
    const chat = opts.token && tool === TICK_TOOL ? opts.chatOf(String(args.to ?? "")) : null;
    if (!opts.token || !chat) return { ok: true, via: "log" };
    try {
      const res = await (opts.fetchFn ?? fetch)(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: tenantMessage(args.template, Number(args.days_late)), link_preview_options: { is_disabled: true } }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } };
      if (!res.ok || body.ok === false) return { ok: false, via: "telegram" };
      return { ok: true, via: "telegram", ...(body.result?.message_id !== undefined ? { ref: String(body.result.message_id) } : {}) };
    } catch {
      return { ok: false, via: "telegram" };
    }
  };
}
