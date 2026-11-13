import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PackId } from "@reeve/core";
import { FixtureProvider, ProviderRegistry } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { ConnectorRegistry, inferFields, LogConnector } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import { createApp } from "../src/app";
import { businessDate, dueTarget, schedulerFromEnv, type SchedulerConfig } from "../src/scheduler";
import { Store } from "../src/store";

const fixtures = Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f));

describe("scheduler config and clock", () => {
  it("is off by default; demo speed and tick come from the environment", () => {
    expect(schedulerFromEnv({}).enabled).toBe(false);
    expect(schedulerFromEnv({}).daySeconds).toBe(86_400);
    const demo = schedulerFromEnv({ REEVE_SCHEDULER: "on", REEVE_SCHEDULER_DAY_SECONDS: "30" });
    expect(demo).toMatchObject({ enabled: true, daySeconds: 30, tickMs: 15_000 });
    expect(schedulerFromEnv({ REEVE_SCHEDULER: "on", REEVE_SCHEDULER_DAY_SECONDS: "junk" }).daySeconds).toBe(86_400);
    expect(schedulerFromEnv({ REEVE_SCHEDULER: "on", REEVE_SCHEDULER_DAY_SECONDS: "2" }).tickMs).toBe(1_000);
  });

  it("maps real time to business days from the start date", () => {
    const op = { startDate: "2026-11-01", createdAt: "2026-11-10T00:00:00.000Z", clock: null as string | null, status: "idle" };
    const t0 = Date.parse(op.createdAt);
    expect(businessDate(op, t0, 30)).toBe("2026-11-01");
    expect(businessDate(op, t0 + 95_000, 30)).toBe("2026-11-04"); // 3 whole 30 s days
    expect(businessDate(op, t0 + 86_400_000, 86_400)).toBe("2026-11-02");
    const cfg: SchedulerConfig = { enabled: true, daySeconds: 30, tickMs: 1000, maxFailures: 3 };
    expect(dueTarget(op, cfg, t0)).toBe("2026-11-01");
    expect(dueTarget({ ...op, clock: "2026-11-01" }, cfg, t0)).toBeNull(); // already there
    expect(dueTarget({ ...op, status: "running" }, cfg, t0 + 95_000)).toBeNull();
    expect(dueTarget({ ...op, scheduler: { failures: 3, paused: true } }, cfg, t0 + 95_000)).toBeNull();
  });
});

describe("scheduler tick", () => {
  it("advances a rent operation on its own at demo speed, shows its state in the operation JSON, and leaves the manual endpoint working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reeve-sched-"));
    const store = new Store(null);
    const app = createApp({
      store,
      providers: ProviderRegistry.of([new FixtureProvider(fixtures)]),
      sandbox: new LocalSandbox(),
      ledger: new Ledger(join(dir, "ledger.jsonl")),
      scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
      defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
      rails: railEntries({}),
      tenants: () => kosMelatiScenario().tenants,
      connectors: new ConnectorRegistry([new LogConnector()]),
      sampleDataset: () => ({ name: "sample", ...bimbelRecords(), fields: inferFields(bimbelRecords().records) }),
      rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
      // Enabled config, but tests drive tick() themselves: the interval is far longer than the test.
      scheduler: { enabled: true, daySeconds: 10, tickMs: 3_600_000, maxFailures: 2 },
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, {});
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = (await call("GET", `/runs/${started.json.id}`)).json;
      if (run.status === "done" || run.status === "error") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run.status).toBe("done");
    Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "c", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
    const op = (await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" })).json;
    expect(op.startDate).toBe("2026-11-01");
    const t0 = Date.parse(op.createdAt);

    // Day 0 (the 1st): the first bills go out without anyone calling advance.
    expect(await app.schedulerTick(t0)).toEqual([op.id]);
    let state = (await call("GET", `/operations/${op.id}`)).json;
    expect(state.clock).toBe("2026-11-01");
    expect(state.status).toBe("idle");
    expect(state.invoices.length).toBeGreaterThan(0);
    expect(state.scheduler).toMatchObject({ enabled: true, daySeconds: 10, failures: 0, lastTarget: "2026-11-01" });
    expect(state.scheduler.nextDayAt).toBeTruthy();

    // Nothing new is due until the next business day starts.
    expect(await app.schedulerTick(t0 + 5_000)).toEqual([]);
    // 25 s later, business day 3 (the 3rd +... 2 whole days → the 3rd): the clock catches up in one step.
    expect(await app.schedulerTick(t0 + 25_000)).toEqual([op.id]);
    state = (await call("GET", `/operations/${op.id}`)).json;
    expect(state.clock).toBe("2026-11-03");
    expect(state.scheduler.lastTarget).toBe("2026-11-03");

    // The list endpoint and the manual endpoint still work.
    expect((await call("GET", "/operations")).json[0].scheduler.enabled).toBe(true);
    expect((await call("GET", "/scheduler")).json).toEqual({ enabled: true, daySeconds: 10, tickMs: 3_600_000 });
    expect((await call("POST", `/operations/${op.id}/advance`, { to: "2026-11-04" })).status).toBe(202);
  });

  it("runs operations independently, never twice at once, picks up new ones next tick, and drafts once per kind (30-tenant kos, fake model)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reeve-sched2-"));
    const store = new Store(null);
    const prompts: string[] = [];
    const fake = Object.assign(new FixtureProvider(fixtures), {
      completeText: async (_s: string, user: string) => (prompts.push(user), "Halo Kak {{name}}, kamar {{room}}: {{amount}}. {{link}}"),
    });
    const app = createApp({
      store,
      providers: ProviderRegistry.of([fake]),
      sandbox: new LocalSandbox(),
      ledger: new Ledger(join(dir, "ledger.jsonl")),
      scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
      defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
      rails: railEntries({}),
      tenants: () => kosMelatiScenario().tenants,
      connectors: new ConnectorRegistry([new LogConnector()]),
      sampleDataset: () => ({ name: "sample", ...bimbelRecords(), fields: inferFields(bimbelRecords().records) }),
      rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
      operatorLlm: true,
      scheduler: { enabled: true, daySeconds: 10, tickMs: 3_600_000, maxFailures: 2 },
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const rb = await call("POST", "/sops", { text: loadFixtureSop() });
    const started = await call("POST", `/rulebooks/${rb.json.id}/runs`, {});
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = (await call("GET", `/runs/${started.json.id}`)).json;
      if (run.status === "done" || run.status === "error") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run.status).toBe("done");
    Object.assign(store.data.rulebooks[rb.json.id]!, { status: "approved", approval: { at: "", credentialId: "c", receiptHash: run.receipt.receipt_hash, ledgerSeq: 0 } });
    const first = (await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" })).json;
    const t0 = Date.parse(first.createdAt);

    // The same operation is never advanced twice at once: of two overlapping ticks, only one takes it.
    const started0 = Date.now();
    const [a, b] = await Promise.all([app.schedulerTick(t0), app.schedulerTick(t0)]);
    const ms = Date.now() - started0;
    expect([...a, ...b]).toEqual([first.id]);
    const state = (await call("GET", `/operations/${first.id}`)).json;
    expect(state.invoices.length).toBeGreaterThanOrEqual(30);
    // One draft per message kind on that advance, not one per bill, and the model never saw a tenant.
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(6);
    expect(prompts.join("\n")).not.toMatch(/Rp[1-9]/);
    console.log(`30-tenant kos advance with fake model: ${ms} ms, ${state.invoices.length} bills, ${prompts.length} model calls`);

    // An operation created after the tick began is picked up by the next tick, independently of the first.
    const second = (await call("POST", `/rulebooks/${rb.json.id}/operations`, { rail: "mock" })).json;
    const advanced = await app.schedulerTick(Date.parse(second.createdAt) + 25_000);
    expect(advanced).toContain(second.id);
  });
});
