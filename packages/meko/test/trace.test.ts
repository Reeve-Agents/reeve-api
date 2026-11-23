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

  it("bootstraps the datapack on Meko Cloud, where a conversation needs a datapack id", async () => {
    const meko = new FakeMeko(["datapack_search", "track_token_usage"]);
    meko.requireDatapack = true;
    const a = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    const b = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    expect(a.datapackId).toBe(b.datapackId);
    expect([...meko.packs.values()]).toEqual(["reeve-kos-melati"]);
    expect(meko.calls).not.toContain("datapack_list");
    const op = await a.run("run_cloud_1").agent("operator", "Tick");
    const d = await op.decide({ input: "kamar 3", output: { action: "hold" }, reasoning: "izin pemilik", action: "hold", usage: { name: "operator_reasoning", model: "fixture", input_tokens: 4, output_tokens: 2 } });
    expect(meko.usage[0]).toMatchObject({ total_tokens: 6, message_id: d.message_id });
  });

  it("pages through a Cloud conversation with more than 100 messages", async () => {
    const meko = new FakeMeko(["datapack_search", "track_token_usage"]);
    meko.requireDatapack = true;
    const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    const op = await ws.run("run_big").agent("operator", "Tick");
    const receipts: string[] = [];
    for (let i = 0; i < 130; i++) receipts.push((await op.decide({ input: `kamar ${i}`, output: { n: i }, reasoning: "r", action: "remind" })).receipt_hash);
    const conv = await ws.conversation("operator", op.conversationId);
    expect(conv.messages).toHaveLength(130);
    expect((await verifyDecision(ws, receipts[129]!)).ok).toBe(true);
  });

  it("uses MEKO_DATAPACK_ID on Cloud and explains a refused datapack_create", async () => {
    const meko = new FakeMeko(["datapack_search", "track_token_usage"]);
    meko.requireDatapack = true;
    const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt(), env: { MEKO_DATAPACK_ID: "11111111-2222-3333-4444-555555555555" } });
    expect(ws.datapackId).toBe("11111111-2222-3333-4444-555555555555");
    expect(meko.packs.size).toBe(0);
    const refusing = new FakeMeko(["datapack_search", "track_token_usage"]);
    const orig = refusing.call.bind(refusing);
    refusing.call = async (tool, args) => (tool === "datapack_create" ? { error: "INTERNAL_ERROR", detail: "Could not create the datapack." } : orig(tool, args));
    await expect(MekoWorkspace.open(refusing, { workspace: "kos-melati", ledger: ledgerAt(), env: {} })).rejects.toThrow(/MEKO_DATAPACK_ID/);
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
