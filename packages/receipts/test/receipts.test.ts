import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReceipt, canonicalJson, Ledger, merkleProof, merkleRoot, sha256, verifyProof } from "../src/index";

describe("canonicalJson", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("merkle", () => {
  const leaves = ["a", "b", "c", "d", "e"].map((x) => sha256(x));

  it("produces a proof that verifies for every leaf", () => {
    const root = merkleRoot(leaves);
    leaves.forEach((leaf, i) => expect(verifyProof(leaf, merkleProof(leaves, i), root)).toBe(true));
  });

  it("rejects a tampered leaf", () => {
    const root = merkleRoot(leaves);
    expect(verifyProof(sha256("x"), merkleProof(leaves, 0), root)).toBe(false);
  });
});

describe("receipt", () => {
  it("changes when the code changes", () => {
    const base = { runId: "r1", rulebook: { a: 1 }, data: {}, results: {}, verdict: "pass" as const, now: new Date(0) };
    const r1 = buildReceipt({ ...base, code: { "rules.py": "X = 1" } });
    const r2 = buildReceipt({ ...base, code: { "rules.py": "X = 2" } });
    expect(r1.code_hash).not.toBe(r2.code_hash);
    expect(r1.receipt_hash).not.toBe(r2.receipt_hash);
  });
});

describe("ledger", () => {
  it("detects a rewritten entry", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reeve-ledger-")), "ledger.jsonl");
    const ledger = new Ledger(path);
    ledger.append({ kind: "receipt", at: "t0", receipt_hash: "aa", run_id: "r1", verdict: "pass" });
    ledger.append({ kind: "receipt", at: "t1", receipt_hash: "bb", run_id: "r2", verdict: "fail" });
    expect(ledger.verify()).toBeNull();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!);
    first.verdict = "pass-but-edited";
    lines[0] = JSON.stringify(first);
    writeFileSync(path, lines.join("\n") + "\n");
    expect(ledger.verify()).toBe(0);
  });
});
