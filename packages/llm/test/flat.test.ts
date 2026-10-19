import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Rulebook } from "@reeve/core";
import { CardConversionError, toRuleCard, toRulebook, type FlatCard } from "../src/index";

const blank: Omit<FlatCard, "id" | "kind" | "type" | "title" | "source_quote"> = {
  day_of_month: null,
  days_after_due: null,
  percent: null,
  basis: null,
  grace_min_months: null,
  grace_extra_days: null,
  policy: null,
  amount: null,
};
const card = (c: Partial<FlatCard> & Pick<FlatCard, "type" | "kind">): FlatCard => ({ id: "R1", title: "t", source_quote: "q", ...blank, ...c });

describe("flat → strict rule cards", () => {
  it("converts a late fee with tenure grace", () => {
    const c = toRuleCard(card({ kind: "rule", type: "late_fee", days_after_due: [7], percent: 5, basis: "rent", grace_min_months: 12, grace_extra_days: 3 }));
    expect(c).toMatchObject({ type: "late_fee", days_after_due: 7, percent: 5, tenure_grace: { min_months: 12, extra_days: 3 } });
  });

  it("rejects a late fee without a percent", () => {
    expect(() => toRuleCard(card({ kind: "rule", type: "late_fee", days_after_due: [7], basis: "rent" }))).toThrow(CardConversionError);
  });

  it("rejects a revenue KPI with a fee basis", () => {
    expect(() => toRuleCard(card({ kind: "kpi", type: "revenue_target", amount: 1, day_of_month: 15, basis: "rent" }))).toThrow(CardConversionError);
  });

  // Live parses saved from the CLI (18 Oct 2026). Every card matches the hand-written rulebook for both
  // packs, from the most accurate Claude model and from the cheapest one.
  it.each([
    ["kos-melati", "claude-opus-5-5"],
    ["kos-melati", "claude-haiku-5-5"],
    ["minimarket", "claude-opus-5-5"],
    ["minimarket", "claude-haiku-5-5"],
  ])("the rulebook %s parsed live by %s matches the hand-written fixture", (business, model) => {
    const read = (f: string) => Rulebook.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${business}/${f}`, import.meta.url)), "utf8")));
    const strip = (rb: Rulebook) => rb.cards.map(({ title: _t, source_quote: _q, ...rest }) => rest);
    expect(strip(read(`rulebook.${model}.json`))).toEqual(strip(read("rulebook.json")));
  });

  it("round-trips through toRulebook", () => {
    const rb = toRulebook({ business_name: "x", cards: [card({ kind: "rule", type: "invoice_schedule", day_of_month: 1 })], questions: [], assumptions: [] });
    expect(rb.cards[0]).toMatchObject({ type: "invoice_schedule", day_of_month: 1 });
  });
});
