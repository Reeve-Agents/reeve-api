import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { anchorFromEnv, encodeAnchor } from "@reeve/anchor";
import type { PackId } from "@reeve/core";
import { ProviderRegistry } from "@reeve/llm";
import { bimbelRecords, kosMelatiScenario, loadFixtureRulebook, loadFixtureSop, minimarketScenario, PACK_FIXTURE, repoRoot, runAttempt } from "@reeve/pipeline";
import { connectorsFromEnv, inferFields } from "@reeve/connectors";
import { railEntries } from "@reeve/rails";
import { sandboxFromEnv, type Sandbox } from "@reeve/sandbox";
import { createAccountsApp } from "./accounts";
import { askLlmFromEnv } from "./ask-llm";
import { createApp } from "./app";
import { createMekoApp, createMekoOwnerApp, createMekoTickApp, mekoOpener } from "./meko";
import { digestSenderFromEnv, liveExecutor, loadBillBook, wibDate } from "@reeve/crew";
import { startMekoTicker } from "./meko-ticker";
import { mekoTelegram } from "./meko-telegram";
import { connectMeko, mekoEndpointFromEnv } from "@reeve/meko";
import { schedulerFromEnv } from "./scheduler";
import { filePersistence } from "./persistence";
import { openPostgres } from "./pg";

const home = resolve(repoRoot, process.env.REEVE_HOME ?? ".reeve");
const port = Number(process.env.REEVE_API_PORT ?? 8787);
const origin = process.env.REEVE_WEB_ORIGIN ?? "http://localhost:5173";
const rp = { id: new URL(origin).hostname, name: "Reeve", origin };

// REEVE_LLM picks the default parser; every other configured one stays selectable per SOP.
const providers = ProviderRegistry.fromEnv(Object.values(PACK_FIXTURE).map((f) => loadFixtureRulebook(f)));

// One sandbox job at a time across every account (CreateOS Free plan: 1 concurrent sandbox).
const base = sandboxFromEnv();
let turn: Promise<unknown> = Promise.resolve();
const sandbox: Sandbox = {
  name: base.name,
  runJob: (bundle, onLog) => {
    const job = turn.then(() => base.runJob(bundle, onLog));
    turn = job.catch(() => undefined);
    return job;
  },
};
const rails = railEntries();
const anchor = anchorFromEnv();

// DATABASE_URL (a deployment): accounts, stores and ledgers live in Postgres. Otherwise files under REEVE_HOME.
const persistence = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : filePersistence(home);

// Supabase Auth sends the magic links (SUPABASE_URL plus a secret or service-role key).
const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = process.env.SUPABASE_URL && supabaseKey ? { url: process.env.SUPABASE_URL.replace(/\/$/, ""), key: supabaseKey } : null;

// REEVE_SCHEDULER=on advances every operation by itself; REEVE_SCHEDULER_DAY_SECONDS=30 shows a business day every 30 seconds.
const scheduler = schedulerFromEnv();

// Meko demo workspace (pseudonymised Kos Melati traces), public and read-only at /api/meko/public/*.
// Local Meko by default; Meko Cloud with MEKO_API_KEY. Seed it with `npm run crew:demo`.
const mekoWorkspace = process.env.REEVE_MEKO_WORKSPACE ?? "kos-melati";
const mekoEndpoint = mekoEndpointFromEnv();
const mekoStore = await persistence.openWorkspace(`meko-${mekoWorkspace}`);
// "Tanya usaha" questions outside the fixed patterns (REEVE_ASK_LLM=on): Haiku words an answer that
// must cite receipts. The public route and the chats each have their own daily cap.
const askLlmPublic = askLlmFromEnv(providers, "public");
const askLlmChat = askLlmFromEnv(providers, "chat");
const mekoDeps = {
  workspace: mekoWorkspace,
  ledger: mekoStore.ledger,
  connect: () => connectMeko(mekoEndpoint),
  endpoint: mekoEndpoint,
  allowAsk: process.env.REEVE_MEKO_PUBLIC_ASK === "on",
  askLlm: askLlmPublic,
  encodeAnchor: (root: string, leaves: number) => encodeAnchor(root, leaves),
};
const mekoOpen = mekoOpener(mekoDeps);
const mekoApp = createMekoApp(mekoDeps, mekoOpen);
// Tenants ask "kenapa saya didenda?" on Telegram (same bot webhook and secret as the workspaces).
// With TELEGRAM_BOT_TOKEN the bot can also write first, so a tenant's chat id is kept for the live billing tick.
const botToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
const mekoTg = mekoTelegram({ secret: process.env.TELEGRAM_WEBHOOK_SECRET || undefined, store: mekoStore.store, open: mekoOpen, webOrigin: origin, botUsername: process.env.TELEGRAM_BOT_USERNAME || undefined, keepChatIds: !!botToken, digest: () => mekoOwner.digestText(), askLlm: askLlmChat });
// Owner actions on that workspace (SOP Discovery), behind the session at /api/meko/owner/*.
const mekoOwner = createMekoOwnerApp(
  {
    audit: async (rulebook) => {
      const a = await runAttempt({ repoRoot, rulebook, scenario: kosMelatiScenario(), sandbox, runId: `discovery-${Date.now().toString(36)}` });
      const mut = a.results?.mutation;
      return { status: a.verdict.status, cases: a.plan.cases.length, killed: mut?.killed ?? 0, total: mut?.total ?? 0 };
    },
    template: () => loadFixtureRulebook(),
    telegram: mekoTg,
    // Daily digest: dry run unless TELEGRAM_BOT_TOKEN, REEVE_DIGEST=on and TELEGRAM_OWNER_CHAT_ID are all set.
    digest: { sender: digestSenderFromEnv() },
    // Staged reminders (10-minute undo) go out on Telegram when the token is set and the tenant linked a chat; otherwise the Log connector records them.
    outbox: { execute: liveExecutor({ token: botToken, chatOf: (subject) => mekoTg.chatFor(subject) }) },
    webOrigin: origin,
    store: mekoStore.store,
    // Bookkeeping to Google Sheets (T1-5): off unless REEVE_JOURNAL=on; needs COMPOSIO_API_KEY with Google Sheets connected.
    ...(process.env.REEVE_JOURNAL === "on" ? { journal: { registry: connectorsFromEnv(process.env), spreadsheetId: process.env.REEVE_JOURNAL_SHEET_ID || undefined } } : {}),
  },
  mekoOpen,
);
// POST /api/meko/tick and POST /api/meko/bills/:id/paid: the live billing loop. Secret only (x-reeve-tick-secret = REEVE_TICK_SECRET), no session.
const mekoTick = createMekoTickApp({ tick: mekoOwner.tick, markPaid: mekoOwner.markPaid, journal: mekoOwner.syncJournal, secret: process.env.REEVE_TICK_SECRET || undefined });

const { app, openAll } = await createAccountsApp({
  persistence,
  publicApps: [
    { prefix: "/api/meko/public/", fetch: (req) => mekoApp.fetch(req) },
    // Served without a session; each route checks the tick secret itself.
    { prefix: "/api/meko/tick", fetch: (req) => mekoTick.fetch(req) },
    { prefix: "/api/meko/bills/", fetch: (req) => mekoTick.fetch(req) },
    { prefix: "/api/meko/journal/", fetch: (req) => mekoTick.fetch(req) },
  ],
  webhookFirst: (req) => (new URL(req.url).pathname === "/api/webhooks/telegram" ? mekoTg.handle(req) : Promise.resolve(null)),
  ownerApps: [{ prefix: "/api/meko/owner/", fetch: (req, account) => mekoOwner.fetch(req, account) }],
  rp,
  sessionSecret: process.env.REEVE_SESSION_SECRET,
  supabase,
  publicHealth: () => ({ llm: providers.defaultId, sandbox: sandbox.name }),
  workspaceApp: (id, { store, ledger }, onPasskeyAdded) =>
    createApp({
      store,
      ledger,
      providers,
      sandbox,
      scenario: (pack: PackId) => (pack === "minimarket" ? minimarketScenario() : kosMelatiScenario()),
      defaultSop: (pack: PackId) => loadFixtureSop(PACK_FIXTURE[pack]),
      // Stripe and Xendit in test mode only (live keys are refused), plus an offline rail.
      rails,
      tenants: () => kosMelatiScenario().tenants,
      // Each workspace acts through its own Composio user, so one account never uses another's apps.
      // "main" (the owner's data from before accounts) keeps the original user and its connections.
      connectors: connectorsFromEnv({ ...process.env, COMPOSIO_USER_ID: id === "main" ? process.env.COMPOSIO_USER_ID : `reeve-${id}` }),
      sampleDataset: () => {
        const { records, updates } = bimbelRecords();
        return { name: "Bimbel Cerdas (sample, 12 students)", records, updates, fields: inferFields(records) };
      },
      rp,
      // REEVE_ANCHOR_PRIVATE_KEY (testnet wallet from `npm run anchor:wallet`) turns on-chain anchoring on.
      anchor,
      scheduler,
      // REEVE_OPERATOR_LLM=on: the LLM words messages and reads replies (sends tenant names and amounts to the provider).
      operatorLlm: ["on", "1", "true", "yes"].includes((process.env.REEVE_OPERATOR_LLM ?? "").toLowerCase()),
      operatorModel: process.env.REEVE_OPERATOR_MODEL || undefined,
      telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
      account: id,
      onPasskeyAdded,
    }).fetch,
});

const ready = providers.list().filter((p) => p.available).map((p) => p.id);
const railIds = rails.filter((r) => r.info.available).map((r) => r.info.id);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(
    `reeve api on http://localhost:${port}/api · default llm ${providers.defaultId} · ${ready.length} parsers ready (${ready.join(", ")}) · rails ${railIds.join(", ")} · origin ${origin} · storage ${persistence.kind} · email login ${supabase ? "on" : "off"}`,
  );
});

if (scheduler.enabled) {
  await openAll();
  console.log(`scheduler on: one business day every ${scheduler.daySeconds}s, checked every ${scheduler.tickMs}ms`);
}

// REEVE_MEKO_TICK=on: run the billing tick after start-up (only from 08:00 WIB, and not again once today's is done), then every day at about 08:00 WIB. One API instance only (see liveTick).
if (process.env.REEVE_MEKO_TICK === "on") {
  startMekoTicker({ isDone: () => !!loadBillBook(mekoStore.store.data)?.ticks[wibDate(Date.now())], tick: () => mekoOwner.tick().then((r) => console.log(`meko tick ${r.date}: ${r.repeated ? "already done today" : r.note}`)), flush: () => mekoOwner.flush() });
  console.log(`meko tick on: after start-up and daily at about 08:00 WIB; reminders go via ${botToken ? "Telegram (tenants who linked a chat), else the Log connector" : "the Log connector (set TELEGRAM_BOT_TOKEN to send)"}`);
}

// On a redeploy, finish the queued Postgres writes before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void persistence.close().finally(() => process.exit(0));
  });
}
