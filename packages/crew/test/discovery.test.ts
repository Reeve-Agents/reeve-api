import { verifyDecision } from "@reeve/meko";
import { kosMelatiScenario, loadFixtureRulebook, repoRoot, runAttempt } from "@reeve/pipeline";
import { LocalSandbox } from "@reeve/sandbox";
import { describe, expect, it } from "vitest";
import { buildHistory, kosDiscoverySample, mineCandidates, paymentsFromRows, parseChatExport, parsePaymentsCsv, replayHistory, SopDiscovery } from "../src/index";
import { testDeps } from "./helpers";
import { Pseudonymiser } from "@reeve/meko";

const sample = kosDiscoverySample();

function history() {
  return buildHistory(parseChatExport(sample.chat), parsePaymentsCsv(sample.payments), new Pseudonymiser(), { business: "Kos Melati" });
}

describe("SOP Discovery parsing", () => {
  it("reads Android and iOS WhatsApp exports, with multi-line messages", () => {
    const lines = parseChatExport("01/08/26 07.30 - Bu Ratna: Tagihan\nbaris kedua\n[02/08/26 09.00.12] Rina: Siap bu\n03/08/26 10.00 - Rina: <Media tidak disertakan>");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 1, at: "2026-08-01 07:30", from: "Bu Ratna", text: "Tagihan\nbaris kedua" });
    expect(lines[1]).toMatchObject({ at: "2026-08-02 09:00", from: "Rina" });
  });

  it("reads payment sheets with Indonesian headers, Rupiah text and Excel serial dates", () => {
    const rows = paymentsFromRows([{ Tgl: 46235, "No Kamar": "Kamar 4", Penghuni: "Bagus", Keterangan: "Sewa Agustus", Nominal: "Rp1.500.000" }]);
    expect(rows[0]).toMatchObject({ date: "2026-08-01", room: "4", kind: "sewa", amount: 1_500_000 });
  });

  it("pseudonymises every name before mining", () => {
    const h = history();
    const all = JSON.stringify(h);
    for (const name of ["Ratna", "Joko", "Rina", "Sinta", "Kusuma", "Bagus"]) expect(all).not.toContain(name);
    expect(h.events[0]!.role).toBe("Pemilik");
    expect(all).toContain("K03");
  });
});

describe("SOP Discovery mining and replay", () => {
  it("proposes the rulebook cards with a confidence and a cited line", () => {
    const c = mineCandidates(history());
    expect(c.map((x) => x.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "X1"]);
    const r3 = c.find((x) => x.id === "R3")!.card as { days_after_due: number; percent: number; tenure_grace: { min_months: number; extra_days: number } };
    expect(r3).toMatchObject({ days_after_due: 7, percent: 5, tenure_grace: { min_months: 12, extra_days: 3 } });
    expect(c.find((x) => x.id === "R2")!.card).toMatchObject({ days_after_due: [3, 10] });
    expect(c.find((x) => x.id === "R7")!.card).toMatchObject({ refund_above: 500_000 });
    for (const x of c) {
      expect(x.confidence).toBeGreaterThan(0);
      expect(x.confidence).toBeLessThan(1);
      expect(x.cites[0]!.ref).toMatch(/^(chat|bayar):\d+$/);
    }
  });

  it("replays the history and shows where the rules differ from the owner", () => {
    const h = history();
    const c = mineCandidates(h);
    const all = replayHistory(h, c);
    expect(all.bills).toBe(36);
    expect(all.diffs.map((d) => `${d.month} ${d.subject} ${d.what}`)).toEqual(["2026-08 K12 reminder", "2026-10 K07 fee"]);
    // Without the owner's exception, the sick tenant's waived fee shows up too.
    const noExc = replayHistory(h, c.filter((x) => x.kind === "card"));
    expect(noExc.diffs.some((d) => d.subject === "K03" && d.what === "fee")).toBe(true);
  });
});

describe("SOP Discovery traced flow", () => {
  it("traces mining, replay and every owner tap, then audits the confirmed rules with the planted defects", async () => {
    const { ws, ledger } = await testDeps();
    const disc = new SopDiscovery(ws);
    const st = await disc.start({ chat: sample.chat, payments: parsePaymentsCsv(sample.payments), business: "Kos Melati" });
    for (const c of st.candidates) await disc.answer(st, c.id, c.id !== "R8");
    const res = await disc.finish(st, async (rb) => {
      const a = await runAttempt({ repoRoot, rulebook: rb, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: "disc-test" });
      const mut = a.results?.mutation ?? { killed: 0, total: 0 };
      return { status: a.verdict.status, cases: a.plan.cases.length, killed: mut.killed, total: mut.total };
    });
    expect(res.mode).toBe("aktif");
    expect(res.rulebook!.cards.map((c) => c.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    expect(res.audit!.status).toBe("pass");
    expect(res.audit!.total).toBeGreaterThan(10);
    expect(res.audit!.killed).toBe(res.audit!.total);
    expect(res.replay!.diffs).toHaveLength(2);
    const acts = ws.decisions({ run_id: st.run_id }).map((d) => d.action);
    expect(acts.filter((a) => a === "confirm_rule")).toHaveLength(8);
    expect(acts).toContain("reject_rule");
    expect(acts).toEqual(expect.arrayContaining(["mine_rules", "replay_history", "replay_confirmed", "audit_pass", "compile_discovered"]));
    for (const d of ws.decisions({ run_id: st.run_id })) expect((await verifyDecision(ws, d.entry_hash)).ok).toBe(true);
    expect(ledger.verify()).toBeNull();
    // The confirmed exception is shared memory the rent tick reads before charging.
    const hits = await (await ws.run().agent("operator", "t")).search("kamar 3 boleh telat");
    expect(hits.memory.some((x) => /Kamar 3 boleh telat sampai 15 hari/.test(x.text))).toBe(true);
  }, 120_000);

  it("falls back to mode belajar when fewer than 3 rules are confirmed", async () => {
    const { ws } = await testDeps();
    const disc = new SopDiscovery(ws);
    const st = await disc.start({ chat: sample.chat, payments: parsePaymentsCsv(sample.payments) });
    await disc.answer(st, "R1", true);
    await disc.answer(st, "R2", true);
    await disc.answer(st, "R3", false);
    const res = await disc.finish(st, undefined, () => loadFixtureRulebook());
    expect(res.mode).toBe("belajar");
    expect(res.rulebook).toBeUndefined();
    expect(res.message).toMatch(/mode belajar/);
    expect(ws.decisions({ run_id: st.run_id }).at(-1)!.action).toBe("discovery_fallback");
    await expect(disc.answer(st, "R4", true)).rejects.toThrow(/sudah selesai/);
  });
});
