import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorLeaves, Ledger, merkleRoot } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { FakeMeko, MekoWorkspace, Pseudonymiser, verifyDecision } from "../src/index";

const ledgerAt = () => new Ledger(join(mkdtempSync(join(tmpdir(), "meko-")), "ledger.jsonl"));

async function chain(meko = new FakeMeko()) {
  const ledger = ledgerAt();
  const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger, pseudonyms: new Pseudonymiser({ "Sri Wahyuni": "Penghuni K03" }) });
  const run = ws.run("run_test_1");
  const builder = await run.agent("builder", "Compile SOP");
  const b = await builder.decide({ input: "Telat bayar > 7 hari didenda Rp50.000", output: { id: "late_fee_7d" }, reasoning: "SOP kalimat 3.", action: "compile" });
  const owner = await run.agent("owner", "Approve");
  await owner.remember("Kamar 3 (Sri Wahyuni) boleh telat sampai 10 hari, izin pemilik.", { kind: "owner_exception", room: "3" }, { promote: true });
  const op = await run.agent("operator", "Tick: kamar 3");
  const hits = await op.search("kamar 3 telat bayar izin pemilik");
  const d = await op.decide({ input: "Sri Wahyuni, kamar 3, telat 11 hari", output: { action: "hold" }, reasoning: "Ada izin pemilik untuk kamar 3.", action: "hold", action_class: "late_fee", usage: { name: "operator_reasoning", model: "fixture", input_tokens: 10, output_tokens: 5 } });
  return { meko, ledger, ws, b, d, hits };
}

describe("Meko trace", () => {
  it("opens one datapack per workspace and reuses it", async () => {
    const meko = new FakeMeko();
    const a = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    const b = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    const c = await MekoWorkspace.open(meko, { workspace: "minimarket", ledger: ledgerAt() });
    expect(a.datapackId).toBe(b.datapackId);
    expect(c.datapackId).not.toBe(a.datapackId);
    expect([...meko.packs.values()].sort()).toEqual(["reeve-kos-melati", "reeve-minimarket"]);
  });

  it("ties agents by run_id, each in its own session, with receipts both ways", async () => {
    const { meko, ledger, d, hits } = await chain();
    const convs = [...meko.convs.values()].filter((c) => c.run_id === "run_test_1");
    expect(convs.map((c) => c.agent_id).sort()).toEqual(["builder", "operator", "owner"]);
    expect(new Set(convs.map((c) => c.session_id)).size).toBe(3);
    expect(hits.memory.length).toBeGreaterThan(0);
    const entry = ledger.entries().find((e) => e.entry_hash === d.receipt_hash);
    expect(entry).toMatchObject({ kind: "decision", agent: "operator", trace_hash: d.trace_hash, action: "hold" });
    const msg = meko.convs.get(d.conversation_id)!.messages[0]!;
    expect(msg.metadata).toMatchObject({ reeve_receipt: d.receipt_hash, reeve_trace_hash: d.trace_hash, reeve_run: "run_test_1" });
    expect((msg.metadata as { reeve_lookups: unknown[] }).reeve_lookups).toHaveLength(1);
  });

  it("never sends the real name to Meko", async () => {
    const { meko } = await chain();
    const everything = JSON.stringify([...meko.convs.values()]) + JSON.stringify(meko.mems);
    expect(everything).not.toContain("Sri Wahyuni");
    expect(everything).toContain("Penghuni K03");
  });

  it("verifies an untouched decision and catches an edited one", async () => {
    const { meko, ws, d } = await chain();
    expect((await verifyDecision(ws, d.receipt_hash)).ok).toBe(true);
    meko.tamper(d.receipt_hash, { reasoning: "Tidak ada izin, langsung denda." });
    const after = await verifyDecision(ws, d.receipt_hash);
    expect(after.ok).toBe(false);
    expect(after.checks.trace_matches).toBe(false);
    expect(after.problem).toMatch(/diubah/);
  });

  it("proves a decision is inside an anchored Merkle root", async () => {
    const { ws, ledger, d } = await chain();
    const leaves = anchorLeaves(ledger.entries());
    ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "local-ledger" });
    const check = await verifyDecision(ws, d.receipt_hash);
    expect(check.checks.anchored).toMatchObject({ proof_ok: true });
    expect(check.ok).toBe(true);
  });

  it("calls track_token_usage only where Meko offers it", async () => {
    const local = await chain(new FakeMeko());
    expect(local.meko.usage).toHaveLength(0);
    const cloud = await chain(new FakeMeko(["track_token_usage"]));
    expect(cloud.meko.usage[0]).toMatchObject({ model: "fixture", total_tokens: 15, message_id: cloud.d.message_id });
  });

  it("masks NIK and phone numbers", () => {
    const p = new Pseudonymiser({ Budi: "Prospek P1" });
    expect(p.redact("Budi 081234567890 NIK 3578012345678901")).toBe("Prospek P1 [nomor HP] NIK [NIK]");
  });
});
