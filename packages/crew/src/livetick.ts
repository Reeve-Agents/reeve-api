// The live billing loop of the Kos Melati demo. The seed stores the demo tenants' bills in the
// workspace store (`data.meko_bills`); a tick (the API route, the in-process scheduler or an outside
// cron) runs `rentTick` over them for today's date in Asia/Jakarta, saves the bill state, and does it
// once per day. The autonomy ladder decides whether a reminder runs by itself; one that does is STAGED
// in the outbox for the 10-minute undo window, and only then goes out through the executor: Telegram
// when the bot token and the tenant's chat are known, otherwise the Log connector (recorded, not sent).
// Fees are decisions in the ledger; nothing is charged or collected.
import type { MekoWorkspace } from "@reeve/meko";
import type { ExecResult } from "./crew";
import { wibDate } from "./digest";
import { Ladder } from "./ladder";
import { Outbox, type OutboxItem } from "./outbox";
import { rentTick, type RentDecision, type TenantBill } from "./tagihan";
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
  /** Set when a new month began and the bills were rolled to its 1st. */
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

export interface BillBook {
  /** Billing month, "2026-12". */
  period: string;
  bills: TenantBill[];
  seeded_at: string;
  ticks: Record<string, TickReport>;
}

type Data = Record<string, unknown>;
type StoreLike = { data: object; save(): void };

/** The 1st of the month that `at` falls in, in Asia/Jakarta. */
export const monthStartWib = (at: string | number | Date): string => `${wibDate(at).slice(0, 7)}-01`;

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
  const due = monthStartWib(now);
  const book: BillBook = { period: due.slice(0, 7), bills, seeded_at: new Date(now).toISOString(), ticks: {} };
  (data as Data).meko_bills = book;
  return book;
}

const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));

/** A new month starts a new bill: due on its 1st, nobody has paid yet, no fee charged, tenure one month longer per month passed. */
function rollBook(book: BillBook, today: string): string | undefined {
  const period = today.slice(0, 7);
  const passed = monthsBetween(book.period, period);
  if (passed <= 0) return undefined;
  const from = book.period;
  book.bills = book.bills.map((b) => ({ id: b.id, room: b.room, due: `${period}-01`, paid: false, tenure_months: b.tenure_months + passed }));
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
 */
export async function liveTick(deps: LiveTickDeps): Promise<TickReport> {
  const now = deps.now?.() ?? Date.now();
  const today = wibDate(now);
  const book = loadBillBook(deps.store.data);
  if (!book) throw new NoBills();
  const flushed = flushedView(await deps.outbox.flush(now, deps.execute));
  const done = book.ticks[today];
  if (done) return { ...done, repeated: true, flushed, note: `Sudah dijalankan untuk ${today}: tidak ada yang dicatat lagi.` };

  const rolled_from = rollBook(book, today);
  const run = deps.ws.run(`run_live_tick_${today.replaceAll("-", "")}_${Date.now().toString(36)}`);
  const stagedBy = new Map<string, OutboxItem>();
  const stage = async (tool: string, args: Record<string, unknown>): Promise<ExecResult> => {
    const item = await deps.outbox.stage({ action_class: "reminder", tool, args, subject: String(args.to) }, now);
    stagedBy.set(String(args.to), item);
    return { ok: true, via: "staged" };
  };
  const out = await rentTick(run, book.bills, today, { execute: stage, gate: (cls, unusual) => deps.ladder.gate(cls, unusual) });

  const decisions = deps.ws.decisions();
  const bills: TickBillResult[] = out.map((o) => ({
    id: o.id,
    action: o.action,
    decision: o.receipt ? decisions.find((d) => d.entry_hash === o.receipt)?.action : undefined,
    days_late: o.days_late,
    ...(o.amount !== undefined ? { amount_idr: o.amount } : {}),
    ...(o.receipt ? { receipt: o.receipt } : {}),
    ...(stagedBy.has(o.id) ? { outbox_item: stagedBy.get(o.id)!.id } : {}),
  }));
  const staged = [...stagedBy.values()];
  const acted = bills.filter((b) => b.action !== "none").length;
  const report: TickReport = {
    date: today,
    ran_at: new Date(now).toISOString(),
    period: book.period,
    ...(rolled_from ? { rolled_from } : {}),
    bills,
    receipts: [...bills.flatMap((b) => (b.receipt ? [b.receipt] : [])), ...staged.map((i) => i.stage_receipt)],
    staged: staged.map((i) => i.id),
    flushed,
    note: acted
      ? `${acted} tagihan ada tindakan hari ini; ${staged.length} pengingat dijadwalkan (bisa dibatalkan 10 menit), denda hanya dicatat, tidak ditagih.`
      : "Tidak ada tagihan yang jatuh pada hari pengingat, denda atau pemberitahuan hari ini.",
  };
  book.ticks[today] = report;
  for (const d of Object.keys(book.ticks).sort().slice(0, -KEEP_DAYS)) delete book.ticks[d];
  deps.store.save();
  return report;
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
