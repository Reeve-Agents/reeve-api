import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoBills, liveExecutor, loadBillBook, saveBillBook } from "@reeve/crew";
import { FakeMeko } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { createAccountsApp } from "../src/accounts";
import { createMekoOwnerApp, createMekoTickApp, mekoOpener } from "../src/meko";
import { mekoTelegram } from "../src/meko-telegram";
import { filePersistence } from "../src/persistence";
import { Store } from "../src/store";

const SECRET = "tick-secret-for-tests";
const WIB = (date: string, time = "08:00") => Date.parse(`${date}T${time}:00+07:00`);

async function setup(opts: { secret?: string | null; level?: "auto" | "ask_if_unusual"; token?: string; chats?: Record<string, string> } = {}) {
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
  const owner = createMekoOwnerApp({ store, now: () => now, outbox: { execute: liveExecutor({ token: opts.token, chatOf: (s) => opts.chats?.[s] ?? null, fetchFn }) } }, open);
  const ticks = createMekoTickApp({ tick: owner.tick, secret: opts.secret === null ? undefined : (opts.secret ?? SECRET) });
  const { app } = await createAccountsApp({
    persistence: filePersistence(mkdtempSync(join(tmpdir(), "meko-tick-acc-"))),
    optionalSessionApps: [{ prefix: "/api/meko/tick", fetch: (req, account) => ticks.fetch(req, account) }],
    rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
    sessionSecret: "test-secret",
    publicHealth: () => ({}),
    workspaceApp: () => async () => new Response("workspace"),
  });
  const post = (headers: Record<string, string> = {}) => app.request("/api/meko/tick", { method: "POST", headers });
  return { store, ledger, sent, post, ticks, setNow: (t: number) => (now = t), decisions: () => ledger.entries().filter((e) => e.kind === "decision").length };
}

describe("POST /api/meko/tick: who may call it", () => {
  it("is 401 without an owner session or the secret, and with a wrong secret", async () => {
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

  it("with REEVE_TICK_SECRET unset the header opens nothing; only an owner session works", async () => {
    const { post, ticks } = await setup({ secret: null, level: "auto" });
    expect((await post({ "x-reeve-tick-secret": SECRET })).status).toBe(401);
    expect((await post({ "x-reeve-tick-secret": "" })).status).toBe(401);
    // the accounts layer hands the session's account id to the route
    const owner = await ticks.fetch(new Request("http://x/api/meko/tick", { method: "POST" }), "acct-1");
    expect(owner.status).toBe(200);
  });

  it("an owner session works with or without the secret configured, and a wrong header does not block it", async () => {
    const { ticks } = await setup({ level: "auto" });
    const res = await ticks.fetch(new Request("http://x/api/meko/tick", { method: "POST", headers: { "x-reeve-tick-secret": "wrong" } }), "acct-1");
    expect(res.status).toBe(200);
  });

  it("is 409 with a clear message when the seed has not written bills", async () => {
    const { post, store } = await setup({ level: "auto" });
    delete (store.data as unknown as Record<string, unknown>).meko_bills;
    const res = await post({ "x-reeve-tick-secret": SECRET });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/seed/);
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
});
