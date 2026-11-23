import { anchorLeaves, canonicalJson, merkleRoot, sha256 } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { listShares, rentTick, revokeShare, shareRapor, sharedRapor } from "../src/index";
import { testDeps } from "./helpers";

describe("Rapor share links", () => {
  it("shares metrics only, lets anyone recompute the hashes, and stops once revoked", async () => {
    const { ws, ledger } = await testDeps();
    await rentTick(ws.run("run_t"), [{ id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 4 }], "2026-12-08", { execute: async () => ({ ok: true, via: "log" }) });
    const leaves = anchorLeaves(ledger.entries());
    ledger.append({ kind: "anchor", at: "2026-12-08T10:00:00Z", merkle_root: merkleRoot(leaves), leaves: leaves.length, anchor: "local-ledger" });

    const s = await shareRapor(ws, { label: "Bank BPR" });
    expect(s.token.length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(ledger.entries())).not.toContain(s.token);
    const view = (await sharedRapor(ws, s.token, (r, n) => `0x524545564531${r}${n.toString(16).padStart(8, "0")}`))!;
    expect(view.share.label).toBe("Bank BPR");
    expect(view.rapor.usaha.fees).toEqual({ count: 1, amount_idr: 75_000 });
    expect(view).not.toHaveProperty("rapor.decisions");
    expect(JSON.stringify(view.rapor)).not.toContain("K05");
    expect(view.traces.every((t) => t.verified)).toBe(true);
    expect(view.anchor_format.calldata).toMatch(/^0x524545564531[0-9a-f]{64}0000000/);

    // What the browser does: recompute every entry hash, the chain, and the anchor's root.
    let prev = "genesis";
    for (const e of view.ledger) {
      const { entry_hash, ...rest } = e;
      expect(e.prev).toBe(prev);
      expect(sha256(canonicalJson(rest))).toBe(entry_hash);
      prev = entry_hash;
    }
    const anchor = view.ledger.find((e) => e.kind === "anchor")!;
    expect(merkleRoot(anchorLeaves(view.ledger.filter((e) => e.seq < anchor.seq)))).toBe((anchor as { merkle_root: string }).merkle_root);

    expect(listShares(ws)).toMatchObject([{ active: true }]);
    await revokeShare(ws, s.subject);
    expect(listShares(ws)).toMatchObject([{ active: false }]);
    expect(await sharedRapor(ws, s.token)).toBeNull();
    expect(await sharedRapor(ws, "not-a-real-token-at-all")).toBeNull();
  });
});
