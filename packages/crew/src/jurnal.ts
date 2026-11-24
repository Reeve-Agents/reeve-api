// Bookkeeping from the ledger (backlog T1-5). Each rent the owner marked paid and each late fee the tick
// recorded becomes one journal row in a Google Sheet, through Composio. The rows are built by code from
// receipts; no model is involved. Every row carries its receipt hash and a proof link, so the sheet can
// be checked against the ledger, and an "Asal" column says whether the decision was live or from the demo seed.
// Each sync that wrote rows is itself a traced decision (operator, action "journal_sync").
import type { MekoMessage, MekoWorkspace } from "@reeve/meko";
import type { DecisionBody, LedgerEntry } from "@reeve/receipts";
import type { CalendarRegistry } from "./calendar";
import { KOS_RENT_IDR } from "./kos";

export const SHEETS_TOOLKIT = "googlesheets";
export const SHEETS_APPEND_TOOL = "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND";
export const SHEETS_CREATE_TOOL = "GOOGLESHEETS_CREATE_GOOGLE_SHEET1";
/** Google Sheets rejects a bare range ("A:J"): the append needs the tab's name, read once with this tool. */
export const SHEETS_NAMES_TOOL = "GOOGLESHEETS_GET_SHEET_NAMES";
export const JOURNAL_TITLE = "Reeve - Jurnal Kos Melati";
export const JOURNAL_HEADER = ["Dicatat (WIB)", "Jenis", "Penghuni", "Kamar", "Jatuh tempo", "Jumlah (Rp)", "Keterangan", "Asal", "Receipt", "Bukti"];
/** At most this many rows go out in one append. */
const BATCH = 200;
const WIB_MS = 7 * 3_600_000;

export interface JournalRow {
  receipt: string;
  /** "YYYY-MM-DD HH:MM", WIB: when the receipt was written. */
  recorded: string;
  kind: "rent_received" | "late_fee";
  subject: string;
  room: string;
  due: string;
  amount_idr: number;
  note: string;
  /** "live": the live tick or the owner's paid button; "demo": written by the seed script. */
  origin: "live" | "demo";
  proof: string;
}

/** Store shape under `data.meko_journal`. The spreadsheet id is kept here, never in the ledger. */
export interface JournalState {
  spreadsheet_id?: string;
  /** The tab rows are appended to (the sheet's first tab). */
  sheet_name?: string;
  /** Set when Reeve created the sheet; cleared once the header row is written. */
  needs_header?: boolean;
  /** Receipts already written to the sheet. */
  synced: string[];
  /** Receipts written to the sheet whose `journal_sync` decision is not recorded yet; the next sync records it. */
  untraced?: string[];
  last_sync?: string;
}

type StoreLike = { data: object; save(): void };
type Decision = LedgerEntry & DecisionBody;

export function loadJournal(data: object): JournalState {
  const d = data as { meko_journal?: JournalState };
  return (d.meko_journal ??= { synced: [] });
}

const LIVE_RUNS = /^run_(live_tick|mark_paid)_/;
const wibStamp = (iso: string) => new Date(Date.parse(iso) + WIB_MS).toISOString().slice(0, 16).replace("T", " ");

function parse(s: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(s ?? "");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * One journal row per rent marked paid and per late fee, oldest first, read from the ledger and the Meko trace.
 * Receipts in `skip` are left out before any conversation is read, so a sync's cost follows the new rows,
 * not the whole history. A conversation that cannot be read is skipped; its rows come back once it can be.
 */
export async function journalRows(ws: MekoWorkspace, proofUrl: (receipt: string) => string = (r) => `/?view=jejak&receipt=${r}`, skip: ReadonlySet<string> = new Set()): Promise<JournalRow[]> {
  const wanted = ws.decisions().filter((d) => (d.action === "mark_paid" || d.action === "charge_fee") && !skip.has(d.entry_hash));
  const convs = new Map<string, string>();
  for (const d of wanted) if (!convs.has(d.conversation_id)) convs.set(d.conversation_id, d.agent);
  const byReceipt = new Map<string, MekoMessage>();
  for (const [id, agent] of convs) {
    let messages: MekoMessage[];
    try {
      messages = (await ws.conversation(agent, id)).messages;
    } catch (e) {
      console.error(`journal: conversation ${id} unreadable, its rows wait: ${oneLine(e)}`);
      continue;
    }
    for (const m of messages) if (typeof m.metadata?.reeve_receipt === "string") byReceipt.set(m.metadata.reeve_receipt, m);
  }
  const rows: JournalRow[] = [];
  for (const d of wanted) {
    const m = byReceipt.get(d.entry_hash);
    if (!m) continue;
    const row = toRow(d, m, proofUrl);
    if (row) rows.push(row);
  }
  return rows;
}

function toRow(d: Decision, m: MekoMessage, proofUrl: (r: string) => string): JournalRow | null {
  const out = parse(m.output);
  const room = m.input.match(/kamar (\d+)/)?.[1] ?? "";
  const base = { receipt: d.entry_hash, recorded: wibStamp(d.at), subject: d.subject ?? "", room, origin: LIVE_RUNS.test(d.run_id) ? ("live" as const) : ("demo" as const), proof: proofUrl(d.entry_hash) };
  if (d.action === "mark_paid") {
    return { ...base, kind: "rent_received", due: String(out.due ?? ""), amount_idr: KOS_RENT_IDR, note: `Sewa${out.period ? ` ${String(out.period)}` : ""} diterima. Dicatat dari kata pemilik; tidak ada rail pembayaran yang dibaca.` };
  }
  const amount = Number(out.amount_idr);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const late = m.input.match(/telat (\d+) hari/)?.[1];
  return { ...base, kind: "late_fee", due: m.input.match(/jatuh tempo (\d{4}-\d{2}-\d{2})/)?.[1] ?? "", amount_idr: amount, note: `Denda keterlambatan${late ? ` ${late} hari` : ""}. Dicatat sebagai piutang; belum ditagih ke penghuni.` };
}

const KIND_LABEL: Record<JournalRow["kind"], string> = { rent_received: "Sewa diterima", late_fee: "Denda (piutang)" };

/** The row as the sheet stores it; amounts are plain numbers, so the sheet can sum them. */
export function sheetValues(r: JournalRow): (string | number)[] {
  return [r.recorded, KIND_LABEL[r.kind], r.subject, r.room, r.due, r.amount_idr, r.note, r.origin === "live" ? "live" : "demo (seed)", r.receipt, r.proof];
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A string field wherever a Composio answer puts it (response_data, data, or the top level). */
function field(data: unknown, ...keys: string[]): string | undefined {
  const o = rec(data);
  for (const c of [rec(o?.response_data), rec(rec(o?.data)?.response_data), rec(o?.data), o]) for (const k of keys) if (typeof c?.[k] === "string" && c[k]) return c[k] as string;
  return undefined;
}

/** The first tab's name from a GOOGLESHEETS_GET_SHEET_NAMES answer. */
export function firstSheetName(data: unknown): string | undefined {
  const o = rec(data);
  for (const c of [rec(o?.response_data), rec(o?.data), o]) {
    const list = c?.sheet_names ?? c?.sheetNames ?? c?.sheets;
    const first = Array.isArray(list) ? list[0] : undefined;
    const name = typeof first === "string" ? first : rec(first)?.title;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

/** A1 range over columns A:J of one tab; the name is quoted, so spaces and quotes are safe. */
export const tabRange = (name: string) => `'${name.replaceAll("'", "''")}'!A:J`;

/** The appended range ("Sheet1!A2:J5") from an append answer; it holds no id. */
export function appendedRange(data: unknown): string | undefined {
  const o = rec(data);
  for (const c of [rec(o?.response_data), rec(o?.data), o]) {
    const u = rec(c?.updates);
    if (typeof u?.updatedRange === "string") return u.updatedRange;
    if (typeof c?.updatedRange === "string") return c.updatedRange;
  }
  return undefined;
}

/** An error as one short line, with keys and long ids (a spreadsheet id, for one) masked. */
const oneLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/\b(?:ck|ak|sk)_[A-Za-z0-9_-]+/g, "[key]")
    .replace(/[A-Za-z0-9_-]{25,}/g, "[id]")
    .replace(/\s+/g, " ")
    .slice(0, 200);

export interface JournalSyncResult {
  status: "synced" | "nothing_new" | "unavailable" | "failed";
  rows: number;
  /** The sync decision, when rows were written. */
  receipt?: string;
  /** Rows not yet written (still pending after a failure or past the batch size). */
  pending: number;
  created_sheet?: boolean;
  note: string;
}

export interface JournalSyncDeps {
  ws: MekoWorkspace;
  store: StoreLike;
  registry: CalendarRegistry | null;
  /** A sheet the owner already has (REEVE_JOURNAL_SHEET_ID); without one, the first sync creates JOURNAL_TITLE. */
  spreadsheetId?: string;
  proofUrl?: (receipt: string) => string;
  now?: () => number;
}

/**
 * Writes the journal rows not yet in the sheet. Nothing is written when Composio or Google Sheets is not
 * connected ("unavailable"). A failed append marks nothing as synced, so the next sync tries the same rows
 * again. A sync that wrote rows records one `journal_sync` decision listing their receipts.
 */
export async function syncJournal(deps: JournalSyncDeps): Promise<JournalSyncResult> {
  const state = loadJournal(deps.store.data);
  const done = new Set(state.synced);
  const owedSet = new Set(state.untraced ?? []);
  const rows = await journalRows(deps.ws, deps.proofUrl, new Set([...done].filter((r) => !owedSet.has(r))));
  const fresh = rows.filter((r) => !done.has(r.receipt));
  const owed = rows.filter((r) => owedSet.has(r.receipt));
  if (fresh.length === 0) {
    if (owed.length === 0) return { status: "nothing_new", rows: 0, pending: 0, note: "Jurnal sudah lengkap: tidak ada baris baru." };
    try {
      const receipt = await traceSync(deps, state, owed, {});
      return { status: "synced", rows: 0, receipt, pending: 0, note: `Jejak untuk ${owed.length} baris jurnal yang sudah ditulis kini tercatat.` };
    } catch (e) {
      return { status: "failed", rows: 0, pending: 0, note: `Baris jurnal sudah di Google Sheets, tetapi jejaknya belum tercatat: ${oneLine(e)}. Dicoba lagi pada sinkron berikutnya.` };
    }
  }
  const registry = deps.registry;
  const why = await unavailable(registry);
  if (why || !registry) return { status: "unavailable", rows: 0, pending: fresh.length, note: `Jurnal belum ditulis: ${why}.` };
  const fail = (e: unknown): JournalSyncResult => ({ status: "failed", rows: 0, pending: fresh.length, note: `Menulis ke Google Sheets gagal: ${oneLine(e)}. Baris akan dicoba lagi pada sinkron berikutnya.` });

  // A sheet the owner names replaces the one Reeve made; its tab is read again.
  if (deps.spreadsheetId && deps.spreadsheetId !== state.spreadsheet_id) {
    state.spreadsheet_id = deps.spreadsheetId;
    delete state.sheet_name;
    delete state.needs_header;
  }
  let created = false;
  let r: Awaited<ReturnType<CalendarRegistry["execute"]>>;
  const batch = fresh.slice(0, BATCH);
  try {
    if (!state.spreadsheet_id) {
      const c = await registry.execute("composio", SHEETS_CREATE_TOOL, { title: JOURNAL_TITLE });
      if (!c.ok) return fail(c.error ?? "membuat spreadsheet gagal");
      const id = field(c.data, "spreadsheetId", "spreadsheet_id", "id");
      if (!id) return fail("Composio tidak mengembalikan id spreadsheet");
      state.spreadsheet_id = id;
      state.needs_header = true;
      created = true;
      deps.store.save();
    }
    const sheet = state.spreadsheet_id;
    if (!state.sheet_name) {
      const n = await registry.execute("composio", SHEETS_NAMES_TOOL, { spreadsheet_id: sheet });
      const name = n.ok ? firstSheetName(n.data) : undefined;
      if (!name) return fail(n.error ?? "nama tab spreadsheet tidak terbaca");
      state.sheet_name = name;
      deps.store.save();
    }
    const header = state.needs_header === true;
    const values = [...(header ? [JOURNAL_HEADER] : []), ...batch.map(sheetValues)];
    r = await registry.execute("composio", SHEETS_APPEND_TOOL, { spreadsheetId: sheet, range: tabRange(state.sheet_name), valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", majorDimension: "ROWS", values });
    if (!r.ok) throw new Error(r.error ?? "append gagal");
  } catch (e) {
    // The tab may have been renamed or removed: read its name again next time.
    if (state.sheet_name) {
      delete state.sheet_name;
      deps.store.save();
    }
    return fail(e);
  }
  // Written: mark the rows synced first, so they are never appended twice, and owe their decision until it is recorded.
  state.synced.push(...batch.map((b) => b.receipt));
  state.untraced = [...(state.untraced ?? []), ...batch.map((b) => b.receipt)];
  state.last_sync = new Date(deps.now?.() ?? Date.now()).toISOString();
  delete state.needs_header;
  deps.store.save();
  const pending = fresh.length - batch.length;
  const base = { status: "synced" as const, rows: batch.length, pending, ...(created ? { created_sheet: true } : {}) };
  const note = `${batch.length} baris jurnal ditulis ke Google Sheets${created ? ` (spreadsheet baru "${JOURNAL_TITLE}")` : ""}.${pending ? ` ${pending} baris lagi pada sinkron berikutnya.` : ""}`;
  try {
    const receipt = await traceSync(deps, state, [...owed, ...batch], { via: r.connector, range: appendedRange(r.data), created });
    return { ...base, receipt, note };
  } catch (e) {
    console.error(`journal: rows written, decision not recorded yet: ${oneLine(e)}`);
    return { ...base, note: `${note} Jejaknya belum tercatat; dicoba lagi pada sinkron berikutnya.` };
  }
}

/** Records one `journal_sync` decision for rows already in the sheet, then clears them from `untraced`. */
async function traceSync(deps: JournalSyncDeps, state: JournalState, rows: JournalRow[], at: { via?: string; range?: string; created?: boolean }): Promise<string> {
  const op = await deps.ws.run(`run_journal_${Date.now().toString(36)}`).agent("operator", "Jurnal Google Sheets");
  const count = (k: JournalRow["kind"]) => rows.filter((b) => b.kind === k).length;
  const totals = (k: JournalRow["kind"]) => rows.filter((b) => b.kind === k).reduce((s, b) => s + b.amount_idr, 0);
  const d = await op.decide({
    input: `${rows.length} baris jurnal dari ledger ditulis ke Google Sheets (${count("rent_received")} sewa diterima, ${count("late_fee")} denda)`,
    output: { action: "journal_sync", ...(at.via ? { via: at.via } : {}), rows: rows.length, receipts: rows.map((b) => b.receipt), rent_received_idr: totals("rent_received"), late_fee_idr: totals("late_fee"), ...(at.range ? { range: at.range } : {}), ...(at.created ? { created_sheet: true } : {}) },
    reasoning: `Code built ${rows.length} journal row(s) from the ledger (rent the owner marked paid, late fees the tick recorded) and appended them to the owner's Google Sheet through Composio; each row carries its receipt hash and proof link. No model was used. The spreadsheet id is kept in the workspace store, not in this receipt.`,
    action: "journal_sync",
    action_class: "bookkeeping",
  });
  const traced = new Set(rows.map((b) => b.receipt));
  const left = (state.untraced ?? []).filter((x) => !traced.has(x));
  if (left.length) state.untraced = left;
  else delete state.untraced;
  deps.store.save();
  return d.receipt_hash;
}

/** Why Google Sheets cannot be used right now, or null when it can. */
async function unavailable(registry: CalendarRegistry | null): Promise<string | null> {
  if (!registry || !registry.list().some((c) => c.kind === "composio")) return "tidak ada konektor Composio (COMPOSIO_API_KEY belum diisi)";
  try {
    return ((await registry.appStatus([SHEETS_TOOLKIT]))[SHEETS_TOOLKIT] ?? 0) > 0 ? null : "Google Sheets belum terhubung di Composio";
  } catch (e) {
    return `koneksi Google Sheets tidak bisa dicek (${oneLine(e)})`;
  }
}
