import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "@reeve/builder";
import { Rulebook } from "@reeve/core";
import { buildSpecCases, decide, generateMutants, prepareAudit, roundHalfEven } from "../src/index";

const fixture = Rulebook.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/kos-melati/rulebook.json", import.meta.url)), "utf8")));

describe("spec", () => {
  it("covers every executable card of the fixture", () => {
    const { cases, skipped } = buildSpecCases(fixture);
    const cards = new Set(cases.map((c) => c.card));
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R8"]) expect(cards).toContain(id);
    expect(skipped).toEqual([]);
  });

  it("expects the veteran's fee only after the grace period", () => {
    const grace = buildSpecCases(fixture).cases.find((c) => c.name.startsWith("long-term"))!;
    const vet = grace.expect.find((e) => e.tenant_id === "veteran")!;
    expect(vet.date).toBe("2026-11-11"); // H+7 + 3 days
  });

  it("rounds like Python (half to even)", () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(75000)).toBe(75000);
  });
});

describe("mutants", () => {
  it("produces distinct, realistic defects", () => {
    const mutants = generateMutants(compile(fixture).files["rules.py"]);
    expect(mutants.length).toBeGreaterThan(20);
    expect(new Set(mutants.map((m) => m.source)).size).toBe(mutants.length);
    expect(mutants.some((m) => m.description === "drop the tenure grace")).toBe(true);
  });

  it("skips dead-code constants (refund threshold under a credit policy)", () => {
    const mutants = generateMutants(compile(fixture).files["rules.py"]);
    expect(mutants.some((m) => m.description.startsWith("REFUND_APPROVAL_ABOVE"))).toBe(false);
  });
});

describe("decide", () => {
  it("fails when the job produced nothing", () => {
    const plan = prepareAudit(fixture, compile(fixture).files["rules.py"]);
    expect(decide(fixture, plan, null).status).toBe("fail");
  });
});
