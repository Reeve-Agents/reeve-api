import { createHash } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { parseSop } from "@reeve/builder";
import { prepareAudit } from "@reeve/auditor";
import { GenericOperator, NeedsPasskeyError, newGenericOperation, newOperation, Operator, OperatorError, type GenericOperationRecord, type OperationRecord } from "@reeve/broker";
import { AppCatalog, inferFields, parseCsv, type ConnectorRegistry } from "@reeve/connectors";
import { compareRuns, diffRulebooks, packOf, PackId, Rulebook, validateRulebook, type AnyScenario, type Tenant } from "@reeve/core";
import { PACKS } from "@reeve/core/packs";
import { CardConversionError, LLMOutputError, LLMRefusalError, UnknownProviderError, type ProviderRegistry } from "@reeve/llm";
import { genericScenario, rentScenario, repoRoot, runAttempt, runOperate, tenantsFromRecords } from "@reeve/pipeline";
import { RailConfigError, WebhookVerificationError, type PaymentRail, type RailEntry } from "@reeve/rails";
import type { ChainAnchor } from "@reeve/anchor";
import { type Ledger, merkleRoot, sha256 } from "@reeve/receipts";
import type { Sandbox } from "@reeve/sandbox";
import { newId, type DatasetRecord, type RulebookRecord, type RunRecord, type Store } from "./store";

export interface AppDeps {
  store: Store;
  /** Every SOP parser the server can use (Claude tiers, OpenAI-compatible services, the offline sample). */
  providers: ProviderRegistry;
  sandbox: Sandbox;
  ledger: Ledger;
  /** The simulated month each pack is audited against. */
  scenario: (pack: PackId) => AnyScenario;
  defaultSop: (pack: PackId) => string;
  /** Payment rails the broker can bill on (keys stay here; the studio sees only which are set up). */
  rails: RailEntry[];
  /** Who the Operator bills. Until a tenant CSV import exists, the sample business's tenants. */
  tenants: (pack: PackId) => Tenant[];
  /** Where generic rules read records and send actions: Composio, MCP servers, a log. */
  connectors: ConnectorRegistry;
  /** The sample records for a generic SOP (Bimbel Cerdas), seeded as dataset "sample". */
  sampleDataset?: () => Omit<DatasetRecord, "id" | "createdAt">;
  rp: { id: string; name: string; origin: string };
  /** Composio's public list of apps the owner can connect (defaults to the live catalog). */
  apps?: Pick<AppCatalog, "search">;
  /** Publishes ledger Merkle roots on a testnet (proof only). Off when no anchor wallet is set up. */
  anchor?: Pick<ChainAnchor, "chainName" | "chain" | "address" | "anchor" | "verify"> | null;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/** The deliberate Builder defect for "inject a bug", one per pack. */
const INJECTED_BUG = { "rent-collection": "ignore_tenure_grace", minimarket: "ignore_markdown_floor", generic: "ignore_never_rules" } as const;

export function createApp(deps: AppDeps) {
  const { store, ledger } = deps;
  const app = new Hono().basePath("/api");

  // One sandbox job at a time (CreateOS Free plan: 1 concurrent sandbox).
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch(() => undefined);
    return queue;
  };

  app.onError((err, c) => {
    if (err instanceof LLMRefusalError || err instanceof CardConversionError || err instanceof LLMOutputError) return c.json({ error: err.message }, 422);
    if (err instanceof UnknownProviderError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) =>
    c.json({ llm: deps.providers.defaultId, sandbox: deps.sandbox.name, passkeys: store.data.passkeys.length, ledgerIntact: ledger.verify() === null }),
  );

  const packParam = (value: string | undefined) => PackId.safeParse(value ?? "rent-collection");

  app.get("/fixtures/sop", (c) => {
    const pack = packParam(c.req.query("pack"));
    if (!pack.success) return c.json({ error: `unknown pack ${c.req.query("pack")}` }, 400);
    return c.json({ pack: pack.data, sop: deps.defaultSop(pack.data) });
  });

  // What the studio's pickers offer: business types (domain packs) and SOP parsers. No keys, only whether each is set up.
  app.get("/packs", (c) =>
    c.json([
      ...PACKS.map((p) => ({ id: p.id, domain: p.domain, example: p.example, entity: p.entity })),
      { id: "generic", domain: "Any SOP", example: "your own spreadsheet and apps", entity: { one: "Record", many: "Records" } },
    ]),
  );
  app.get("/connectors", (c) => c.json(deps.connectors.list()));

  // ── Every app the owner could connect (Composio's catalog), and a sign-in link per app. ──
  const apps = deps.apps ?? new AppCatalog();

  app.get("/apps", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 24) || 24, 100);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    try {
      const page = await apps.search(c.req.query("q") ?? "", limit, offset);
      return c.json({ ...page, canConnect: deps.connectors.canConnectApps() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Which of these apps the owner has an active account for (no side effects).
  app.get("/apps/status", async (c) => {
    const slugs = (c.req.query("slugs") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9_]+$/.test(x)).slice(0, 50);
    try {
      return c.json(await deps.connectors.appStatus(slugs));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Start connecting one app: returns Composio's sign-in link for the owner to open (valid about 10 minutes).
  app.post("/apps/:slug/connect", async (c) => {
    const slug = c.req.param("slug").toLowerCase();
    if (!/^[a-z0-9_]+$/.test(slug)) return c.json({ error: "bad app slug" }, 400);
    if (!deps.connectors.canConnectApps()) return c.json({ error: "no Composio key: set COMPOSIO_API_KEY in reeve/.env" }, 409);
    try {
      const r = await deps.connectors.connectApp(slug);
      return c.json({ slug, ...r, expiresInMinutes: 10 });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // ── Owners' records for generic SOPs ──
  if (deps.sampleDataset && !store.data.datasets.sample) {
    store.data.datasets.sample = { id: "sample", createdAt: new Date().toISOString(), ...deps.sampleDataset() };
    store.save();
  }
  const datasetSummary = ({ records, ...d }: DatasetRecord) => ({ ...d, count: records.length });
  app.get("/datasets", (c) => c.json(Object.values(store.data.datasets).map(datasetSummary)));
  app.get("/datasets/:id", (c) => {
    const d = store.data.datasets[c.req.param("id")];
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });
  app.post("/datasets", async (c) => {
    const { name, csv } = await c.req.json<{ name?: string; csv?: string }>();
    if (!csv || csv.length > 2_000_000) return c.json({ error: "a CSV (under 2 MB) is required" }, 400);
    const records = parseCsv(csv);
    if (records.length === 0) return c.json({ error: "the CSV has no rows under its header" }, 400);
    const id = newId("ds");
    store.data.datasets[id] = { id, name: name?.trim() || "Uploaded sheet", records, fields: inferFields(records), createdAt: new Date().toISOString() };
    store.save();
    return c.json(datasetSummary(store.data.datasets[id]!), 201);
  });

  // Records straight from a connected app's read tool: a sheet range, a Notion database, a ClickUp list, ...
  app.post("/datasets/connector", async (c) => {
    const body = await c.req.json<{ name?: string; connector?: string; tool?: string; args?: Record<string, unknown> }>();
    if (!body.tool) return c.json({ error: "tool is required (e.g. GOOGLESHEETS_VALUES_GET)" }, 400);
    let records;
    try {
      records = await deps.connectors.readRecords(body.connector ?? "", body.tool, body.args ?? {});
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
    if (records.length === 0) return c.json({ error: `${body.tool} returned no rows Reeve could read` }, 422);
    const id = newId("ds");
    store.data.datasets[id] = {
      id,
      name: body.name?.trim() || body.tool,
      records,
      fields: inferFields(records),
      source: { connector: body.connector ?? "", tool: body.tool, args: body.args ?? {} },
      createdAt: new Date().toISOString(),
    };
    store.save();
    return c.json(datasetSummary(store.data.datasets[id]!), 201);
  });

  /** Field names, types and category labels only: never names, phones or emails. */
  const hintsFor = (datasetId: string | undefined) => {
    const d = datasetId ? store.data.datasets[datasetId] : undefined;
    return { fields: d?.fields ?? [], connectors: deps.connectors.list().map((x) => x.label) };
  };
  const checkTools = (rb: Rulebook) =>
    deps.connectors.check(rb.cards.flatMap((card) => (card.type === "generic_rule" ? [{ rule: card.id, connector: card.action.connector, tool: card.action.tool, args: card.action.args.map((a) => a.name) }] : [])));

  /** The month a rulebook is audited against: its pack's sample, or for a generic SOP the owner's records. */
  /** The owner's tenants for a rent rulebook with its own data (re-read from the app when it came from one). */
  const tenantsOf = async (rb: RulebookRecord | undefined): Promise<Tenant[]> => {
    const d = rb?.datasetId ? store.data.datasets[rb.datasetId] : undefined;
    if (!rb || packOf(rb.rulebook) !== "rent-collection" || !d) return deps.tenants("rent-collection");
    if (d.source) {
      d.records = await deps.connectors.readRecords(d.source.connector, d.source.tool, d.source.args);
      store.save();
    }
    const { tenants, problems } = tenantsFromRecords(d.records);
    if (problems.length) throw new OperatorError(`the tenant data has problems: ${problems.slice(0, 3).join("; ")}`);
    return tenants;
  };

  const scenarioFor = (rb: RulebookRecord): AnyScenario => {
    if (packOf(rb.rulebook) === "rent-collection" && rb.datasetId && store.data.datasets[rb.datasetId]) {
      return rentScenario(tenantsFromRecords(store.data.datasets[rb.datasetId]!.records).tenants);
    }
    if (packOf(rb.rulebook) !== "generic") return deps.scenario(packOf(rb.rulebook));
    const d = store.data.datasets[rb.datasetId ?? "sample"];
    if (!d) throw new OperatorError(`dataset ${rb.datasetId} is gone; upload the records again`);
    return genericScenario(rb.rulebook, d.records, d.updates ?? []);
  };
  app.get("/providers", (c) => c.json({ default: deps.providers.defaultId, providers: deps.providers.list() }));

  // Phase 1: SOP → rule cards, for the chosen pack, by the chosen model
  app.post("/sops", async (c) => {
    const body = await c.req.json<{ text?: string; pack?: string; provider?: string; datasetId?: string }>();
    const text = body.text;
    if (!text || text.trim().length < 20) return c.json({ error: "SOP text is required" }, 400);
    const pack = packParam(body.pack);
    if (!pack.success) return c.json({ error: `unknown pack ${body.pack}` }, 400);
    const generic = pack.data === "generic";
    // Rent collection can bill the owner's own tenants (a sheet, a CSV, any app); without a dataset it uses the sample.
    const rentData = pack.data === "rent-collection" && body.datasetId ? body.datasetId : undefined;
    const datasetId = generic ? (body.datasetId ?? "sample") : rentData;
    if (datasetId && !store.data.datasets[datasetId]) return c.json({ error: `unknown dataset ${datasetId}` }, 400);
    if (rentData) {
      const { problems } = tenantsFromRecords(store.data.datasets[rentData]!.records);
      if (problems.length) return c.json({ error: `these rows are not tenants yet: ${problems.slice(0, 4).join("; ")}` }, 400);
    }
    const provider = deps.providers.get(body.provider || undefined);
    let parsed = await parseSop(provider, text, pack.data, generic ? hintsFor(datasetId) : undefined);
    let toolChecks = generic ? await checkTools(parsed.rulebook) : undefined;
    // Build time: if the model named a tool no connected service has (or left out what it needs), look up
    // the real tools for those rules on the connected services and let it try once more with them.
    const gaps = toolChecks?.filter((t) => t.status === "not_found" || t.status === "missing_args") ?? [];
    if (generic && gaps.length) {
      const titles = gaps.map((g) => parsed.rulebook.cards.find((c) => c.id === g.rule)?.title ?? g.tool);
      const found = (await Promise.all(titles.map((t) => deps.connectors.suggestTools(t, 4)))).flat();
      const tools = [...new Map(found.map((t) => [t.slug, t])).values()];
      if (tools.length) {
        const retry = await parseSop(provider, text, pack.data, { ...hintsFor(datasetId), tools });
        const retryChecks = await checkTools(retry.rulebook);
        const bad = (cs: typeof retryChecks) => cs.filter((t) => t.status === "not_found" || t.status === "missing_args").length;
        if (bad(retryChecks) < gaps.length) {
          parsed = retry;
          toolChecks = retryChecks;
        }
      }
    }
    const id = newId("rb");
    store.data.rulebooks[id] = {
      id,
      sop: text,
      rulebook: parsed.rulebook,
      issues: parsed.issues,
      provider: parsed.provider,
      status: "draft",
      createdAt: new Date().toISOString(),
      ...(generic ? { datasetId, toolChecks } : rentData ? { datasetId: rentData } : {}),
    };
    store.save();
    return c.json(store.data.rulebooks[id], 201);
  });

  app.get("/rulebooks", (c) =>
    c.json(
      Object.values(store.data.rulebooks)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ sop: _sop, ...rest }) => rest),
    ),
  );

  /** A rulebook with, for a revision, what changed from its parent and what that does to the month. */
  const withRevision = (rb: RulebookRecord) => {
    const lineage: string[] = [];
    for (let p = rb.parentId; p && store.data.rulebooks[p]; p = store.data.rulebooks[p]!.parentId) lineage.push(p);
    const parent = rb.parentId ? store.data.rulebooks[rb.parentId] : undefined;
    if (!parent) return { ...rb, lineage };
    const before = parent.lastRunId ? store.data.runs[parent.lastRunId]?.results?.simulation : undefined;
    const after = rb.lastRunId ? store.data.runs[rb.lastRunId]?.results?.simulation : undefined;
    return {
      ...rb,
      lineage,
      diff: diffRulebooks(parent.rulebook, rb.rulebook),
      impact: before && after ? compareRuns(before, after) : null,
    };
  };

  app.get("/rulebooks/:id", (c) => {
    const rb = store.data.rulebooks[c.req.param("id")];
    return rb ? c.json(withRevision(rb)) : c.json({ error: "not found" }, 404);
  });

  // Phase 4, Maintain: a new version of a rulebook, from a revised SOP (read by a model) or edited cards.
  // It goes through the same audit and needs its own passkey approval; the old version keeps running until then.
  app.post("/rulebooks/:id/revisions", async (c) => {
    const parent = store.data.rulebooks[c.req.param("id")];
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: string; rulebook?: unknown; provider?: string }>();
    const pack = packOf(parent.rulebook);
    let rulebook: Rulebook;
    let provider: string;
    if (body.rulebook !== undefined) {
      const parsed = Rulebook.safeParse(body.rulebook);
      if (!parsed.success) return c.json({ error: `invalid rulebook: ${parsed.error.issues[0]?.message ?? "schema"}` }, 400);
      if (packOf(parsed.data) !== pack) return c.json({ error: "a revision cannot change the business type" }, 400);
      rulebook = parsed.data;
      provider = "edited by the owner";
    } else {
      if (!body.text || body.text.trim().length < 20) return c.json({ error: "the revised SOP text is required" }, 400);
      const parsed = await parseSop(deps.providers.get(body.provider || undefined), body.text, pack, pack === "generic" ? hintsFor(parent.datasetId) : undefined);
      rulebook = parsed.rulebook;
      provider = parsed.provider;
    }
    const diff = diffRulebooks(parent.rulebook, rulebook);
    if (diff.length === 0) return c.json({ error: "no rule changed in this revision" }, 409);
    const id = newId("rb");
    store.data.rulebooks[id] = {
      id,
      sop: body.text ?? parent.sop,
      rulebook,
      issues: validateRulebook(rulebook),
      provider,
      status: "draft",
      createdAt: new Date().toISOString(),
      parentId: parent.id,
      ...(pack === "generic" ? { datasetId: parent.datasetId, toolChecks: await checkTools(rulebook) } : {}),
    };
    store.save();
    return c.json(withRevision(store.data.rulebooks[id]!), 201);
  });

  // Phase 2: compile + audit in one sandbox job (async; poll GET /runs/:id)
  app.post("/rulebooks/:id/runs", async (c) => {
    const rb = store.data.rulebooks[c.req.param("id")];
    if (!rb) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ injectBug?: boolean }>().catch(() => ({}) as { injectBug?: boolean });
    const run: RunRecord = { id: newId("run"), rulebookId: rb.id, injectBug: Boolean(body.injectBug), status: "queued", createdAt: new Date().toISOString(), log: [] };
    store.data.runs[run.id] = run;
    rb.lastRunId = run.id;
    if (rb.status === "approved") rb.status = "draft"; // any new run needs a fresh approval
    store.save();

    void enqueue(async () => {
      const started = Date.now();
      const say = (line: string) => {
        run.log.push({ ms: Date.now() - started, line });
        store.save();
      };
      run.status = "running";
      run.startedAt = new Date().toISOString();
      run.backend = deps.sandbox.name;
      say(`queued job for rulebook ${rb.id} on ${deps.sandbox.name}`);
      try {
        const attempt = await runAttempt({
          repoRoot,
          rulebook: rb.rulebook,
          scenario: scenarioFor(rb),
          sandbox: deps.sandbox,
          runId: run.id,
          bugs: run.injectBug ? [INJECTED_BUG[packOf(rb.rulebook)]] : [],
          onLog: say,
        });
        run.rulesPy = attempt.compiled.files["rules.py"];
        run.sandboxId = attempt.run.sandboxId;
        run.results = attempt.results;
        run.verdict = attempt.verdict;
        run.receipt = attempt.receipt;
        const entry = ledger.append({ kind: "receipt", at: attempt.receipt.created_at, receipt_hash: attempt.receipt.receipt_hash, run_id: run.id, verdict: attempt.verdict.status });
        run.ledgerSeq = entry.seq;
        const receipts = ledger.entries().flatMap((e) => (e.kind === "receipt" ? [e.receipt_hash] : []));
        const root = merkleRoot(receipts);
        const anchor = ledger.append({ kind: "anchor", at: new Date().toISOString(), merkle_root: root, leaves: receipts.length, anchor: "local-ledger" });
        say(`receipt ${attempt.receipt.receipt_hash.slice(0, 16)}… → ledger #${entry.seq}; merkle root ${root.slice(0, 16)}… → ledger #${anchor.seq}`);
        say(`auditor verdict: ${attempt.verdict.status.toUpperCase()}`);
        rb.status = attempt.verdict.status === "pass" ? "audited" : "draft";
        run.status = "done";
      } catch (err) {
        run.status = "error";
        run.error = err instanceof Error ? err.message : String(err);
        say(`error: ${run.error}`);
      } finally {
        run.finishedAt = new Date().toISOString();
        store.save();
      }
    });
    return c.json(run, 202);
  });

  app.get("/runs/:id", (c) => {
    const run = store.data.runs[c.req.param("id")];
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.get("/ledger", (c) => {
    const entries = ledger.entries();
    const lastAnchor = [...entries].reverse().find((e) => e.kind === "anchor");
    return c.json({ intact: ledger.verify() === null, entries: entries.slice(-50).reverse(), merkleRoot: lastAnchor?.kind === "anchor" ? lastAnchor.merkle_root : null });
  });

  // ── On-chain anchor: the ledger's Merkle root published on a testnet, so anyone can check it. ──

  app.get("/anchor", (c) => {
    const a = deps.anchor;
    if (!a) return c.json({ configured: false, setup: "run `npm run anchor:wallet`, fund the printed address from the testnet faucet, restart the API" });
    const explorer = a.chain.blockExplorers?.default.url;
    return c.json({ configured: true, chain: a.chainName, chainId: a.chain.id, address: a.address, explorer: explorer ? `${explorer}/address/${a.address}` : null });
  });

  app.post("/ledger/anchor", async (c) => {
    if (!deps.anchor) return c.json({ error: "no anchor wallet: run `npm run anchor:wallet`, fund the address from the testnet faucet, restart the API" }, 409);
    const receipts = ledger.entries().flatMap((e) => (e.kind === "receipt" ? [e.receipt_hash] : []));
    if (receipts.length === 0) return c.json({ error: "no receipts to anchor yet" }, 409);
    const root = merkleRoot(receipts);
    let published;
    try {
      published = await deps.anchor.anchor(root, receipts.length);
    } catch (err) {
      return c.json({ error: `anchor failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
    const entry = ledger.append({
      kind: "anchor",
      at: new Date().toISOString(),
      merkle_root: root,
      leaves: receipts.length,
      anchor: published.chain,
      chain_id: published.chainId,
      tx: published.tx,
      from: published.from,
      explorer: published.explorer,
    });
    return c.json(entry, 201);
  });

  // Check an anchor two ways: the root still matches the receipts before it, and the chain carries that root.
  app.get("/ledger/anchors/:seq/verify", async (c) => {
    const seq = Number(c.req.param("seq"));
    const entries = ledger.entries();
    const entry = entries.find((e) => e.seq === seq);
    if (!entry || entry.kind !== "anchor") return c.json({ error: "no anchor entry at that position" }, 404);
    const receipts = entries.filter((e) => e.seq < seq).flatMap((e) => (e.kind === "receipt" ? [e.receipt_hash] : []));
    const local = merkleRoot(receipts.slice(0, entry.leaves)) === entry.merkle_root && ledger.verify() === null;
    if (!entry.tx) return c.json({ seq, local, onChain: null, reason: "anchored in the local ledger only" });
    if (!deps.anchor || deps.anchor.chainName !== entry.anchor) return c.json({ error: `this API has no ${entry.anchor} anchor wallet to read with` }, 409);
    try {
      const onChain = await deps.anchor.verify(entry.tx as `0x${string}`, entry.merkle_root);
      return c.json({ seq, local, onChain, tx: entry.tx, explorer: entry.explorer });
    } catch (err) {
      return c.json({ error: `could not read the chain: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  });

  // Owner passkey (WebAuthn). Mera's PRF-derived vault keys layer on top of this later.
  app.get("/passkeys", (c) => c.json({ registered: store.data.passkeys.length > 0, count: store.data.passkeys.length }));

  app.post("/passkeys/register/options", async (c) => {
    const options = await generateRegistrationOptions({
      rpName: deps.rp.name,
      rpID: deps.rp.id,
      userName: "owner",
      userDisplayName: "Business owner",
      userID: Buffer.from(store.data.ownerUserId, "base64url"),
      attestationType: "none",
      excludeCredentials: store.data.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    store.data.challenges.registration = { challenge: options.challenge, at: Date.now() };
    store.save();
    return c.json(options);
  });

  app.post("/passkeys/register/verify", async (c) => {
    const pending = store.data.challenges.registration;
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return c.json({ error: "registration expired, start again" }, 400);
    const { response } = await c.req.json<{ response: Parameters<typeof verifyRegistrationResponse>[0]["response"] }>();
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: deps.rp.origin,
      expectedRPID: deps.rp.id,
      requireUserVerification: true,
    });
    delete store.data.challenges.registration;
    if (!result.verified) {
      store.save();
      return c.json({ error: "passkey could not be verified" }, 400);
    }
    const cred = result.registrationInfo.credential;
    store.data.passkeys.push({ id: cred.id, publicKey: Buffer.from(cred.publicKey).toString("base64url"), counter: cred.counter, transports: cred.transports, createdAt: new Date().toISOString() });
    store.save();
    return c.json({ registered: true, count: store.data.passkeys.length });
  });

  // Phase 2 → 3: the owner approves exactly the audited run. The WebAuthn challenge commits to its receipt hash.
  app.post("/rulebooks/:id/approve/options", async (c) => {
    const rb = store.data.rulebooks[c.req.param("id")];
    if (!rb) return c.json({ error: "not found" }, 404);
    const run = rb.lastRunId ? store.data.runs[rb.lastRunId] : undefined;
    if (!run || run.status !== "done" || run.verdict?.status !== "pass" || !run.receipt) {
      return c.json({ error: "only a rulebook whose latest run passed the Auditor can be approved" }, 409);
    }
    if (store.data.passkeys.length === 0) return c.json({ error: "register the owner's passkey first" }, 409);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const challenge = createHash("sha256").update(run.receipt.receipt_hash).update(nonce).digest();
    const options = await generateAuthenticationOptions({
      rpID: deps.rp.id,
      challenge: new Uint8Array(challenge),
      userVerification: "required",
      allowCredentials: store.data.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    store.data.challenges.approvals[rb.id] = { challenge: options.challenge, receiptHash: run.receipt.receipt_hash, runId: run.id, at: Date.now() };
    store.save();
    return c.json({ options, receiptHash: run.receipt.receipt_hash });
  });

  app.post("/rulebooks/:id/approve/verify", async (c) => {
    const rb = store.data.rulebooks[c.req.param("id")];
    if (!rb) return c.json({ error: "not found" }, 404);
    const pending = store.data.challenges.approvals[rb.id];
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return c.json({ error: "approval expired, start again" }, 400);
    if (rb.lastRunId !== pending.runId) return c.json({ error: "a newer run exists; approve that one" }, 409);
    const { response } = await c.req.json<{ response: Parameters<typeof verifyAuthenticationResponse>[0]["response"] }>();
    const passkey = store.data.passkeys.find((p) => p.id === response.id);
    if (!passkey) return c.json({ error: "unknown passkey" }, 400);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: deps.rp.origin,
      expectedRPID: deps.rp.id,
      credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    });
    delete store.data.challenges.approvals[rb.id];
    if (!result.verified) {
      store.save();
      return c.json({ error: "passkey could not be verified" }, 400);
    }
    passkey.counter = result.authenticationInfo.newCounter;
    const entry = ledger.append({ kind: "approval", at: new Date().toISOString(), rulebook_id: rb.id, receipt_hash: pending.receiptHash, credential_id: passkey.id });
    rb.status = "approved";
    store.supersedeAncestors(rb.id);
    rb.approval = { at: entry.at, credentialId: passkey.id, receiptHash: pending.receiptHash, ledgerSeq: entry.seq };
    store.save();
    return c.json(rb);
  });

  // ── Phase 3: Run. The broker bills on a real payment rail (test mode) what the approved rules decide. ──

  const railCache = new Map<string, PaymentRail>();
  const railFor = (id: string): PaymentRail => {
    const entry = deps.rails.find((r) => r.info.id === id);
    if (!entry) throw new OperatorError(`unknown rail ${id}`);
    if (!entry.info.available) throw new OperatorError(`${entry.info.label} is not set up: add ${entry.info.setup} to reeve/.env`);
    let rail = railCache.get(id);
    if (!rail) railCache.set(id, (rail = entry.create()));
    return rail;
  };

  /** Everything the Operator needs for one operation, re-checked on every call. */
  const operatorFor = (op: OperationRecord, onLog?: (line: string) => void) => {
    const rb = store.data.rulebooks[op.rulebookId];
    const run = rb?.lastRunId ? store.data.runs[rb.lastRunId] : undefined;
    if (rb?.status === "superseded") throw new OperatorError("the rules were revised and the revision approved: switch this run to the new rules first");
    if (!rb || rb.status !== "approved" || rb.approval?.receiptHash !== op.receiptHash || !run?.rulesPy || run.receipt?.receipt_hash !== op.receiptHash) {
      throw new OperatorError("this operation's rulebook is no longer the approved one; start a new run from the approved rulebook");
    }
    const rulesPy = run.rulesPy;
    // The sandbox runs exactly the code the Auditor passed and the owner approved.
    if (sha256(rulesPy) !== run.receipt.files["rules.py"]) throw new OperatorError("rules.py does not match the approved receipt");
    const constraintsJson = prepareAudit(rb.rulebook, rulesPy).files["constraints.json"]!;
    // The roster snapshot taken when this run started; runs from before that change fall back to the sample.
    const roster = op.tenants.every((t) => t.rent !== undefined && t.move_in) ? (op.tenants as Tenant[]) : deps.tenants(packOf(rb.rulebook));
    return new Operator(op, rb.rulebook, roster, {
      rail: railFor(op.rail),
      runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: deps.sandbox, onLog }),
      record: (b) => ledger.append({ kind: "operation", at: new Date().toISOString(), operation_id: op.id, rail: op.rail, receipt_hash: op.receiptHash, ...b }),
      save: () => store.save(),
    });
  };

  const operationError = (c: { json: (b: unknown, s: 400 | 403 | 404 | 409 | 502) => Response }, err: unknown) => {
    if (err instanceof NeedsPasskeyError) return c.json({ error: err.message, needsPasskey: true }, 403);
    if (err instanceof OperatorError || err instanceof RailConfigError) return c.json({ error: err.message }, 409);
    return c.json({ error: `rail error: ${err instanceof Error ? err.message : String(err)}` }, 502);
  };

  app.get("/rails", (c) => c.json(deps.rails.map((r) => r.info)));

  app.get("/operations", (c) =>
    c.json(
      [...Object.values(store.data.operations), ...Object.values(store.data.genericOperations)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20),
    ),
  );

  app.get("/operations/:id", (c) => {
    const op = store.data.operations[c.req.param("id")] ?? store.data.genericOperations[c.req.param("id")];
    return op ? c.json(op) : c.json({ error: "not found" }, 404);
  });

  // Start a run of the approved rulebook on a rail. Nothing is billed until the clock advances.
  app.post("/rulebooks/:id/operations", async (c) => {
    const rb = store.data.rulebooks[c.req.param("id")];
    if (!rb) return c.json({ error: "not found" }, 404);
    if (rb.status !== "approved" || !rb.approval) return c.json({ error: "only a rulebook the owner approved with a passkey can run" }, 409);
    if (packOf(rb.rulebook) === "generic") {
      const op = newGenericOperation({ id: newId("op"), rulebookId: rb.id, receiptHash: rb.approval.receiptHash, datasetId: rb.datasetId ?? "sample", startDate: new Date().toISOString().slice(0, 10) });
      store.data.genericOperations[op.id] = op;
      store.save();
      return c.json(op, 201);
    }
    if (packOf(rb.rulebook) !== "rent-collection") return c.json({ error: "running on a payment rail is built for rent collection so far; minimarket purchase orders come next" }, 409);
    const run = rb.lastRunId ? store.data.runs[rb.lastRunId] : undefined;
    if (!run?.receipt || run.receipt.receipt_hash !== rb.approval.receiptHash) return c.json({ error: "the approved run is missing" }, 409);
    const { rail } = await c.req.json<{ rail?: string }>().catch(() => ({ rail: undefined }));
    try {
      railFor(rail ?? "mock");
    } catch (err) {
      return operationError(c, err);
    }
    let roster: Tenant[];
    try {
      roster = await tenantsOf(rb);
    } catch (err) {
      return operationError(c, err);
    }
    const firstInvoice = run.results?.simulation.events.find((e) => e.type === "invoice")?.date;
    const op = newOperation({
      id: newId("op"),
      rulebookId: rb.id,
      receiptHash: rb.approval.receiptHash,
      rail: rail ?? "mock",
      startDate: firstInvoice ?? deps.scenario("rent-collection").start_date,
      tenants: roster,
    });
    store.data.operations[op.id] = op;
    store.save();
    return c.json(op, 201);
  });

  // Move Reeve's business clock forward: the approved rules run in the sandbox, then the broker bills.
  app.post("/operations/:id/advance", async (c, next) => {
    if (store.data.genericOperations[c.req.param("id")]) return next();
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    if (op.status === "running") return c.json({ error: "this operation is already running" }, 409);
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({ to: undefined }));
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return c.json({ error: "to (YYYY-MM-DD) is required" }, 400);
    let operator: Operator;
    try {
      operator = operatorFor(op, (line) => op.log.push({ at: new Date().toISOString(), line }));
    } catch (err) {
      return operationError(c, err);
    }
    op.status = "running";
    delete op.error;
    store.save();
    void enqueue(async () => {
      try {
        await operator.advance(to);
        op.status = "idle";
      } catch (err) {
        op.status = "error";
        op.error = err instanceof Error ? err.message : String(err);
      } finally {
        store.save();
      }
    });
    return c.json(op, 202);
  });

  // Phase 4: move a live run onto the approved revision. The clock, bills and payments stay; from the next
  // business day on, the new rules decide. Past days are not re-billed.
  app.post("/operations/:id/upgrade", (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    if (op.status === "running") return c.json({ error: "wait for the current step to finish" }, 409);
    let rb = store.data.rulebooks[op.rulebookId];
    while (rb?.supersededBy && store.data.rulebooks[rb.supersededBy]) rb = store.data.rulebooks[rb.supersededBy];
    if (!rb || rb.id === op.rulebookId || rb.status !== "approved" || !rb.approval) return c.json({ error: "there is no newer approved version of these rules" }, 409);
    const from = op.rulebookId;
    op.rulebookId = rb.id;
    op.receiptHash = rb.approval.receiptHash;
    op.log.push({ at: new Date().toISOString(), line: `switched to the approved revision ${rb.id} (was ${from}); the new rules decide from the next business day` });
    ledger.append({ kind: "operation", at: new Date().toISOString(), operation_id: op.id, rail: op.rail, receipt_hash: op.receiptHash, event: "rules_upgraded", ref: `${from}→${rb.id}` });
    store.save();
    return c.json(op);
  });

  // Ask the rail which bills are paid (local runs have no public webhook URL).
  app.post("/operations/:id/refresh", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    try {
      const paid = await operatorFor(op).refresh();
      return c.json({ paid, operation: op });
    } catch (err) {
      return operationError(c, err);
    }
  });

  // Test mode: pay one bill as the tenant would (Stripe test card; Xendit after a channel was picked).
  app.post("/operations/:id/invoices/:invoiceId/simulate-payment", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    try {
      await operatorFor(op).simulatePayment(c.req.param("invoiceId"));
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  // A bank transfer the owner saw outside the rail; paying twice this way shows the overpayment rule.
  app.post("/operations/:id/transfers", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    const { tenant, amount } = await c.req.json<{ tenant?: string; amount?: number }>();
    try {
      operatorFor(op).recordTransfer(String(tenant), Number(amount));
      return c.json(op, 201);
    } catch (err) {
      return operationError(c, err);
    }
  });

  app.post("/operations/:id/exceptions/:exId/keep", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    try {
      operatorFor(op).keepCredit(c.req.param("exId"));
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  // A refund within the rulebook's limit: no passkey. Above it, use /refund/options + /refund/verify.
  app.post("/operations/:id/exceptions/:exId/refund", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    try {
      await operatorFor(op).refund(c.req.param("exId"), false);
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  app.post("/operations/:id/exceptions/:exId/refund/options", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    const ex = op?.exceptions.find((x) => x.id === c.req.param("exId"));
    if (!op || !ex) return c.json({ error: "not found" }, 404);
    if (ex.status !== "open") return c.json({ error: `already ${ex.status}` }, 409);
    if (store.data.passkeys.length === 0) return c.json({ error: "register the owner's passkey first" }, 409);
    // The challenge commits to this operation, this exception and this amount.
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const challenge = createHash("sha256").update(`${op.id}|${ex.id}|${ex.tenant}|${ex.amount}`).update(nonce).digest();
    const options = await generateAuthenticationOptions({
      rpID: deps.rp.id,
      challenge: new Uint8Array(challenge),
      userVerification: "required",
      allowCredentials: store.data.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    store.data.challenges.refunds[`${op.id}:${ex.id}`] = { challenge: options.challenge, amount: ex.amount, at: Date.now() };
    store.save();
    return c.json({ options, amount: ex.amount, tenant: ex.tenant });
  });

  app.post("/operations/:id/exceptions/:exId/refund/verify", async (c) => {
    const op = store.data.operations[c.req.param("id")];
    const ex = op?.exceptions.find((x) => x.id === c.req.param("exId"));
    if (!op || !ex) return c.json({ error: "not found" }, 404);
    const key = `${op.id}:${ex.id}`;
    const pending = store.data.challenges.refunds[key];
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS || pending.amount !== ex.amount) return c.json({ error: "refund approval expired, start again" }, 400);
    const { response } = await c.req.json<{ response: Parameters<typeof verifyAuthenticationResponse>[0]["response"] }>();
    const passkey = store.data.passkeys.find((p) => p.id === response.id);
    if (!passkey) return c.json({ error: "unknown passkey" }, 400);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: deps.rp.origin,
      expectedRPID: deps.rp.id,
      credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    });
    delete store.data.challenges.refunds[key];
    store.save();
    if (!result.verified) return c.json({ error: "passkey could not be verified" }, 400);
    passkey.counter = result.authenticationInfo.newCounter;
    try {
      await operatorFor(op).refund(ex.id, true);
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  // ── Generic runs: the approved rules' tool calls go out through the connector registry. ──

  const genericOperatorFor = (op: GenericOperationRecord) => {
    const rb = store.data.rulebooks[op.rulebookId];
    const run = rb?.lastRunId ? store.data.runs[rb.lastRunId] : undefined;
    if (!rb || rb.status !== "approved" || rb.approval?.receiptHash !== op.receiptHash || !run?.rulesPy || run.receipt?.receipt_hash !== op.receiptHash) {
      throw new OperatorError("this run's rulebook is no longer the approved one; start a new run from the approved rulebook");
    }
    const rulesPy = run.rulesPy;
    if (sha256(rulesPy) !== run.receipt.files["rules.py"]) throw new OperatorError("rules.py does not match the approved receipt");
    const constraintsJson = prepareAudit(rb.rulebook, rulesPy).files["constraints.json"]!;
    return new GenericOperator(op, rb.rulebook, {
      runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: deps.sandbox, onLog: (line) => op.log.push({ at: new Date().toISOString(), line }) }),
      execute: (connector, tool, args) => deps.connectors.execute(connector, tool, args),
      // A dataset read from an app is read again on every step, so the rules see today's rows.
      records: async () => {
        const d = store.data.datasets[op.datasetId];
        if (!d) throw new OperatorError(`dataset ${op.datasetId} is gone`);
        if (!d.source) return d.records;
        d.records = await deps.connectors.readRecords(d.source.connector, d.source.tool, d.source.args);
        store.save();
        return d.records;
      },
      record: (b) => ledger.append({ kind: "operation", at: new Date().toISOString(), operation_id: op.id, rail: "connectors", receipt_hash: op.receiptHash, ...b }),
      save: () => store.save(),
    });
  };

  app.post("/operations/:id/advance", async (c) => {
    const op = store.data.genericOperations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    if (op.status === "running") return c.json({ error: "this run is already running" }, 409);
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({ to: undefined }));
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return c.json({ error: "to (YYYY-MM-DD) is required" }, 400);
    let operator: GenericOperator;
    try {
      operator = genericOperatorFor(op);
    } catch (err) {
      return operationError(c, err);
    }
    op.status = "running";
    delete op.error;
    store.save();
    void enqueue(async () => {
      try {
        await operator.advance(to);
        op.status = "idle";
      } catch (err) {
        op.status = "error";
        op.error = err instanceof Error ? err.message : String(err);
      } finally {
        store.save();
      }
    });
    return c.json(op, 202);
  });

  app.post("/operations/:id/held/:hid/decline", (c) => {
    const op = store.data.genericOperations[c.req.param("id")];
    if (!op) return c.json({ error: "not found" }, 404);
    try {
      genericOperatorFor(op).decline(c.req.param("hid"));
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  // Sending an action above the rulebook's limit: the passkey challenge commits to that exact action.
  app.post("/operations/:id/held/:hid/approve/options", async (c) => {
    const op = store.data.genericOperations[c.req.param("id")];
    const h = op?.held.find((x) => x.id === c.req.param("hid"));
    if (!op || !h) return c.json({ error: "not found" }, 404);
    if (h.status !== "open" || h.kind !== "approval_request") return c.json({ error: "nothing to approve" }, 409);
    if (store.data.passkeys.length === 0) return c.json({ error: "register the owner's passkey first" }, 409);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const challenge = createHash("sha256").update(`${op.id}|${h.id}|${h.tool}|${JSON.stringify(h.args)}|${h.amount}`).update(nonce).digest();
    const options = await generateAuthenticationOptions({
      rpID: deps.rp.id,
      challenge: new Uint8Array(challenge),
      userVerification: "required",
      allowCredentials: store.data.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    store.data.challenges.refunds[`${op.id}:${h.id}`] = { challenge: options.challenge, amount: h.amount ?? 0, at: Date.now() };
    store.save();
    return c.json({ options, amount: h.amount, tool: h.tool });
  });

  app.post("/operations/:id/held/:hid/approve/verify", async (c) => {
    const op = store.data.genericOperations[c.req.param("id")];
    const h = op?.held.find((x) => x.id === c.req.param("hid"));
    if (!op || !h) return c.json({ error: "not found" }, 404);
    const key = `${op.id}:${h.id}`;
    const pending = store.data.challenges.refunds[key];
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return c.json({ error: "approval expired, start again" }, 400);
    const { response } = await c.req.json<{ response: Parameters<typeof verifyAuthenticationResponse>[0]["response"] }>();
    const passkey = store.data.passkeys.find((p) => p.id === response.id);
    if (!passkey) return c.json({ error: "unknown passkey" }, 400);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: deps.rp.origin,
      expectedRPID: deps.rp.id,
      credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    });
    delete store.data.challenges.refunds[key];
    store.save();
    if (!result.verified) return c.json({ error: "passkey could not be verified" }, 400);
    passkey.counter = result.authenticationInfo.newCounter;
    try {
      await genericOperatorFor(op).approve(h.id, true);
      return c.json(op);
    } catch (err) {
      return operationError(c, err);
    }
  });

  // Rail webhooks: verified with the rail's secret, matched to the operation that sent the bill.
  app.post("/webhooks/:rail", async (c) => {
    const id = c.req.param("rail");
    const raw = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let event;
    try {
      event = railFor(id).parseWebhook(raw, headers);
    } catch (err) {
      if (err instanceof WebhookVerificationError) return c.json({ error: err.message }, 400);
      return operationError(c, err);
    }
    if (!event) return c.json({ ignored: true });
    for (const op of Object.values(store.data.operations).filter((o) => o.rail === id)) {
      if (!op.invoices.some((i) => i.invoiceId === event.invoiceId)) continue;
      try {
        operatorFor(op).handleEvent(event);
      } catch (err) {
        return operationError(c, err);
      }
      return c.json({ received: true, operation: op.id });
    }
    return c.json({ ignored: true, reason: "no operation sent this bill" });
  });

  return app;
}
