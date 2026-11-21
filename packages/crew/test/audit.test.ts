import { describe, expect, it } from "vitest";
import { auditPlaybook, checkPlaybook, KOS_FACTS, KOS_WHITELIST, kosListingDraft, playbookB, playbookC, rupiahIn, validate, worstCase } from "../src/index";

const opts = { whitelist: KOS_WHITELIST, facts: KOS_FACTS, good_draft: kosListingDraft("7", "1 Desember") };

describe("playbook auditor", () => {
  it.each([playbookB(), playbookC()])("$id passes, and every planted violation and bad draft is caught", (pb) => {
    const a = auditPlaybook(pb, opts);
    expect(a.findings).toEqual([]);
    expect(a.planted.survivors).toEqual([]);
    expect(a.planted.total).toBeGreaterThan(10);
    expect(a.drafts.survivors).toEqual([]);
    expect(a.drafts.good_draft_clean).toBe(true);
    expect(a.status).toBe("pass");
  });

  it("does the budget math over the days until the goal date", () => {
    const wc = worstCase(playbookB());
    expect(wc.days).toBe(31);
    expect(wc.cost_idr).toBe((1 + 3 + 1) * 40 * 31);
  });

  it("names a step that can never fire", () => {
    const pb = playbookB();
    pb.steps[3]!.when = "viewing_finished";
    const f = checkPlaybook(pb, opts);
    expect(f.map((x) => `${x.code}:${x.step}`)).toEqual(expect.arrayContaining(["UNREACHABLE_STEP:b4_deposit", "UNREACHABLE_STEP:b5_contract", "UNREACHABLE_STEP:b6_accept"]));
  });

  it("refuses a deposit above the bound and a payment with no review", () => {
    const pb = playbookB();
    pb.steps[3]!.payment!.amount_idr = 2_000_000;
    pb.steps[3]!.review = "none";
    expect(checkPlaybook(pb, opts).map((f) => f.code)).toEqual(expect.arrayContaining(["PAYMENT_ABOVE_BOUND", "UNREVIEWED_PAYMENT"]));
  });

  it("fails the audit when a check is too weak to catch a planted draft", () => {
    const weak = { ...opts, facts: { ...KOS_FACTS, prices: [...KOS_FACTS.prices, 1_400_000] } };
    expect(auditPlaybook(playbookB(), weak).drafts.survivors).toContain("R10");
  });
});

describe("validator", () => {
  it("reads rupiah figures", () => {
    expect(rupiahIn("Rp1.500.000, deposit Rp 500.000, atau 1,5 juta, Rp2 jt")).toEqual([1_500_000, 500_000, 1_500_000, 2_000_000]);
  });
  it("passes a clean listing and blocks a wrong price", () => {
    expect(validate(kosListingDraft("7", "1 Desember"), KOS_FACTS)).toEqual([]);
    expect(validate(`Sewa Rp1.200.000 (dibuat dengan bantuan AI)`, KOS_FACTS).map((h) => h.rule)).toEqual(["R10"]);
  });
});
