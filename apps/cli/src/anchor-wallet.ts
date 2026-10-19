/**
 * Create the testnet wallet that publishes ledger roots (proof only, never payments).
 *   npm run anchor:wallet
 * If reeve/.env has no REEVE_ANCHOR_PRIVATE_KEY, a fresh key is generated and appended to .env.
 * The key is never printed: only the address, which you fund from the testnet faucet.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorFromEnv, CHAINS } from "@reeve/anchor";
import { repoRoot } from "@reeve/pipeline";
import { generatePrivateKey } from "viem/accounts";

const envPath = process.env.REEVE_ENV_FILE ?? join(repoRoot, ".env");
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const has = (name: string) => new RegExp(`^${name}=\\S`, "m").test(current);
const chain = process.env.REEVE_ANCHOR_CHAIN?.trim() || "monad-testnet";
if (!CHAINS[chain]) throw new Error(`REEVE_ANCHOR_CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);

let created = false;
if (!has("REEVE_ANCHOR_PRIVATE_KEY")) {
  const lines = [`${current.endsWith("\n") || current === "" ? "" : "\n"}# On-chain anchor wallet (testnet only; created by npm run anchor:wallet)`];
  if (!has("REEVE_ANCHOR_CHAIN")) lines.push(`REEVE_ANCHOR_CHAIN=${chain}`);
  lines.push(`REEVE_ANCHOR_PRIVATE_KEY=${generatePrivateKey()}`);
  appendFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  created = true;
}

const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => /^REEVE_ANCHOR_/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const a = anchorFromEnv(env as NodeJS.ProcessEnv)!;
console.log(created ? "Created a new anchor wallet in reeve/.env (the key is not shown)." : "reeve/.env already has an anchor wallet.");
console.log(`chain    ${a.chainName} (id ${a.chain.id})`);
console.log(`address  ${a.address}`);
console.log(`explorer ${a.chain.blockExplorers?.default.url}/address/${a.address}`);
console.log("Next: send testnet funds to this address from the chain's faucet, then restart the API (or run npm run anchor:now).");
