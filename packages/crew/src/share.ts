// Rapor Usaha share links: the owner shares the business metrics (no decisions, no tenant text)
// with a bank, an investor or a judge, and can revoke the link. A link is a random token; only its
// hash is recorded, as an owner decision on Meko and in the ledger, so whether a link is live is
// read from the ledger itself (`share_rapor`, then maybe `revoke_share`, on the same subject).
// The shared page gets the ledger entries too, so a browser can recompute every hash and Merkle
// root without trusting Reeve's server.
import { createHash, randomBytes } from "node:crypto";
import type { MekoWorkspace } from "@reeve/meko";
import type { AnchorBody, LedgerEntry } from "@reeve/receipts";
import { buildRapor, type Rapor } from "./rapor";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const shareSubject = (token: string) => `share:${sha(token).slice(0, 24)}`;

export interface ShareInfo {
  subject: string;
  created_at: string;
  label?: string;
  from?: string;
  to?: string;
  active: boolean;
  receipt: string;
  revoked_receipt?: string;
}

export interface SharedRapor {
  share: { created_at: string; label?: string; receipt: string };
  rapor: Omit<Rapor, "decisions">;
  /** Per decision, without its text: did the trace in Meko still match (checked by the server)? */
  traces: { receipt: string; verified: boolean }[];
  /** The whole ledger, so the browser recomputes the hash chain and every anchor's Merkle root. */
  ledger: LedgerEntry[];
  anchor_format: { calldata: string; magic: string; note: string };
}

async function shareMeta(ws: MekoWorkspace, subject: string): Promise<{ label?: string; from?: string; to?: string }> {
  const d = ws.decisions({ subject }).find((x) => x.action === "share_rapor");
  if (!d) return {};
  const m = (await ws.conversation(d.agent, d.conversation_id)).messages.find((x) => x.metadata?.reeve_receipt === d.entry_hash);
  try {
    const out = JSON.parse(m?.output ?? "{}") as { label?: string; from?: string; to?: string };
    return { label: out.label, from: out.from, to: out.to };
  } catch {
    return {};
  }
}

export function listShares(ws: MekoWorkspace): ShareInfo[] {
  const by = new Map<string, ShareInfo>();
  for (const d of ws.decisions({ agent: "owner" })) {
    if (!d.subject?.startsWith("share:")) continue;
    if (d.action === "share_rapor") by.set(d.subject, { subject: d.subject, created_at: d.at, active: true, receipt: d.entry_hash });
    else if (d.action === "revoke_share" && by.has(d.subject)) Object.assign(by.get(d.subject)!, { active: false, revoked_receipt: d.entry_hash });
  }
  return [...by.values()].reverse();
}

export async function shareRapor(ws: MekoWorkspace, opts: { label?: string; from?: string; to?: string; by?: string } = {}): Promise<{ token: string; subject: string; receipt: string }> {
  const token = randomBytes(18).toString("base64url");
  const subject = shareSubject(token);
  const owner = await ws.run(`run_share_${Date.now().toString(36)}`).agent("owner", "Bagikan Rapor Usaha");
  const d = await owner.decide({
    input: `share Rapor Usaha${opts.label ? ` with ${opts.label}` : ""}`,
    output: { token_hash: sha(token), label: opts.label, from: opts.from, to: opts.to, metrics_only: true },
    reasoning: `The owner (${opts.by ?? "signed in"}) made a revocable link that shows metrics only: totals, no decision text and no tenant names. Only the token's hash is recorded.`,
    action: "share_rapor",
    action_class: "share",
    subject,
  });
  return { token, subject, receipt: d.receipt_hash };
}

export async function revokeShare(ws: MekoWorkspace, subject: string, by?: string): Promise<string> {
  const s = listShares(ws).find((x) => x.subject === subject);
  if (!s) throw new Error("Tautan ini tidak ada.");
  if (!s.active) return s.revoked_receipt!;
  const owner = await ws.run(`run_share_${Date.now().toString(36)}`).agent("owner", "Cabut tautan Rapor");
  const d = await owner.decide({
    input: `revoke ${subject}`,
    output: { revoked: subject, shared_by: s.receipt },
    reasoning: `The owner (${by ?? "signed in"}) revoked the link; from this ledger entry on, the link shows nothing.`,
    action: "revoke_share",
    action_class: "share",
    subject,
  });
  return d.receipt_hash;
}

/** The shared view for a token, or null when the link never existed or was revoked. */
export async function sharedRapor(ws: MekoWorkspace, token: string, encodeAnchor?: (root: string, leaves: number) => string): Promise<SharedRapor | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const subject = shareSubject(token);
  const s = listShares(ws).find((x) => x.subject === subject);
  if (!s?.active) return null;
  const meta = await shareMeta(ws, subject);
  const { decisions, ...rapor } = await buildRapor(ws, { from: meta.from, to: meta.to });
  const last = ws.ledger.entries().filter((e): e is LedgerEntry & AnchorBody => e.kind === "anchor").at(-1);
  return {
    share: { created_at: s.created_at, label: meta.label, receipt: s.receipt },
    rapor,
    traces: decisions.map((d) => ({ receipt: d.receipt, verified: d.verified })),
    ledger: ws.ledger.entries(),
    anchor_format: {
      magic: "REEVE1",
      calldata: last && encodeAnchor ? encodeAnchor(last.merkle_root, last.leaves) : "",
      note: "Each anchor transaction carries calldata 0x5245455645 31 + Merkle root (32 bytes) + leaf count (uint32). The leaves are the run receipts and the decision entry hashes before the anchor, in ledger order; each leaf is hashed with SHA-256 first, pairs are SHA-256(left || right), and an odd node is paired with itself.",
    },
  };
}
