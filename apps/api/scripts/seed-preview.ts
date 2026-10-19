// Preview-only store for checking the Run panel: approval is simulated, not a passkey. Never point it at .reeve/db.json.
import { join } from "node:path";
import { FixtureProvider, ProviderRegistry } from "@reeve/llm";
import { kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, repoRoot } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { railEntries } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { createApp } from "../src/app";
import { Store } from "../src/store";

const home = join(repoRoot, ".reeve/preview");
const store = new Store(join(home, "db.json"));
const app = createApp({
  store,
  providers: ProviderRegistry.of([new FixtureProvider(loadFixtureRulebook())]),
  sandbox: new LocalSandbox(),
  ledger: new Ledger(join(home, "ledger.jsonl")),
  scenario: () => kosMelatiScenario(),
  defaultSop: () => loadFixtureSop(),
  rails: railEntries({}),
  tenants: () => kosMelatiScenario().tenants,
  rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
});
const call = async (method: string, path: string, body?: unknown) =>
  (await (await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()) as any;
const rb = await call("POST", "/sops", { text: loadFixtureSop() });
let run = await call("POST", `/rulebooks/${rb.id}/runs`, {});
while (run.status !== "done" && run.status !== "error") {
  await new Promise((r) => setTimeout(r, 200));
  run = await call("GET", `/runs/${run.id}`);
}
Object.assign(store.data.rulebooks[rb.id]!, { status: "approved", approval: { at: new Date().toISOString(), credentialId: "preview-simulated", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
store.save();
console.log(`seeded ${rb.id}: run ${run.verdict.status}, approval simulated for preview`);
