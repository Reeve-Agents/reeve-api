import { describe, expect, it } from "vitest";
import { approveBound, AskBusiness, auditBound, checkOffer, exceptionDays, KOS_PLAN_BOUND, Ladder, negotiate, rentTick, type TenantBill } from "../src/index";
import { DEMO_PASSKEY, testDeps } from "./helpers";

const bills = (): TenantBill[] => [
  { id: "K03", room: "3", due: "2026-12-01", paid: false, tenure_months: 4 },
  { id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 3 },
  { id: "K08", room: "8", due: "2026-12-01", paid: false, tenure_months: 14 },
  { id: "K09", room: "9", due: "2026-12-01", paid: true, tenure_months: 2 },
];

describe("rent tick", () => {
  it("charges the fee, holds where the owner allowed it, gives tenure grace", async () => {
    const { ws, sent } = await testDeps();
    const run = ws.run("run_tick");
    const owner = await run.agent("owner", "Izin");
    await owner.remember("Kamar 3 boleh telat sampai 10 hari bulan Desember, izin pemilik.", { kind: "owner_exception", room: "3" }, { promote: true });
    const out = await rentTick(run, bills(), "2026-12-09", { execute: async (tool, args) => (sent.push({ connector: "log", tool, args }), { ok: true, via: "log" }) });
    expect(out.map((o) => `${o.id}:${o.action}`)).toEqual(["K03:hold", "K05:charge_fee", "K08:none"]);
    expect(out[1]!.amount).toBe(75_000);
    const later = await rentTick(run, bills(), "2026-12-11", { execute: async () => ({ ok: true, via: "log" }) });
    expect(later.map((o) => `${o.id}:${o.action}`)).toEqual(["K03:hold", "K05:charge_fee", "K08:charge_fee"]);
  });

  it("reads an exception sentence", () => {
    expect(exceptionDays("Kamar 3 boleh telat sampai 10 hari", "3")).toBe(10);
    expect(exceptionDays("Kamar 13 boleh telat sampai 10 hari", "3")).toBeNull();
  });
});

describe("Tanya usaha (read-only)", () => {
  it("answers 'kenapa saya didenda?' and 'kenapa kamar 3 boleh telat?' from the trace with proof", async () => {
    const { ws } = await testDeps();
    const run = ws.run("run_tick");
    const owner = await run.agent("owner", "Izin");
    await owner.remember("Kamar 3 boleh telat sampai 10 hari, izin pemilik.", { kind: "owner_exception", room: "3" }, { promote: true });
    await rentTick(run, bills(), "2026-12-09", { execute: async () => ({ ok: true, via: "log" }) });
    const ask = new AskBusiness(ws);
    const fee = await ask.ask("Kenapa saya didenda?", { role: "tenant", subject: "K05" });
    expect(fee.kind).toBe("why_fee");
    expect(fee.text).toContain("Rp75.000");
    expect(fee.text).toContain("terlambat 8 hari");
    expect(fee.text).toContain("H+7 belum lunas");
    expect(fee.proofs).toHaveLength(1);
    const hold = await ask.ask("Kenapa kamar 3 boleh telat?", { role: "staff" });
    expect(hold.text).toMatch(/izin dari pemilik/);
    expect((await ask.ask("Siapa yang sering telat?", { role: "tenant", subject: "K05" })).text).toMatch(/tidak bisa dibagikan/);
    expect((await ask.ask("Siapa yang sering telat?", { role: "owner" })).text).toContain("K05");
    expect(ws.decisions({ agent: "ask" }).every((d) => d.action === "explain")).toBe(true);
  });
});

describe("earned autonomy", () => {
  it("climbs only on clean receipts with consent, drops on a complaint, undo within 10 minutes", async () => {
    const { ws } = await testDeps();
    const ladder = new Ladder(ws);
    expect(ladder.gate("reminder", false)).toBe("ask");
    const op = await ws.run("run_rem").agent("operator", "Reminders");
    for (let i = 0; i < 19; i++) await op.decide({ input: `r${i}`, output: {}, reasoning: "Rule R2.", action: "remind", action_class: "reminder" });
    expect(ladder.proposal("reminder")).toBeNull();
    await op.decide({ input: "r19", output: {}, reasoning: "Rule R2.", action: "remind", action_class: "reminder" });
    expect(ladder.proposal("reminder")?.question).toMatch(/20 kali/);
    expect(await ladder.promote("reminder", DEMO_PASSKEY)).toBe("ask_if_unusual");
    expect(ladder.gate("reminder", false)).toBe("auto");
    expect(ladder.gate("reminder", true)).toBe("ask");
    expect(ladder.proposal("reminder")).toBeNull(); // evidence restarts after a change
    expect(await ladder.demote("reminder", "complaint", "K05 mengeluh")).toBe("ask");
    expect(ladder.proposal("late_fee")).toBeNull();
    const auto = await op.decide({ input: "x", output: {}, reasoning: "r", action: "remind", action_class: "reminder" });
    await expect(ladder.undo(auto.receipt_hash, new Date(Date.now() + 11 * 60_000))).rejects.toThrow(/10 menit/);
  });
});

describe("payment-plan bound", () => {
  const bill = { subject: "K05", amount: 1_500_000, month: "2026-12" };
  it("is audited with planted bad offers", () => {
    const a = auditBound(KOS_PLAN_BOUND, bill);
    expect(a).toMatchObject({ status: "pass", spec: { passed: 3 }, planted: { survivors: [] } });
    expect(auditBound({ ...KOS_PLAN_BOUND, max_installments: 3 }, bill).planted.survivors).toContain("three_installments");
    expect(checkOffer(KOS_PLAN_BOUND, bill, { installments: [{ date: "2026-12-27", amount: 1_500_000 }], waive_fee: true })).toContain("AFTER_DEADLINE");
  });
  it("offers inside the bound with a receipt, sends the rest to the owner", async () => {
    const { ws } = await testDeps();
    const run = ws.run("run_nego");
    expect((await approveBound(run, KOS_PLAN_BOUND, bill, DEMO_PASSKEY)).status).toBe("pass");
    const ok = await negotiate(run, KOS_PLAN_BOUND, bill, "Bu, saya baru bisa bayar tanggal 20.");
    expect(ok.action).toBe("offer_plan");
    expect(ok.reply).toMatch(/Rp1\.500\.000 paling lambat 2026-12-20, tanpa denda/);
    const no = await negotiate(run, KOS_PLAN_BOUND, bill, "Bisa tanggal 28?");
    expect(no.action).toBe("ask_owner");
    expect(no.suggested).toMatch(/2026-12-25/);
  });
});
