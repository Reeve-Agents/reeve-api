import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeMeko, MekoWorkspace, Pseudonymiser } from "@reeve/meko";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { batchPOs, consentGroupBuy, fixturePOs, GROUP_WORKSPACE, placeGroupOrder, runGroupBuy, tierPrice, verifyGroupOrder, type GroupBuyer, type Quote } from "../src/index";

async function world(consent: boolean[] = [true, true, true], choose: ("approve" | "refuse")[] = ["approve", "approve", "approve"]) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "gb-")), "ledger.jsonl"));
  const open = (workspace: string) => MekoWorkspace.open(meko, { workspace, ledger, pseudonyms: new Pseudonymiser() });
  const shared = await open(GROUP_WORKSPACE);
  const pos = fixturePOs();
  const wss = await Promise.all(pos.map((p) => open(`gb-${p.business}`)));
  const buyers: GroupBuyer[] = [];
  for (const [i, po] of pos.entries()) {
    if (consent[i]) await consentGroupBuy(wss[i]!, `M${i + 1}`);
    buyers.push({ ws: wss[i]!, po, label: `M${i + 1}`, consent: consent[i]!, decide: () => choose[i]! });
  }
  const sent: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
  const execute = async (connector: string, tool: string, args: Record<string, unknown>) => {
    sent.push({ connector, tool, args });
    return { ok: true, via: "log" };
  };
  return { meko, shared, wss, buyers, execute, sent, pos };
}

describe("group buying", () => {
  it("batches per sku, prices at the tier and sums each owner's line", () => {
    const b = batchPOs(fixturePOs());
    const sku = (s: string) => b.skus.find((x) => x.sku === s)!;
    expect(sku("BRS-5KG").qty).toBe(55);
    expect(sku("BRS-5KG").discount).toBe(0.05);
    expect(sku("MYK-2L").qty).toBe(110);
    expect(sku("MYK-2L").unit_price).toBe(Math.round(36000 * 0.92));
    expect(sku("GLA-1KG").discount).toBe(0); // 35 < 50
    expect(tierPrice(1000, 49).unit_price).toBe(1000);
    expect(tierPrice(1000, 50).unit_price).toBe(950);
    for (const q of b.quotes) expect(q.total).toBe(q.lines.reduce((a, l) => a + l.qty * l.unit_price, 0));
    expect(b.total).toBe(b.quotes.reduce((a, q) => a + q.total, 0));
    expect(b.saving).toBeGreaterThan(0);
    expect(b.quotes.every((q) => q.saving >= 0)).toBe(true);
  });

  it("a refusal removes that line and the tier drops on recompute", async () => {
    const w = await world([true, true, true], ["approve", "approve", "refuse"]);
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    expect(r.excluded).toEqual([{ business: "minimarket-3", reason: "refused" }]);
    expect(r.rounds).toBe(2);
    const full = batchPOs(w.pos);
    expect(r.batch.skus.find((s) => s.sku === "MYK-2L")!.discount).toBeLessThan(full.skus.find((s) => s.sku === "MYK-2L")!.discount);
    expect(r.batch.skus.find((s) => s.sku === "BRS-5KG")!.qty).toBe(40);
    expect(r.batch.skus.find((s) => s.sku === "BRS-5KG")!.discount).toBe(0); // 55 -> 40, below 50
    expect(r.order).not.toBeNull();
  });

  it("needs consent: a business that did not consent never joins, the batch is recomputed", async () => {
    const w = await world([true, true, false]);
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    expect(r.excluded).toEqual([{ business: "minimarket-3", reason: "no_consent" }]);
    expect(r.batch.quotes.map((q) => q.business)).toEqual(["minimarket-1", "minimarket-2"]);
    expect(w.wss[2]!.decisions({ action_class: "groupbuy" })).toEqual([]);
    // A buyer claiming consent without a receipt in its own ledger is still excluded.
    const w2 = await world([true, true, false]);
    w2.buyers[2]!.consent = true;
    const r2 = await runGroupBuy(w2.shared, w2.buyers, w2.execute);
    expect(r2.excluded).toEqual([{ business: "minimarket-3", reason: "no_consent" }]);
  });

  it("places no order with fewer than 2 approvals", async () => {
    const w = await world([true, true, true], ["approve", "refuse", "refuse"]);
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    expect(r.order).toBeNull();
    expect(w.sent).toEqual([]);
    await expect(placeGroupOrder(w.shared, r.batch, ["x"], w.execute)).rejects.toThrow(/at least 2/);
  });

  it("an owner's approval holds only their own line, and the order names no business", async () => {
    const w = await world();
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    const batch = batchPOs(w.pos);
    for (const [i, ws] of w.wss.entries()) {
      const d = ws.decisions({ action_class: "groupbuy" }).find((x) => x.action === "approve_group_line")!;
      const conv = await ws.conversation(d.agent, d.conversation_id);
      const m = conv.messages.find((x) => x.metadata?.reeve_receipt === d.entry_hash)!;
      const own = batch.quotes[i]!;
      const input = JSON.parse(m.input as string) as { lines: { sku: string; qty: number }[] };
      expect(input.lines.map((l) => [l.sku, l.qty])).toEqual(own.lines.map((l) => [l.sku, l.qty]));
      const others = batch.quotes.filter((_, j) => j !== i);
      expect(JSON.stringify(m.input) + JSON.stringify(m.output)).not.toMatch(/minimarket-\d|M\d/);
      // The batch totals (the only place others' quantities would show) are not in the owner's decision.
      for (const s of batch.skus) expect(JSON.stringify(m.output)).not.toContain(`"batch_qty":${s.qty}`);
      expect(others.length).toBe(2);
    }
    const so = w.shared.decisions({ action_class: "groupbuy" }).find((x) => x.action === "place_group_order")!;
    const conv = await w.shared.conversation(so.agent, so.conversation_id);
    const out = JSON.stringify(conv.messages.find((x) => x.metadata?.reeve_receipt === so.entry_hash));
    expect(out).not.toMatch(/minimarket/);
    expect(r.order!.exec.via).toBe("log");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.connector).toBe("log");
  });

  it("verifies receipts and detects an edited line", async () => {
    const w = await world();
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    const v = await verifyGroupOrder(w.shared, w.wss, r.order!.receipt);
    expect(v).toEqual({ ok: true, problems: [], approvals: 3 });

    // Edit one approved line after the fact: its trace no longer matches the receipt.
    const target = r.approvals[0]!.receipt;
    const q = batchPOs(w.pos).quotes[0]! as Quote;
    const lines = q.lines.map((l, i) => (i === 0 ? { ...l, qty: l.qty + 5, total: (l.qty + 5) * l.unit_price } : l));
    w.meko.tamper(target, { output: JSON.stringify({ line: { lines, total: lines.reduce((a, l) => a + l.total, 0), saving: 0 } }) });
    const bad = await verifyGroupOrder(w.shared, w.wss, r.order!.receipt);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/diubah|cocok/);
  });

  it("detects an order whose totals differ from the approved lines", async () => {
    const w = await world();
    const r = await runGroupBuy(w.shared, w.buyers, w.execute);
    // A second order that claims more than the approvals back.
    const inflated = batchPOs(w.pos);
    inflated.skus[0]!.qty += 10;
    inflated.total += 1;
    const o = await placeGroupOrder(w.shared, inflated, r.approvals.map((a) => a.receipt), w.execute);
    const v = await verifyGroupOrder(w.shared, w.wss, o.receipt);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/sum to|total/);
  });
});
