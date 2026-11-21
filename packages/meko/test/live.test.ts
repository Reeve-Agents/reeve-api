// Runs against a real Meko (local `meko start`, or Cloud with MEKO_API_KEY). Off unless MEKO_LIVE=1.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { connectMeko, MekoWorkspace, verifyDecision } from "../src/index";

describe.skipIf(process.env.MEKO_LIVE !== "1")("live Meko", () => {
  it("records a traced decision and verifies it from what Meko stores", async () => {
    const meko = await connectMeko();
    try {
      const ws = await MekoWorkspace.open(meko, { workspace: "test-live", ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "meko-live-")), "l.jsonl")) });
      const op = await ws.run().agent("operator", "Live check");
      await op.remember("Kamar 9 boleh telat 5 hari.", { kind: "owner_exception" }, { promote: true });
      await op.search("kamar 9 telat");
      const d = await op.decide({ input: "kamar 9, telat 4 hari", output: { action: "hold" }, reasoning: "Izin pemilik 5 hari.", action: "hold" });
      const check = await verifyDecision(ws, d.receipt_hash);
      expect(check.ok).toBe(true);
    } finally {
      await meko.close();
    }
  });
});
