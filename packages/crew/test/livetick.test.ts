import { describe, expect, it } from "vitest";
import { demoBills, KOS_FACTS, Ladder, liveExecutor, liveTick, loadBillBook, loadOutbox, monthStartWib, NoBills, Outbox, saveBillBook, tenantMessage, UNDO_WINDOW_MS, validate } from "../src/index";
import { testDeps } from "./helpers";

const MIN = 60_000;
/** 08:00 WIB on the given Jakarta date. */
const at = (date: string, time = "08:00") => Date.parse(`${date}T${time}:00+07:00`);

async function setup(level?: "auto" | "ask_if_unusual", opts: { token?: string; chats?: Record<string, string>; fetchFn?: typeof fetch } = {}) {
  const t = await testDeps();
  const store = { data: {} as object, save() {} };
  saveBillBook(store.data, demoBills("2026-12-01"), at("2026-12-01"));
  const ladder = new Ladder(t.ws);
  if (level) ladder.state.levels.reminder = { level, since_seq: -1 };
  const outbox = new Outbox(t.ws, store, ladder);
  const calls: { url: string; body: { chat_id: string; text: string } }[] = [];
  const fetchFn = opts.fetchFn ?? ((async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as unknown as typeof fetch);
  const execute = liveExecutor({ token: opts.token, chatOf: (s) => opts.chats?.[s] ?? null, fetchFn });
  const tick = (now: number) => liveTick({ ws: t.ws, store, ladder, outbox, execute, now: () => now });
  return { ...t, store, ladder, outbox, calls, tick };
}

describe("live billing tick", () => {
  it("needs the seed's bills", async () => {
    const t = await testDeps();
    const store = { data: {}, save() {} };
    const ladder = new Ladder(t.ws);
    await expect(liveTick({ ws: t.ws, store, ladder, outbox: new Outbox(t.ws, store, ladder), execute: async () => ({ ok: true, via: "log" }) })).rejects.toBeInstanceOf(NoBills);
  });

  it("is idempotent per Jakarta day: a second call records nothing new and returns the first result", async () => {
    const { tick, ws, outbox } = await setup("auto");
    const first = await tick(at("2026-12-04"));
    expect(first.repeated).toBeUndefined();
    expect(first.bills.map((b) => `${b.id}:${b.action}:${b.decision}`)).toEqual(["K03:remind:remind_staged", "K05:remind:remind_staged", "K08:remind:remind_staged", "K17:remind:remind_staged"]);
    expect(first.staged).toHaveLength(4);
    expect(first.receipts).toHaveLength(8); // four bill decisions + four stage decisions
    const decisions = ws.decisions().length;
    const second = await tick(at("2026-12-04", "08:03"));
    expect(second).toMatchObject({ repeated: true, date: "2026-12-04", receipts: first.receipts, staged: first.staged, bills: first.bills });
    expect(ws.decisions()).toHaveLength(decisions);
    expect(outbox.items()).toHaveLength(4);
    // 23:59 WIB is still the same day; 00:01 WIB the next day is a new tick
    expect((await tick(at("2026-12-04", "23:59"))).repeated).toBe(true);
    expect((await tick(at("2026-12-05", "00:01"))).repeated).toBeUndefined();
  });

  it("uses the Jakarta date, not the UTC date", async () => {
    const { tick } = await setup("auto");
    // 2026-12-04 18:30 UTC is 2026-12-05 01:30 WIB
    expect((await tick(Date.parse("2026-12-04T18:30:00Z"))).date).toBe("2026-12-05");
    expect(monthStartWib(Date.parse("2026-11-30T18:00:00Z"))).toBe("2026-12-01");
  });

  it("respects the autonomy ladder: a reminder class still at ask is not staged, the owner is asked", async () => {
    const { tick, outbox, ws } = await setup();
    const r = await tick(at("2026-12-04"));
    expect(r.bills.map((b) => b.decision)).toEqual(["ask_owner", "ask_owner", "ask_owner", "ask_owner"]);
    expect(r.staged).toEqual([]);
    expect(outbox.items()).toEqual([]);
    expect(ws.decisions().some((d) => d.action === "auto_stage")).toBe(false);
  });

  it("stages for the 10-minute undo window; nothing runs before it, then it runs exactly once", async () => {
    const { tick, outbox, store, calls } = await setup("auto", { token: "TOKEN", chats: { K05: "5555" } });
    const r = await tick(at("2026-12-04"));
    expect(loadOutbox(store.data).every((i) => i.status === "staged")).toBe(true);
    expect(Date.parse(outbox.items()[0]!.due_at) - at("2026-12-04")).toBe(UNDO_WINDOW_MS);
    expect(calls).toEqual([]);
    expect((await tick(at("2026-12-04", "08:09"))).flushed).toEqual([]);
    const later = await tick(at("2026-12-04", "08:11"));
    expect(later.repeated).toBe(true);
    expect(later.flushed).toHaveLength(4);
    expect(calls).toHaveLength(1); // only K05 has a linked chat
    expect((await tick(at("2026-12-04", "08:20"))).flushed).toEqual([]);
    expect(r.staged).toHaveLength(4);
  });

  it("sends the reminder through the Telegram Bot API when the token and the tenant's chat are known", async () => {
    const { tick, outbox, calls, ws } = await setup("auto", { token: "TOKEN", chats: { K05: "5555" } });
    await tick(at("2026-12-04"));
    await tick(at("2026-12-04", "08:11"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0]!.body.chat_id).toBe("5555");
    expect(calls[0]!.body.text).toMatch(/^Pengingat dari Kos Melati: tagihan sewa kamar Anda sudah lewat jatuh tempo 3 hari/);
    const k05 = outbox.items().find((i) => i.subject === "K05")!;
    expect(k05).toMatchObject({ status: "done", via: "telegram" });
    expect(outbox.items().filter((i) => i.subject !== "K05").every((i) => i.status === "done" && i.via === "log")).toBe(true);
    const run = ws.decisions().find((d) => d.entry_hash === k05.done_receipt)!;
    expect(run).toMatchObject({ action: "auto_run", action_class: "reminder" });
  });

  it("falls back to the Log connector without a token, even when a chat is known", async () => {
    const { tick, outbox, calls } = await setup("auto", { chats: { K05: "5555" } });
    await tick(at("2026-12-04"));
    await tick(at("2026-12-04", "08:11"));
    expect(calls).toEqual([]);
    expect(outbox.items().map((i) => `${i.status}:${i.via}`)).toEqual(Array(4).fill("done:log"));
  });

  it("records a Telegram refusal as a failed run, never as sent", async () => {
    const { tick, outbox } = await setup("auto", { token: "TOKEN", chats: { K05: "5555" }, fetchFn: (async () => new Response(JSON.stringify({ ok: false, description: "blocked" }), { status: 403 })) as unknown as typeof fetch });
    await tick(at("2026-12-04"));
    await tick(at("2026-12-04", "08:11"));
    expect(outbox.items().find((i) => i.subject === "K05")).toMatchObject({ status: "failed" });
  });

  it("charges the late fee once per bill (a decision, no money moves), with the 3-day grace for 12+ months", async () => {
    const { tick, store } = await setup("auto");
    const d8 = await tick(at("2026-12-08"));
    expect(d8.bills.filter((b) => b.action === "charge_fee").map((b) => `${b.id}:${b.amount_idr}`)).toEqual(["K03:75000", "K05:75000", "K17:75000"]);
    expect(d8.bills.find((b) => b.id === "K08")!.action).toBe("none"); // 14 months: day 10
    expect(loadBillBook(store.data)!.bills.find((b) => b.id === "K05")!.fee_charged).toBe(true);
    const d9 = await tick(at("2026-12-09"));
    expect(d9.bills.filter((b) => b.action === "charge_fee")).toEqual([]);
    const d11 = await tick(at("2026-12-11"));
    expect(d11.bills.filter((b) => b.action === "charge_fee").map((b) => b.id)).toEqual(["K08"]);
    // K12 paid: never touched
    expect([d8, d9, d11].flatMap((r) => r.bills).some((b) => b.id === "K12")).toBe(false);
  });

  it("rolls the bills to the new month, unpaid and without last month's fee", async () => {
    const { tick, store } = await setup("auto");
    await tick(at("2026-12-08"));
    const jan = await tick(at("2027-01-04"));
    expect(jan).toMatchObject({ period: "2027-01", rolled_from: "2026-12" });
    expect(jan.bills.map((b) => `${b.id}:${b.days_late}`)).toEqual(["K03:3", "K05:3", "K08:3", "K12:3", "K17:3"]);
    const book = loadBillBook(store.data)!;
    expect(book.bills.find((b) => b.id === "K08")).toMatchObject({ due: "2027-01-01", paid: false, tenure_months: 15 });
    expect(book.bills.every((b) => !b.fee_charged)).toBe(true);
  });

  it("keeps only the last 14 days of tick reports", async () => {
    const { tick, store } = await setup();
    for (let d = 1; d <= 20; d++) await tick(at(`2026-12-${String(d).padStart(2, "0")}`));
    expect(Object.keys(loadBillBook(store.data)!.ticks)).toHaveLength(14);
  });
});

describe("tenant message", () => {
  it("is Indonesian, names nobody, has the AI label and passes the Validator", () => {
    for (const template of ["remind", "notice"]) {
      const text = tenantMessage(template, 14);
      expect(text).toContain("14 hari");
      expect(text).toContain("dibuat dengan bantuan AI");
      expect(text).not.toMatch(/K\d{2}|Rp\d/);
      expect(validate(text, KOS_FACTS, ["R10", "R15", "R19", "R22", "R24"])).toEqual([]);
    }
  });
});
