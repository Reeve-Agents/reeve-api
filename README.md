# Reeve

**Your operations, run on your behalf.** Reeve turns a business SOP written in plain language into code that runs on its own, and a separate Auditor proves that code before any money moves.

- **Builder**: SOP → rule cards (LLM) → Python rules + its own tests (deterministic compiler)
- **Auditor**: independent spec from the rulebook, mutation testing, constraint checks → verdict
- **Owner**: approves with a passkey (web app, next slice)
- **Proof**: every run leaves a receipt; Merkle roots go into an append-only, hash-chained ledger

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Design notes live in the private reeve-vault repo.

## Quick start

Requires Node ≥ 20 and Python ≥ 3.9.

```bash
npm install
```

```bash
npm run demo
```

```bash
npm run demo:bug
```

Live (reads `.env`): `npm run demo:createos` runs the job in a real CreateOS microVM; `npm run demo:live` also parses the SOP with Claude; `npm run check:egress` proves the sandbox cannot reach the internet.

`demo` runs the Kos Melati SOP (30 rooms, 45 simulated days) end to end. `demo:bug` makes the Builder misread the tenure-grace rule; the Builder's own tests still pass, the Auditor catches it, and the revised code passes.

Default mode is fully offline: `REEVE_LLM=fixture` (pre-recorded rule cards) and `REEVE_SANDBOX=local` (subprocess, **dev only, no isolation**).

| Variable | Values | Effect |
|---|---|---|
| `REEVE_LLM` | `fixture` · `anthropic` · `anthropic:claude-haiku-5-5` · `openrouter` · `gemini` · `groq` · `deepseek` · `openai` · `ollama` · `custom` | The default SOP parser. Every parser that is set up stays selectable per SOP in the studio. See "Choosing the model" below |
| `REEVE_MODEL` | Claude model id | With `REEVE_LLM=anthropic`: `claude-opus-5-5` (default), `claude-sonnet-5-5` or `claude-haiku-5-5` |
| `REEVE_SANDBOX` | `local` · `createos` | `createos` runs every job in a CreateOS microVM (`CREATEOS_API_KEY`), egress locked, destroyed after the job |
| `REEVE_HOME` | path | Where runs, receipts and `ledger.jsonl` are written (default `.reeve/`) |

Flags override env: `--llm=anthropic:claude-haiku-5-5`, `--sandbox=createos`, `--pack=minimarket`, `--sop=path/to/sop.md`.

### Choosing the model

The model only turns the SOP into rule cards; the Builder's code and the Auditor's checks are the same whichever model reads it, and a card that does not fit the schema is rejected before anything runs. So an owner on a small budget can pick a cheaper or free model:

| Parser | Set up in `.env` | Price |
|---|---|---|
| Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | `ANTHROPIC_API_KEY` | $4/$20 · $2/$10 · $0.10/$0.50 per M tokens |
| OpenRouter, Google Gemini, Groq, DeepSeek, OpenAI | `<NAME>_API_KEY` and `<NAME>_MODEL` (e.g. `GROQ_API_KEY`, `GROQ_MODEL`), model id exactly as the service lists it | The service's price; several have free tiers |
| Ollama on this computer | `OLLAMA_MODEL` (and `OLLAMA_BASE_URL` if not `localhost:11434`) | Free; the SOP never leaves the machine |
| Any other OpenAI-compatible server (LM Studio, Together, vLLM, ...) | `REEVE_OPENAI_BASE_URL`, `REEVE_OPENAI_MODEL`, optional `REEVE_OPENAI_API_KEY` | Depends |
| Sample rulebook (`fixture`) | nothing | Free; replays the hand-written cards and ignores the SOP text |

Claude goes through the official SDK with structured outputs. The others use the OpenAI chat-completions protocol: strict JSON Schema first, plain JSON mode if the server rejects it (DeepSeek starts there), one repair turn if the reply does not fit, then a clear error. Keys stay on the server; `GET /api/providers` lists only which parsers are set up.

## Dashboard (API + web)

```bash
npm run dev -w @reeve/api
```

```bash
npm run dev -w @reeve/web
```

On a phone the studio folds into one step at a time:
- A compact header.
- A sticky progress bar: Describe → Rules → Audit → Approve → Run → Proof.
- Every other step as a numbered row with a one-line summary; tap one to open it.
- The next action docked at the bottom.

On wider screens every step stays open, with the same progress bar and a "Next" banner.

Open http://localhost:5173. Compile the SOP, run **Simulate & audit** (watch the sandbox in the glass box), register the owner passkey, then **Approve with passkey**: the WebAuthn challenge is bound to the run's receipt hash and the approval lands on the ledger.

### Run on a payment rail (Stripe or Xendit, test mode)

After approval, **06 · Run** bills the tenants for real on a payment rail. Reeve keeps a business clock that starts on the cycle the Auditor simulated (1 Nov). Each step runs the approved `rules.py`, unchanged and hash-checked against the receipt, in the sandbox over the payments the rail has confirmed. The broker (`packages/broker`) then turns only the new events into rail calls:

- **Invoice:** a bill on the rail with a hosted payment page.
- **Late fee:** a separate bill.
- **Reminder or notice:** logged only, because no WhatsApp or email connector exists yet.
- **Overpayment:** an exception. Keeping it as credit needs no approval; a refund above the rulebook's limit needs the owner's passkey.

If the rules break a constraint, nothing is sent. Every step goes on the ledger.

| Rail | Set up in `.env` | What it uses |
|---|---|---|
| Stripe | `STRIPE_SECRET_KEY` (`sk_test_…`); optional `STRIPE_WEBHOOK_SECRET` from `stripe listen --forward-to localhost:8787/api/webhooks/stripe` | Invoicing: a finalised `send_invoice` invoice with a hosted invoice page; IDR in minor units (×100). **Pay (test)** uses the test card |
| Xendit | `XENDIT_SECRET_KEY` (`xnd_development_…`); optional `XENDIT_WEBHOOK_TOKEN` (Dashboard → Webhooks, URL `…/api/webhooks/xendit`) | Payment Sessions (the successor of the Invoice API): a PAY session with a hosted link for VA, QRIS and e-wallets. Pay on the link in test mode; **Pay (test)** then settles the payment request you started |
| Offline | nothing | In-memory bills, for demos without a key |

Live keys are refused. Without a webhook secret, **Check payments** polls the rail. `npm run rails:smoke -- --rail=stripe` (or `xendit`) creates one Rp10.000 bill, pays it and refunds half, to check a key before a demo. `npm run preview:seed` builds a separate store in `.reeve/preview` with a simulated approval, for trying the Run panel without a passkey (`reeve-api-preview` in `.claude/launch.json`).

### Any SOP (generic pack) and connectors

**Any SOP** in the studio runs a business process that no domain pack covers. The rules run over the owner's own records: the Bimbel Cerdas sample (12 students), or an uploaded CSV exported from Google Sheets or Excel. A rule card says: on a schedule, for each record whose conditions hold, run one connector tool. Other cards:

- **Never:** a tool must not run for records that match a condition.
- **Approval limit:** an action above an amount waits for the owner's passkey.
- **KPI:** a sum or count over the records, compared with a threshold.

The model sees only field names, types and short category labels such as `lunas/belum`. It never sees names, phone numbers or emails.

The Builder generates `rules.py` with named thresholds, and `reeve_runtime/generic_engine.py` runs it. The Auditor builds its own boundary cases from the cards: either side of every condition, the schedule, once-per-record, approval limits, never rules and KPI thresholds. Every threshold, operator, schedule and limit is then mutated to check those cases catch the change. At compile time, every tool is checked against the connected services:

| Connector | Set up | For |
|---|---|---|
| Composio | `COMPOSIO_API_KEY`: a project key (`ak_…`, official SDK, `COMPOSIO_USER_ID`) or a Connect consumer key (`ck_…`, Composio's hosted MCP server; Reeve calls its schema, connection-list and execute tools deterministically) | Gmail, Telegram, Sheets, Slack, Shopify, HubSpot, ... |
| Any MCP server | `REEVE_MCP_SERVERS` (JSON list of `{name, url, headers}`) | Systems Composio lacks: Indonesian POS, accounting, marketplaces |
| Log | nothing | Actions are recorded, not sent, until a service is connected |

**Any app, both ways:**
- **Records:** come from any connected app's read tool. The studio has presets for Google Sheets (`GOOGLESHEETS_VALUES_GET`), Notion (`NOTION_QUERY_DATABASE`), ClickUp (`CLICKUP_GET_TASKS`) and Airtable (`AIRTABLE_LIST_RECORDS`), plus any slug with JSON arguments. Reeve flattens whatever comes back into rows: a header row with data rows, or a list of objects with Notion-style properties reduced to plain values. A dataset read from an app is read again on every run step.
- **Actions:** can use any tool. Rules render text, and the broker turns it into the numbers, flags and lists the tool's schema asks for.
- **Build-time correction:** if the model names a tool no connected service has, the API asks Composio's tool search for real tools for that rule, with their required arguments. The model gets one retry with them.
- **Commands:** `npm run connectors:check`, `connectors:read` and `connectors:send` do the same from the terminal.

Verified live on 19 Oct 2026 with Composio Connect and Google Sheets:
- Reeve added a "Reeve test" tab with one row to an existing spreadsheet, leaving the other tabs untouched.
- It created a "Reeve - Bimbel Cerdas (sample)" spreadsheet and filled it with the sample's 12 rows.
- It read that sheet back as a dataset. Opus 5.5 compiled the SOP over its columns, using real tool slugs with every required argument.
- The Auditor passed it: 3/3 Builder tests, 13/13 spec cases, 24/24 planted defects, no violations.

When a run goes live, each step runs the approved `rules.py` over the current records in the sandbox. The broker then calls only the tools the approved rulebook names. Actions above the limit wait for the passkey, and every call goes on the ledger.

`npm run demo:generic` runs the sample end to end. Live results on 19 Oct 2026, from the Bimbel Cerdas SOP:

- **Opus 5.5:** PASS (13/13 spec cases, 24/24 planted defects). Its decisions matched the hand-written rulebook: 23 actions, 7 waiting for approval, 5 blocked, 5 KPI alerts.
- **Haiku 5.5:** blocked, because it left out the amount the Rp2 jt limit applies to, so the limit could never trigger.

The owner app (PWA) shows "Any SOP" rulebooks the same way as the domain packs:
- The tab is named after the data's entity (Siswa, Orders, ...).
- "What Reeve did" is written in the owner's own rule titles.
- Actions held above the limit appear under Approvals. In a live run they can be sent with the fingerprint, or declined.

### Connect your apps

`/?view=apps` lists every app the owner can connect: Composio's catalog of about 1,600 apps, read from `docs.composio.dev/toolkits.md` and cached for a day. Common small-business apps (Gmail, Sheets, Drive, Telegram, Notion, ClickUp, Odoo, ...) come first, and the list is searchable.

**Connect** opens a card with Composio's sign-in link, valid about 10 minutes. The owner signs in with OAuth or pastes the app's API key on Composio's page, so Reeve never sees it. "I've connected it" checks the account is active. API: `GET /api/apps?q=`, `GET /api/apps/status?slugs=`, `POST /api/apps/:slug/connect`.

### Change a rule (Maintain)

On an audited or approved rulebook, **Change a rule** opens the SOP for editing. The chosen model reads the revision into a new version; edited card values also work through `POST /api/rulebooks/:id/revisions` with `{ rulebook }`. The studio then shows:

- **Changes from the approved version:** card by card, ignoring wording (for example, R3 percent: 5 → 8).
- **Impact on the same simulated month,** once the revision passes the audit: totals that move, and which tenants are affected and how (late fees Rp1.275.000 → Rp2.040.000, 11 rooms).

The revision needs its own passkey approval. Until then, the approved version keeps running. Approving it marks the old version `superseded`. A live run then offers **Switch this run to the new rules**: bills and payments so far stay, and the new rules decide from the next business day. The switch goes on the ledger.

### Owner app (mobile, PWA)

Phones, and the installed app, open the owner view; `?view=owner` forces it on desktop and the **Studio** / **Owner app** buttons switch between the two. Four tabs: **Today** (money collected against the target, rooms paid, late fees, exit notices, and what Reeve did on a simulated day), **Approvals** (approve the audited rulebook with your fingerprint, plus the Auditor's questions), **Rooms** (30 rooms on any day; tap one for what it owes) and **Ledger** (the signed track record). Every figure is read from the run's simulation events, and the nouns, statuses and KPIs come from the rulebook's **domain pack** (`@reeve/core/packs`; rent collection is pack 1). See `docs/PACKS.md`, including the plan for pack 2 (minimarket stock and expiry).

To try it as an installable app, build and serve the production bundle (the service worker only runs there):

```bash
npm run build -w @reeve/web && npm run preview -w @reeve/web -- --port 4173
```

Open http://localhost:4173 on a phone on the same network, or in Chrome, and use "Install app". The service worker caches the app shell only; `/api` calls always go to the network.

## Landing page

```bash
npm run dev -w @reeve/landing
```

Open http://localhost:5174. Design system and theses: `apps/landing/MASTER.md`. The simulated month it shows is `fixtures/kos-melati/sim-events.json`, the events of the 18 Oct CreateOS run.

## Tests

```bash
npm test
```

```bash
npm run test:py
```

```bash
npm run typecheck
```

## Layout

```text
apps/cli        MVP pipeline + demo (implemented)
apps/api        Hono API: rulebooks, queued sandbox runs, passkeys, ledger (implemented)
apps/web        Vite + React: studio dashboard + owner app (PWA) with WebAuthn approvals (implemented)
apps/landing    Landing page: React, GSAP, React Bits, Hairline (implemented)
apps/broker     Deployable broker (Railway): egress proxy, mandates (next; the Operator logic is in packages/broker)
packages/core   Domain schemas (rule cards, rulebook, results, receipts)
packages/llm    SOP parsers: Claude (SDK), OpenAI-compatible services, fixture; per-pack schemas (0G TEE later)
packages/builder  SOP → rulebook → rules.py + Builder tests
packages/auditor  Independent spec, mutation testing, verdict
packages/sandbox  CreateOS REST adapter + local dev runner
packages/receipts Hashing, receipts, Merkle proofs, hash-chained ledger
packages/rails    PaymentRail: Stripe (Invoicing) and Xendit (Payment Sessions) in test mode, plus an offline rail
packages/broker   The Operator: approved rules over real payments → rail calls, exceptions, refunds; generic runs → connector calls
packages/connectors Composio (SDK), any MCP server (SDK), CSV, log; build-time tool checks
runtime/        Python engine shipped into every sandbox job
contracts/      Notes on the on-chain anchor (no contract needed; see packages/anchor)
packages/anchor   Publishes ledger Merkle roots on a testnet and verifies them
```

## Status

| Piece | State |
|---|---|
| SOP → rule cards with Claude | **Verified live (18 Oct 2026):** Opus 5.5 and Haiku 5.5 each parsed both sample SOPs (Kos Melati, Minimarket Berkah) into 8 cards with parameters identical to the hand-written fixtures (`fixtures/*/rulebook.claude-*.json`), and each rulebook passed the Auditor. Flat structured-output schema per pack (the full union exceeds the grammar size limit) |
| Other model providers | OpenRouter, Gemini, Groq, DeepSeek, OpenAI, Ollama and any OpenAI-compatible server: implemented and tested against a fake server (schema mode, JSON-mode fallback, repair turn, refusal). **Not yet run against a real one** (no key in `.env`) |
| Compiler, Auditor, mutation testing, receipts, ledger | Implemented and tested locally |
| CreateOS sandbox adapter | **Verified live (18 Oct 2026):** create → upload 40 files → exec → destroy; egress lock confirmed (`npm run check:egress`: example.com and api.stripe.com blocked) |
| API + web dashboard | **Verified live (18 Oct 2026):** Claude compile → CreateOS run (3.9 s, PASS) → timeline → owner passkey registered with a real authenticator. Approval flow tested with unit tests; the live approval needs the owner's biometric. The studio picks the business type and the model; a minimarket SOP read by Haiku 5.5 from the studio passed the Auditor in the local sandbox |
| Owner app (PWA) | Implemented: Today, Approvals, Rooms, Ledger on real run events; manifest, icons and an app-shell service worker verified in a production preview (SW activated, standalone manifest). Installing on a real phone not yet tried |
| Landing page | Implemented (`apps/landing`), 11 scenes; figures read from the run's events |
| Pack 2: minimarket stock and expiry | **Verified live (18 Oct 2026):** CreateOS run PASS (8/8 Builder tests, 10/10 spec, 30/30 planted defects). `npm run demo:minimarket[:createos]`; owner view at `?view=owner&sample=minimarket`. Claude parsing and the dashboard compile both work for this pack |
| Run on a payment rail (Stripe, Xendit) | **Stripe verified live in test mode (19 Oct 2026):** the Operator billed 30 rooms with real Stripe invoices (82 s). Kamar 1 paid by test card, then sent an extra Rp200k transfer; the rules turned it into credit, and Reeve refunded it on Stripe (under the Rp500k limit, so no passkey). The first live call found that `send_invoice` customers need an email and that the test card must be attached first; both are fixed. **Xendit verified live in test mode (19 Oct 2026):** a Payment Session was created and paid on the hosted test checkout, and a half refund was accepted (`pending`, because Xendit settles refunds asynchronously). The Operator billed 30 rooms as Payment Sessions in 11 s |
| Change a rule (Maintain) | Implemented: revisions from a revised SOP or edited cards, a card-level diff, run impact on the same month, superseding on approval, and switching a live run to the new rules. Checked in the browser: Haiku 5.5 read "denda 5%" → "8%" as exactly one change (R3 percent 5 → 8), the revision passed the Auditor, and the impact showed late fees Rp1.275.000 → Rp2.040.000 across 11 rooms. The passkey approval of a revision needs the owner |
| Any SOP (generic pack) + connectors | Implemented: rule DSL, codegen, engine, Auditor spec + mutants, CSV data, Composio and MCP connectors, generic Operator with passkey-held actions, studio flow. Checked live with Opus and Haiku and in the browser. Composio and MCP are tested with a fake Composio client and a real in-process MCP server. **Composio verified live (19 Oct 2026):** with a Connect consumer key (`ck_…`, via Composio's hosted MCP server), the tool check found GMAIL_SEND_EMAIL ready, and a test email was sent and accepted by Gmail through the broker's path (`npm run connectors:send`). Telegram is wired into the sample but not connected yet. WhatsApp is deferred, because Composio's WhatsApp tools need a WhatsApp Business account. Google Sheets is read via CSV export for now |
| On-chain anchor | Implemented: the ledger's Merkle root goes on Monad testnet or Base Sepolia as a zero-value self-transaction with `REEVE1` + root + receipt count, and is checked back from the chain. Endpoints `GET /api/anchor`, `POST /api/ledger/anchor`, `GET /api/ledger/anchors/:seq/verify`; `npm run anchor:wallet` and `anchor:now`. **Verified live on Monad testnet (19 Oct 2026):** the root over 23 receipts was anchored in tx `0x6f1938…3c39` (block 72355956), recorded at ledger #44, and read back from the chain (check OK) |
| Mera PRF vault, Midtrans, payouts | Next slices |

> Running from inside Claude Code? Its shell sets `ANTHROPIC_BASE_URL`; run `env -u ANTHROPIC_BASE_URL npm run demo:live` so the SDK talks to api.anthropic.com with your own key.

## Repository layout

This repo is the backend. The Python runtime is the `runtime/` submodule, and shared packages come from
their own repos:

```bash
git clone --recurse-submodules https://github.com/Reeve-Agents/reeve-api
cd reeve-api && npm install && npm run dev
```

## The Reeve repos

| Repo | What it holds |
|---|---|
| [reeve-core](https://github.com/Reeve-Agents/reeve-core) | Shared domain model: rulebook schemas, domain packs, simulation views and the sample businesses. |
| [reeve-connectors](https://github.com/Reeve-Agents/reeve-connectors) | Connectors: Composio toolkits and MCP servers the broker acts through, plus CSV and app record readers. |
| [reeve-payments](https://github.com/Reeve-Agents/reeve-payments) | Payment rails (Stripe, Xendit, mock) the broker bills through, test mode only. |
| [reeve-runtime](https://github.com/Reeve-Agents/reeve-runtime) | The Python agent runtime that runs compiled rules inside the sandbox. |
| [reeve-api](https://github.com/Reeve-Agents/reeve-api) | Backend: HTTP API, Builder, Auditor, pipeline, sandbox, broker, receipts ledger, on-chain anchor and the CLI. |
| [reeve-web](https://github.com/Reeve-Agents/reeve-web) | Owner app, owner studio and developer studio (Vite + React). |
| [reeve-landing](https://github.com/Reeve-Agents/reeve-landing) | Landing page (Vite + React + GSAP). |

```
reeve-web ─┐                      ┌─ reeve-connectors (MCP, Composio)
reeve-landing ─┼─ reeve-core ─ reeve-api ─┼─ reeve-payments (Stripe, Xendit)
               │   (schemas,       │      └─ reeve-runtime (Python, submodule)
               │    packs,         │
               │    fixtures)      └─ /api over HTTP ── reeve-web
```

## Working across repos

Shared packages are installed straight from GitHub (`"@reeve/core": "github:Reeve-Agents/reeve-core#main"`) and pinned by
`package-lock.json`. After a change lands in one of them, pull it in with:

```bash
npm update @reeve/core
```

To edit two repos side by side, clone them next to each other and link the local copy:

```bash
npm install ../reeve-core --no-save
```
