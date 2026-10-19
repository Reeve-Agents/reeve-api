import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Rulebook, validateRulebook } from "@reeve/core";
import { compile } from "../src/index";

const fixture = Rulebook.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/kos-melati/rulebook.json", import.meta.url)), "utf8")));

describe("compile", () => {
  it("is deterministic", () => {
    expect(compile(fixture).files["rules.py"]).toBe(compile(fixture).files["rules.py"]);
  });

  it("encodes every rule card as a constant", () => {
    const py = compile(fixture).files["rules.py"];
    expect(py).toContain("INVOICE_DAY = 1");
    expect(py).toContain("REMINDER_DAYS = (3, 10)");
    expect(py).toContain("LATE_FEE_DAYS = 7");
    expect(py).toContain("GRACE_MIN_MONTHS = 12");
    expect(py).toContain("NOTICE_DAYS = 14");
    expect(py).toContain("REVENUE_TARGET = 45000000");
  });

  it("the injected bug removes the tenure grace from code AND from the Builder's own tests", () => {
    const buggy = compile(fixture, { bugs: ["ignore_tenure_grace"] });
    expect(buggy.files["rules.py"]).not.toContain("GRACE_EXTRA_DAYS\n");
    expect(buggy.files["rules.py"]).not.toContain("days = days + GRACE_EXTRA_DAYS");
    expect(buggy.files["test_builder.py"]).not.toContain("test_long_term_tenant_grace");
  });
});

describe("validateRulebook", () => {
  it("accepts the fixture", () => {
    expect(validateRulebook(fixture)).toEqual([]);
  });

  it("flags impossible values", () => {
    const bad = structuredClone(fixture);
    const fee = bad.cards.find((c) => c.type === "late_fee");
    if (fee?.type === "late_fee") fee.percent = 0;
    expect(validateRulebook(bad).map((i) => i.card)).toContain("R3");
  });
});
