import { describe, expect, it } from "vitest";
import { demoBills, dueDateWib, KOS_DUE_DAY, KOS_FACTS, kosDueDate, Ladder, liveExecutor, liveTick, loadBillBook, loadOutbox, markBillPaid, monthStartWib, NoBills, Outbox, saveBillBook, tenantMessage, UnknownBill, UNDO_WINDOW_MS, validate } from "../src/index";
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

describe("a tick that fails midway", () => {
  it("is resumable: a retry the same day stages each reminder exactly once", async () => {
    const { tick, ladder, outbox, ws, store } = await setup("auto");
    const realGate = ladder.gate;
    let calls = 0;
    ladder.gate = (cls, unusual) => {
      if (++calls === 3) throw new Error("meko down");
      return realGate(cls, unusual);
    };
    await expect(tick(at("2026-12-04"))).rejects.toThrow("meko down");
    const book = loadBillBook(store.data)!;
    expect(book.ticks["2026-12-04"]).toBeUndefined(); // the day is not done
    expect(book.bills.filter((b) => b.last_tick === "2026-12-04").map((b) => b.id)).toEqual(["K03", "K05"]);
    expect(outbox.items().map((i) => i.subject)).toEqual(["K03", "K05"]);

    ladder.gate = realGate;
    const r = await tick(at("2026-12-04", "08:02"));
    expect(r.repeated).toBeUndefined();
    expect(r.bills.map((b) => `${b.id}:${b.decision}`)).toEqual(["K03:remind_staged", "K05:remind_staged", "K08:remind_staged", "K17:remind_staged"]);
    expect(outbox.items().map((i) => i.subject)).toEqual(["K03", "K05", "K08", "K17"]); // none twice
    expect(r.staged).toHaveLength(4);
    expect(r.receipts).toHaveLength(8);
    expect(ws.decisions().filter((d) => d.action === "remind_staged")).toHaveLength(4);
    expect(ws.decisions().filter((d) => d.action === "auto_stage")).toHaveLength(4);
    expect(book.partial).toBeUndefined();
    expect(Object.keys(book.ticks)).toEqual(["2026-12-04"]);
    expect((await tick(at("2026-12-04", "08:03"))).repeated).toBe(true);
    expect((await tick(at("2026-12-04", "08:20"))).flushed).toHaveLength(4); // each goes out once
  });

  it("does not stage a reminder twice when the failure came right after it was staged", async () => {
    const { tick, outbox, ws } = await setup("auto");
    const realStage = outbox.stage.bind(outbox);
    let n = 0;
    outbox.stage = async (input, now) => {
      const item = await realStage(input, now);
      if (++n === 3) throw new Error("boom after staging");
      return item;
    };
    await expect(tick(at("2026-12-04"))).rejects.toThrow("boom after staging");
    expect(outbox.items()).toHaveLength(3);
    outbox.stage = realStage;
    const r = await tick(at("2026-12-04", "08:02"));
    expect(outbox.items().map((i) => i.subject)).toEqual(["K03", "K05", "K08", "K17"]);
    expect(r.staged).toHaveLength(4);
    expect(ws.decisions().filter((d) => d.action === "auto_stage")).toHaveLength(4);
    expect(ws.decisions().filter((d) => d.action === "remind_staged")).toHaveLength(4);
  });

  it("keeps the month roll in the resumed report", async () => {
    const { tick, ladder, store } = await setup("auto");
    const realGate = ladder.gate;
    ladder.gate = () => {
      throw new Error("down");
    };
    await expect(tick(at("2027-01-04"))).rejects.toThrow("down");
    ladder.gate = realGate;
    const r = await tick(at("2027-01-04", "09:00"));
    expect(r).toMatchObject({ period: "2027-01", rolled_from: "2026-12" });
  });

  it("an unfinished day that is never retried does not block the next day", async () => {
    const { tick, ladder, store } = await setup("auto");
    const realGate = ladder.gate;
    let calls = 0;
    ladder.gate = (cls, unusual) => {
      if (++calls === 2) throw new Error("down");
      return realGate(cls, unusual);
    };
    await expect(tick(at("2027-01-04"))).rejects.toThrow("down");
    expect(loadBillBook(store.data)!.partial?.date).toBe("2027-01-04");
    ladder.gate = realGate;
    const next = await tick(at("2027-01-05"));
    expect(next.date).toBe("2027-01-05");
    expect(next.bills.map((b) => b.id)).toEqual(["K03", "K05", "K08", "K12", "K17"]); // K03 was done on the 4th, but that was another day
    expect(loadBillBook(store.data)!.partial).toBeUndefined();
  });
});

describe("recording a payment", () => {
  const paidDeps = (t: Awaited<ReturnType<typeof setup>>, when = at("2026-12-02")) => ({ ws: t.ws, store: t.store, outbox: t.outbox, now: () => when });

  it("a paid bill gets no reminder, notice or fee; the next month starts it unpaid again", async () => {
    const t = await setup("auto");
    const res = await markBillPaid(paidDeps(t), "K05", "pemilik");
    expect(res).toMatchObject({ id: "K05", period: "2026-12", paid: true, cancelled: [] });
    expect(loadBillBook(t.store.data)!.bills.find((b) => b.id === "K05")!.paid).toBe(true);
    const d = t.ws.decisions().find((x) => x.entry_hash === res.receipt)!;
    expect(d).toMatchObject({ action: "mark_paid", subject: "K05", agent: "owner" });
    const msgs = JSON.stringify((await t.ws.conversation(d.agent, d.conversation_id)).messages);
    expect(msgs).toContain("pemilik");

    const d4 = await t.tick(at("2026-12-04"));
    expect(d4.bills.map((b) => b.id)).toEqual(["K03", "K08", "K17"]);
    const d8 = await t.tick(at("2026-12-08"));
    expect(d8.bills.filter((b) => b.action === "charge_fee").map((b) => b.id)).toEqual(["K03", "K17"]);
    expect(t.outbox.items().some((i) => i.subject === "K05")).toBe(false);

    const jan = await t.tick(at("2027-01-04"));
    expect(jan.bills.map((b) => b.id)).toEqual(["K03", "K05", "K08", "K12", "K17"]); // rent is monthly: everyone unpaid again
  });

  it("is idempotent: the second call records nothing", async () => {
    const t = await setup("auto");
    const first = await markBillPaid(paidDeps(t), "K03", "pemilik");
    const n = t.ws.decisions().length;
    const second = await markBillPaid(paidDeps(t), "K03", "pemilik");
    expect(second).toMatchObject({ already: true, paid: true });
    expect(second.receipt).toBeUndefined();
    expect(first.receipt).toBeDefined();
    expect(t.ws.decisions()).toHaveLength(n);
  });

  it("cancels the bill's reminder that is still in its undo window, without demoting the class", async () => {
    const t = await setup("auto", { token: "TOKEN", chats: { K08: "808" } });
    await t.tick(at("2026-12-04"));
    const res = await markBillPaid(paidDeps(t, at("2026-12-04", "08:05")), "K08", "pemilik");
    expect(res.cancelled).toHaveLength(1);
    expect(t.outbox.items().find((i) => i.subject === "K08")).toMatchObject({ status: "undone", undo_receipt: res.receipt });
    expect(t.ladder.level("reminder")).toBe("auto");
    const later = await t.tick(at("2026-12-04", "08:11"));
    expect(later.flushed).toHaveLength(3);
    expect(t.calls).toEqual([]); // K08 was the only tenant with a chat, and it was cancelled
  });

  it("refuses an unknown bill and a missing bill book", async () => {
    const t = await setup("auto");
    await expect(markBillPaid(paidDeps(t), "K99", "pemilik")).rejects.toBeInstanceOf(UnknownBill);
    const empty = { data: {}, save() {} };
    await expect(markBillPaid({ ws: t.ws, store: empty, outbox: t.outbox }, "K05", "pemilik")).rejects.toBeInstanceOf(NoBills);
  });
});

describe("due day", () => {
  it("the live bills, the monthly roll and the contract share one due day (KOS_DUE_DAY)", async () => {
    expect(KOS_DUE_DAY).toBe(1); // SOP: bills go out on the 1st, the fee counts H+7 from it
    expect(dueDateWib(at("2026-12-17"))).toBe("2026-12-01");
    expect(kosDueDate("2027-02")).toBe("2027-02-01");
    const { tick, store } = await setup("auto");
    await tick(at("2027-01-04"));
    const rolled = loadBillBook(store.data)!.bills;
    expect(rolled.every((b) => Number(b.due.slice(8)) === KOS_DUE_DAY && b.due === "2027-01-01")).toBe(true);
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
