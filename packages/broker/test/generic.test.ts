import { describe, expect, it } from "vitest";
import { prepareAudit } from "@reeve/auditor";
import { compile } from "@reeve/builder";
import { bimbelRecords, loadFixtureRulebook, repoRoot, runOperate } from "@reeve/pipeline";
import { LocalSandbox } from "@reeve/sandbox";
import { GenericOperator, NeedsPasskeyError, newGenericOperation } from "../src/index";

const rb = loadFixtureRulebook("bimbel-cerdas");
const rulesPy = compile(rb).files["rules.py"];
const constraintsJson = prepareAudit(rb, rulesPy).files["constraints.json"]!;

function setup() {
  const calls: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
  const ledger: { event: string }[] = [];
  const op = newGenericOperation({ id: "op_g", rulebookId: "rb", receiptHash: "r", datasetId: "sample", startDate: "2026-11-02" });
  const operator = new GenericOperator(op, rb, {
    runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: new LocalSandbox() }),
    execute: async (connector, tool, args) => {
      calls.push({ connector, tool, args });
      return { ok: true, connector: tool === "GMAIL_SEND_EMAIL" ? "composio" : "log" };
    },
    records: async () => bimbelRecords().records,
    record: (b) => ledger.push(b),
    save: () => undefined,
  });
  return { op, operator, calls, ledger };
}

describe("generic Operator", () => {
  it("sends the approved rules' tool calls, holds the ones above the limit, never messages a stopped student", async () => {
    const { op, operator, calls } = setup();
    await operator.advance("2026-11-02");
    // Day 1: S05 is 8 days overdue → one email (S09 is only 5); S01 and S03 due within 3 days → WhatsApp;
    // S03 and S06 have < 2 sessions → renewal offer; S11 owes Rp3 jt → held for approval.
    const by = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => String(c.args.chat_id ?? c.args.recipient_email));
    expect(by("GMAIL_SEND_EMAIL")).toEqual(["ortu.eka@example.com"]);
    expect(op.held.find((h) => h.kind === "approval_request")).toMatchObject({ key: "S11", amount: 3_000_000, needsPasskey: true });
    expect(calls.some((c) => String(c.args.chat_id) === "900000007")).toBe(false); // S07 stopped
    const firstDay = calls.length;

    // Running the same day again is refused; the next day sends only that day's decisions.
    await expect(operator.advance("2026-11-02")).rejects.toThrow(/already/);
    await operator.advance("2026-11-03");
    expect(calls.length).toBeGreaterThan(firstDay);
    expect(calls.slice(firstDay).filter((c) => c.tool === "GMAIL_SEND_EMAIL")).toEqual([]); // once per record

    const held = op.held.find((h) => h.kind === "approval_request")!;
    await expect(operator.approve(held.id, false)).rejects.toBeInstanceOf(NeedsPasskeyError);
    await operator.approve(held.id, true);
    expect(calls.at(-1)).toMatchObject({ tool: "TELEGRAM_SEND_MESSAGE", args: { chat_id: "900000011" } });
  });
});
