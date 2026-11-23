import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSop } from "@reeve/builder";
import { Rulebook } from "@reeve/core";
import { packSchema, sharedHintsBlock, type LLMProvider, type SopHints } from "@reeve/llm";
import { FakeMeko, MekoWorkspace, Pseudonymiser } from "@reeve/meko";
import { minimarketScenario, repoRoot, runAttempt } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { LocalSandbox } from "@reeve/sandbox";
import { describe, expect, it } from "vitest";
import { consentReceipt, consentShare, draftRunFromAttempt, extractPatterns, GOTONG_WORKSPACE, hooksFromMemory, leakCheck, publish, readForNewBusiness, revokeConsent, forbiddenTerms, type DraftRun } from "../src/index";

const draft = (over: Partial<DraftRun> = {}): DraftRun => ({ verdict: "pass", mutation: { total: 60, killed: 60 }, plantedByKind: { boundary: 30, logic: 20, safety: 10 }, survivorKinds: [], blockers: [], ...over });

async function world(names: string[]) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "gotong-")), "ledger.jsonl"));
  const open = (workspace: string, pseudonyms = new Pseudonymiser()) => MekoWorkspace.open(meko, { workspace, ledger, pseudonyms });
  const shared = await open(GOTONG_WORKSPACE);
  const biz = await Promise.all(names.map((n) => open(n, new Pseudonymiser({ "Bu Sari": "Pemilik P1", "Toko Sumber Rejeki": "Usaha U1" }))));
  return { meko, ledger, shared, biz };
}

describe("Gotong Royong", () => {
  it("only a business that consented contributes, and revoking takes it back out", async () => {
    const { biz } = await world(["gotong-a", "gotong-b", "gotong-c"]);
    const [a, b, c] = biz as [MekoWorkspace, MekoWorkspace, MekoWorkspace];
    const sources = () => [a, b, c].map((ws) => ({ ws, drafts: [draft(), draft({ survivorKinds: ["boundary"] })] }));

    expect(consentReceipt(a, "defect_kinds")).toBeNull();
    let ex = extractPatterns(sources());
    expect(ex.patterns).toEqual([]);
    expect(ex.dropped.find((d) => d.kind === "defect_kinds")?.reason).toMatch(/only 0 consenting/);

    const ca = await consentShare(a, "a", ["defect_kinds"]);
    await consentShare(b, "b", ["defect_kinds"]);
    expect(ca[0]!.receipt).toMatch(/^[0-9a-f]{64}$/);
    ex = extractPatterns(sources());
    const p = ex.patterns.find((x) => x.kind === "defect_kinds")!;
    expect(p.businesses).toBe(2); // c never agreed
    expect(p.counts.drafts).toBe(4);
    expect(ex.withheld).toContainEqual({ business: "gotong-c", kind: "defect_kinds" });
    expect(p.consents).toContain(ca[0]!.receipt);
    // Consent for one kind is not consent for another.
    expect(ex.patterns.some((x) => x.kind === "first_draft_findings")).toBe(false);

    await revokeConsent(b, "defect_kinds");
    expect(consentReceipt(b, "defect_kinds")).toBeNull();
    ex = extractPatterns(sources());
    expect(ex.patterns).toEqual([]); // one consenting business is below k = 2
  });

  it("drops what has no data source or fewer than two businesses, and says why", async () => {
    const { biz } = await world(["gotong-a", "gotong-b"]);
    for (const ws of biz) await consentShare(ws, ws.workspace, ["defect_kinds", "first_draft_findings", "content_hooks", "reminder_times"]);
    const ex = extractPatterns([
      { ws: biz[0]!, drafts: [draft()], hooks: hooksFromMemory([`Konten ct_1 hook "pertanyaan" ... menghasilkan 4 chat calon penghuni`]) },
      { ws: biz[1]!, drafts: [draft()] },
    ]);
    expect(hooksFromMemory(['Konten ct_9 hook "tur" kamar 5 menghasilkan 7 chat'])).toEqual([{ hook: "tur", chats: 7 }]);
    expect(ex.dropped.find((d) => d.kind === "content_hooks")?.reason).toMatch(/only 1 business has hook results/);
    expect(ex.dropped.find((d) => d.kind === "reminder_times")?.reason).toMatch(/no data source/);
    expect(ex.patterns.map((p) => p.kind)).toEqual(["defect_kinds"]); // no blocker anywhere: nothing to learn in findings
  });

  it("publishes only counts and kinds: no business name, alias or amount reaches the shared datapack", async () => {
    const { meko, ledger, shared, biz } = await world(["gotong-toko-sumber-rejeki", "gotong-bu-sari"]);
    for (const ws of biz) await consentShare(ws, ws.workspace, ["defect_kinds", "first_draft_findings"]);
    const blocker = { code: "RULEBOOK_INVALID", message: "R5: this approval limit can never apply: no rule names the amount it is about (amount_field)" };
    const sources = biz.map((ws, i) => ({ ws, drafts: [draft(i ? { verdict: "fail", blockers: [blocker, { code: "MUTANT_SURVIVED", message: "m1: Toko Sumber Rejeki Rp2.500.000 threshold" }], survivorKinds: ["boundary"] } : {})] }));
    const ex = extractPatterns(sources);
    expect(ex.patterns.length).toBeGreaterThanOrEqual(2);
    const forbidden = forbiddenTerms(sources, ["Toko Sumber Rejeki", "Bu Sari", "Rp2.500.000"]);
    const out = await publish(shared, ex.patterns, { forbidden });
    expect(out.every((o) => o.receipt)).toBe(true);

    // What the pool holds: its memories, its ledger entries and its conversations. (Each business's own consent
    // decisions live in its own workspace and name it; they are not part of the pool.)
    const stored = JSON.stringify([
      ...meko.mems.filter((m) => m.datapack_id === shared.datapackId),
      ...ledger.entries().filter((e) => (e as { workspace?: string }).workspace === GOTONG_WORKSPACE),
      ...[...meko.convs.values()].filter((c) => c.datapack_id === shared.datapackId).flatMap((c) => c.messages),
    ]);
    expect(stored).toContain("[gotong]");
    for (const term of ["Toko Sumber Rejeki", "Sumber Rejeki", "Bu Sari", "Pemilik P1", "Usaha U1", "gotong-toko", "gotong-bu-sari", "2.500.000", "Rp2"]) expect(stored).not.toContain(term);
    // Promoted memory in the shared datapack, with a decision receipt per pattern.
    expect(meko.mems.filter((m) => m.promoted).length).toBe(ex.patterns.length);
    expect(shared.decisions({ action_class: "gotong" }).filter((d) => d.action === "publish_pattern").length).toBe(ex.patterns.length);
    // Publishing again adds nothing.
    expect((await publish(shared, ex.patterns, { forbidden })).every((o) => o.skipped === "already_published")).toBe(true);

    // The check itself refuses a leaking pattern and one resting on a single business.
    expect(leakCheck("Toko Sumber Rejeki sent Rp 2500000", ["toko sumber rejeki"])).toEqual(["toko sumber rejeki", "(an amount)"]);
    await expect(publish(shared, [{ ...ex.patterns[0]!, text: "[gotong] Toko Sumber Rejeki leaked" }], { forbidden })).rejects.toThrow(/would leak/);
    await expect(publish(shared, [{ ...ex.patterns[0]!, businesses: 1 }], { forbidden })).rejects.toThrow(/floor is 2/);
  });

  it("a new business reads the published hints before drafting", async () => {
    const { shared, biz } = await world(["gotong-a", "gotong-b"]);
    for (const ws of biz) await consentShare(ws, ws.workspace, ["first_draft_findings"]);
    const blocker = { code: "RULEBOOK_INVALID", message: "R5: this approval limit can never apply: no rule names the amount it is about (amount_field)" };
    const ex = extractPatterns(biz.map((ws) => ({ ws, drafts: [draft({ verdict: "fail", blockers: [blocker] })] })));
    await publish(shared, ex.patterns);
    const read = await readForNewBusiness(shared, "Untuk tagihan di atas batas, saya harus setuju dulu sebelum pesan dikirim.");
    expect(read.hints.length).toBe(1);
    expect(read.hints[0]).toMatch(/amount_field/);
    expect(shared.decisions({ agent: "builder" }).some((d) => d.action === "read_shared_hints")).toBe(true);
    const empty = await world(["gotong-x"]);
    expect((await readForNewBusiness(empty.shared, "apa saja")).hints).toEqual([]);
  });

  it("hints change what the Builder sends, and change nothing when absent", async () => {
    const rb = Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, "apps/cli/fixtures/laundry-kiloan/rulebook.json"), "utf8")));
    const seen: (SopHints | undefined)[] = [];
    const provider: LLMProvider = { name: "recorder", parseSop: async (_s, _p, hints) => (seen.push(hints), rb) };
    const fields = [{ name: "bill", type: "number" }];
    await parseSop(provider, "sop", "generic", { fields });
    await parseSop(provider, "sop", "generic", { fields }, { sharedHints: ["approval limits need amount_field"] });
    await parseSop(provider, "sop", "generic", { fields }, { sharedHints: [] });
    expect(seen[0]).toEqual({ fields });
    expect(seen[1]?.sharedHints).toEqual(["approval limits need amount_field"]);
    expect(seen[2]).toEqual({ fields });

    // What a real provider turns hints into: the system prompt.
    const plain = packSchema("generic", { fields }).system;
    const hinted = packSchema("generic", { fields, sharedHints: ["approval limits need amount_field"] }).system;
    expect(hinted).not.toBe(plain);
    expect(hinted.startsWith(plain)).toBe(true);
    expect(hinted).toContain("- approval limits need amount_field");
    expect(packSchema("generic", { fields, sharedHints: [] }).system).toBe(plain);
    expect(sharedHintsBlock({})).toBe("");
    for (const pack of ["rent-collection", "minimarket"] as const) expect(packSchema(pack, { sharedHints: ["x"] }).system).toContain("- x");
  });

  it("derives a draft profile from a real pipeline run, offline", async () => {
    const rb = Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, "fixtures/minimarket/rulebook.json"), "utf8")));
    const a = await runAttempt({ repoRoot, rulebook: rb, scenario: minimarketScenario(), sandbox: new LocalSandbox(), runId: "gotong-test" });
    const d = draftRunFromAttempt(a);
    expect(d.verdict).toBe(a.verdict.status);
    expect(d.mutation.total).toBe(a.results!.mutation.total);
    expect(Object.values(d.plantedByKind).reduce((x, y) => x + y, 0)).toBe(a.plan.mutants.length);
    expect(d.survivorKinds.length).toBe(a.results!.mutation.survivors.length);
  });
});
