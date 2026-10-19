import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { anchorFromEnv } from "@reeve/anchor";
import type { PackId } from "@reeve/core";
import { ProviderRegistry } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE, repoRoot } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { connectorsFromEnv, inferFields } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { sandboxFromEnv } from "@reeve/sandbox";
import { createApp } from "./app";
import { openPostgres } from "./pg";
import { Store } from "./store";

const home = resolve(repoRoot, process.env.REEVE_HOME ?? ".reeve");
const port = Number(process.env.REEVE_API_PORT ?? 8787);
const origin = process.env.REEVE_WEB_ORIGIN ?? "http://localhost:5173";

// REEVE_LLM picks the default parser; every other configured one stays selectable per SOP.
const providers = ProviderRegistry.fromEnv(Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f)));

// DATABASE_URL (a deployment): Store and Ledger live in Postgres. Otherwise files under REEVE_HOME.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : null;
const store = db ? new Store(null, { initial: db.initialStore, persist: db.persistStore }) : new Store(join(home, "db.json"));
const ledger = new Ledger(db ? db.ledger : join(home, "ledger.jsonl"));

const app = createApp({
  store,
  providers,
  sandbox: sandboxFromEnv(),
  ledger,
  scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
  defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
  // Stripe and Xendit in test mode only (live keys are refused), plus an offline rail.
  rails: railEntries(),
  tenants: () => kosMelatiScenario().tenants,
  // Composio (COMPOSIO_API_KEY) and any MCP server (REEVE_MCP_SERVERS) for generic SOPs; a log otherwise.
  connectors: connectorsFromEnv(),
  sampleDataset: () => {
    const { records, updates } = bimbelRecords();
    return { name: "Bimbel Cerdas (sample, 12 students)", records, updates, fields: inferFields(records) };
  },
  rp: { id: new URL(origin).hostname, name: "Reeve", origin },
  // REEVE_ANCHOR_PRIVATE_KEY (testnet wallet from `npm run anchor:wallet`) turns on-chain anchoring on.
  anchor: anchorFromEnv(),
});

const ready = providers.list().filter((p) => p.available).map((p) => p.id);
const rails = railEntries().filter((r) => r.info.available).map((r) => r.info.id);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`reeve api on http://localhost:${port}/api · default llm ${providers.defaultId} · ${ready.length} parsers ready (${ready.join(", ")}) · rails ${rails.join(", ")} · origin ${origin} · storage ${db ? "postgres" : home}`);
});

// On a redeploy, finish the queued Postgres writes before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void (db?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
