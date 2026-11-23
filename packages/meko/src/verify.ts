// "Verify this decision": recompute the trace hash from what Meko stores now, compare it with the
// ledger, check the hash chain, and check the Merkle proof against the latest anchor that covers it.
import { anchorLeaves, type AnchorBody, type DecisionBody, type LedgerEntry, merkleProof, merkleRoot, verifyProof } from "@reeve/receipts";
import { type MekoMessage, type MekoWorkspace, type TraceBody, traceHash } from "./trace";

export interface DecisionCheck {
  receipt_hash: string;
  ok: boolean;
  /** Plain-language reason when something does not match. */
  problem?: string;
  checks: {
    in_ledger: boolean;
    ledger_intact: boolean;
    message_found: boolean;
    trace_matches: boolean;
    anchored: { seq: number; merkle_root: string; tx?: string; explorer?: string; proof_ok: boolean } | null;
  };
  decision?: LedgerEntry & DecisionBody;
  message?: MekoMessage;
}

export function traceBodyOf(entry: DecisionBody, m: MekoMessage): TraceBody {
  return {
    agent: entry.agent,
    run_id: entry.run_id,
    input: m.input,
    output: m.output,
    reasoning: m.reasoning ?? "",
    plan: m.plan ?? [],
    lookups: (m.metadata?.reeve_lookups as TraceBody["lookups"] | undefined) ?? [],
  };
}

/**
 * The first anchor after the decision covers it (its leaves include every earlier receipt and decision).
 * `onchain: true` looks only at anchors published on a chain (they carry a tx or explorer link), not at a local Merkle root.
 */
export function anchorProof(entries: LedgerEntry[], decision: LedgerEntry, opts: { onchain?: boolean } = {}): DecisionCheck["checks"]["anchored"] {
  const anchor = entries.find((e): e is LedgerEntry & AnchorBody => e.kind === "anchor" && e.seq > decision.seq && (!opts.onchain || !!(e.tx || e.explorer)));
  if (!anchor) return null;
  const leaves = anchorLeaves(entries.filter((e) => e.seq < anchor.seq)).slice(0, anchor.leaves);
  const index = leaves.indexOf(decision.entry_hash);
  const proof_ok = index >= 0 && merkleRoot(leaves) === anchor.merkle_root && verifyProof(decision.entry_hash, merkleProof(leaves, index), anchor.merkle_root);
  return { seq: anchor.seq, merkle_root: anchor.merkle_root, tx: anchor.tx, explorer: anchor.explorer, proof_ok };
}

export async function verifyDecision(ws: MekoWorkspace, receiptHash: string): Promise<DecisionCheck> {
  const entries = ws.ledger.entries();
  const decision = entries.find((e): e is LedgerEntry & DecisionBody => e.kind === "decision" && e.entry_hash === receiptHash);
  const ledger_intact = ws.ledger.verify() === null;
  const base = { receipt_hash: receiptHash, checks: { in_ledger: !!decision, ledger_intact, message_found: false, trace_matches: false, anchored: null } };
  if (!decision) return { ...base, ok: false, problem: "Receipt ini tidak ada di ledger." };
  const conv = await ws.conversation(decision.agent, decision.conversation_id);
  const message = conv.messages.find((m) => m.metadata?.reeve_receipt === receiptHash);
  const anchored = anchorProof(entries, decision);
  if (!message) return { ...base, decision, ok: false, problem: "Pesan jejak keputusan tidak ditemukan di Meko.", checks: { ...base.checks, anchored } };
  const trace_matches = traceHash(traceBodyOf(decision, message)) === decision.trace_hash;
  const ok = ledger_intact && trace_matches && (anchored ? anchored.proof_ok : true);
  const problem = !ledger_intact
    ? "Rantai hash ledger rusak: ada baris yang diubah."
    : !trace_matches
      ? "Isi jejak di Meko tidak cocok dengan hash di receipt: jejaknya diubah setelah dicatat."
      : anchored && !anchored.proof_ok
        ? "Bukti Merkle tidak cocok dengan anchor."
        : undefined;
  return { receipt_hash: receiptHash, ok, problem, decision, message, checks: { in_ledger: true, ledger_intact, message_found: true, trace_matches, anchored } };
}
