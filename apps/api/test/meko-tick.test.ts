import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CalendarRegistry, demoBills, liveExecutor, loadBillBook, saveBillBook } from "@reeve/crew";
import { FakeMeko } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it, vi } from "vitest";
import { createAccountsApp } from "../src/accounts";
import { createMekoOwnerApp, createMekoTickApp, mekoOpener } from "../src/meko";
import { mekoTelegram } from "../src/meko-telegram";
import { filePersistence } from "../src/persistence";
import { Store } from "../src/store";

const SECRET = "tick-secret-for-tests";
const WIB = (date: string, time = "08:00") => Date.parse(`${date}T${time}:00+07:00`);

async function setup(opts: { secret?: string | null; level?: "auto" | "ask_if_unusual"; token?: string; chats?: Record<string, string>; tick?: () => Promise<never>; journal?: CalendarRegistry } = {}) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-tick-")), "ledger.jsonl"));
  const store = new Store(null);
  let now = WIB("2026-12-04");
  saveBillBook(store.data, demoBills("2026-12-01"), WIB("2026-12-01"));
  if (opts.level) (store.data as unknown as Record<string, unknown>).meko_ladder = { levels: { reminder: { level: opts.level, since_seq: -1 } } };
  const sent: { url: string; body: { chat_id: string; text: string } }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
  const owner = createMekoOwnerApp({ store, now: () => now, ...(opts.journal ? { journal: { registry: opts.journal, spreadsheetId: "sheet-test" } } : {}), outbox: { execute: liveExecutor({ token: opts.token, chatOf: (s) => opts.chats?.[s] ?? null, fetchFn }) } }, open);
  const ticks = createMekoTickApp({ tick: opts.tick ?? owner.tick, markPaid: owner.markPaid, secret: opts.secret === null ? undefined : (opts.secret ?? SECRET) });
  const { app } = await createAccountsApp({
    persistence: filePersistence(mkdtempSync(join(tmpdir(), "meko-tick-acc-"))),
    publicApps: [
      { prefix: "/api/meko/tick", fetch: (req) => ticks.fetch(req) },
      { prefix: "/api/meko/bills/", fetch: (req) => ticks.fetch(req) },
    ],
    rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
    sessionSecret: "test-secret",
    publicHealth: () => ({}),
    workspaceApp: () => async () => new Response("workspace"),
  });
  const post = (headers: Record<string, string> = {}) => app.request("/api/meko/tick", { method: "POST", headers });
  const paid = (id: string, headers: Record<string, string> = {}) => app.request(`/api/meko/bills/${id}/paid`, { method: "POST", headers });
  return { store, ledger, sent, post, paid, ticks, setNow: (t: number) => (now = t), decisions: () => ledger.entries().filter((e) => e.kind === "decision").length };
}

describe("POST /api/meko/tick: who may call it", () => {
  it("is 401 without the secret, and with a wrong or empty one", async () => {
    const { post, decisions } = await setup({ level: "auto" });
    expect((await post()).status).toBe(401);
    expect((await post({ "x-reeve-tick-secret": "nope" })).status).toBe(401);
    expect((await post({ "x-reeve-tick-secret": "" })).status).toBe(401);
    expect(decisions()).toBe(0);
  });

  it("accepts the right secret header", async () => {
    const { post } = await setup({ level: "auto" });
    const res = await post({ "x-reeve-tick-secret": SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: "2026-12-04", period: "2026-12" });
  });

  it("a session is not enough: a signed-in cookie without the secret is 401 (any self-registered account could otherwise cause sends)", async () => {
    const { post, paid, decisions } = await setup({ level: "auto" });
    const cookie = { cookie: "reeve_session=anything.valid-looking" };
    expect((await post(cookie)).status).toBe(401);
    expect((await paid("K05", cookie)).status).toBe(401);
    expect(decisions()).toBe(0);
  });

  it("with REEVE_TICK_SECRET unset the header opens nothing", async () => {
    const { post, paid, ticks } = await setup({ secret: null, level: "auto" });
    expect((await post({ "x-reeve-tick-secret": SECRET })).status).toBe(401);
    expect((await post({ "x-reeve-tick-secret": "" })).status).toBe(401);
    expect((await paid("K05", { "x-reeve-tick-secret": "" })).status).toBe(401);
    expect((await ticks.fetch(new Request("http://x/api/meko/tick", { method: "POST" }))).status).toBe(401);
  });

  it("is 409 with a clear message when the seed has not written bills", async () => {
    const { post, store } = await setup({ level: "auto" });
    delete (store.data as unknown as Record<string, unknown>).meko_bills;
    const res = await post({ "x-reeve-tick-secret": SECRET });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/seed/);
  });

  it("does not leak the internal error: a generic Indonesian message, the detail goes to the server log", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { post } = await setup({
        level: "auto",
        tick: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.7:5432 password=hunter2");
        },
      });
      const res = await post({ "x-reeve-tick-secret": SECRET });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("Tick gagal dijalankan");
      expect(text).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.7/);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain("ECONNREFUSED");
    } finally {
      err.mockRestore();
    }
  });
});

describe("POST /api/meko/bills/:id/paid", () => {
  const h = { "x-reeve-tick-secret": SECRET };

  it("needs the secret, a tenant code, and an existing bill", async () => {
    const { paid, store } = await setup({ level: "auto" });
    expect((await paid("K05")).status).toBe(401);
    expect((await paid("K05", { "x-reeve-tick-secret": "nope" })).status).toBe(401);
    expect((await paid("PEMILIK", h)).status).toBe(400);
    expect((await paid("K99", h)).status).toBe(404);
    expect(loadBillBook(store.data)!.bills.some((b) => b.paid && b.id !== "K12")).toBe(false);
    delete (store.data as unknown as Record<string, unknown>).meko_bills;
    expect((await paid("K05", h)).status).toBe(409);
  });

  it("marks the bill paid with a traced mark_paid decision, once; a paid bill gets no reminder and no fee", async () => {
    const { paid, post, store, ledger, decisions } = await setup({ level: "auto" });
    const res = await paid("k05", h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; paid: boolean; receipt: string; period: string };
    expect(body).toMatchObject({ id: "K05", paid: true, period: "2026-12" });
    expect(loadBillBook(store.data)!.bills.find((b) => b.id === "K05")!.paid).toBe(true);
    const entry = ledger.entries().find((e) => e.entry_hash === body.receipt) as unknown as { kind: string; action: string; subject: string };
    expect(entry).toMatchObject({ kind: "decision", action: "mark_paid", subject: "K05" });
    const n = decisions();
    const again = (await (await paid("K05", h)).json()) as { already?: boolean };
    expect(again.already).toBe(true);
    expect(decisions()).toBe(n);

    const tick = (await (await post(h)).json()) as { bills: { id: string }[]; staged: string[] };
    expect(tick.bills.map((b) => b.id)).toEqual(["K03", "K08", "K17"]);
    expect(tick.staged).toHaveLength(3);
  });

  it("does not leak an internal error either", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ticks = createMekoTickApp({
        tick: async () => {
          throw new Error("x");
        },
        markPaid: async () => {
          throw new Error("db host=10.1.1.1");
        },
        secret: SECRET,
      });
      const res = await ticks.fetch(new Request("http://x/api/meko/bills/K05/paid", { method: "POST", headers: h }));
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain("10.1.1.1");
    } finally {
      err.mockRestore();
    }
  });
});

describe("POST /api/meko/tick: what it does", () => {
  it("runs rentTick over the stored bills, saves the state, and is idempotent per day", async () => {
    const { post, store, decisions } = await setup({ level: "auto" });
    const h = { "x-reeve-tick-secret": SECRET };
    const first = (await (await post(h)).json()) as { repeated?: boolean; bills: { id: string; action: string; decision: string; outbox_item?: string }[]; receipts: string[]; staged: string[] };
    expect(first.repeated).toBeUndefined();
    expect(first.bills.map((b) => `${b.id}:${b.action}:${b.decision}`)).toEqual(["K03:remind:remind_staged", "K05:remind:remind_staged", "K08:remind:remind_staged", "K17:remind:remind_staged"]);
    expect(first.staged).toHaveLength(4);
    const after = decisions();
    expect(after).toBe(8);
    expect(Object.keys(loadBillBook(store.data)!.ticks)).toEqual(["2026-12-04"]);

    const second = (await (await post(h)).json()) as { repeated?: boolean; receipts: string[] };
    expect(second.repeated).toBe(true);
    expect(second.receipts).toEqual(first.receipts);
    expect(decisions()).toBe(after);
  });

  it("with the reminder class at ask it records ask_owner and stages nothing", async () => {
    const { post, decisions } = await setup();
    const body = (await (await post({ "x-reeve-tick-secret": SECRET })).json()) as { bills: { decision: string }[]; staged: string[] };
    expect(body.bills.map((b) => b.decision)).toEqual(Array(4).fill("ask_owner"));
    expect(body.staged).toEqual([]);
    expect(decisions()).toBe(4);
  });

  it("sends staged reminders on Telegram after the 10-minute window, for a tenant with a linked chat, and logs the rest", async () => {
    const { post, sent, setNow, store } = await setup({ level: "auto", token: "BOT", chats: { K08: "808" } });
    const h = { "x-reeve-tick-secret": SECRET };
    await post(h);
    expect(sent).toEqual([]); // staged, not sent
    setNow(WIB("2026-12-04", "08:11"));
    const again = (await (await post(h)).json()) as { repeated: boolean; flushed: { via: string; status: string }[] };
    expect(again.repeated).toBe(true);
    expect(again.flushed.map((f) => `${f.status}:${f.via}`).sort()).toEqual(["done:log", "done:log", "done:log", "done:telegram"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe("808");
    expect(sent[0]!.body.text).toContain("Pengingat dari Kos Melati");
    expect(JSON.stringify(store.data)).not.toContain("BOT");
  });

  it("uses the Log connector for everyone when TELEGRAM_BOT_TOKEN is not set", async () => {
    const { post, sent, setNow } = await setup({ level: "auto", chats: { K08: "808" } });
    const h = { "x-reeve-tick-secret": SECRET };
    await post(h);
    setNow(WIB("2026-12-04", "08:11"));
    const again = (await (await post(h)).json()) as { flushed: { via: string }[] };
    expect(again.flushed.map((f) => f.via)).toEqual(Array(4).fill("log"));
    expect(sent).toEqual([]);
  });

  it("two calls at once share one run", async () => {
    const { post, decisions } = await setup({ level: "auto" });
    const h = { "x-reeve-tick-secret": SECRET };
    const [a, b] = await Promise.all([post(h), post(h)]);
    expect(((await a.json()) as { receipts: string[] }).receipts).toEqual(((await b.json()) as { receipts: string[] }).receipts);
    expect(decisions()).toBe(8);
  });
});

describe("Telegram chat ids for push", () => {
  const post = (tg: ReturnType<typeof mekoTelegram>, text: string, chat = 4242) =>
    tg.handle(new Request("http://x/api/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "s3cret" }, body: JSON.stringify({ message: { chat: { id: chat }, text } }) }));

  it("keeps the raw chat id only when push is on (TELEGRAM_BOT_TOKEN), and upgrades an older link on the next message", async () => {
    const meko = new FakeMeko();
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-push-")), "ledger.jsonl"));
    const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
    const store = new Store(null);
    const off = mekoTelegram({ secret: "s3cret", store, open, webOrigin: "https://reeve.example" });
    const code = off.createLink("K05").code;
    await post(off, `/start ${code}`);
    expect(off.chatFor("K05")).toBeNull();
    expect(JSON.stringify(store.data)).not.toContain("4242");

    const on = mekoTelegram({ secret: "s3cret", store, open, webOrigin: "https://reeve.example", keepChatIds: true });
    expect(on.chatFor("K05")).toBeNull(); // linked before push was on
    await post(on, "Kenapa saya didenda?");
    expect(on.chatFor("K05")).toBe("4242");
    const owner = on.createOwnerLink().code;
    await post(on, `/start ${owner}`, 777);
    expect(on.chatFor("PEMILIK")).toBeNull(); // the owner's chat is never kept this way
  });

  it("a chat that links again under a new pseudonym stops being the push target of the old one", async () => {
    const meko = new FakeMeko();
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-push-")), "ledger.jsonl"));
    const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
    const store = new Store(null);
    const tg = mekoTelegram({ secret: "s3cret", store, open, webOrigin: "https://reeve.example", keepChatIds: true });
    await post(tg, `/start ${tg.createLink("K05").code}`, 4242);
    expect(tg.chatFor("K05")).toBe("4242");
    // the same chat is linked to K08 (a new tenant in the same phone, or a re-link by mistake)
    await post(tg, `/start ${tg.createLink("K08").code}`, 4242);
    expect(tg.chatFor("K08")).toBe("4242");
    expect(tg.chatFor("K05")).toBeNull(); // no reminder of K05 reaches this chat any more
    expect(Object.keys((store.data as unknown as { meko_links: { push: object } }).meko_links.push)).toEqual(["K08"]);
    // another chat's link is untouched
    await post(tg, `/start ${tg.createLink("K03").code}`, 9999);
    expect(tg.chatFor("K03")).toBe("9999");
    expect(tg.chatFor("K08")).toBe("4242");
    // when the chat becomes the owner's, it is no tenant's push target either
    await post(tg, `/start ${tg.createOwnerLink().code}`, 4242);
    expect(tg.chatFor("K08")).toBeNull();
    expect(tg.chatFor("PEMILIK")).toBeNull();
    expect(tg.chatFor("K03")).toBe("9999");
  });
});

describe("POST /api/meko/journal/sync", () => {
  const post = (ticks: ReturnType<typeof createMekoTickApp>, secret?: string) =>
    ticks.fetch(new Request("http://x/api/meko/journal/sync", { method: "POST", headers: secret ? { "x-reeve-tick-secret": secret } : {} }));
  const base = { tick: async () => { throw new Error("unused"); }, markPaid: async () => { throw new Error("unused"); }, secret: "s3cret" };

  it("needs the secret, and is 404 when the journal is off", async () => {
    const on = createMekoTickApp({ ...base, journal: async () => ({ status: "nothing_new", rows: 0, pending: 0, note: "ok" }) });
    expect((await post(on)).status).toBe(401);
    expect((await post(on, "wrong")).status).toBe(401);
    const res = await post(on, "s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "nothing_new" });
    expect((await post(createMekoTickApp(base), "s3cret")).status).toBe(404);
  });

  it("does not leak the internal error", async () => {
    const res = await post(createMekoTickApp({ ...base, journal: async () => { throw new Error("db host=10.1.1.1"); } }), "s3cret");
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("10.1.1.1");
  });
});

describe("journal after a paid mark and a tick", () => {
  it("writes the paid rent and the tick's fees to the sheet, each once; a sheet failure never fails the call", async () => {
    const appended: unknown[][] = [];
    let broken = false;
    const journal: CalendarRegistry = {
      list: () => [{ id: "composio", kind: "composio" }],
      appStatus: async () => ({ googlesheets: 1 }),
      execute: async (_c, tool, args) => {
        if (tool === "GOOGLESHEETS_GET_SHEET_NAMES") return { ok: true, connector: "composio", data: { sheet_names: ["Sheet1"] } };
        if (broken) return { ok: false, error: "quota", connector: "composio" };
        appended.push(...(args.values as unknown[][]));
        return { ok: true, connector: "composio", data: {} };
      },
    };
    const h = { "x-reeve-tick-secret": SECRET };
    const { paid, post, setNow } = await setup({ level: "auto", journal });
    const p = (await (await paid("K05", h)).json()) as { journal?: { status: string; rows: number } };
    expect(p.journal).toMatchObject({ status: "synced", rows: 1 });
    expect(appended.map((r) => `${r[1]}:${r[2]}`)).toEqual(["Sewa diterima:K05"]);

    setNow(WIB("2026-12-09"));
    broken = true;
    const t = await post(h);
    expect(t.status).toBe(200);
    const tick = (await t.json()) as { journal?: { status: string; pending: number } };
    expect(tick.journal?.status).toBe("failed");
    expect(tick.journal?.pending).toBeGreaterThan(0);

    broken = false;
    const again = (await (await post(h)).json()) as { repeated?: boolean; journal?: { status: string; rows: number } };
    expect(again.repeated).toBe(true);
    expect(again.journal?.status).toBe("synced");
    expect(appended.filter((r) => r[1] === "Denda (piutang)").length).toBe(again.journal!.rows);
    expect(new Set(appended.map((r) => r[8])).size).toBe(appended.length);
  });
});
