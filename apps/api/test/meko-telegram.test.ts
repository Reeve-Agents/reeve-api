import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rentTick } from "@reeve/crew";
import { FakeMeko, MekoWorkspace, verifyDecision } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { mekoTelegram } from "../src/meko-telegram";
import { Store } from "../src/store";

const SECRET = "tg-test-secret";

async function setup() {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-tg-")), "ledger.jsonl"));
  const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger });
  await rentTick(ws.run("run_tick"), [{ id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 4 }], "2026-12-08", { execute: async () => ({ ok: true, via: "log" }) });
  const store = new Store(null);
  const tg = mekoTelegram({ secret: SECRET, store, open: async () => ws, webOrigin: "https://reeve.example", botUsername: "reeve_demo_bot" });
  const post = (text: string, chat = 4242, secret = SECRET) =>
    tg.handle(new Request("http://x/api/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify({ message: { chat: { id: chat }, text } }) }));
  return { ws, store, tg, post };
}

describe("Meko Telegram: kenapa saya didenda?", () => {
  it("links a tenant with a one-time code, then answers from the trace with a proof link", async () => {
    const { ws, store, tg, post } = await setup();
    const link = tg.createLink("K05");
    expect(link.url).toBe(`https://t.me/reeve_demo_bot?start=${link.code}`);
    expect(await post("kenapa saya didenda?")).toBeNull(); // not linked yet: the workspaces get it
    const hello = (await (await post(`/start ${link.code}`))!.json()) as { method: string; chat_id: number; text: string };
    expect(hello).toMatchObject({ method: "sendMessage", chat_id: 4242 });
    expect(JSON.stringify(store.data)).not.toContain("4242"); // the chat id is stored only as an HMAC
    const again = (await (await post(`/start ${link.code}`, 999))!.json()) as { text: string };
    expect(again.text).toMatch(/tidak berlaku/);

    const res = (await (await post("Kenapa saya didenda?"))!.json()) as { text: string };
    expect(res.text).toContain("Rp75.000");
    expect(res.text).toMatch(/Lihat bukti: https:\/\/reeve\.example\/\?view=jejak&receipt=[0-9a-f]{64}/);
    const answer = ws.decisions({ agent: "ask" }).at(-1)!;
    expect(answer).toMatchObject({ action: "explain", subject: "K05" });
    expect((await verifyDecision(ws, answer.entry_hash)).ok).toBe(true);
    expect((await verifyDecision(ws, answer.entry_hash)).message?.input).toContain("via telegram");
  });

  it("ignores a wrong secret and offers the wa.me fallback", async () => {
    const { tg, post } = await setup();
    tg.createLink("K05");
    expect(await post("/start abcdef", 1, "wrong-secret-x")).toBeNull();
    const wa = await tg.explainForWhatsApp("K05", "kenapa saya didenda?");
    expect(wa.wa_me).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(wa.wa_me)).toContain("Rp75.000");
    expect(() => tg.createLink("Budi")).toThrow(/K05/);
  });
});
