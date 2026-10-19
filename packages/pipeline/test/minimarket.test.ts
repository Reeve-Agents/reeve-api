import { LocalSandbox } from "@reeve/sandbox";
import { describe, expect, it } from "vitest";
import { loadFixtureRulebook, minimarketScenario, repoRoot, runAttempt } from "../src/index";

describe("minimarket pack (pack 2)", () => {
  const rulebook = loadFixtureRulebook("minimarket");

  it("passes the Auditor end to end in a local sandbox", async () => {
    const a = await runAttempt({ repoRoot, rulebook, scenario: minimarketScenario(), sandbox: new LocalSandbox(), runId: "test-mm" });
    expect(a.verdict.status).toBe("pass");
    expect(a.results?.builder_tests.failed).toBe(0);
    expect(a.results?.audit_spec.failed).toBe(0);
    expect(a.verdict.mutation_score).toBe(1);
    expect(a.results?.constraints.violations).toEqual([]);
    const types = new Set(a.results?.simulation.events.map((e) => e.type));
    for (const t of ["po_created", "po_approval_request", "supplier_switched", "markdown", "writeoff", "reorder_stopped", "kpi_alert"]) expect(types).toContain(t);
  });

  it("catches a Builder that forgets the never-below-cost floor", async () => {
    const a = await runAttempt({ repoRoot, rulebook, scenario: minimarketScenario(), sandbox: new LocalSandbox(), bugs: ["ignore_markdown_floor"], runId: "test-mm-bug" });
    expect(a.verdict.status).toBe("fail");
    expect(a.verdict.findings.some((f) => f.code === "SPEC_MISMATCH" && f.message.includes("[M5]"))).toBe(true);
    expect(a.verdict.findings.some((f) => f.code === "CONSTRAINT_VIOLATION")).toBe(true);
  });
});
