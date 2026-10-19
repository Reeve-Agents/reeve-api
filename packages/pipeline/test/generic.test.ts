import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Rulebook } from "@reeve/core";
import { LocalSandbox } from "@reeve/sandbox";
import { bimbelRecords, genericScenario, loadFixtureRulebook, repoRoot, runAttempt } from "../src/index";

describe("generic pack: Bimbel Cerdas (any SOP over a spreadsheet)", () => {
  it("compiles, simulates and passes the Auditor locally", async () => {
    const rb = loadFixtureRulebook("bimbel-cerdas");
    const { records, updates } = bimbelRecords();
    const a = await runAttempt({ repoRoot, rulebook: rb, scenario: genericScenario(rb, records, updates), sandbox: new LocalSandbox(), runId: "t-generic" });
    if (a.verdict.status !== "pass") console.log(a.verdict.findings.filter((f) => f.severity !== "info"), a.run.stderr.slice(-1500));
    expect(a.results!.builder_tests.failed).toBe(0);
    expect(a.results!.audit_spec.failed).toBe(0);
    expect(a.results!.constraints.violations).toEqual([]);
    expect(a.verdict.mutation_score).toBe(1);
    expect(a.verdict.status).toBe("pass");

    const ev = a.results!.simulation.events;
    const of = (type: string, who: string) => ev.filter((e) => e.type === type && e.tenant_id === who);
    // S07 has stopped: never messaged, though unpaid and due.
    expect(ev.filter((e) => e.tenant_id === "S07" && e.type === "action")).toEqual([]);
    expect(of("blocked", "S07").length).toBeGreaterThan(0);
    // S04 and S11 owe more than Rp2 jt: their reminders wait for the owner.
    expect(of("approval_request", "S11").length).toBeGreaterThan(0);
    expect(of("action", "S11")).toEqual([]);
    // S05 was 8 days overdue on 2 Nov: one email, then it paid.
    expect(of("action", "S05").filter((e) => e.tool === "GMAIL_SEND_EMAIL")).toHaveLength(1);
    // S03 has 1 session left: one renewal offer only.
    expect(of("action", "S03").filter((e) => e.rule === "R3")).toHaveLength(1);
    expect(ev.filter((e) => e.type === "kpi_alert").length).toBeGreaterThan(0);
  });

  it("catches a Builder that forgets the never rule", async () => {
    const rb = loadFixtureRulebook("bimbel-cerdas");
    const { records, updates } = bimbelRecords();
    const a = await runAttempt({ repoRoot, rulebook: rb, scenario: genericScenario(rb, records, updates), sandbox: new LocalSandbox(), runId: "t-generic-bug", bugs: ["ignore_never_rules"] });
    expect(a.verdict.status).toBe("fail");
    expect(a.results!.constraints.violations.some((v) => v.startsWith("[R4]"))).toBe(true);
    expect(a.results!.audit_spec.failures.some((f) => f.includes("R4"))).toBe(true);
  });
});

describe("generic pack: live parses of the Bimbel Cerdas SOP (18-19 Oct 2026)", () => {
  const run = async (fixture: string) => {
    const rb = Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, "fixtures/bimbel-cerdas", fixture), "utf8")));
    const { records, updates } = bimbelRecords();
    return runAttempt({ repoRoot, rulebook: rb, scenario: genericScenario(rb, records, updates), sandbox: new LocalSandbox(), runId: `t-${fixture}` });
  };

  it("Opus 5.5's rulebook passes and decides exactly what the hand-written one does", async () => {
    const a = await run("rulebook.claude-opus-5-5.json");
    expect(a.verdict.status).toBe("pass");
    expect(a.results!.simulation.summary).toMatchObject({ actions: 23, approval_requests: 7, blocked: 5, kpi_alerts: 5 });
  });

  it("Haiku 5.5's rulebook is blocked: its approval limit names no amount, so it could never apply", async () => {
    const a = await run("rulebook.claude-haiku-5-5.json");
    expect(a.verdict.status).toBe("fail");
    expect(a.verdict.findings.find((f) => f.code === "RULEBOOK_INVALID")!.message).toMatch(/approval limit can never apply/);
  });
});
