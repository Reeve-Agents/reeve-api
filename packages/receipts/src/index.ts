import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt, Verdict } from "@reeve/core";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON (sorted keys) so the same object always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashFiles(files: Record<string, string>): { root: string; files: Record<string, string> } {
  const hashed: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) hashed[path] = sha256(files[path]!);
  return { root: sha256(canonicalJson(hashed)), files: hashed };
}

export function buildReceipt(input: {
  runId: string;
  rulebook: unknown;
  code: Record<string, string>;
  data: unknown;
  results: unknown;
  verdict: Verdict["status"];
  now?: Date;
}): Receipt {
  const code = hashFiles(input.code);
  const body = {
    run_id: input.runId,
    created_at: (input.now ?? new Date()).toISOString(),
    rulebook_hash: sha256(canonicalJson(input.rulebook)),
    code_hash: code.root,
    data_hash: sha256(canonicalJson(input.data)),
    result_hash: sha256(canonicalJson(input.results)),
    verdict: input.verdict,
    files: code.files,
  };
  return { ...body, receipt_hash: sha256(canonicalJson(body)) };
}

/** Merkle root over leaf hashes (hex). Odd levels duplicate the last node. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256("");
  let level = leaves.map((l) => sha256(Buffer.from(l, "hex")));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(sha256(Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")])));
    }
    level = next;
  }
  return level[0]!;
}

/** Inclusion proof: sibling hashes from leaf to root, with their side. */
export function merkleProof(leaves: string[], index: number): { sibling: string; side: "left" | "right" }[] {
  let level = leaves.map((l) => sha256(Buffer.from(l, "hex")));
  const proof: { sibling: string; side: "left" | "right" }[] = [];
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : i + 1;
    proof.push({ sibling: level[siblingIndex] ?? level[i]!, side: isRight ? "left" : "right" });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j]!;
      const right = level[j + 1] ?? left;
      next.push(sha256(Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")])));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf: string, proof: { sibling: string; side: "left" | "right" }[], root: string): boolean {
  let node = sha256(Buffer.from(leaf, "hex"));
  for (const step of proof) {
    const pair = step.side === "left" ? [step.sibling, node] : [node, step.sibling];
    node = sha256(Buffer.concat(pair.map((h) => Buffer.from(h, "hex"))));
  }
  return node === root;
}

export type LedgerEntry =
  | { kind: "receipt"; seq: number; at: string; receipt_hash: string; run_id: string; verdict: string; prev: string; entry_hash: string }
  | ({ kind: "anchor"; seq: number; prev: string; entry_hash: string } & AnchorBody)
  | { kind: "approval"; seq: number; at: string; rulebook_id: string; receipt_hash: string; credential_id: string; prev: string; entry_hash: string }
  | ({ kind: "operation"; seq: number; prev: string; entry_hash: string } & OperationBody);

/**
 * A Merkle root over the receipts so far. `anchor` is where it was published: "local-ledger" (this
 * file only) or a chain name; chain anchors also carry the transaction anyone can look up.
 */
export interface AnchorBody {
  at: string;
  merkle_root: string;
  leaves: number;
  anchor: string;
  chain_id?: number;
  tx?: string;
  from?: string;
  explorer?: string;
}

/** What the Operator did on a payment rail (or refused to do), so the track record covers live runs too. */
export interface OperationBody {
  at: string;
  operation_id: string;
  rail: string;
  event: "invoice_created" | "payment_received" | "message_logged" | "exception_raised" | "refund_issued" | "credit_kept" | "blocked" | "rules_upgraded";
  tenant?: string;
  amount?: number;
  ref?: string;
  receipt_hash: string;
}

export type LedgerBody =
  | { kind: "receipt"; at: string; receipt_hash: string; run_id: string; verdict: string }
  | ({ kind: "anchor" } & AnchorBody)
  | { kind: "approval"; at: string; rulebook_id: string; receipt_hash: string; credential_id: string }
  | ({ kind: "operation" } & OperationBody);

/**
 * Append-only, hash-chained local ledger (the track record).
 * Each entry commits to the previous entry's hash, so history cannot be rewritten silently.
 * An on-chain anchor (contracts/) will publish the Merkle roots recorded here.
 */
export class Ledger {
  constructor(private readonly path: string) {}

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  append(body: LedgerBody): LedgerEntry {
    const all = this.entries();
    const last = all[all.length - 1];
    const prev = last ? last.entry_hash : "genesis";
    const seq = last ? last.seq + 1 : 0;
    const withLink = { ...body, seq, prev };
    const entry = { ...withLink, entry_hash: sha256(canonicalJson(withLink)) } as LedgerEntry;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Recompute the chain; returns the first broken seq or null if intact. */
  verify(): number | null {
    let prev = "genesis";
    for (const e of this.entries()) {
      const { entry_hash, ...rest } = e;
      if (e.prev !== prev || sha256(canonicalJson(rest)) !== entry_hash) return e.seq;
      prev = entry_hash;
    }
    return null;
  }
}
