import { describe, expect, it } from "vitest";
import { prepareAudit } from "@reeve/auditor";
import { compile } from "@reeve/builder";
import type { Scenario } from "@reeve/core";
import { kosMelatiScenario, loadFixtureRulebook, repoRoot, runOperate } from "@reeve/pipeline";
import { MockRail } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { NeedsPasskeyError, newOperation, Operator, OperatorError, type OperationRecord } from "../src/index";

const rulebook = loadFixtureRulebook();
const rulesPy = compile(rulebook).files["rules.py"];
const constraintsJson = prepareAudit(rulebook, rulesPy).files["constraints.json"]!;
const tenants = kosMelatiScenario().tenants;

function setup(runRules?: (s: Scenario) => Promise<{ events: never[]; violations: string[] }>) {
  const rail = new MockRail();
  const ledger: { event: string; tenant?: string; amount?: number; ref?: string }[] = [];
  const op: OperationRecord = newOperation({ id: "op_test", rulebookId: "rb_1", receiptHash: "r".repeat(64), rail: "mock", startDate: "2026-11-01", tenants });
  const operator = new Operator(op, rulebook, tenants, {
    rail,
    runRules: runRules ?? ((scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: new LocalSandbox() })),
    record: (b) => ledger.push(b),
    save: () => undefined,
    now: () => new Date("2026-10-18T03:00:00Z"),
  });
  return { rail, ledger, op, operator };
}

describe("Operator: approved rules over real payments", () => {
  it("bills every room on day 1, then reminds only the rooms that have not paid", async () => {
    const { rail, op, operator, ledger } = setup();
    const day1 = await operator.advance("2026-11-01");
    expect(day1.filter((a) => a.outcome === "invoiced")).toHaveLength(30);
    expect(op.invoices[0]).toMatchObject({ key: "K01-2026-11", amount: 1_500_000, status: "open" });
    expect(rail.log.filter((l) => l.startsWith("createInvoice"))).toHaveLength(30);

    // 28 rooms pay on the rail; K29 and K30 do not.
    for (const inv of op.invoices.slice(0, 28)) await operator.simulatePayment(inv.invoiceId);
    const day4 = await operator.advance("2026-11-04");
    const reminders = day4.filter((a) => a.type === "reminder");
    expect(reminders.map((a) => a.tenant)).toEqual(["K29", "K30"]);
    expect(reminders[0]!.outcome).toBe("logged");
    expect(ledger.filter((l) => l.event === "payment_received")).toHaveLength(28);

    // Late fee on H+7 for the two non-payers only, billed on the rail.
    const day8 = await operator.advance("2026-11-08");
    const fees = day8.filter((a) => a.type === "late_fee");
    expect(fees.map((a) => [a.tenant, a.amount, a.outcome])).toEqual([
      ["K29", 75_000, "invoiced"],
      ["K30", 75_000, "invoiced"],
    ]);
    // Re-running the same window never bills twice.
    await expect(operator.advance("2026-11-08")).rejects.toThrow(OperatorError);
    expect(op.invoices).toHaveLength(32);
  });

  it("a double payment becomes credit per the rulebook; refunding above Rp500k needs the passkey", async () => {
    const { rail, op, operator } = setup();
    await operator.advance("2026-11-01");
    const k01 = op.invoices.find((i) => i.tenant === "K01")!;
    await operator.simulatePayment(k01.invoiceId);
    operator.recordTransfer("K01", 1_500_000); // paid again by bank transfer

    const day2 = await operator.advance("2026-11-02");
    const raised = day2.find((a) => a.outcome === "raised")!;
    expect(raised.tenant).toBe("K01");
    const ex = op.exceptions[0]!;
    expect(ex).toMatchObject({ kind: "overpayment", amount: 1_500_000, status: "open", needsPasskey: true });

    await expect(operator.refund(ex.id, false)).rejects.toBeInstanceOf(NeedsPasskeyError);
    const done = await operator.refund(ex.id, true);
    expect(done.status).toBe("refunded");
    expect(rail.log.at(-1)).toMatch(/^refund re_mock_\d+ inv_mock_1 1500000$/);
    // Netted: the rules no longer see the refunded amount as credit, so December is billed in full.
    expect(op.payments.filter((p) => p.tenant === "K01").reduce((s, p) => s + p.amount, 0)).toBe(1_500_000);
  });

  it("keeping the credit needs no passkey; the next bill shrinks by it", async () => {
    const { op, operator } = setup();
    await operator.advance("2026-11-01");
    operator.recordTransfer("K02", 1_700_000); // 200k more than the rent, outside the rail
    await operator.advance("2026-11-02");
    const ex = op.exceptions.find((x) => x.tenant === "K02")!;
    expect(ex).toMatchObject({ amount: 200_000, needsPasskey: false });
    expect(operator.keepCredit(ex.id).status).toBe("kept_as_credit");
    await operator.advance("2026-12-01");
    expect(op.invoices.find((i) => i.key === "K02-2026-12")!.amount).toBe(1_300_000);
  });

  it("ignores duplicate webhooks", async () => {
    const { op, operator, ledger } = setup();
    await operator.advance("2026-11-01");
    const inv = op.invoices[0]!;
    const ev = { type: "invoice.paid" as const, eventId: "evt_1", invoiceId: inv.invoiceId, amount: inv.amount, at: "2026-10-18T03:00:00Z" };
    expect(operator.handleEvent(ev)).toBe(true);
    expect(operator.handleEvent(ev)).toBe(true);
    expect(operator.handleEvent({ ...ev, invoiceId: "not-ours" })).toBe(false);
    expect(ledger.filter((l) => l.event === "payment_received")).toHaveLength(1);
  });

  it("sends nothing when the rules break a constraint", async () => {
    const { rail, op, operator, ledger } = setup(async () => ({ events: [], violations: ["K01: fees 20% of rent > 10%"] }));
    await expect(operator.advance("2026-11-01")).rejects.toThrow(/constraint violated/);
    expect(rail.log).toHaveLength(0);
    expect(op.clock).toBeNull();
    expect(ledger.at(-1)!.event).toBe("blocked");
  });
});
