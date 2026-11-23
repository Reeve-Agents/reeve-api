import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@reeve/receipts";
import { FakeMeko, MekoWorkspace } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { BASELINE_INPUT_PER_EVENT, buildRapor, raporHtml, tokenSavings, verifyWeak, weakSearches, type RaporEntry } from "../src/index";

const ledgerAt = () => new Ledger(join(mkdtempSync(join(tmpdir(), "weak-")), "ledger.jsonl"));
const entry = (receipt: string, extra: Partial<RaporEntry> = {}): RaporEntry => ({ seq: 1, at: "2026-12-01T00:00:00Z", run_id: "r", agent: "operator", receipt, input: "x".repeat(400), reasoning: "", looked_up: 1, tokens_saved: 0, verified: true, ...extra });

describe("token savings from Reeve's own records", () => {
  it("compares billed or estimated input with the benchmark baseline per event", () => {
    const s = tokenSavings([entry("a", { usage: { model: "m", input_tokens: 100, output_tokens: 5 } }), entry("b"), entry("c", { agent: "owner" })], new Map([["b", 400]]));
    expect(s.events).toBe(2);
    expect(s.baseline_input).toBe(2 * BASELINE_INPUT_PER_EVENT);
    expect(s.reeve_input_basis).toEqual({ billed: 100, estimated: 200 });
    expect(s.saved).toBe(2 * BASELINE_INPUT_PER_EVENT - 300);
    expect(s.ratio).toBe(Math.round(((2 * BASELINE_INPUT_PER_EVENT) / 300) * 10) / 10);
  });
});

describe("weak searches (Meko Cloud selflearning_*)", () => {
  it("is empty and says so on local Meko, and the Rapor still renders", async () => {
    const ws = await MekoWorkspace.open(new FakeMeko(), { workspace: "kos-melati", ledger: ledgerAt() });
    expect((await weakSearches(ws)).source).toBe("none");
    const html = raporHtml(await buildRapor(ws));
    expect(html).toContain("Pencarian lemah");
    expect(html).toContain("Hemat token input vs konteks penuh");
  });

  it("reads status and shortfalls on Cloud, and verify returns the replayed band", async () => {
    const meko = new FakeMeko(["datapack_search", "track_token_usage", "selflearning_status", "selflearning_shortfalls", "selflearning_verify"]);
    meko.requireDatapack = true;
    const orig = meko.call.bind(meko);
    meko.call = async (tool, args) => {
      if (tool === "selflearning_status") return { quality: { pct: 6, searches: 389 } };
      if (tool === "selflearning_shortfalls") return (args as { todo_id: string }).todo_id === "add_context" ? { searches: [{ log_id: "L1", query: "kamar 3 izin", count: 23, band: "low", reason: "source_not_searched", state: "open", latest_run: { band: "low" } }] } : { searches: [] };
      if (tool === "selflearning_verify") return { outcome: "no_change", before: { band: "low" }, after: { band: "low" }, hint: "tambah memori" };
      return orig(tool, args);
    };
    const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger: ledgerAt() });
    const w = await weakSearches(ws);
    expect(w).toMatchObject({ source: "meko-cloud", quality_pct: 6, searches: 389 });
    expect(w.items[0]).toMatchObject({ log_id: "L1", count: 23, reason: "source_not_searched", replay_band: "low" });
    expect(await verifyWeak(ws, "L1")).toMatchObject({ outcome: "no_change", after: "low" });
    expect(raporHtml(await buildRapor(ws))).toContain("source_not_searched");
  });
});
