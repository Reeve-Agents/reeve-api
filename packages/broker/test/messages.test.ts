import { describe, expect, it } from "vitest";
import { prepareAudit } from "@reeve/auditor";
import { compile } from "@reeve/builder";
import { kosMelatiScenario, loadFixtureRulebook, repoRoot, runOperate } from "@reeve/pipeline";
import { MockRail } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { contactsFromRecords, keepsFacts, messageFor, newOperation, Operator, RENT_MESSAGE_TOOLS, toolCallFor, type ToolCall } from "../src/index";

const rulebook = loadFixtureRulebook();
const rulesPy = compile(rulebook).files["rules.py"];
const constraintsJson = prepareAudit(rulebook, rulesPy).files["constraints.json"]!;
const tenants = kosMelatiScenario().tenants;

function setup(opts: { contacts?: Parameters<typeof newOperation>[0]["contacts"]; send?: (c: ToolCall) => Promise<{ ok: boolean; connector: string; error?: string }>; draft?: (m: any) => Promise<string | null> }) {
  const ledger: { event: string; ref?: string }[] = [];
  const op = newOperation({ id: "op_msg", rulebookId: "rb", receiptHash: "r".repeat(64), rail: "mock", startDate: "2026-11-01", tenants, contacts: opts.contacts });
  const operator = new Operator(op, rulebook, tenants, {
    rail: new MockRail(),
    runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: new LocalSandbox() }),
    record: (b) => ledger.push(b),
    save: () => undefined,
    send: opts.send,
    draft: opts.draft,
    now: () => new Date("2026-10-18T03:00:00Z"),
  });
  return { op, operator, ledger };
}

describe("rent messages", () => {
  it("picks Telegram, then Gmail, then the log, and only ever the allow-listed tools", () => {
    const msg = messageFor("reminder", { name: "Budi", room: "A1", amount: 1_500_000, payUrl: "https://pay/x" });
    expect(msg.body).toContain("https://pay/x");
    expect(msg.body).toContain("Rp1.500.000");
    const calls = [toolCallFor(msg, { telegram_chat_id: "42", email: "b@x.id" }), toolCallFor(msg, { email: "b@x.id" }), toolCallFor(msg, undefined)];
    expect(calls.map((c) => c.tool)).toEqual(["TELEGRAM_SEND_MESSAGE", "GMAIL_SEND_EMAIL", "LOG"]);
    for (const c of calls) expect(RENT_MESSAGE_TOOLS).toContain(c.tool as (typeof RENT_MESSAGE_TOOLS)[number]);
    expect(calls[0]!.args).toMatchObject({ chat_id: "42" });
    expect(calls[1]!.args).toMatchObject({ recipient_email: "b@x.id", subject: msg.subject });
  });

  it("reads contact columns from the tenant sheet by row", () => {
    const c = contactsFromRecords([{ kamar: "A1", telegram_chat_id: "111", email: "" }, { kamar: "A2", telegram_chat_id: "", email: "s@x.id" }, { kamar: "A3" }], ["A1", "A2", "A3"]);
    expect(c).toEqual({ A1: { telegram_chat_id: "111" }, A2: { email: "s@x.id" } });
  });

  it("a drafted text must keep the amount and the payment link", () => {
    const facts = { name: "B", room: "A1", amount: 1_500_000, payUrl: "https://pay/x" };
    expect(keepsFacts("Hai, mohon bayar Rp1.500.000 di https://pay/x ya", facts)).toBe(true);
    expect(keepsFacts("Hai, mohon bayar Rp1.500.000", facts)).toBe(false);
    expect(keepsFacts("Hai, mohon bayar Rp1.000.000 di https://pay/x", facts)).toBe(false);
  });

  it("bills and reminders reach the tenant with the payment link; tenants without a contact and failed sends fall back to the log", async () => {
    const sent: ToolCall[] = [];
    const send = async (c: ToolCall) => {
      sent.push(c);
      if (c.connector === "log") return { ok: true, connector: "log" };
      return String(c.args.chat_id) === "9002" ? { ok: false, connector: "none", error: "no connected service has TELEGRAM_SEND_MESSAGE" } : { ok: true, connector: "composio" };
    };
    const { op, operator, ledger } = setup({ send, contacts: { K29: { telegram_chat_id: "9001" }, K30: { telegram_chat_id: "9002" } } });
    const day1 = await operator.advance("2026-11-01");
    expect(day1.filter((a) => a.outcome === "invoiced")).toHaveLength(30);
    const k29 = sent.find((c) => c.tool === "TELEGRAM_SEND_MESSAGE" && c.args.chat_id === "9001")!;
    const k29bill = op.invoices.find((i) => i.tenant === "K29")!;
    expect(k29.args.text).toContain(k29bill.payUrl);

    const day4 = await operator.advance("2026-11-04");
    const reminders = day4.filter((a) => a.type === "reminder");
    expect(reminders.map((a) => [a.tenant, a.outcome])).toEqual([["K01", "logged"], ["K02", "logged"]].length ? expect.any(Array) : []);
    const byTenant = Object.fromEntries(reminders.map((a) => [a.tenant, a]));
    expect(byTenant.K29).toMatchObject({ outcome: "sent" });
    expect(byTenant.K29!.detail).toContain("sent via TELEGRAM_SEND_MESSAGE");
    expect(byTenant.K30).toMatchObject({ outcome: "logged" });
    expect(byTenant.K30!.detail).toContain("failed");
    expect(byTenant.K01).toMatchObject({ outcome: "logged" });
    expect(byTenant.K01!.detail).toContain("no Telegram chat id or email");
    const reminderForK29 = sent.filter((c) => c.args.chat_id === "9001").at(-1)!;
    expect(reminderForK29.args.text).toContain(k29bill.payUrl);
    expect(ledger.filter((l) => l.event === "message_sent").length).toBeGreaterThan(0);
    expect(ledger.filter((l) => l.event === "message_logged").length).toBeGreaterThan(0);
    // Nothing but allow-listed tools was ever called.
    for (const c of sent) expect(RENT_MESSAGE_TOOLS).toContain(c.tool as (typeof RENT_MESSAGE_TOOLS)[number]);
  });

  it("without a send function everything stays logged", async () => {
    const { operator } = setup({ contacts: { K29: { telegram_chat_id: "9001" } } });
    await operator.advance("2026-11-01");
    const day4 = await operator.advance("2026-11-04");
    expect(day4.filter((a) => a.type === "reminder").every((a) => a.outcome === "logged")).toBe(true);
  });
});
