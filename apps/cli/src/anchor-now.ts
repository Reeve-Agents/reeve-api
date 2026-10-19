/**
 * Publish the ledger's current Merkle root on the testnet, record it in the ledger, and check it back.
 *   npm run anchor:now
 * Sends one zero-value transaction from the anchor wallet (testnet gas only).
 */
import { join, resolve } from "node:path";
import { anchorFromEnv } from "@reeve/anchor";
import { repoRoot } from "@reeve/pipeline";
import { Ledger, merkleRoot } from "@reeve/receipts";

const a = anchorFromEnv();
if (!a) {
  console.error("No anchor wallet: run npm run anchor:wallet first.");
  process.exit(1);
}
const ledger = new Ledger(join(resolve(repoRoot, process.env.REEVE_HOME ?? ".reeve"), "ledger.jsonl"));
const receipts = ledger.entries().flatMap((e) => (e.kind === "receipt" ? [e.receipt_hash] : []));
if (!receipts.length) {
  console.error("The ledger has no receipts yet.");
  process.exit(1);
}
const balance = await a.balance();
if (balance === 0n) {
  console.error(`${a.address} has no ${a.chainName} funds yet: use the faucet first.`);
  process.exit(1);
}
const root = merkleRoot(receipts);
console.log(`anchoring root ${root.slice(0, 16)}… over ${receipts.length} receipts on ${a.chainName}`);
const r = await a.anchor(root, receipts.length);
const entry = ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: root, leaves: receipts.length, anchor: r.chain, chain_id: r.chainId, tx: r.tx, from: r.from, explorer: r.explorer });
const check = await a.verify(r.tx, root);
console.log(`tx       ${r.tx} (block ${r.block})`);
console.log(`explorer ${r.explorer}`);
console.log(`ledger   #${entry.seq}; chain check ${check.ok ? "OK" : `FAILED: ${check.reason}`}`);
