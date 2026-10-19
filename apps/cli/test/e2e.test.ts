import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Rulebook } from "@reeve/core";
import { LocalSandbox } from "@reeve/sandbox";
import { kosMelatiScenario, runAttempt } from "@reeve/pipeline";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = Rulebook.parse(JSON.parse(readFileSync(`${repoRoot}fixtures/kos-melati/rulebook.json`, "utf8")));

describe("end to end (local sandbox, needs python3)", () => {
  it("passes the Auditor with the correct code", async () => {
    const a = await runAttempt({ repoRoot, rulebook: fixture, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: "e2e-ok" });
    expect(a.results).not.toBeNull();
    expect(a.verdict.status).toBe("pass");
    expect(a.results!.mutation.killed).toBe(a.results!.mutation.total);
    const vetFees = a.results!.simulation.events.filter((e) => e.tenant_id === "K24" && e.type === "late_fee" && e.date < "2026-12-01");
    expect(vetFees).toEqual([]); // the veteran paid inside the grace period
  });

  it("the Auditor catches a bug the Builder's own tests miss", async () => {
    const a = await runAttempt({ repoRoot, rulebook: fixture, scenario: kosMelatiScenario(), sandbox: new LocalSandbox(), runId: "e2e-bug", bugs: ["ignore_tenure_grace"] });
    expect(a.results!.builder_tests.failed).toBe(0);
    expect(a.verdict.status).toBe("fail");
    expect(a.verdict.findings.some((f) => f.code === "SPEC_MISMATCH" && f.message.includes("[R3]"))).toBe(true);
  });
});
