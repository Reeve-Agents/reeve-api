import { describe, expect, it } from "vitest";
import { anchorLeaves, merkleRoot } from "@reeve/receipts";
import { buildRapor, isOnchainAnchor, raporHtml, storeRapor } from "../src/index";
import { testDeps } from "./helpers";

async function withDecision() {
  const t = await testDeps();
  const op = await t.ws.run("run_anchor_label").agent("operator", "Tick");
  await op.decide({ input: "K05 telat 4 hari", output: { action: "remind" }, reasoning: "Rule R2: reminders on day 3 and 10.", action: "remind", action_class: "reminder", subject: "K05" });
  return t;
}

const appendLocal = (ledger: Awaited<ReturnType<typeof withDecision>>["ledger"]) => {
  const leaves = anchorLeaves(ledger.entries());
  ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "local-ledger" });
};

describe("Rapor anchor labels", () => {
  it("calls a root without a tx a local Merkle root, never an on-chain anchor", async () => {
    const { ws, ledger } = await withDecision();
    appendLocal(ledger);
    const r = await buildRapor(ws);
    expect(r.totals).toMatchObject({ anchored: 1, anchored_onchain: 0 });
    const html = raporHtml(r);
    expect(html).toContain("Merkle root lokal");
    expect(html).toContain("local Merkle root");
    expect(html).toContain("belum dipublikasikan on-chain");
    expect(html).not.toContain("anchor on-chain");
    expect(html).not.toContain("anchored on-chain");
    expect(html).not.toContain("membuktikan receipt tidak diubah sesudahnya");
    const stored = await storeRapor(ws, r);
    expect(ws.decisions().find((d) => d.entry_hash === stored.receipt)).toBeDefined();
    const text = JSON.stringify((await ws.conversation("auditor", ws.decisions().find((d) => d.entry_hash === stored.receipt)!.conversation_id)).messages);
    expect(text).toContain("0 are inside a Merkle root published on-chain and 1 only inside a local Merkle root");
  });

  it("says on-chain, with the tx link, only when the anchor entry has a tx", async () => {
    const { ws, ledger } = await withDecision();
    const leaves = anchorLeaves(ledger.entries());
    const explorer = "https://testnet.monadexplorer.com/tx/0xabc";
    ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "monad-testnet", chain_id: 10143, tx: "0xabc", explorer });
    const r = await buildRapor(ws);
    expect(r.totals).toMatchObject({ anchored: 1, anchored_onchain: 1 });
    expect(r.decisions[0]!.anchored).toMatchObject({ tx: "0xabc", explorer, proof_ok: true });
    const html = raporHtml(r);
    expect(html).toContain("anchor on-chain");
    expect(html).toContain("anchored on-chain");
    expect(html).toContain(explorer);
    expect(html).not.toContain("local Merkle root, not published on-chain");
  });

  it("prefers a later on-chain anchor over an earlier local one for the same decision", async () => {
    const { ws, ledger } = await withDecision();
    appendLocal(ledger);
    const leaves = anchorLeaves(ledger.entries());
    ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "monad-testnet", tx: "0xdef", explorer: "https://testnet.monadexplorer.com/tx/0xdef" });
    const r = await buildRapor(ws);
    expect(r.totals).toMatchObject({ anchored: 1, anchored_onchain: 1 });
    expect(r.anchors.map((a) => isOnchainAnchor(a))).toEqual([false, true]);
  });

  it("renders a Rapor stored before anchored_onchain existed", async () => {
    const { ws, ledger } = await withDecision();
    appendLocal(ledger);
    const r = await buildRapor(ws);
    delete (r.totals as { anchored_onchain?: number }).anchored_onchain;
    expect(raporHtml(r)).toContain("Merkle root lokal");
  });
});
