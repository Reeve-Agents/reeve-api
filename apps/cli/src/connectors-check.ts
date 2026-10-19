/**
 * Live look at the connectors (no secrets printed):
 *   npm run connectors:check            accounts connected in Composio, and the sample rulebook's tools
 *   npm run connectors:check -- --rulebook=fixtures/bimbel-cerdas/rulebook.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Composio } from "@composio/core";
import { connectorsFromEnv } from "@reeve/connectors";
import { Rulebook } from "@reeve/core";
import { repoRoot } from "@reeve/pipeline";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const registry = connectorsFromEnv();
console.log("connectors:", registry.list().map((c) => c.id).join(", "));

if (process.env.COMPOSIO_API_KEY && !process.env.COMPOSIO_API_KEY.startsWith("ck_")) {
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  const accounts = await composio.connectedAccounts.list({ limit: 50 });
  const items = (accounts as unknown as { items: { id: string; status: string; toolkit: { slug: string }; userId?: string; user_id?: string }[] }).items;
  console.log(`\nComposio connected accounts (${items.length}):`);
  for (const a of items) console.log(`  ${a.toolkit.slug.padEnd(16)} ${a.status.padEnd(10)} user ${a.userId ?? a.user_id ?? "?"}  ${a.id}`);
  console.log(`Reeve acts as user: ${process.env.COMPOSIO_USER_ID || "reeve-owner"} (COMPOSIO_USER_ID)`);
}

const rb = Rulebook.parse(JSON.parse(readFileSync(join(repoRoot, arg("rulebook") ?? "fixtures/bimbel-cerdas/rulebook.json"), "utf8")));
const checks = await registry.check(rb.cards.flatMap((c) => (c.type === "generic_rule" ? [{ rule: c.id, connector: c.action.connector, tool: c.action.tool, args: c.action.args.map((a) => a.name) }] : [])));
console.log(`\nTools in ${rb.business_name}:`);
for (const c of checks) console.log(`  ${c.rule} ${c.tool.padEnd(24)} ${c.status.padEnd(13)} ${c.detail}`);
