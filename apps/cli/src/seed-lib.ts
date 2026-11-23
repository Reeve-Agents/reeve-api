// Choices the Meko demo seed makes from the environment, kept apart from crew-demo.ts (which runs
// at import) so they can be tested without Meko, a sandbox or a chain.
//   - which sandbox the Auditor's planted defects run in (the same factory the API uses: REEVE_SANDBOX)
//   - which anchor the ledger's Merkle root gets: a real testnet transaction when the anchor wallet is
//     configured, otherwise a local Merkle root that says so, or none with --no-anchor.
//   - whether viewings can be booked on the owner's Google Calendar (Composio), else they stay on the Log.
import { anchorFromEnv, CHAINS, type AnchorResult } from "@reeve/anchor";
import { connectorsFromEnv } from "@reeve/connectors";
import type { CalendarRegistry } from "@reeve/crew";
import { anchorLeaves, merkleRoot, type LedgerBody, type LedgerEntry } from "@reeve/receipts";
import { sandboxFromEnv, type Sandbox } from "@reeve/sandbox";

export type SandboxKind = "createos" | "local";

/**
 * The connector registry the seed books viewings with. Without a Composio key, or with --no-calendar,
 * there is none and every viewing stays on the Log connector. With one, the registry is only asked about
 * Google Calendar when a viewing is booked: the seed's one real side effect, an event on the owner's own
 * calendar (no attendees, no invitation), and only if Google Calendar is connected in Composio.
 */
export function seedCalendar(env: NodeJS.ProcessEnv = process.env, opts: { skip?: boolean; make?: (env: NodeJS.ProcessEnv) => CalendarRegistry } = {}): { registry: CalendarRegistry | null; note: string } {
  if (opts.skip) return { registry: null, note: "calendar: Log only (--no-calendar); viewings are recorded, not booked" };
  if (!(env.COMPOSIO_API_KEY ?? env.COMPOSIO_CONSUMER_API_KEY)?.trim()) return { registry: null, note: "calendar: Log only (no COMPOSIO_API_KEY); viewings are recorded, not booked" };
  return { registry: (opts.make ?? connectorsFromEnv)(env), note: "calendar: viewings are booked on Google Calendar via Composio if it is connected, else recorded on the Log (--no-calendar keeps the Log)" };
}

/** The Auditor's sandbox: REEVE_SANDBOX=createos runs the mutants in a CreateOS microVM; `flag` (--sandbox=) overrides it. */
export function seedSandbox(env: NodeJS.ProcessEnv = process.env, flag?: string): { sandbox: Sandbox; kind: SandboxKind } {
  if (flag !== undefined && flag !== "local" && flag !== "createos") throw new Error(`--sandbox=${flag} is not a sandbox (local or createos)`);
  const sandbox = sandboxFromEnv(flag ? { ...env, REEVE_SANDBOX: flag } : env);
  return { sandbox, kind: sandbox.name === "createos" ? "createos" : "local" };
}

/** What an anchor wallet must offer; ChainAnchor from @reeve/anchor does, and tests pass a fake. */
export interface AnchorSubmitter {
  readonly chainName: string;
  balance?(): Promise<bigint>;
  anchor(root: string, leaves: number): Promise<AnchorResult>;
  verify?(tx: `0x${string}`, root: string): Promise<{ ok: boolean; reason?: string }>;
}

export type AnchorChoice = { mode: "onchain"; submitter: AnchorSubmitter } | { mode: "local"; why: string } | { mode: "skip" };

/**
 * No wallet key: a local Merkle root, labelled as such. A wallet key: a real testnet anchor. A chain
 * that is not a known testnet is refused (throws), never quietly replaced by a local root.
 */
export function chooseAnchor(env: NodeJS.ProcessEnv = process.env, opts: { skip?: boolean; make?: (env: NodeJS.ProcessEnv) => AnchorSubmitter | null } = {}): AnchorChoice {
  if (opts.skip) return { mode: "skip" };
  if (!env.REEVE_ANCHOR_PRIVATE_KEY?.trim()) return { mode: "local", why: "REEVE_ANCHOR_PRIVATE_KEY is not set" };
  const chain = env.REEVE_ANCHOR_CHAIN?.trim() || "monad-testnet";
  const known = CHAINS[chain];
  if (!known) throw new Error(`REEVE_ANCHOR_CHAIN=${chain} is not an anchor chain this repo knows (${Object.keys(CHAINS).join(", ")})`);
  if (!known.testnet) throw new Error(`REEVE_ANCHOR_CHAIN=${chain} is not a testnet: the seed anchors on testnets only`);
  const submitter = (opts.make ?? anchorFromEnv)(env);
  return submitter ? { mode: "onchain", submitter } : { mode: "local", why: "no anchor wallet could be built from the environment" };
}

/** Fail before the long seed runs, not after it: the wallet must have testnet funds. */
export async function preflightAnchor(choice: AnchorChoice): Promise<string> {
  if (choice.mode === "skip") return "anchor: skipped (--no-anchor)";
  if (choice.mode === "local") return `anchor: local Merkle root only (${choice.why}); nothing is published on a chain`;
  const bal = await choice.submitter.balance?.();
  if (bal === 0n) throw new Error(`the anchor wallet has no ${choice.submitter.chainName} funds: use the testnet faucet first, or run with --no-anchor`);
  return `anchor: testnet ${choice.submitter.chainName}, the ledger's Merkle root is published on-chain at the end`;
}

interface LedgerLike {
  entries(): LedgerEntry[];
  append(body: LedgerBody): LedgerEntry;
}

export interface SeedAnchor {
  mode: AnchorChoice["mode"];
  entry?: LedgerEntry;
  note: string;
}

/** Anchors the Merkle root of THIS ledger and records it. On-chain mode submits one transaction and reads it back before recording. */
export async function writeSeedAnchor(ledger: LedgerLike, choice: AnchorChoice, now: () => Date = () => new Date()): Promise<SeedAnchor> {
  if (choice.mode === "skip") return { mode: "skip", note: "no anchor written (--no-anchor)" };
  const leaves = anchorLeaves(ledger.entries());
  const root = merkleRoot(leaves);
  if (choice.mode === "local") {
    const entry = ledger.append({ kind: "anchor", at: now().toISOString(), merkle_root: root, leaves: leaves.length, anchor: "local-ledger" });
    return { mode: "local", entry, note: `LOCAL Merkle root only (${choice.why}), ${leaves.length} receipts, root ${root.slice(0, 16)}…; no transaction, so nothing is proven to a third party` };
  }
  const r = await choice.submitter.anchor(root, leaves.length);
  const check = await choice.submitter.verify?.(r.tx, root);
  if (check && !check.ok) throw new Error(`anchor transaction ${r.tx} does not carry this root: ${check.reason ?? "unknown"}`);
  const entry = ledger.append({ kind: "anchor", at: now().toISOString(), merkle_root: root, leaves: leaves.length, anchor: r.chain, chain_id: r.chainId, tx: r.tx, from: r.from, explorer: r.explorer });
  return { mode: "onchain", entry, note: `on-chain on ${r.chain}, ${leaves.length} receipts, root ${root.slice(0, 16)}…, tx ${r.tx}, ${r.explorer}${check ? " (read back from the chain: OK)" : ""}` };
}
