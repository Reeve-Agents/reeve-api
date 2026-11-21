import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackId } from "@reeve/core";
import { FixtureProvider, ProviderRegistry, type LLMProvider, type LLMUsage } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { ConnectorRegistry, inferFields, LogConnector } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { createApp, type AppDeps } from "../src/app";
import { Store } from "../src/store";

/** Shared by the cost-meter and WhatsApp API tests: an app over an in-memory store, the local sandbox and the Log connector. */

export const fixtures = Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f));

export function setup(providers = ProviderRegistry.of([new FixtureProvider(fixtures)]), extra: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reeve-api-"));
  const store = new Store(null);
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const app = createApp({
    store,
    providers,
    sandbox: new LocalSandbox(),
    ledger,
    scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
    defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
    rails: railEntries({}),
    tenants: () => kosMelatiScenario().tenants,
    connectors: new ConnectorRegistry([new LogConnector()]),
    sampleDataset: () => {
      const { records, updates } = bimbelRecords();
      return { name: "sample", records, updates, fields: inferFields(records) };
    },
    rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
    anchor: null,
    ...extra,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, store, ledger, call };
}

export type Harness = ReturnType<typeof setup>;

export async function waitForRun(call: Harness["call"], id: string) {
  for (let i = 0; i < 200; i++) {
    const { json } = await call("GET", `/runs/${id}`);
    if (json.status === "done" || json.status === "error") return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not finish");
}

/** Waits until an operation is no longer running, and returns it. */
export async function waitForOperation(call: Harness["call"], id: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await call("GET", `/operations/${id}`);
    if (json.status !== "running") return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("operation did not finish");
}

/** An SOP compiled, audited and approved (the passkey step is set directly, as the existing API tests do). */
export async function approvedRulebook(h: Harness, pack?: PackId) {
  const sop = pack ? (await h.call("GET", `/fixtures/sop?pack=${pack}`)).json.sop : loadFixtureSop();
  const rb = await h.call("POST", "/sops", { text: sop, ...(pack ? { pack } : {}) });
  const run = await waitForRun(h.call, (await h.call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);
  Object.assign(h.store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "cred1", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
  h.store.data.passkeys.push({ id: "cred1", publicKey: "x", counter: 0, createdAt: "" });
  return rb.json as { id: string };
}

export const tokens = (provider: string, model: string, inputTokens: number, outputTokens: number): LLMUsage => ({ provider, model, inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 });

/** A provider that reads the sample rulebooks but reports the tokens a real model would have used. */
export function metered(name: string, model: string, parse: [number, number] = [3_000, 1_500], text: [number, number] = [900, 80]): LLMProvider {
  const base = new FixtureProvider(fixtures);
  return {
    name,
    parseSop: async (_sop, pack, _hints, opts) => {
      opts?.onUsage?.(tokens(name, model, parse[0], parse[1]));
      return base.parseSop("", pack);
    },
    completeText: async (system, _user, opts) => {
      opts?.onUsage?.(tokens(name, model, text[0], text[1]));
      return system.includes("label its intent") ? '{"intent":"unclear","promised_date":null}' : "Halo Kak {{name}}, kamar {{room}}: {{amount}}. {{link}}";
    },
  };
}
