import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun, type DigestSender, Ladder, loadLadderState, Outbox } from "@reeve/crew";
import { FakeMeko } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { createAccountsApp } from "../src/accounts";
import { createMekoOwnerApp, mekoOpener } from "../src/meko";
import { filePersistence } from "../src/persistence";
import { mekoTelegram } from "../src/meko-telegram";
import { Store } from "../src/store";

const SECRET = "tg-test-secret";
const T0 = Date.parse("2026-12-01T03:00:00Z");
const MIN = 60_000;

async function setup(sender?: DigestSender) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-digest-")), "ledger.jsonl"));
  const store = new Store(null);
  const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
  const ws = await open();
  const ladder = new Ladder(ws, loadLadderState(store.data));
  ladder.state.levels.reminder = { level: "auto", since_seq: -1 };
  const outbox = new Outbox(ws, store, ladder);
  let now = T0;
  const ran: string[] = [];
  const tg = mekoTelegram({ secret: SECRET, store, open, webOrigin: "https://reeve.example", botUsername: "reeve_demo_bot", digest: () => owner.digestText() });
  const owner = createMekoOwnerApp({ store, telegram: tg, webOrigin: "https://reeve.example", now: () => now, outbox: { execute: async (tool, a) => (ran.push(`${tool}:${a.to}`), { ok: true, via: "log" }) }, digest: sender ? { sender } : undefined }, open);
  const call = (p: string, body?: unknown) => owner.fetch(new Request(`http://x/api/meko/owner${p}`, body ? { method: "POST", body: JSON.stringify(body) } : {}), "acc1");
  const stage = (to: string, at = T0) => outbox.stage({ action_class: "reminder", tool: "TELEGRAM_SEND_MESSAGE", args: { to, template: "remind" }, subject: to }, at);
  const post = (text: string, chat = 777) => tg.handle(new Request("http://x/api/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ message: { chat: { id: chat }, text } }) }));
  return { ws, store, ladder, call, stage, post, tg, ran, setNow: (t: number) => (now = t), owner };
}

describe("owner outbox routes", () => {
  it("lists staged items with seconds_left, undo works before the window and is refused after", async () => {
    const { call, stage, ran, setNow, ladder } = await setup();
    const a = await stage("K05");
    const b = await stage("K06");
    setNow(T0 + 9 * MIN + 59_000);
    const list = (await (await call("/outbox")).json()) as { items: { id: string; status: string; seconds_left: number }[]; staged: number; window_seconds: number };
    expect(list).toMatchObject({ staged: 2, window_seconds: 600 });
    expect(list.items.map((i) => i.seconds_left)).toEqual([1, 1]);
    const ok = await call(`/outbox/${a.id}/undo`, {});
    expect(ok.status).toBe(200);
    const done = (await ok.json()) as { receipt: string; level: string; item: { status: string } };
    expect(done).toMatchObject({ level: "auto_digest", item: { status: "undone" } });
    expect(done.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(ladder.level("reminder")).toBe("auto_digest");
    setNow(T0 + 10 * MIN + 1000);
    const late = await call(`/outbox/${b.id}/undo`, {});
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("Sudah terkirim, tidak bisa dibatalkan.");
    expect(ran).toEqual(["TELEGRAM_SEND_MESSAGE:K06"]); // the undone one never ran, the other ran once
    const after = (await (await call("/outbox")).json()) as { items: { id: string; status: string; done_receipt?: string; undo_receipt?: string }[]; staged: number };
    expect(after.staged).toBe(0);
    expect(after.items.find((i) => i.id === a.id)).toMatchObject({ status: "undone", undo_receipt: done.receipt });
    expect(after.items.find((i) => i.id === b.id)).toMatchObject({ status: "done" });
    expect((await call("/outbox/nope/undo", {})).status).toBe(404);
  });
});

describe("owner digest routes", () => {
  it("previews text, a wa.me link and channel status; send is a dry run and idempotent", async () => {
    const { call, stage, setNow } = await setup();
    await stage("K05");
    setNow(T0 + 11 * MIN);
    await stage("K06", T0 + 11 * MIN);
    const p = (await (await call("/digest?date=2026-12-01")).json()) as { text: string; wa_me: string; channel: { telegram_linked: boolean; live: boolean }; counts: { staged: number; ran_total: number } };
    expect(p.channel).toMatchObject({ telegram_linked: false, live: false });
    expect(p.wa_me).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(p.wa_me.replace("https://wa.me/?text=", ""))).toBe(p.text);
    expect(p.text).toContain("https://reeve.example/?view=kendali");
    expect(p.text).not.toMatch(/K05|K06/);
    expect(p.counts).toMatchObject({ staged: 1 });
    const s1 = (await (await call("/digest/send", {})).json()) as { delivered: boolean; channel: string; receipt: string; repeat: boolean; note: string };
    const s2 = (await (await call("/digest/send", {})).json()) as { receipt: string; repeat: boolean };
    expect(s1).toMatchObject({ delivered: false, channel: "dry-run", repeat: false });
    expect(s1.note).toMatch(/Dry-run/);
    expect(s2).toMatchObject({ receipt: s1.receipt, repeat: true });
  });

  it("calls no sender when it is not live", async () => {
    let calls = 0;
    const { call } = await setup({ channel: "telegram", live: false, send: async () => (calls++, true) });
    await call("/digest/send", {});
    expect(calls).toBe(0);
    expect(dryRun.live).toBe(false);
  });

  it("owner routes need a session (401 through the accounts app)", async () => {
    const { owner } = await setup();
    const { app } = await createAccountsApp({ persistence: filePersistence(mkdtempSync(join(tmpdir(), "reeve-401-"))), ownerApps: [{ prefix: "/api/meko/owner/", fetch: (req, acc) => owner.fetch(req, acc) }], rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" }, sessionSecret: "test-secret", publicHealth: () => ({}), workspaceApp: () => async () => new Response("x") });
    for (const [m, p] of [["GET", "/api/meko/owner/outbox"], ["POST", "/api/meko/owner/outbox/x/undo"], ["GET", "/api/meko/owner/digest"], ["POST", "/api/meko/owner/digest/send"]] as const)
      expect((await app.request(p, { method: m })).status).toBe(401);
  });
});

describe("Telegram /ringkasan", () => {
  it("a bound owner chat gets the digest as the webhook reply; a tenant chat does not", async () => {
    const { tg, post, store } = await setup();
    const o = tg.createOwnerLink();
    expect(tg.ownerLinked()).toBe(false);
    const hello = (await (await post(`/start ${o.code}`))!.json()) as { text: string };
    expect(hello.text).toMatch(/pemilik/);
    expect(tg.ownerLinked()).toBe(true);
    expect(JSON.stringify(store.data)).not.toContain("777");
    const r = (await (await post("/ringkasan"))!.json()) as { method: string; chat_id: number; text: string };
    expect(r).toMatchObject({ method: "sendMessage", chat_id: 777 });
    expect(r.text).toMatch(/^Ringkasan Reeve/);
    expect(r.text).toContain("/?view=kendali");

    expect(() => tg.createLink("PEMILIK")).toThrow(/K05/); // tenant links keep their format
    const t = tg.createLink("K05");
    await post(`/start ${t.code}`, 888);
    const asTenant = (await (await post("/ringkasan", 888))!.json()) as { text: string };
    expect(asTenant.text).not.toMatch(/^Ringkasan Reeve/);
    expect(await post("/ringkasan", 999)).toBeNull(); // unknown chat: not for us
  });
});
