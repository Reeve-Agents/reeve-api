import { FakeMeko, verifyDecision } from "@reeve/meko";
import { kosMelatiScenario, loadFixtureRulebook, repoRoot, runAttempt } from "@reeve/pipeline";
import { LocalSandbox } from "@reeve/sandbox";
import { describe, expect, it } from "vitest";
import { amendmentsEnabled, amendSampleHistory, approveAmendment, loadAmendments, loadExceptions, loadRulebookVersions, localShortfalls, MekoSelfLearning, proposeAmendment, recordException, rejectAmendment, scanAmendments, SHORTFALL_MIN, reasonClass } from "../src/index";
import { DEMO_PASSKEY, testDeps } from "./helpers";

const pass = async () => ({ status: "pass", cases: 40, killed: 51, total: 51 });
const fail = async () => ({ status: "fail", cases: 40, killed: 49, total: 51 });

async function seeded(n: number) {
  const t = await testDeps();
  const data = {};
  const rooms = ["3", "5", "8", "9"];
  for (let i = 0; i < n; i++) await recordException(t.ws, data, { rule_id: "R3", reason: `Kamar ${rooms[i]} boleh telat sampai ${[12, 14, 15, 15][i]} hari`, subject: `K0${rooms[i]}`, month: `2026-0${8 + (i % 3)}` });
  return { ...t, data };
}

describe("exceptions and shortfalls", () => {
  it("normalises the reason into a class rounded up to 5 days", () => {
    expect(reasonClass("boleh telat sampai 12 hari").cls).toBe("late_grace:15");
    expect(reasonClass("boleh telat hingga 15 hari").cls).toBe("late_grace:15");
    expect(reasonClass("boleh telat sampai 10 hari").cls).toBe("late_grace:10");
    expect(reasonClass("lagi sakit").cls).toBe("lainnya");
  });

  it("stores each exception as shared memory and an owner_exception receipt, once per tenant and month", async () => {
    const { ws, data, meko } = await seeded(1);
    const rec = loadExceptions(data)[0]!;
    expect(rec).toMatchObject({ rule_id: "R3", reason_class: "late_grace:15", subject: "K03", days: 12 });
    expect(ws.decisions().find((d) => d.entry_hash === rec.receipt)).toMatchObject({ action: "owner_exception", agent: "owner", subject: "K03" });
    expect(meko.mems.some((m) => m.promoted && m.metadata.reason_class === "late_grace:15" && m.metadata.rule_id === "R3")).toBe(true);
    const again = await recordException(ws, data, { rule_id: "R3", reason: "Kamar 3 boleh telat sampai 12 hari", subject: "K03", month: "2026-08" });
    expect(again.duplicate).toBe(true);
    expect(loadExceptions(data)).toHaveLength(1);
  });

  it("gives nothing below the threshold and one shortfall at it", async () => {
    expect(SHORTFALL_MIN).toBe(3);
    const two = await seeded(2);
    expect(localShortfalls(loadExceptions(two.data))).toEqual([]);
    const three = await seeded(3);
    const sf = localShortfalls(loadExceptions(three.data));
    expect(sf).toHaveLength(1);
    expect(sf[0]).toMatchObject({ rule_id: "R3", count: 3, suggested: { field: "days_after_due", to: 15 } });
    expect(sf[0]!.receipts).toHaveLength(3);
  });

  it("does not count different reason classes together", async () => {
    const t = await testDeps();
    const data = {};
    for (const [i, d] of [10, 10, 15].entries()) await recordException(t.ws, data, { rule_id: "R3", reason: `boleh telat sampai ${d} hari`, subject: `K0${i + 1}`, month: "2026-09" });
    expect(localShortfalls(loadExceptions(data))).toEqual([]);
  });
});

describe("Cloud adapter", () => {
  it("falls back to the local path when the tools are missing, even with REEVE_SELFLEARNING=cloud", async () => {
    const { ws, data } = await seeded(3);
    const r = await new MekoSelfLearning(ws, { REEVE_SELFLEARNING: "cloud" }).shortfalls(loadExceptions(data));
    expect(r.path).toBe("local");
    expect(r.note).toContain("tidak punya selflearning_shortfalls");
    expect(r.shortfalls).toHaveLength(1);
  });

  it("stays local when the flag is not cloud, even if the tool exists", async () => {
    const meko = new FakeMeko(["selflearning_shortfalls"]);
    const t = await testDeps();
    const ws = Object.assign(Object.create(Object.getPrototypeOf(t.ws)), t.ws, { transport: meko });
    const r = await new MekoSelfLearning(ws, {}).shortfalls([]);
    expect(r.path).toBe("local");
    expect(meko.calls).not.toContain("selflearning_shortfalls");
  });

  it("falls back when the Cloud call throws or answers in an unknown shape, and uses it when it names a rule", async () => {
    const { ws, data } = await seeded(3);
    const exceptions = loadExceptions(data);
    const withTool = (reply: () => unknown) => {
      const transport = { call: async (tool: string) => (tool === "selflearning_shortfalls" ? reply() : null), tools: async () => ["selflearning_shortfalls"], close: async () => {} };
      return new MekoSelfLearning(Object.assign(Object.create(Object.getPrototypeOf(ws)), ws, { transport }), { REEVE_SELFLEARNING: "cloud" });
    };
    const boom = await withTool(() => { throw new Error("schema mismatch"); }).shortfalls(exceptions);
    expect(boom).toMatchObject({ path: "local" });
    expect(boom.note).toContain("gagal");
    expect((await withTool(() => ({ weird: true })).shortfalls(exceptions)).path).toBe("local");
    const ok = await withTool(() => ({ shortfalls: [{ rule_id: "R3", occurrences: 4 }] })).shortfalls(exceptions);
    expect(ok.path).toBe("cloud");
    expect(ok.shortfalls[0]).toMatchObject({ rule_id: "R3", count: 4, suggested: { to: 15 } });
  });
});

describe("amendment proposal", () => {
  it("offers a pending amendment when the audit passes, with the diff and a computed improvement", async () => {
    const { ws, data } = await seeded(3);
    const rb = loadFixtureRulebook("kos-melati");
    const [sf] = localShortfalls(loadExceptions(data));
    const res = await proposeAmendment(ws, data, rb, sf!, { audit: pass, history: amendSampleHistory() });
    expect(res.offered).toBe(true);
    const a = loadAmendments(data)[0]!;
    expect(a).toMatchObject({ status: "pending", rule_id: "R3", change: { from: 7, to: 15 }, audit: { killed: 51, total: 51 } });
    expect(a.diff.before[0]).toContain("H+7");
    expect(a.diff.after[0]).toContain("H+15");
    expect(a.rulebook_after.cards.find((c) => c.id === "R3")).toMatchObject({ days_after_due: 15 });
    expect(rb.cards.find((c) => c.id === "R3")).toMatchObject({ days_after_due: 7 }); // the old rulebook is untouched
    expect(a.improvement).toMatchObject({ improved: true, replay: { bills: 24, before: { waived: 3 }, after: { waived: 0 }, new_diffs: 0 } });
    const actions = ws.decisions({ run_id: a.run_id }).map((d) => `${d.agent}:${d.action}`);
    expect(actions).toEqual(["builder:amend_propose", "auditor:amend_audit"]);
    expect((await verifyDecision(ws, a.receipts.audit)).ok).toBe(true);
    // the same change is not proposed twice
    expect((await proposeAmendment(ws, data, rb, sf!, { audit: pass })).offered).toBe(false);
  });

  it("does not offer it when the audit misses a planted defect, but records the audit", async () => {
    const { ws, data } = await seeded(3);
    const [sf] = localShortfalls(loadExceptions(data));
    const res = await proposeAmendment(ws, data, loadFixtureRulebook("kos-melati"), sf!, { audit: fail, history: amendSampleHistory() });
    expect(res).toMatchObject({ offered: false, audit: { killed: 49, total: 51 } });
    expect(loadAmendments(data)).toHaveLength(0);
    expect(ws.decisions().some((d) => d.action === "amend_audit")).toBe(true);
  });

  it("never claims an improvement without a history to replay", async () => {
    const { ws, data } = await seeded(3);
    const [sf] = localShortfalls(loadExceptions(data));
    await proposeAmendment(ws, data, loadFixtureRulebook("kos-melati"), sf!, { audit: pass, history: null });
    expect(loadAmendments(data)[0]!.improvement).toMatchObject({ improved: false, replay: null });
  });

  it("approve saves a new rulebook version and writes an owner receipt; reject changes nothing", async () => {
    const { ws, data } = await seeded(3);
    const [sf] = localShortfalls(loadExceptions(data));
    await proposeAmendment(ws, data, loadFixtureRulebook("kos-melati"), sf!, { audit: pass, history: amendSampleHistory() });
    const a = loadAmendments(data)[0]!;
    const done = await approveAmendment(ws, data, a.id, { method: "session", credential_id: "account x" });
    expect(done.status).toBe("approved");
    expect(ws.decisions().find((d) => d.entry_hash === done.decision_receipt)).toMatchObject({ agent: "owner", action: "amend_approve" });
    expect((await verifyDecision(ws, done.decision_receipt!)).ok).toBe(true);
    expect(loadRulebookVersions(data)).toHaveLength(1);
    expect(loadRulebookVersions(data)[0]!.rulebook.cards.find((c) => c.id === "R3")).toMatchObject({ days_after_due: 15 });
    expect(done.improvement!.search.after).toMatchObject({ new: 0 });
    await expect(approveAmendment(ws, data, a.id, DEMO_PASSKEY)).rejects.toThrow("sudah diputuskan");

    const t2 = await seeded(3);
    const [sf2] = localShortfalls(loadExceptions(t2.data));
    await proposeAmendment(t2.ws, t2.data, loadFixtureRulebook("kos-melati"), sf2!, { audit: pass });
    const r = await rejectAmendment(t2.ws, t2.data, loadAmendments(t2.data)[0]!.id);
    expect(r.status).toBe("rejected");
    expect(loadRulebookVersions(t2.data)).toHaveLength(0);
    expect(t2.ws.decisions().at(-1)).toMatchObject({ action: "amend_reject" });
  });

  it("scan records which path ran", async () => {
    const { ws, data } = await seeded(3);
    const out = await scanAmendments(ws, data, { audit: pass, template: () => loadFixtureRulebook("kos-melati"), history: amendSampleHistory(), env: {} });
    expect(out.path).toBe("local");
    expect(loadAmendments(data)[0]).toMatchObject({ path: "local" });
  });

  it("the flag is off unless set", () => {
    expect(amendmentsEnabled({})).toBe(false);
    expect(amendmentsEnabled({ REEVE_SOP_AMENDMENTS: "on" })).toBe(true);
  });
});

describe("the amended rulebook passes the real audit", () => {
  it("catches every planted defect in the local sandbox", async () => {
    const { ws, data } = await seeded(3);
    const [sf] = localShortfalls(loadExceptions(data));
    let audited: { killed: number; total: number } | undefined;
    await proposeAmendment(ws, data, loadFixtureRulebook("kos-melati"), sf!, {
      audit: async (rb) => {
        const a = await runAttempt({ repoRoot, rulebook: rb, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: `amend-test-${Date.now().toString(36)}` });
        audited = { killed: a.results?.mutation.killed ?? 0, total: a.results?.mutation.total ?? 0 };
        return { status: a.verdict.status, cases: a.plan.cases.length, killed: audited.killed, total: audited.total };
      },
      history: amendSampleHistory(),
    });
    console.log("real audit:", JSON.stringify(audited));
    expect(audited!.total).toBeGreaterThan(0);
    expect(audited!.killed).toBe(audited!.total);
    expect(loadAmendments(data)).toHaveLength(1);
  }, 180_000);
});
