import { describe, expect, it } from "vitest";
import { type CalendarRegistry, JOURNAL_HEADER, journalRows, loadJournal, rentTick, SHEETS_APPEND_TOOL, SHEETS_CREATE_TOOL, SHEETS_NAMES_TOOL, sheetValues, syncJournal, tabRange, type TenantBill } from "../src/index";
import { testDeps } from "./helpers";

const bills = (): TenantBill[] => [
  { id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 3 },
  { id: "K08", room: "8", due: "2026-12-01", paid: false, tenure_months: 14 },
];

/** A seeded ledger: one late fee (K05, demo run) and one rent marked paid (K08, live-style run). */
async function seeded() {
  const { ws } = await testDeps();
  await rentTick(ws.run("run_tick"), bills(), "2026-12-09", { execute: async () => ({ ok: true, via: "log" }) });
  const owner = await ws.run("run_mark_paid_t1").agent("owner", "Tandai lunas: K08");
  await owner.decide({
    input: "K08 kamar 8: ditandai sudah bayar untuk tagihan 2026-12 oleh pemilik",
    output: { action: "mark_paid", bill: "K08", period: "2026-12", due: "2026-12-01", paid: true },
    reasoning: "The owner recorded the payment.",
    action: "mark_paid",
    action_class: "payment",
    subject: "K08",
  });
  return ws;
}

function store() {
  const s = { data: {} as object, saves: 0, save() { s.saves++; } };
  return s;
}

function registry(opts: { connected?: boolean; fail?: string } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const r: CalendarRegistry = {
    list: () => [{ id: "composio", kind: "composio" }],
    appStatus: async (t) => Object.fromEntries(t.map((k) => [k, opts.connected === false ? 0 : 1])),
    execute: async (_c, tool, args) => {
      calls.push({ tool, args });
      if (opts.fail && tool === opts.fail) return { ok: false, error: "quota", connector: "composio" };
      if (tool === SHEETS_NAMES_TOOL) return { ok: true, connector: "composio", data: { sheet_names: ["Lembar 1"], sheets: ["Lembar 1"] } };
      if (tool === SHEETS_CREATE_TOOL) return { ok: true, connector: "composio", data: { response_data: { spreadsheetId: "sheet-123", spreadsheetUrl: "https://docs.google.com/x" } } };
      return { ok: true, connector: "composio", data: { response_data: { updates: { updatedRange: "Sheet1!A1:J3" } } } };
    },
  };
  return { r, calls };
}

describe("journal from the ledger", () => {
  it("builds one row per late fee and per rent marked paid, from receipts", async () => {
    const ws = await seeded();
    const rows = await journalRows(ws, (r) => `https://web/?receipt=${r}`);
    expect(rows.map((r) => `${r.kind}:${r.subject}:${r.amount_idr}:${r.origin}`)).toEqual(["late_fee:K05:75000:demo", "rent_received:K08:1500000:live"]);
    const fee = rows[0]!;
    expect(fee).toMatchObject({ room: "5", due: "2026-12-01" });
    expect(fee.note).toMatch(/8 hari.*piutang/);
    expect(ws.decisions().some((d) => d.entry_hash === fee.receipt && d.action === "charge_fee")).toBe(true);
    expect(sheetValues(rows[1]!)).toEqual([rows[1]!.recorded, "Sewa diterima", "K08", "8", "2026-12-01", 1_500_000, expect.stringMatching(/kata pemilik/), "live", rows[1]!.receipt, `https://web/?receipt=${rows[1]!.receipt}`]);
  });
});

describe("syncJournal", () => {
  it("creates the sheet once, appends the header and rows, records a decision, and never writes a row twice", async () => {
    const ws = await seeded();
    const st = store();
    const { r, calls } = registry();
    const first = await syncJournal({ ws, store: st, registry: r });
    expect(first).toMatchObject({ status: "synced", rows: 2, pending: 0, created_sheet: true });
    expect(calls.map((c) => c.tool)).toEqual([SHEETS_CREATE_TOOL, SHEETS_NAMES_TOOL, SHEETS_APPEND_TOOL]);
    const values = calls[2]!.args.values as unknown[][];
    expect(values[0]).toEqual(JOURNAL_HEADER);
    expect(values).toHaveLength(3);
    expect(calls[2]!.args).toMatchObject({ spreadsheetId: "sheet-123", valueInputOption: "RAW", range: "'Lembar 1'!A:J" });
    expect(loadJournal(st.data)).toMatchObject({ spreadsheet_id: "sheet-123", synced: expect.arrayContaining([expect.any(String)]) });

    const d = ws.decisions({ agent: "operator" }).at(-1)!;
    expect(d.action).toBe("journal_sync");
    expect(d.entry_hash).toBe(first.receipt);
    const msg = (await ws.conversation(d.agent, d.conversation_id)).messages.find((m) => m.metadata?.reeve_receipt === d.entry_hash)!;
    expect(JSON.parse(msg.output)).toMatchObject({ rows: 2, rent_received_idr: 1_500_000, late_fee_idr: 75_000, range: "Sheet1!A1:J3", created_sheet: true });
    expect(msg.output).not.toContain("sheet-123");

    const again = await syncJournal({ ws, store: st, registry: r });
    expect(again.status).toBe("nothing_new");
    expect(calls).toHaveLength(3);
  });

  it("uses the owner's sheet when one is named, without a header", async () => {
    const ws = await seeded();
    const { r, calls } = registry();
    await syncJournal({ ws, store: store(), registry: r, spreadsheetId: "owner-sheet" });
    expect(calls.map((c) => c.tool)).toEqual([SHEETS_NAMES_TOOL, SHEETS_APPEND_TOOL]);
    expect(calls[1]!.args.spreadsheetId).toBe("owner-sheet");
    expect((calls[1]!.args.values as unknown[][])[0]).not.toEqual(JOURNAL_HEADER);
  });

  it("writes nothing when Google Sheets is not connected or Composio is missing", async () => {
    const ws = await seeded();
    const { r, calls } = registry({ connected: false });
    expect(await syncJournal({ ws, store: store(), registry: r })).toMatchObject({ status: "unavailable", pending: 2 });
    expect(await syncJournal({ ws, store: store(), registry: null })).toMatchObject({ status: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(ws.decisions().filter((d) => d.action === "journal_sync")).toHaveLength(0);
  });

  it("marks nothing synced after a failed append, so the next sync retries the same rows", async () => {
    const ws = await seeded();
    const st = store();
    const failing = registry({ fail: SHEETS_APPEND_TOOL });
    const bad = await syncJournal({ ws, store: st, registry: failing.r, spreadsheetId: "s" });
    expect(bad).toMatchObject({ status: "failed", rows: 0, pending: 2 });
    expect(loadJournal(st.data).synced).toEqual([]);
    expect(ws.decisions().filter((d) => d.action === "journal_sync")).toHaveLength(0);
    const ok = registry();
    expect(await syncJournal({ ws, store: st, registry: ok.r, spreadsheetId: "s" })).toMatchObject({ status: "synced", rows: 2 });
  });

  it("still writes the header when the first append after creating the sheet failed", async () => {
    const ws = await seeded();
    const st = store();
    const failing = registry({ fail: SHEETS_APPEND_TOOL });
    expect((await syncJournal({ ws, store: st, registry: failing.r })).status).toBe("failed");
    expect(loadJournal(st.data)).toMatchObject({ spreadsheet_id: "sheet-123", needs_header: true });
    const ok = registry();
    await syncJournal({ ws, store: st, registry: ok.r });
    expect(ok.calls.map((c) => c.tool)).toEqual([SHEETS_NAMES_TOOL, SHEETS_APPEND_TOOL]);
    expect((ok.calls[1]!.args.values as unknown[][])[0]).toEqual(JOURNAL_HEADER);
    expect(loadJournal(st.data).needs_header).toBeUndefined();
  });

  it("reads no conversation for rows already synced, and skips one it cannot read", async () => {
    const ws = await seeded();
    const st = store();
    await syncJournal({ ws, store: st, registry: registry().r });
    const real = ws.conversation.bind(ws);
    let reads = 0;
    (ws as { conversation: typeof ws.conversation }).conversation = async (a, id) => (reads++, real(a, id));
    expect((await syncJournal({ ws, store: st, registry: registry().r })).status).toBe("nothing_new");
    expect(reads).toBe(0);

    const fresh = await seeded();
    const broken = fresh.decisions().find((d) => d.action === "charge_fee")!.conversation_id;
    const realF = fresh.conversation.bind(fresh);
    (fresh as { conversation: typeof fresh.conversation }).conversation = async (a, id) => {
      if (id === broken) throw new Error("404 conversation gone");
      return realF(a, id);
    };
    expect((await journalRows(fresh)).map((r) => r.kind)).toEqual(["rent_received"]);
  });

  it("reads the tab name again after an append fails, so a renamed tab heals", async () => {
    const ws = await seeded();
    const st = store();
    await syncJournal({ ws, store: st, registry: registry({ fail: SHEETS_APPEND_TOOL }).r, spreadsheetId: "s" });
    expect(loadJournal(st.data).sheet_name).toBeUndefined();
    const ok = registry();
    await syncJournal({ ws, store: st, registry: ok.r, spreadsheetId: "s" });
    expect(ok.calls.map((c) => c.tool)).toEqual([SHEETS_NAMES_TOOL, SHEETS_APPEND_TOOL]);
  });

  it("keeps rows written when the decision fails, and records it on the next sync", async () => {
    const ws = await seeded();
    const st = store();
    const realRun = ws.run.bind(ws);
    let broken = true;
    (ws as { run: typeof ws.run }).run = (id) => {
      if (broken && id.startsWith("run_journal_")) throw new Error("meko down");
      return realRun(id);
    };
    const { r, calls } = registry();
    const first = await syncJournal({ ws, store: st, registry: r });
    expect(first).toMatchObject({ status: "synced", rows: 2 });
    expect(first.receipt).toBeUndefined();
    expect(first.note).toMatch(/Jejaknya belum tercatat/);
    expect(loadJournal(st.data).untraced).toHaveLength(2);
    broken = false;
    const second = await syncJournal({ ws, store: st, registry: r });
    expect(second).toMatchObject({ status: "synced", rows: 0 });
    expect(second.receipt).toBeDefined();
    expect(calls.filter((c) => c.tool === SHEETS_APPEND_TOOL)).toHaveLength(1);
    const d = ws.decisions().filter((x) => x.action === "journal_sync");
    expect(d).toHaveLength(1);
    expect(loadJournal(st.data).untraced).toBeUndefined();
    expect((await syncJournal({ ws, store: st, registry: r })).status).toBe("nothing_new");
  });

  it("quotes tab names", () => {
    expect(tabRange("Sheet1")).toBe("'Sheet1'!A:J");
    expect(tabRange("Kas O'Neil")).toBe("'Kas O''Neil'!A:J");
  });
});
