import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rentTick } from "@reeve/crew";
import { FakeMeko, MekoWorkspace } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { createMekoApp, createMekoOwnerApp, mekoOpener } from "../src/meko";

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
