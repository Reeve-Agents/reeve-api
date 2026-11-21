import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMOutputError, ProviderRegistry, type LLMProvider } from "@reeve/llm";
import { loadFixtureSop, PACK_FIXTURE, kosMelatiScenario, minimarketScenario, bimbelRecords } from "@reeve/pipeline";
import { ConnectorRegistry, inferFields, LogConnector } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import type { PackId } from "@reeve/core";
import { createAccountsApp } from "../src/accounts";
import { createApp } from "../src/app";
import { filePersistence } from "../src/persistence";
import type { UsageRecord } from "../src/store";
import { monthOf, stepsOf, summarize } from "../src/usage";
import { approvedRulebook, metered, setup, tokens, waitForOperation } from "./helpers";

const HAIKU = "anthropic:claude-haiku-5-5";
const RATE = 18154;
const record = (over: Partial<UsageRecord>): UsageRecord => ({
  id: "u",
  at: "2026-11-11T05:00:00.000Z",
  phase: "builder_compile",
  provider: HAIKU,
  model: "claude-haiku-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  usd: 0,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("summarize", () => {
  const rate = { usdIdr: RATE, asOf: "2026-11-11", source: "JISDOR BI" };
  const now = new Date("2026-11-11T05:00:00Z");

  it("totals tokens, USD and IDR per phase, per rulebook and for the current month", () => {
    const rows = [
      record({ id: "1", phase: "builder_compile", rulebookId: "rb1", inputTokens: 3_000, outputTokens: 1_500, usd: 0.00105 }),
      record({ id: "2", phase: "operator_draft", rulebookId: "rb1", operationId: "op1", inputTokens: 900, outputTokens: 80, usd: 0.00013 }),
      record({ id: "3", phase: "operator_classify", rulebookId: "rb1", operationId: "op1", inputTokens: 100, outputTokens: 20, usd: 0.00002, at: "2026-10-05T05:00:00.000Z" }),
      record({ id: "4", phase: "builder_compile", rulebookId: "rb2", inputTokens: 10, outputTokens: 10, usd: 0.000006 }),
    ];
    const s = summarize(rows, [], {}, now, rate);
    expect(s.month).toBe("2026-11");
    expect(s.total).toMatchObject({ calls: 4, inputTokens: 4_010, outputTokens: 1_610, unpricedCalls: 0, sampleCalls: 0 });
    expect(s.total.usd).toBeCloseTo(0.001206, 9);
    expect(s.total.idr).toBeCloseTo(0.001206 * RATE, 6);
    // The October call is in the total and not in this month.
    expect(s.thisMonth.calls).toBe(3);
    expect(s.byPhase.builder_compile.calls).toBe(2);
    expect(s.byPhase.operator_draft.calls).toBe(1);
    expect(s.thisMonthByPhase.operator_classify.calls).toBe(0);
    expect(s.byRulebook.map((r) => [r.rulebookId, r.total.calls])).toEqual([["rb1", 3], ["rb2", 1]]);
    expect(summarize(rows, [], { rulebookId: "rb1" }, now, rate).total.calls).toBe(3);
    expect(summarize(rows, [], { operationId: "op1" }, now, rate).total.calls).toBe(2);
    expect(summarize(rows, [], { rulebookId: "rb1" }, now, rate).byRulebook).toHaveLength(1);
    expect(summarize(rows, [], { month: "2026-10" }, now, rate).thisMonth.calls).toBe(1);
  });

  it("counts a month in Jakarta time (UTC+7)", () => {
    expect(monthOf("2026-10-31T16:59:00Z")).toBe("2026-10"); // 23:59 on 31 Oct in Jakarta
    expect(monthOf("2026-10-31T17:00:00Z")).toBe("2026-11"); // midnight 1 Nov in Jakarta
  });

  it("keeps unpriced calls apart: their tokens count, their cost is 'unknown', never zero", () => {
    const s = summarize([record({ provider: "groq:x", model: "x", usd: null, inputTokens: 500, outputTokens: 50 }), record({ id: "2", usd: 0.001, inputTokens: 100 })], [], {}, now, rate);
    expect(s.total).toMatchObject({ calls: 2, unpricedCalls: 1, inputTokens: 600, usd: 0.001 });
  });

  it("counts the offline sample apart, with no tokens and no cost", () => {
    const s = summarize([record({ provider: "fixture", model: "fixture", usd: 0 })], [], {}, now, rate);
    expect(s.total).toMatchObject({ calls: 0, sampleCalls: 1, usd: 0, idr: 0, inputTokens: 0 });
  });

  it("counts the steps plain code ran: actions done, not the blocked or failed ones", () => {
    const rent = { id: "op1", rulebookId: "rb1", actions: [{ outcome: "invoiced" }, { outcome: "sent" }, { outcome: "prepared" }, { outcome: "raised" }, { outcome: "blocked" }] } as never;
    const generic = { id: "op2", rulebookId: "rb1", kind: "generic", sent: [{ ok: true }, { ok: true }, { ok: false }] } as never;
    expect(stepsOf(rent)).toBe(4);
    expect(stepsOf(generic)).toBe(2);
    const s = summarize([record({ operationId: "op1", rulebookId: "rb1", phase: "operator_draft" })], [rent, generic], { rulebookId: "rb1" }, now, rate);
    expect(s.deterministicSteps).toBe(6);
    expect(s.byRulebook[0]).toMatchObject({ rulebookId: "rb1", deterministicSteps: 6 });
    expect(s.byOperation.map((o) => [o.operationId, o.steps])).toEqual([["op1", 4], ["op2", 2]]);
    expect(summarize([], [rent, generic], { operationId: "op2" }, now, rate).deterministicSteps).toBe(2);
  });
});

describe("GET /api/usage", () => {
  it("records the Builder's tokens with the rulebook, prices them, converts to Rupiah and shows the rate", async () => {
    const { call, store } = setup(ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5")]));
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    expect(rb.status).toBe(201);
    expect(store.data.usage).toHaveLength(1);
    expect(store.data.usage![0]).toMatchObject({ phase: "builder_compile", provider: HAIKU, model: "claude-haiku-5-5", inputTokens: 3_000, outputTokens: 1_500, rulebookId: rb.json.id });

    const { status, json } = await call("GET", "/usage");
    expect(status).toBe(200);
    const usd = (3_000 * 0.1 + 1_500 * 0.5) / 1_000_000;
    expect(json.total).toMatchObject({ calls: 1, inputTokens: 3_000, outputTokens: 1_500, unpricedCalls: 0 });
    expect(json.total.usd).toBeCloseTo(usd, 12);
    expect(json.total.idr).toBeCloseTo(usd * RATE, 6);
    expect(json.thisMonth.calls).toBe(1);
    expect(json.byPhase.builder_compile.calls).toBe(1);
    expect(json.byPhase.operator_draft.calls).toBe(0);
    expect(json.byRulebook).toHaveLength(1);
    expect(json.byRulebook[0].rulebookId).toBe(rb.json.id);
    // The rate and its date are always there next to the cost, and so is where the prices come from.
    expect(json.rate).toEqual({ usdIdr: 18154, asOf: "2026-11-11", source: "JISDOR BI" });
    expect(json.prices.source).toContain("platform.claude.com");

    // The same numbers, narrowed to one rulebook (path or query), and nothing for another one.
    expect((await call("GET", `/rulebooks/${rb.json.id}/usage`)).json.total.calls).toBe(1);
    expect((await call("GET", `/usage?rulebookId=${rb.json.id}`)).json.total.calls).toBe(1);
    expect((await call("GET", "/usage?rulebookId=rb_other")).json.total.calls).toBe(0);
    expect((await call("GET", "/rulebooks/rb_other/usage")).status).toBe(404);
    // A month with no calls shows zero for the month but keeps the total.
    const old = (await call("GET", "/usage?month=2020-01")).json;
    expect(old.thisMonth.calls).toBe(0);
    expect(old.total.calls).toBe(1);
    expect((await call("GET", "/usage?month=2026-13")).status).toBe(400);
    expect((await call("GET", "/usage?month=nov")).status).toBe(400);
  });

  it("converts at REEVE_USD_IDR and says which rate and date", async () => {
    const { call } = setup(ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5")]), { env: { REEVE_USD_IDR: "16000", REEVE_USD_IDR_DATE: "2026-12-01" } });
    await call("POST", "/sops", { text: loadFixtureSop() });
    const { json } = await call("GET", "/usage");
    expect(json.rate).toEqual({ usdIdr: 16000, asOf: "2026-12-01", source: "REEVE_USD_IDR" });
    expect(json.total.idr).toBeCloseTo(json.total.usd * 16000, 6);
  });

  it("the offline sample reports zero tokens and zero cost, and is not counted as a model call", async () => {
    const { call, store } = setup();
    await call("POST", "/sops", { text: loadFixtureSop() });
    expect(store.data.usage).toHaveLength(1);
    expect(store.data.usage![0]).toMatchObject({ provider: "fixture", inputTokens: 0, outputTokens: 0, usd: 0 });
    expect((await call("GET", "/usage")).json.total).toMatchObject({ calls: 0, sampleCalls: 1, usd: 0, idr: 0 });
  });

  it("a provider with no known price keeps its tokens and an unknown cost, until an override names the price", async () => {
    const unknown = setup(ProviderRegistry.of([metered("groq:llama-x", "llama-x")]), { env: {} });
    await unknown.call("POST", "/sops", { text: loadFixtureSop() });
    expect(unknown.store.data.usage![0]).toMatchObject({ provider: "groq:llama-x", inputTokens: 3_000, usd: null });
    expect((await unknown.call("GET", "/usage")).json.total).toMatchObject({ calls: 1, unpricedCalls: 1, usd: 0, inputTokens: 3_000, outputTokens: 1_500 });

    const priced = setup(ProviderRegistry.of([metered("groq:llama-x", "llama-x")]), { env: { REEVE_PRICE_OVERRIDES: '{"groq:llama-x":{"input":1,"output":2}}' } });
    await priced.call("POST", "/sops", { text: loadFixtureSop() });
    expect(priced.store.data.usage![0]!.usd).toBeCloseTo((3_000 * 1 + 1_500 * 2) / 1_000_000, 12);
  });

  it("a Builder call that fails after spending tokens is still counted, with no rulebook to blame", async () => {
    const failing: LLMProvider = {
      name: HAIKU,
      parseSop: async (_s, _p, _h, opts) => {
        opts?.onUsage?.(tokens(HAIKU, "claude-haiku-5-5", 2_000, 900));
        throw new LLMOutputError("model reply is not valid JSON");
      },
    };
    const { call, store } = setup(ProviderRegistry.of([failing]));
    expect((await call("POST", "/sops", { text: loadFixtureSop() })).status).toBe(422);
    expect(store.data.rulebooks).toEqual({});
    expect(store.data.usage).toHaveLength(1);
    expect(store.data.usage![0]!.rulebookId).toBeUndefined();
    const { json } = await call("GET", "/usage");
    expect(json.total).toMatchObject({ calls: 1, inputTokens: 2_000 });
    expect(json.byRulebook[0].rulebookId).toBeNull();
  });

  it("a revision from revised SOP text is a Builder call too, tagged with the revision", async () => {
    const { call, store } = setup(ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5")]));
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    // The metered provider replays the same rules, so the revision changes nothing (409): the cost goes to the version asked about.
    expect((await call("POST", `/rulebooks/${rb.json.id}/revisions`, { text: `${loadFixtureSop()}\n\nTambahan dari pemilik.` })).status).toBe(409);
    expect(store.data.usage).toHaveLength(2);
    expect(store.data.usage!.every((u) => u.rulebookId === rb.json.id && u.phase === "builder_compile")).toBe(true);
  });

  it("measures the Operator: one draft per message kind, one classify per reply, each tagged with the operation, against the steps code ran", async () => {
    const h = setup(ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5", [3_000, 1_500], [900, 80])]), { operatorLlm: true });
    const rb = await approvedRulebook(h);
    const op = (await h.call("POST", `/rulebooks/${rb.id}/operations`, { rail: "mock" })).json;
    expect((await h.call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" })).status).toBe(202);
    const state = await waitForOperation(h.call, op.id);
    expect(state.status).toBe("idle");
    expect(state.actions.length).toBe(30); // 30 bills, all by the rules and plain code

    expect((await h.call("POST", `/operations/${op.id}/replies`, { tenant: "K29", text: "boleh dicicil kak?" })).status).toBe(201);

    const phases = h.store.data.usage!.map((u) => u.phase);
    expect(phases.filter((p) => p === "builder_compile")).toHaveLength(1);
    expect(phases.filter((p) => p === "operator_draft")).toHaveLength(1); // 30 bills, one model call
    expect(phases.filter((p) => p === "operator_classify")).toHaveLength(1);
    const operatorRows = h.store.data.usage!.filter((u) => u.phase !== "builder_compile");
    expect(operatorRows.every((u) => u.operationId === op.id && u.rulebookId === rb.id && u.model === "claude-haiku-5-5")).toBe(true);

    const { json } = await h.call("GET", `/usage?operationId=${op.id}`);
    expect(json.total.calls).toBe(2);
    expect(json.deterministicSteps).toBe(30);
    expect(json.byOperation).toMatchObject([{ operationId: op.id, steps: 30 }]);
    const usd = (2 * (900 * 0.1 + 80 * 0.5)) / 1_000_000;
    expect(json.total.usd).toBeCloseTo(usd, 12);
    expect(json.total.idr).toBeCloseTo(usd * RATE, 6);

    // The rulebook's own view has the compile and the run side by side.
    const rbView = (await h.call("GET", `/rulebooks/${rb.id}/usage`)).json;
    expect(rbView.byPhase.builder_compile.calls).toBe(1);
    expect(rbView.byPhase.operator_draft.calls + rbView.byPhase.operator_classify.calls).toBe(2);
    expect(rbView.deterministicSteps).toBe(30);
    expect(rbView.byRulebook[0]).toMatchObject({ rulebookId: rb.id, deterministicSteps: 30 });
  });

  it("with the Operator's model switched off, the run costs no model calls at all", async () => {
    const h = setup(ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5")]));
    const rb = await approvedRulebook(h);
    const op = (await h.call("POST", `/rulebooks/${rb.id}/operations`, { rail: "mock" })).json;
    await h.call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" });
    await waitForOperation(h.call, op.id);
    const { json } = await h.call("GET", `/usage?operationId=${op.id}`);
    expect(json.total.calls).toBe(0);
    expect(json.deterministicSteps).toBe(30);
  });

  it("is behind the session like every other route, and each workspace sees only its own calls", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/v1/user")) {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "");
        return new Response(JSON.stringify({ id: `user-${token}`, email: token }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const providers = ProviderRegistry.of([metered(HAIKU, "claude-haiku-5-5")]);
    const { app } = await createAccountsApp({
      persistence: filePersistence(mkdtempSync(join(tmpdir(), "reeve-usage-"))),
      rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
      sessionSecret: "test-secret",
      supabase: { url: "https://example.supabase.co", key: "k" },
      publicHealth: () => ({}),
      workspaceApp: (id, { store, ledger }) =>
        createApp({
          store,
          ledger,
          providers,
          sandbox: new LocalSandbox(),
          scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
          defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
          rails: railEntries({}),
          tenants: () => kosMelatiScenario().tenants,
          connectors: new ConnectorRegistry([new LogConnector()]),
          sampleDataset: () => ({ name: "sample", records: bimbelRecords().records, fields: inferFields(bimbelRecords().records) }),
          rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
          account: id,
        }).fetch,
    });
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      return { status: res.status, json: (await res.json()) as any };
    };
    expect((await call("GET", "/usage")).status).toBe(401);
    expect((await call("GET", "/rulebooks/x/usage")).status).toBe(401);

    await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" });
    await call("POST", "/sops", { text: loadFixtureSop() });
    const ani = await call("GET", "/usage");
    expect(ani.json.total.calls).toBe(1);

    cookie = "";
    await call("POST", "/auth/email/verify", { access_token: "token-budi@example.com" });
    expect((await call("GET", "/usage")).json.total.calls).toBe(0);
    await call("POST", "/sops", { text: loadFixtureSop() });
    await call("POST", "/sops", { text: loadFixtureSop() });
    expect((await call("GET", "/usage")).json.total.calls).toBe(2);
  });
});
