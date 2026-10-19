import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PackId } from "@reeve/core";
import { FixtureProvider, ProviderRegistry, providerEntries } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { ConnectorRegistry, inferFields, LogConnector } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { createApp, type AppDeps } from "../src/app";
import { Store } from "../src/store";

const fixtures = Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f));

function setup(providers = ProviderRegistry.of([new FixtureProvider(fixtures)]), anchor: AppDeps["anchor"] = null) {
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
    anchor,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, store, ledger, call };
}

async function waitForRun(call: ReturnType<typeof setup>["call"], id: string) {
  for (let i = 0; i < 200; i++) {
    const { json } = await call("GET", `/runs/${id}`);
    if (json.status === "done" || json.status === "error") return json;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
}

describe("api", () => {
  it("compiles an SOP, runs the audit, and records the receipt on the ledger", async () => {
    const { call, ledger } = setup();
    const health = await call("GET", "/health");
    expect(health.json.llm).toBe("fixture");

    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    expect(rb.status).toBe(201);
    expect(rb.json.rulebook.cards).toHaveLength(8);
    expect(rb.json.status).toBe("draft");

    const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, {});
    expect(started.status).toBe(202);
    const run = await waitForRun(call, started.json.id);
    expect(run.status).toBe("done");
    expect(run.verdict.status).toBe("pass");
    expect(run.log.some((l: { line: string }) => l.line.includes("exec python3"))).toBe(true);

    const after = await call("GET", `/rulebooks/${rb.json.id}`);
    expect(after.json.status).toBe("audited");
    expect(ledger.verify()).toBeNull();
    expect(ledger.entries().map((e) => e.kind)).toEqual(["receipt", "anchor"]);
  });

  it("refuses approval when the latest run failed the Auditor", async () => {
    const { call, store } = setup();
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, { injectBug: true });
    const run = await waitForRun(call, started.json.id);
    expect(run.verdict.status).toBe("fail");
    store.data.passkeys.push({ id: "x", publicKey: "x", counter: 0, createdAt: "" });
    const approve = await call("POST", `/rulebooks/${rb.json.id}/approve/options`);
    expect(approve.status).toBe(409);
  });

  it("issues an approval challenge that commits to the receipt", async () => {
    const { call, store } = setup();
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, {});
    const run = await waitForRun(call, started.json.id);

    const noKey = await call("POST", `/rulebooks/${rb.json.id}/approve/options`);
    expect(noKey.status).toBe(409); // no passkey registered yet

    store.data.passkeys.push({ id: "cred1", publicKey: "x", counter: 0, createdAt: "" });
    const opts = await call("POST", `/rulebooks/${rb.json.id}/approve/options`);
    expect(opts.status).toBe(200);
    expect(opts.json.receiptHash).toBe(run.receipt.receipt_hash);
    expect(opts.json.options.userVerification).toBe("required");
    expect(opts.json.options.allowCredentials[0].id).toBe("cred1");
  });

  it("compiles and audits a minimarket SOP, and catches the minimarket Builder bug", async () => {
    const { call } = setup();
    const sop = await call("GET", "/fixtures/sop?pack=minimarket");
    expect(sop.json.sop).toContain("Supplier");
    const rb = await call("POST", "/sops", { text: sop.json.sop, pack: "minimarket" });
    expect(rb.status).toBe(201);
    expect(rb.json.rulebook.pack).toBe("minimarket");
    expect(rb.json.rulebook.cards.map((c: { type: string }) => c.type)).toContain("reorder_point");

    const good = await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);
    expect(good.verdict.status).toBe("pass");
    expect(good.rulesPy).toContain("REORDER_BELOW");

    const bad = await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, { injectBug: true })).json.id);
    expect(bad.verdict.status).toBe("fail");
  });

  it("rejects an unknown pack or provider", async () => {
    const { call } = setup();
    expect((await call("POST", "/sops", { text: loadFixtureSop(), pack: "bakery" })).status).toBe(400);
    expect((await call("POST", "/sops", { text: loadFixtureSop(), provider: "nope" })).status).toBe(400);
  });

  it("lists packs and providers without exposing keys", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-secret", GROQ_API_KEY: "gsk-secret", REEVE_LLM: "fixture" };
    const { call } = setup(new ProviderRegistry(providerEntries(fixtures, env), "fixture"));
    const packs = await call("GET", "/packs");
    expect(packs.json.map((p: { id: string }) => p.id)).toEqual(["rent-collection", "minimarket", "generic"]);
    const res = await call("GET", "/providers");
    expect(res.json.default).toBe("fixture");
    const byId = Object.fromEntries(res.json.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId["anthropic:claude-haiku-5-5"].available).toBe(true);
    expect(byId.groq).toMatchObject({ available: false, setup: "GROQ_MODEL" }); // key present, model id missing
    expect(byId.ollama).toMatchObject({ available: false, setup: "OLLAMA_MODEL" });
    expect(JSON.stringify(res.json)).not.toContain("secret");
    // A parser that is not set up is refused before any call goes out.
    expect((await call("POST", "/sops", { text: loadFixtureSop(), provider: "groq" })).status).toBe(400);
  });

  it("runs the approved rulebook on a rail: bills, payments, a double payment, a passkey-gated refund", async () => {
    const { call, store, ledger } = setup();
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    const run = await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);

    // Not approved yet: nothing may run.
    expect((await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" })).status).toBe(409);
    // Approval normally comes from the owner's passkey (tested above); set it directly here.
    Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "cred1", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
    store.data.passkeys.push({ id: "cred1", publicKey: "x", counter: 0, createdAt: "" });

    const rails = await call("GET", "/rails");
    expect(rails.json.map((r: { id: string; available: boolean }) => [r.id, r.available])).toEqual([["stripe", false], ["xendit", false], ["mock", true]]);
    expect((await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "stripe" })).status).toBe(409); // no key

    const op = await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" });
    expect(op.status).toBe(201);
    expect(op.json.startDate).toBe("2026-11-01");
    const id = op.json.id;
    const waitIdle = async () => {
      for (let i = 0; i < 200; i++) {
        const { json } = await call("GET", `/operations/${id}`);
        if (json.status !== "running") return json;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("operation did not finish");
    };

    expect((await call("POST", `/operations/${id}/advance`, { to: "2026-11-01" })).status).toBe(202);
    let state = await waitIdle();
    expect(state.status).toBe("idle");
    expect(state.invoices).toHaveLength(30);

    const k01 = state.invoices[0];
    expect((await call("POST", `/operations/${id}/invoices/${k01.invoiceId}/simulate-payment`)).status).toBe(200);
    // A duplicate webhook for the same payment changes nothing.
    const hook = { type: "invoice.paid", eventId: "evt_dup", invoiceId: k01.invoiceId, amount: 1_500_000, at: "2026-10-18T00:00:00Z" };
    expect((await call("POST", "/webhooks/mock", hook)).json.received).toBe(true);
    expect((await call("POST", `/operations/${id}/transfers`, { tenant: "K01", amount: 1_500_000 })).status).toBe(201);

    await call("POST", `/operations/${id}/advance`, { to: "2026-11-02" });
    state = await waitIdle();
    const ex = state.exceptions.find((x: { tenant: string }) => x.tenant === "K01");
    expect(ex).toMatchObject({ kind: "overpayment", amount: 1_500_000, needsPasskey: true, status: "open" });

    const direct = await call("POST", `/operations/${id}/exceptions/${ex.id}/refund`);
    expect(direct.status).toBe(403);
    expect(direct.json.needsPasskey).toBe(true);
    const opts = await call("POST", `/operations/${id}/exceptions/${ex.id}/refund/options`);
    expect(opts.status).toBe(200);
    expect(opts.json.options.userVerification).toBe("required");

    expect((await call("POST", `/operations/${id}/exceptions/${ex.id}/keep`)).json.exceptions[0].status).toBe("kept_as_credit");
    const kinds = ledger.entries().filter((e) => e.kind === "operation").map((e) => (e as { event: string }).event);
    expect(kinds.filter((k) => k === "invoice_created")).toHaveLength(30);
    expect(kinds.filter((k) => k === "payment_received")).toHaveLength(2); // the card payment and the transfer, not the duplicate
    expect(kinds).toContain("credit_kept");
    expect(ledger.verify()).toBeNull();
  });

  it("maintain: a revised rulebook shows its diff and impact, replaces the old one once approved, and takes over the live run", async () => {
    const { call, store, ledger } = setup();
    const approve = (id: string, receiptHash: string) => {
      // The passkey ceremony is tested above; here the approval is set directly, then the same superseding runs.
      Object.assign(store.data.rulebooks[id]!, { status: "approved", approval: { at: "", credentialId: "cred1", receiptHash, ledgerSeq: 0 } });
      store.supersedeAncestors(id);
    };
    const v1 = await call("POST", "/sops", { text: loadFixtureSop() });
    const run1 = await waitForRun(call, (await call("POST", `/rulebooks/${v1.json.id}/runs`, {})).json.id);
    approve(v1.json.id, run1.receipt.receipt_hash);
    const op = (await call("POST", `/rulebooks/${v1.json.id}/operations`, { rail: "mock" })).json;

    // Nothing changed: refused.
    expect((await call("POST", `/rulebooks/${v1.json.id}/revisions`, { rulebook: v1.json.rulebook })).status).toBe(409);

    // The owner raises the late fee from 5% to 8% (still under the 10% cap).
    const edited = structuredClone(v1.json.rulebook);
    edited.cards.find((c: { type: string }) => c.type === "late_fee").percent = 8;
    const v2 = await call("POST", `/rulebooks/${v1.json.id}/revisions`, { rulebook: edited });
    expect(v2.status).toBe(201);
    expect(v2.json.parentId).toBe(v1.json.id);
    expect(v2.json.diff).toEqual([{ kind: "changed", id: "R3", type: "late_fee", title: expect.any(String), fields: [{ field: "percent", before: 5, after: 8 }] }]);

    const run2 = await waitForRun(call, (await call("POST", `/rulebooks/${v2.json.id}/runs`, {})).json.id);
    expect(run2.verdict.status).toBe("pass");
    const after = (await call("GET", `/rulebooks/${v2.json.id}`)).json;
    expect(after.impact.totals).toContainEqual({ key: "fees", before: 1_275_000, after: 2_040_000 });
    // K22 pays late twice: bigger fees, and the reminders after them quote a bigger balance.
    expect(after.impact.subjects.find((s: { id: string }) => s.id === "K22").changes).toContainEqual({ type: "late_fee", count: [2, 2], amount: [150_000, 240_000] });
    expect(after.impact.subjects.find((s: { id: string }) => s.id === "K01")).toBeUndefined(); // pays on time: unaffected

    // Until the revision is approved, the run keeps the old rules and cannot switch.
    expect((await call("POST", `/operations/${op.id}/upgrade`)).status).toBe(409);
    approve(v2.json.id, run2.receipt.receipt_hash);
    expect(store.data.rulebooks[v1.json.id]!.status).toBe("superseded");
    expect((await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" })).json.error).toMatch(/switch this run/);

    const upgraded = await call("POST", `/operations/${op.id}/upgrade`);
    expect(upgraded.json.rulebookId).toBe(v2.json.id);
    expect(upgraded.json.receiptHash).toBe(run2.receipt.receipt_hash);
    expect(ledger.entries().at(-1)).toMatchObject({ kind: "operation", event: "rules_upgraded" });
    expect((await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" })).status).toBe(202);
  });

  it("generic SOP: compiles over the sample sheet, checks every tool, audits, and runs through connectors", async () => {
    const { call, store } = setup();
    expect((await call("GET", "/packs")).json.map((p: { id: string }) => p.id)).toContain("generic");
    const ds = (await call("GET", "/datasets")).json;
    expect(ds[0]).toMatchObject({ id: "sample", count: 12 });

    const uploaded = await call("POST", "/datasets", { name: "mine", csv: "id,status,fee\nA,belum,100\nB,lunas,200\nC,belum,300\n" });
    expect(uploaded.json).toMatchObject({ count: 3, fields: [{ name: "id" }, { name: "status", values: ["belum", "lunas"] }, { name: "fee", type: "number" }] });

    const sop = (await call("GET", "/fixtures/sop?pack=generic")).json.sop;
    const rb = await call("POST", "/sops", { text: sop, pack: "generic" });
    expect(rb.status).toBe(201);
    expect(rb.json.datasetId).toBe("sample");
    // Only a log connector here: WhatsApp and Gmail are not connected, and the check says so.
    expect(rb.json.toolChecks.map((t: { rule: string; status: string }) => [t.rule, t.status])).toEqual([["R1", "not_found"], ["R2", "not_found"], ["R3", "not_found"]]);

    const run = await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);
    expect(run.verdict.status).toBe("pass");
    expect(run.results.simulation.summary).toMatchObject({ actions: 23, approval_requests: 7, blocked: 5 });

    Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "c", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
    const op = await call("POST", `/rulebooks/${rb.json.id}/operations`, {});
    expect(op.json.kind).toBe("generic");
    expect((await call("POST", `/operations/${op.json.id}/advance`, { to: op.json.startDate })).status).toBe(202);
    let state = op.json;
    for (let i = 0; i < 100 && (state.status === "running" || state.clock === null); i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await call("GET", `/operations/${op.json.id}`)).json;
    }
    expect(state.status).toBe("idle");
    // The records' dates are in Oct-Nov 2026; today's run may decide nothing, which is fine. What ran must be honest:
    for (const a of state.sent) expect(a.ok ? a.via : a.error).toBeTruthy();
  });

  it("rent collection over the owner's own tenants: maps Indonesian columns, audits on their rents, bills them", async () => {
    const { call, store } = setup();
    const csv = "kamar,nama,sewa,tanggal_masuk\nA1,Budi,1200000,2025-01-10\nA2,Sari,950000,2026-08-01\nA3,Tono,1100000,2026-09-15\nA4,Rina,1300000,2024-05-20\nA5,Joko,1000000,2026-02-01\nA6,Lia,1250000,2026-06-12\n";
    const bad = await call("POST", "/datasets", { name: "bad", csv: "nama,sewa\nBudi,100\nSari,200\n" });
    expect((await call("POST", "/sops", { text: loadFixtureSop(), datasetId: bad.json.id })).json.error).toMatch(/no column for room/);

    const ds = await call("POST", "/datasets", { name: "Kos Mawar", csv });
    const rb = await call("POST", "/sops", { text: loadFixtureSop(), datasetId: ds.json.id });
    expect(rb.status).toBe(201);
    expect(rb.json.datasetId).toBe(ds.json.id);
    const run = await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);
    expect(run.verdict.status).toBe("pass");
    const invoices = run.results.simulation.events.filter((e: { type: string; date: string }) => e.type === "invoice" && e.date === "2026-11-01");
    expect(invoices.map((e: { tenant_id: string; amount: number }) => [e.tenant_id, e.amount])).toEqual([
      ["A1", 1_200_000],
      ["A2", 950_000],
      ["A3", 1_100_000],
      ["A4", 1_300_000],
      ["A5", 1_000_000],
      ["A6", 1_250_000],
    ]);

    Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "c", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
    const op = await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" });
    expect(op.json.tenants.map((t: { id: string; rent: number }) => [t.id, t.rent])).toContainEqual(["A2", 950_000]);
    await call("POST", `/operations/${op.json.id}/advance`, { to: "2026-11-01" });
    let state = op.json;
    for (let i = 0; i < 100 && state.clock === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await call("GET", `/operations/${op.json.id}`)).json;
    }
    expect(state.invoices.map((i: { tenant: string; amount: number }) => [i.tenant, i.amount])).toContainEqual(["A2", 950_000]);
  });

  it("anchors the ledger root on a testnet and checks it back (fake chain)", async () => {
    const chainTxs = new Map<string, string>();
    const fake: NonNullable<AppDeps["anchor"]> = {
      chainName: "monad-testnet",
      chain: { id: 10143, blockExplorers: { default: { name: "x", url: "https://testnet.monadexplorer.com" } } } as never,
      address: "0x00000000000000000000000000000000000000aa",
      anchor: async (root: string) => {
        chainTxs.set("0xt1", root);
        return { chain: "monad-testnet", chainId: 10143, tx: "0xt1", from: "0x00000000000000000000000000000000000000aa", block: "1", explorer: "https://testnet.monadexplorer.com/tx/0xt1" };
      },
      verify: async (tx: string, root: string) => (chainTxs.get(tx) === root ? { ok: true, leaves: 1 } : { ok: false, reason: "root differs" }),
    };

    // Without a wallet: said plainly, nothing sent.
    const off = setup();
    expect((await off.call("GET", "/anchor")).json).toMatchObject({ configured: false });
    expect((await off.call("POST", "/ledger/anchor")).status).toBe(409);

    const { call, ledger } = setup(undefined, fake);
    expect((await call("GET", "/anchor")).json).toMatchObject({ configured: true, chain: "monad-testnet", chainId: 10143, address: fake.address });
    expect(JSON.stringify((await call("GET", "/anchor")).json)).not.toMatch(/key/i);
    expect((await call("POST", "/ledger/anchor")).json.error).toMatch(/no receipts/);

    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    await waitForRun(call, (await call("POST", `/rulebooks/${rb.json.id}/runs`, {})).json.id);
    const anchored = await call("POST", "/ledger/anchor");
    expect(anchored.status).toBe(201);
    expect(anchored.json).toMatchObject({ kind: "anchor", anchor: "monad-testnet", chain_id: 10143, tx: "0xt1", leaves: 1 });
    expect(ledger.verify()).toBeNull();

    const check = await call("GET", `/ledger/anchors/${anchored.json.seq}/verify`);
    expect(check.json).toMatchObject({ local: true, onChain: { ok: true }, tx: "0xt1" });
    // The run's own local anchor has no transaction: verified locally only.
    const localSeq = ledger.entries().find((e) => e.kind === "anchor" && !("tx" in e && e.tx))!.seq;
    expect((await call("GET", `/ledger/anchors/${localSeq}/verify`)).json).toMatchObject({ local: true, onChain: null });
  });

  it("lists every app the owner can connect and hands out a sign-in link per app", async () => {
    const linked: string[] = [];
    const connectors = new ConnectorRegistry([
      {
        id: "composio",
        kind: "composio",
        label: "Composio",
        describeTool: async () => null,
        execute: async () => ({ ok: false }),
        linkApp: async (slug: string) => (linked.push(slug), { redirectUrl: `https://connect.composio.dev/link/lk_${slug}`, status: "initiated" }),
        connectionStatus: async (slugs: string[]) => Object.fromEntries(slugs.map((x) => [x, x === "gmail" ? 1 : 0])),
      },
    ]);
    const catalog = { search: async (q: string) => ({ total: 1, apps: [{ name: q || "Gmail", slug: "gmail", tools: 61, triggers: 2, auth: ["OAUTH2"] }] }) };
    const dir = mkdtempSync(join(tmpdir(), "reeve-apps-"));
    const app = createApp({
      store: new Store(null),
      providers: ProviderRegistry.of([new FixtureProvider(fixtures)]),
      sandbox: new LocalSandbox(),
      ledger: new Ledger(join(dir, "l.jsonl")),
      scenario: () => kosMelatiScenario(),
      defaultSop: () => loadFixtureSop(),
      rails: railEntries({}),
      tenants: () => kosMelatiScenario().tenants,
      connectors,
      apps: catalog,
      rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
    });
    const get = async (path: string, method = "GET") => {
      const r = await app.request(`/api${path}`, { method });
      return { status: r.status, json: (await r.json()) as any };
    };
    expect((await get("/apps?q=gmail")).json).toMatchObject({ total: 1, canConnect: true, apps: [{ slug: "gmail" }] });
    expect((await get("/apps/status?slugs=gmail,notion,bad;slug")).json).toEqual({ gmail: 1, notion: 0 });
    const link = await get("/apps/notion/connect", "POST");
    expect(link.json).toEqual({ slug: "notion", redirectUrl: "https://connect.composio.dev/link/lk_notion", status: "initiated", expiresInMinutes: 10 });
    expect(linked).toEqual(["notion"]);
    expect((await get("/apps/no%20pe/connect", "POST")).status).toBe(400);

    // Without Composio the apps can be browsed but not connected.
    const { call } = setup();
    expect((await call("POST", "/apps/notion/connect")).status).toBe(409);
  });

  it("returns WebAuthn registration options for the owner", async () => {
    const { call } = setup();
    const opts = await call("POST", "/passkeys/register/options");
    expect(opts.json.rp.id).toBe("localhost");
    expect(opts.json.authenticatorSelection.userVerification).toBe("required");
  });
});
