import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReview, rentTick, type ReviewItem, saveReview } from "@reeve/crew";
import { FakeMeko, MekoWorkspace, verifyDecision } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { createMekoApp, createMekoOwnerApp, mekoOpener } from "../src/meko";
import { Store } from "../src/store";

async function setup(allowAsk = false) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-api-")), "ledger.jsonl"));
  const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger });
  const run = ws.run("run_api");
  const owner = await run.agent("owner", "Izin");
  await owner.remember("Kamar 3 boleh telat sampai 10 hari, izin pemilik.", { kind: "owner_exception" }, { promote: true });
  const bills = [
    { id: "K03", room: "3", due: "2026-12-01", paid: false, tenure_months: 4 },
    { id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 4 },
  ];
  const out = await rentTick(run, bills, "2026-12-08", { execute: async () => ({ ok: true, via: "log" }) });
  const app = createMekoApp({ workspace: "kos-melati", ledger, connect: async () => meko, endpoint: { url: "fake", cloud: false }, allowAsk });
  const get = (p: string) => app.request(`/api/meko/public${p}`);
  return { meko, out, app, get };
}

describe("public Meko view", () => {
  it("lists decisions and explains one with its chain and verification", async () => {
    const { out, get } = await setup();
    const list = (await (await get("/decisions")).json()) as { decisions: { action: string }[] };
    expect(list.decisions.map((d) => d.action)).toEqual(["charge_fee", "hold"]);
    const fee = out.find((o) => o.action === "charge_fee")!.receipt!;
    const res = (await (await get(`/decisions/${fee}`)).json()) as { verify: { ok: boolean }; trace: { reasoning: string; seen: unknown[] }; chain: unknown[] };
    expect(res.verify.ok).toBe(true);
    expect(res.trace.reasoning).toContain("Rule R3");
    expect(res.trace.seen).toHaveLength(1);
    expect(res.chain).toHaveLength(1); // only decisions about K05
    expect((await get("/decisions/nope")).status).toBe(404);
  });

  it("shows a tampered trace as changed", async () => {
    const { meko, out, get } = await setup();
    const fee = out.find((o) => o.action === "charge_fee")!.receipt!;
    meko.tamper(fee, { reasoning: "edited later" });
    const v = (await (await get(`/decisions/${fee}/verify`)).json()) as { ok: boolean; checks: { trace_matches: boolean } };
    expect(v).toMatchObject({ ok: false, checks: { trace_matches: false } });
  });

  it("renders the Rapor Usaha in Indonesian with an English toggle", async () => {
    const { get } = await setup();
    const html = await (await get("/report.html")).text();
    expect(html).toContain("Rapor Usaha");
    expect(html).toContain('data-l="en"');
    expect(html).toContain("Denda");
    const json = (await (await get("/report")).json()) as { totals: { decisions: number; verified: number }; usaha: { fees: { amount_idr: number }; exceptions_honoured: number } };
    expect(json.totals).toMatchObject({ decisions: 2, verified: 2 });
    expect(json.usaha).toMatchObject({ fees: { amount_idr: 75_000 }, exceptions_honoured: 1 });
  });

  it("keeps Tanya usaha closed unless the server opens it", async () => {
    const closed = await setup(false);
    expect((await closed.app.request("/api/meko/public/ask", { method: "POST", body: JSON.stringify({ question: "kenapa saya didenda?" }) })).status).toBe(403);
    const open = await setup(true);
    const res = await open.app.request("/api/meko/public/ask", { method: "POST", body: JSON.stringify({ question: "Kenapa saya didenda?", role: "tenant", subject: "K05" }) });
    expect(((await res.json()) as { text: string }).text).toContain("Rp75.000");
  });
});

describe("owner SOP Discovery API", () => {
  it("mines the sample, records each tap and finishes in mode belajar below 3 rules", async () => {
    const meko = new FakeMeko();
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-owner-")), "ledger.jsonl"));
    const owner = createMekoOwnerApp({ audit: async () => ({ status: "pass", cases: 10, killed: 5, total: 5 }) }, mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko }));
    const call = (p: string, body?: unknown) => owner.fetch(new Request(`http://x/api/meko/owner${p}`, body ? { method: "POST", body: JSON.stringify(body) } : {}), "acc1");
    const sample = (await (await call("/discovery/sample")).json()) as { chat: string; payments: string };
    expect(sample.chat).toContain("Bu Ratna Melati");
    const st = (await (await call("/discovery", { chat: sample.chat, payments_csv: sample.payments, business: "Kos Melati" })).json()) as { id: string; candidates: { id: string; cites: { text: string }[] }[] };
    expect(st.candidates).toHaveLength(9);
    expect(JSON.stringify(st)).not.toContain("Ratna");
    const a = (await (await call(`/discovery/${st.id}/answer`, { candidate: "R1", yes: true })).json()) as { receipt: string };
    expect(a.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect((await call(`/discovery/${st.id}/answer`, { candidate: "R1" })).status).toBe(400);
    const res = (await (await call(`/discovery/${st.id}/finish`, {})).json()) as { mode: string };
    expect(res.mode).toBe("belajar");
    expect((await call("/discovery/nope")).status).toBe(404);
    expect((await call("/discovery", { chat: "bukan chat", payments_csv: "" })).status).toBe(400);
  });
});

describe("owner review queue and autonomy ladder", () => {
  async function ownerSetup() {
    const meko = new FakeMeko();
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-review-")), "ledger.jsonl"));
    const store = new Store(null);
    const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
    const owner = createMekoOwnerApp({ store }, open);
    const call = (p: string, body?: unknown) => owner.fetch(new Request(`http://x/api/meko/owner${p}`, body ? { method: "POST", body: JSON.stringify(body) } : {}), "acc1");
    const mk = (id: string, step: string, kind: ReviewItem["kind"], text: string, extra: Partial<ReviewItem> = {}): ReviewItem => ({ id, step, kind, subject: "kamar 7", text, status: "pending", receipt: "ab".repeat(32), ...extra });
    const good = "Kamar kos 7 kosong, Rp1.500.000 per bulan. (dibuat dengan bantuan AI)";
    saveReview(store.data, [mk("rv1", "b1_listing", "draft", good), mk("rv2", "b1_listing", "draft", good), mk("rv3", "b1_listing", "draft", good), mk("rv4", "b6_accept", "contract", "Kontrak", { status: "approved" })]);
    return { meko, ledger, store, open, call };
  }

  it("lists pending first, then records approve, reject and edit as owner receipts", async () => {
    const { call, store, open } = await ownerSetup();
    const list = (await (await call("/review")).json()) as { items: { id: string; status: string; action_class: string }[]; pending: number };
    expect(list.items.map((i) => i.id)).toEqual(["rv1", "rv2", "rv3", "rv4"]);
    expect(list.pending).toBe(3);
    expect(list.items[0]!.action_class).toBe("listing_post");

    const ok = (await (await call("/review/rv1", { action: "approve" })).json()) as { receipt: string; item: { status: string }; note: string };
    expect(ok.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.item.status).toBe("approved");
    expect(ok.note).toContain("Belum ada pesan terkirim");
    expect((await call("/review/rv1", { action: "reject" })).status).toBe(409);

    const no = (await (await call("/review/rv2", { action: "reject" })).json()) as { item: { status: string } };
    expect(no.item.status).toBe("rejected");

    expect((await call("/review/rv3", { action: "edit", text: "Kamar 7 Rp900.000 per bulan" })).status).toBe(400); // Validator: wrong price, no AI label
    const ed = (await (await call("/review/rv3", { action: "edit", text: "Kamar kos 7 kosong, Rp1.500.000, dekat kampus. (dibuat dengan bantuan AI)" })).json()) as { receipt: string; item: { status: string; text: string } };
    expect(ed.item).toMatchObject({ status: "edited" });
    expect(ed.item.text).toContain("dekat kampus");

    const ws = await open();
    expect(ws.decisions({ agent: "owner" }).map((d) => d.action)).toEqual(["review_approve", "review_reject", "review_edit"]);
    expect(ws.decisions({ agent: "owner" })[0]).toMatchObject({ action_class: "listing_post", subject: "kamar 7" });
    expect((await verifyDecision(ws, ed.receipt)).ok).toBe(true);
    expect(loadReview(store.data).find((i) => i.id === "rv3")!.original_text).toContain("Rp1.500.000");
    expect((await call("/review/nope", { action: "approve" })).status).toBe(404);
    expect((await call("/review/rv4", { action: "bogus" })).status).toBe(400);
  });

  it("refuses to promote without evidence, promotes with it, and the owner can demote", async () => {
    const { call, open, store } = await ownerSetup();
    const ws = await open();
    const before = (await (await call("/autonomy")).json()) as { classes: { cls: string; level: string; locked: boolean; needs: number | null; proposal: unknown; evidence: { clean: number; receipts: string[] } }[] };
    const rem = before.classes.find((c) => c.cls === "reminder")!;
    expect(rem).toMatchObject({ level: "ask", locked: false, needs: 20, proposal: null });
    expect(before.classes.find((c) => c.cls === "refund")).toMatchObject({ locked: true, needs: null });
    expect((await call("/autonomy/promote", { cls: "reminder" })).status).toBe(400);
    expect((await call("/autonomy/promote", { cls: "nope" })).status).toBe(400);
    expect((await call("/autonomy/demote", { cls: "reminder" })).status).toBe(400); // already at the bottom

    const op = await ws.run("run_rem").agent("operator", "Pengingat");
    for (let i = 0; i < 20; i++) await op.decide({ input: `K${i}`, output: { action: "remind" }, reasoning: "Reminder day 3.", action: "remind", action_class: "reminder", subject: `K${i}` });
    const after = (await (await call("/autonomy")).json()) as typeof before;
    const r2 = after.classes.find((c) => c.cls === "reminder")!;
    expect(r2.evidence.clean).toBe(20);
    expect(r2.evidence.receipts).toHaveLength(5);
    expect(r2.proposal).toMatchObject({ to: "ask_if_unusual" });

    const up = (await (await call("/autonomy/promote", { cls: "reminder" })).json()) as { level: string };
    expect(up.level).toBe("ask_if_unusual");
    expect((store.data as { meko_ladder?: { levels: Record<string, { level: string }> } }).meko_ladder!.levels.reminder!.level).toBe("ask_if_unusual");
    const promoted = ws.decisions({ action_class: "reminder" }).find((d) => d.action === "autonomy_promote")!;
    const msg = (await ws.conversation(promoted.agent, promoted.conversation_id)).messages.find((m) => m.metadata?.reeve_receipt === promoted.entry_hash);
    expect(msg?.reasoning).toContain("while signed in");
    expect((await call("/autonomy/promote", { cls: "reminder" })).status).toBe(400); // the evidence restarts

    const down = (await (await call("/autonomy/demote", { cls: "reminder" })).json()) as { level: string };
    expect(down.level).toBe("ask");
  });
});
