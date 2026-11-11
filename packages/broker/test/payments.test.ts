import { describe, expect, it } from "vitest";
import { prepareAudit } from "@reeve/auditor";
import { compile } from "@reeve/builder";
import { ConnectorRegistry, LogConnector } from "@reeve/connectors";
import { bimbelRecords, loadFixtureRulebook, repoRoot, runOperate } from "@reeve/pipeline";
import { MockRail, railEntries, type InvoiceRequest } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { GenericOperator, NeedsPasskeyError, newGenericOperation, PAYMENT_TOOLS, PaymentsConnector, withPayments } from "../src/index";

// The bimbel rulebook, with its two billing-style rules turned into "create an invoice" tool calls.
const rb = loadFixtureRulebook("bimbel-cerdas");
const invoiceAction = {
  connector: "payments",
  tool: "MOCK_CREATE_INVOICE",
  args: [
    { name: "amount", template: "{fee}" },
    { name: "description", template: "SPP {name}" },
    { name: "customer_name", template: "{name}" },
    { name: "customer_email", template: "{email}" },
    { name: "customer_ref", template: "{id}" },
    { name: "due_date", template: "{due_date}" },
  ],
  amount_field: "fee",
};
for (const card of rb.cards) if (card.type === "generic_rule" && (card.id === "R1" || card.id === "R2")) card.action = invoiceAction as typeof card.action;
const rulesPy = compile(rb).files["rules.py"];
const constraintsJson = prepareAudit(rb, rulesPy).files["constraints.json"]!;

function setup() {
  const created: InvoiceRequest[] = [];
  const mock = new MockRail();
  const spy = { ...mock, createInvoice: async (r: InvoiceRequest) => (created.push(r), mock.createInvoice(r)) } as unknown as MockRail;
  const rails = railEntries({} as NodeJS.ProcessEnv); // no keys: mock only
  const registry = withPayments(new ConnectorRegistry([new LogConnector()]), rails, () => spy);
  const ledger: { event: string; ref?: string }[] = [];
  const op = newGenericOperation({ id: "op_pay", rulebookId: "rb", receiptHash: "r", datasetId: "sample", startDate: "2026-11-02" });
  const operator = new GenericOperator(op, rb, {
    runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: new LocalSandbox() }),
    execute: (c, t, a) => registry.execute(c, t, a),
    records: async () => bimbelRecords().records,
    record: (b) => ledger.push(b),
    save: () => undefined,
  });
  return { op, operator, created, registry, ledger };
}

describe("payments as connector tools", () => {
  it("names the tools, and only answers them when their rail is set up", async () => {
    expect(Object.keys(PAYMENT_TOOLS).sort()).toEqual(["MOCK_CREATE_INVOICE", "STRIPE_CREATE_INVOICE", "XENDIT_CREATE_INVOICE"]);
    const { registry } = setup();
    expect((await registry.resolve("payments", "MOCK_CREATE_INVOICE"))?.connector.id).toBe("payments");
    // Stripe and Xendit have no key here: the registry does not pretend to have them.
    expect(await registry.resolve("payments", "XENDIT_CREATE_INVOICE")).toBeNull();
    expect((await registry.execute("payments", "STRIPE_CREATE_INVOICE", { amount: 1000, customer_name: "A" })).ok).toBe(false);
    // Build-time check sees the tool and its required arguments.
    const [ok] = await registry.check([{ rule: "R1", connector: "payments", tool: "MOCK_CREATE_INVOICE", args: ["amount", "description", "customer_name"] }]);
    expect(ok).toMatchObject({ status: "ok", connector: "payments" });
    const [missing] = await registry.check([{ rule: "R1", connector: "payments", tool: "MOCK_CREATE_INVOICE", args: ["amount"] }]);
    expect(missing).toMatchObject({ status: "missing_args" });
  });

  it("creates a hosted invoice, refuses bad input, and never bills twice for the same thing", async () => {
    const conn = new PaymentsConnector(() => new MockRail());
    const a = await conn.execute("MOCK_CREATE_INVOICE", { amount: 500000, description: "SPP", customer_name: "Eka", customer_ref: "S05", due_date: "2026-11-01" });
    expect(a).toMatchObject({ ok: true, data: { rail: "mock", status: "open", amount: 500000 } });
    expect((a.data as { pay_url: string }).pay_url).toMatch(/^https:\/\//);
    expect((await conn.execute("MOCK_CREATE_INVOICE", { amount: 0, customer_name: "Eka" })).ok).toBe(false);
    expect((await conn.execute("MOCK_CREATE_INVOICE", { amount: 5000, customer_name: " " })).ok).toBe(false);
    expect((await conn.execute("NOT_A_TOOL", {})).ok).toBe(false);
  });

  it("a rule card creates the bill, the payment link is kept, and a bill above the limit waits for the passkey", async () => {
    const { op, operator, created, ledger } = setup();
    await operator.advance("2026-11-02");
    const billed = op.sent.filter((s) => s.tool === "MOCK_CREATE_INVOICE" && s.ok);
    expect(billed.length).toBeGreaterThan(0);
    expect(created.length).toBe(billed.length);
    const s05 = billed.find((s) => s.key === "S05")! as typeof billed[number] & { result?: { pay_url: string } };
    expect(s05.via).toBe("payments");
    expect(s05.result?.pay_url).toMatch(/^https:\/\//);
    expect(ledger.some((l) => l.event === "invoice_created")).toBe(true);

    // S11 is above the limit: held, nothing created until the passkey-verified approval.
    const held = op.held.find((h) => h.kind === "approval_request" && h.key === "S11")!;
    expect(held).toMatchObject({ tool: "MOCK_CREATE_INVOICE", needsPasskey: true });
    expect(created.some((c) => c.customer.ref === "S11")).toBe(false);
    await expect(operator.approve(held.id, false)).rejects.toBeInstanceOf(NeedsPasskeyError);
    expect(created.some((c) => c.customer.ref === "S11")).toBe(false);
    await operator.approve(held.id, true);
    expect(created.filter((c) => c.customer.ref === "S11")).toHaveLength(1);
    expect(op.sent.at(-1)).toMatchObject({ key: "S11", tool: "MOCK_CREATE_INVOICE", ok: true });
  });

  it("a payment tool the approved rulebook does not name is never called", async () => {
    const { op, operator, created } = setup();
    const send = (operator as unknown as { send: (a: Record<string, unknown>) => Promise<void> }).send.bind(operator);
    await send({ date: "2026-11-02", key: "X1", rule: "R9", tool: "STRIPE_CREATE_INVOICE", connector: "payments", args: { amount: "1000", customer_name: "X" } });
    expect(op.sent.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("not in the approved rulebook") });
    expect(created).toHaveLength(0);
  });
});
