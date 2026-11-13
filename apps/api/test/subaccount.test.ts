import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PackId } from "@reeve/core";
import { FixtureProvider, ProviderRegistry } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { ConnectorRegistry, inferFields, LogConnector } from "@reeve/connectors";
import { XenditRail, type RailEntry } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { createApp } from "../src/app";
import { Store } from "../src/store";

const fixtures = Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f));
const SUB = "661f87c614802d6c402cd82d";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa";

/** Xendit with a fake network: records every request, answers like the Payment Sessions API. */
function setup() {
  const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ method: init.method!, url, headers: init.headers as Record<string, string> });
    const body = init.body ? (JSON.parse(String(init.body)) as { amount: number }) : undefined;
    if (url.endsWith("/sessions") && init.method === "POST") return new Response(JSON.stringify({ payment_session_id: `ps-${++n}`, status: "ACTIVE", amount: body!.amount, payment_link_url: `https://xen.to/${n}` }), { status: 201 });
    return new Response(JSON.stringify({}), { status: 404 });
  }) as unknown as typeof fetch;
  const rails: RailEntry[] = [
    {
      info: { id: "xendit", label: "Xendit (test mode)", note: "", available: true, webhooks: true },
      create: () => new XenditRail({ secretKey: "xnd_development_fake", webhookToken: "tok", fetch: fakeFetch }),
    },
  ];
  const dir = mkdtempSync(join(tmpdir(), "reeve-sub-"));
  const store = new Store(null);
  const app = createApp({
    store,
    providers: ProviderRegistry.of([new FixtureProvider(fixtures)]),
    sandbox: new LocalSandbox(),
    ledger: new Ledger(join(dir, "ledger.jsonl")),
    scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
    defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
    rails,
    tenants: () => kosMelatiScenario().tenants,
    connectors: new ConnectorRegistry([new LogConnector()]),
    sampleDataset: () => ({ name: "sample", ...bimbelRecords(), fields: inferFields(bimbelRecords().records) }),
    rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { store, call, seen };
}

async function approvedRulebook(call: ReturnType<typeof setup>["call"], store: Store) {
  const rb = await call("POST", "/sops", { text: loadFixtureSop() });
  const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, {});
  let run: any;
  for (let i = 0; i < 200; i++) {
    run = (await call("GET", `/runs/${started.json.id}`)).json;
    if (run.status === "done" || run.status === "error") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "c", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
  return rb.json.id as string;
}

describe("Xendit per-merchant sub-account", () => {
  it("refuses to start a Xendit run until the owner connects their own account, then bills on it", async () => {
    const { store, call, seen } = setup();
    const rb = await approvedRulebook(call, store);

    // Not connected: refused in Indonesian, nothing sent to Xendit.
    const refused = await call("POST", `/rulebooks/${rb}/operations`, { rail: "xendit" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/Hubungkan akun Xendit/);
    expect(seen).toHaveLength(0);
    expect((await call("GET", "/rails")).json[0]).toMatchObject({ id: "xendit", accountConnected: false });

    // A malformed id is refused; a good one is stored for this owner.
    expect((await call("PUT", "/rails/xendit/account", { accountId: "x" })).status).toBe(400);
    expect((await call("PUT", "/rails/xendit/account", { accountId: SUB })).json).toEqual({ connected: true, accountId: SUB });
    expect((await call("GET", "/rails")).json[0]).toMatchObject({ accountConnected: true });

    const op = (await call("POST", `/rulebooks/${rb}/operations`, { rail: "xendit" })).json;
    expect(op.rail).toBe("xendit");
    expect((await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" })).status).toBe(202);
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await call("GET", `/operations/${op.id}`)).json;
      if (state.clock === "2026-11-01" && state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(state.invoices.length).toBeGreaterThan(0);
    // Every Xendit call went out as the owner's sub-account, never as Reeve's master balance.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.headers["for-user-id"] === SUB)).toBe(true);
  });

  it("rejects a webhook whose sub-account is not the operation owner's, and accepts the owner's", async () => {
    const { store, call } = setup();
    const rb = await approvedRulebook(call, store);
    await call("PUT", "/rails/xendit/account", { accountId: SUB });
    const op = (await call("POST", `/rulebooks/${rb}/operations`, { rail: "xendit" })).json;
    await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" });
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await call("GET", `/operations/${op.id}`)).json;
      if (state.invoices.length && state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const invoiceId = state.invoices[0].invoiceId as string;
    const hook = (business_id?: string) =>
      call("POST", "/webhooks/xendit", { event: "payment_session.completed", ...(business_id ? { business_id } : {}), created: "2026-11-01T03:00:00Z", data: { payment_session_id: invoiceId, amount: state.invoices[0].amount, payment_id: `py-${business_id ?? "none"}`, status: "COMPLETED" } }, { "x-callback-token": "tok" });

    expect((await hook(OTHER)).status).toBe(403); // someone else's sub-account
    expect((await hook()).status).toBe(403); // names no sub-account at all
    expect((await call("GET", `/operations/${op.id}`)).json.invoices[0].status).toBe("open");
    expect((await hook(SUB)).json).toMatchObject({ received: true, operation: op.id });
    expect((await call("GET", `/operations/${op.id}`)).json.invoices[0].status).toBe("paid");
  });

  it("will not disconnect the account while Xendit bills are still open", async () => {
    const { store, call } = setup();
    const rb = await approvedRulebook(call, store);
    await call("PUT", "/rails/xendit/account", { accountId: SUB });
    const op = (await call("POST", `/rulebooks/${rb}/operations`, { rail: "xendit" })).json;
    await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" });
    for (let i = 0; i < 100; i++) {
      const s = (await call("GET", `/operations/${op.id}`)).json;
      if (s.invoices.length && s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await call("DELETE", "/rails/xendit/account")).status).toBe(409);
  });
});
