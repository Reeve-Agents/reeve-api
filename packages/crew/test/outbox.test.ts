import { verifyDecision } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { buildDigest, dryRun, type DigestSender, Ladder, Outbox, sendDigest, telegramSender, UNDO_WINDOW_MS, UndoRefused, digestSenderFromEnv } from "../src/index";
import { testDeps } from "./helpers";

const T0 = Date.parse("2026-12-01T03:00:00Z");
const MIN = 60_000;

async function setup() {
  const t = await testDeps();
  const store = { data: {} as object, save() {} };
  const ladder = new Ladder(t.ws);
  ladder.state.levels.reminder = { level: "auto", since_seq: -1 };
  const box = new Outbox(t.ws, store, ladder);
  const calls: string[] = [];
  const exec = async (tool: string, a: Record<string, unknown>) => {
    calls.push(`${tool}:${a.to}`);
    return { ok: true, via: "log" };
  };
  const item = (to = "K05", at = T0) => box.stage({ action_class: "reminder", tool: "TELEGRAM_SEND_MESSAGE", args: { to, template: "remind" }, subject: to }, at);
  return { ...t, store, ladder, box, calls, exec, item };
}

describe("outbox: undo window", () => {
  it("stages without executing; due_at is now + 10 minutes and the stage is a traced decision", async () => {
    const { box, item, calls, ws, exec } = await setup();
    const i = await item();
    expect(UNDO_WINDOW_MS).toBe(10 * MIN);
    expect(i).toMatchObject({ status: "staged", due_at: new Date(T0 + 10 * MIN).toISOString() });
    expect(await box.flush(T0 + 9 * MIN, exec)).toEqual([]);
    expect(calls).toEqual([]);
    expect(ws.decisions().find((d) => d.entry_hash === i.stage_receipt)).toMatchObject({ action: "auto_stage", action_class: "reminder", subject: "K05" });
    expect((await verifyDecision(ws, i.stage_receipt)).ok).toBe(true);
  });

  it("undo at 9:59 cancels it for real: never executed, receipt links the stage, class demoted", async () => {
    const { box, item, calls, exec, ws, ladder } = await setup();
    const i = await item();
    const r = await box.undo(i.id, T0 + 9 * MIN + 59_000);
    expect(r.item.status).toBe("undone");
    expect(r.level).toBe("auto_digest");
    expect(ladder.level("reminder")).toBe("auto_digest");
    const d = ws.decisions().find((x) => x.entry_hash === r.receipt)!;
    expect(d).toMatchObject({ action: "undo", action_class: "reminder" });
    expect((await verifyDecision(ws, r.receipt)).message?.input).toContain(i.stage_receipt.slice(0, 12));
    expect(await box.flush(T0 + 30 * MIN, exec)).toEqual([]);
    expect(calls).toEqual([]);
    await expect(box.undo(i.id, T0 + 9 * MIN + 59_500)).rejects.toThrow(/Sudah dibatalkan/);
  });

  it("undo at 10:01 is refused with a clear message; flush runs it exactly once and logs auto_run", async () => {
    const { box, item, calls, exec, ws, ladder } = await setup();
    const i = await item();
    const err = await box.undo(i.id, T0 + 10 * MIN + 1000).catch((e) => e);
    expect(err).toBeInstanceOf(UndoRefused);
    expect(err.message).toBe("Sudah terkirim, tidak bisa dibatalkan.");
    const [a, b] = await Promise.all([box.flush(T0 + 11 * MIN, exec), box.flush(T0 + 11 * MIN, exec)]);
    expect(a.length + b.length).toBe(1);
    expect(await box.flush(T0 + 12 * MIN, exec)).toEqual([]);
    expect(calls).toEqual(["TELEGRAM_SEND_MESSAGE:K05"]);
    const done = box.items()[0]!;
    expect(done.status).toBe("done");
    expect(ws.decisions().find((d) => d.entry_hash === done.done_receipt)).toMatchObject({ action: "auto_run", action_class: "reminder" });
    expect(ladder.evidence("reminder").clean).toBe(1); // auto_run is the clean evidence
    await expect(box.undo(i.id, T0 + 13 * MIN)).rejects.toThrow(/tidak bisa dibatalkan/);
    await expect(box.undo("nope", T0)).rejects.toThrow(/tidak ditemukan/);
  });

  it("a failed connector is no clean run", async () => {
    const { box, item, ladder } = await setup();
    await item();
    await box.flush(T0 + 11 * MIN, async () => ({ ok: false, via: "log" }));
    expect(box.items()[0]!.status).toBe("failed");
    expect(ladder.evidence("reminder").clean).toBe(0);
  });
});

describe("daily digest", () => {
  const origin = "https://reeve.example";

  async function day() {
    const s = await setup();
    await s.item("K05", T0);
    await s.item("K06", T0 + 5 * MIN);
    await s.box.flush(T0 + 11 * MIN, s.exec); // K05 ran, K06 still staged
    return s;
  }

  it("is built from ledger facts: ran per class, undoable count, queue, ledger status, link, no names", async () => {
    const { ws, ladder, store } = await day();
    const date = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10); // decisions carry the real clock
    (store.data as { meko_review?: unknown[] }).meko_review = [{ id: "r1", status: "pending", text: "Halo Budi Santoso, kos Anda", subject: "K05" }];
    const d = buildDigest(ws, ladder, store, date, { webOrigin: origin });
    expect(d.counts).toMatchObject({ ran: { "Pengingat bayar": 1 }, ran_total: 1, staged: 1, review_pending: 1, amendments_pending: 0, ledger_intact: true });
    expect(d.text).toContain("1 Pengingat bayar");
    expect(d.text).toContain("1 tindakan menunggu 10 menit");
    expect(d.text).toContain("Menunggu keputusan Anda: 1 draf");
    expect(d.text).toContain("Catatan bukti: utuh");
    expect(d.text).toContain(`${origin}/?view=kendali`);
    expect(d.text).not.toMatch(/Budi|Santoso|K05|K06/);
    expect(d.receipts).toHaveLength(1);
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildDigest(ws, ladder, store, date, { webOrigin: origin }).hash).toBe(d.hash);
  });

  it("is idempotent per date: one send_digest decision, one message", async () => {
    const { ws, ladder, store } = await day();
    const sent: string[] = [];
    const live: DigestSender = { channel: "telegram", live: true, send: async (t) => (sent.push(t), true) };
    const deps = { ws, ladder, store, date: "2026-12-01", webOrigin: origin };
    const a = await sendDigest(deps, live);
    const b = await sendDigest(deps, live);
    const c = await sendDigest(deps, dryRun);
    expect(a).toMatchObject({ delivered: true, channel: "telegram", repeat: false });
    expect(b).toMatchObject({ receipt: a.receipt, repeat: true });
    expect(c.receipt).toBe(a.receipt);
    expect(sent).toHaveLength(1);
    expect(ws.decisions().filter((d) => d.action === "send_digest")).toHaveLength(1);
    const m = (await verifyDecision(ws, a.receipt)).message!;
    expect(JSON.parse(m.output)).toEqual({ date: "2026-12-01", hash: a.hash, channel: "telegram", delivered: true });
    const other = await sendDigest({ ...deps, date: "2026-12-02" }, dryRun);
    expect(other).toMatchObject({ delivered: false, channel: "dry-run", repeat: false });
  });

  it("dry run never calls a sender; live Telegram needs token AND REEVE_DIGEST=on AND a chat", async () => {
    expect(digestSenderFromEnv({})).toBe(dryRun);
    expect(digestSenderFromEnv({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_OWNER_CHAT_ID: "1" })).toBe(dryRun);
    expect(digestSenderFromEnv({ REEVE_DIGEST: "on", TELEGRAM_OWNER_CHAT_ID: "1" })).toBe(dryRun);
    expect(digestSenderFromEnv({ TELEGRAM_BOT_TOKEN: "x", REEVE_DIGEST: "on" })).toBe(dryRun);
    expect(digestSenderFromEnv({ TELEGRAM_BOT_TOKEN: "x", REEVE_DIGEST: "on", TELEGRAM_OWNER_CHAT_ID: "1" }).channel).toBe("telegram");
    const { ws, ladder, store } = await setup();
    let calls = 0;
    const spy = { channel: "telegram", live: false, send: async () => (calls++, true) };
    expect((await sendDigest({ ws, ladder, store, date: "2026-12-03" }, spy)).delivered).toBe(false);
    expect(calls).toBe(0);
    const fetched: string[] = [];
    const tg = telegramSender("TOKEN", "42", (async (url: string) => (fetched.push(String(url)), { ok: true })) as unknown as typeof fetch);
    expect(await tg.send("hai")).toBe(true);
    expect(fetched[0]).toContain("/sendMessage");
  });
});
