# Domain packs

Reeve's pipeline is the same for every SOP: compile → simulate → audit → approve → run →
maintain. A **domain pack** is everything that changes from one kind of SOP to another. The
vault's rule ("Reeve - SOP Inputs and Rule Types", *Domains outside finance*): any process with
a clear trigger, condition and action fits; only the connector and the egress allowlist change,
plus the vocabulary the owner reads.

## The contract (`@reeve/core/packs`)

| Field | What it is | Rent collection (pack 1) |
|---|---|---|
| `domain`, `example` | Name and running example | "Rent collection", a 30-room kos |
| `entity` | What the SOP is about | Room / Rooms |
| `statuses` | Entity states with a tone (`ok` `warn` `bad` `idle`) | paid, part paid, unpaid, exit notice |
| `cardTypes` | Rule card types the engine runs; a rulebook made of these selects the pack (`packFor`) | invoice_schedule, reminder, late_fee, notice, overpayment, max_fee, approval_threshold, revenue_target |
| `connectors`, `egress` | Where data and actions live; the only hosts the sandbox may reach | Stripe / Xendit / Midtrans, WhatsApp, Sheets |
| `view(events, date, rulebook)` | The owner's day: `kpis`, `stats`, `entities`, `lines`, `exceptions` | Collected vs Rp45 jt; 24/30 paid; 6 notices on Nov 15 |

The SOP's three statement types map onto the view: **rules** become `lines` and entity states,
**constraints** become `exceptions` Reeve refuses to decide on its own, **KPIs** become `kpis` with
an honesty note ("a target, not a promise").

`genericPack` is the fallback for a rulebook no pack claims: it still shows what happened and to
whom from the events alone, so the owner app never goes blank.

The owner app (`apps/web/src/owner`) renders only the contract: the Today tab, the entity tab
(named by the pack) and "Flagged for you" have no rent-specific code left. Tests:
`packages/core/test/packs.test.ts`.

## Pack 2 status: built, first PASS on CreateOS (18 Oct 2026)

| Check | Result |
|---|---|
| Builder tests | 8/8 |
| Auditor spec | 10/10 cases |
| Planted defects | 30/30 caught (one more, `PO_APPROVAL_ABOVE + 1`, is reported as an equivalent mutant: no order size can be worth exactly Rp2,000,001) |
| Constraints | no violations |
| Sandbox | `sb-01m570snrebjtmxrrbdzc1cz32`, egress locked, exec 0.5 s |
| Receipt | `5d1fba6f…` → ledger #24 |
| Month | 38 POs (Rp12.9 jt), 1 PO waiting for the owner (beras 5kg, Rp3.0 jt), 4 orders moved from late Supplier A to B, 8 markdowns, Rp64,800 written off, 2 slow movers stopped, 1 Monday alert (Rp1,007,600 expiring within 30 days) |

Run it: `npm run demo:minimarket` (local) or `npm run demo:minimarket:createos`; add `--inject-bug` to watch the
Auditor catch a Builder that forgets "never below cost" (4 spec mismatches, 6 constraint violations, FAIL).
The owner app shows it read-only at `?view=owner&sample=minimarket`. Events: `fixtures/minimarket/sim-events.json`.

Parsing with a model (18 Oct 2026): `packages/llm/src/flat-stock.ts` is the minimarket flat schema, chosen by
pack. Claude Opus 5.5 and Haiku 5.5 each read the Bahasa SOP into the same 8 cards as the hand-written
rulebook (`fixtures/minimarket/rulebook.claude-*.json`), and both rulebooks passed the Auditor. The first live
parse wrote suppliers as "Supplier A" where the shop's list says "A"; the converter now normalises the label
and the engine names an unknown supplier instead of crashing. The dashboard API takes `pack` and `provider` on
`POST /sops`, runs each pack against its own scenario, and injects that pack's Builder bug.

## What was rent-specific, and what changed

| Layer | File | Today |
|---|---|---|
| Card schema | `packages/core/src/index.ts` (`RuleCard`, `Rulebook.pack`) | **Done:** 7 minimarket card types; `pack` selects the pack |
| LLM parse | `packages/llm/src/flat-stock.ts`, `schemas.ts` (`packSchema`) | **Done:** one flat schema and prompt per pack, for Claude and every OpenAI-compatible parser |
| Builder codegen | `packages/builder/src/codegen-stock.ts` | **Done:** `compile()` dispatches by pack |
| Simulation engine | `runtime/reeve_runtime/stock_engine.py`, `dispatch.py` | **Done:** `job.py` and `spec.py` dispatch by `scenario.pack` |
| Auditor spec | `packages/auditor/src/spec-stock.ts` | **Done:** 10 cases from the rulebook |
| Constraints | `runtime/reeve_runtime/constraints.py` (`check_stock_constraints`) | **Done** |
| Scenario | `packages/pipeline/src/scenario-minimarket.ts` | **Done:** 24 items, 30 days, deterministic |

Mutation testing (`packages/auditor/src/mutate.ts`), receipts, the ledger, the sandbox and passkey
approval are domain-free. The API and the studio take the pack from the rulebook (`GET /api/packs`).

A third pack needs: card types in `@reeve/core`, a flat schema and prompt in `packages/llm`, codegen, an
engine, an Auditor spec, a scenario, a fixture SOP, and a `DomainPack` view. Adding the id to `PackId` makes the
type checker list the small per-pack maps still missing an entry (`PACK_FIXTURE`, the API's injected bug and
scenario, the studio's result view). Every model provider and the owner app need no change.

## Pack 2 plan: minimarket stock and expiry

From the vault: the inventory example ("stock below 20 → PO to supplier A; A 3 days late →
switch to B"), the expiry-stock waste row in "Reeve - Sustainability and Crypto Layer"
(markdown at H-30 / H-14, stop reordering slow movers; data from POS or Sheets is `measured`),
and the connector ladder in "Reeve - Connectors and Composio".

### Owner-facing (the pack definition)

| Contract field | Minimarket |
|---|---|
| `domain` / `example` | "Stock and expiry" / a minimarket with 24 items |
| `entity` | Item (SKU) / Stock |
| `statuses` | `ok` aman · `low` menipis (warn) · `out` habis (bad) · `expiring` akan kedaluwarsa (warn) · `marked_down` diskon (ok) · `written_off` dibuang (bad) |
| `kpis` | Stock value; **value expiring within 30 days** (the Green mode KPI); stock-outs this week; gross margin vs target |
| `lines` | "4 POs sent to Supplier A, Rp3.2 jt" · "12 items marked down 20% (H-30)" · "Supplier A late 3 days: 2 POs moved to Supplier B" |
| `exceptions` | PO above the owner's limit (passkey) · markdown that would sell below cost · supplier out of stock with no fallback |
| `connectors` | POS (Moka, Majoo, Loyverse via Composio), Google Sheets, supplier email or WhatsApp |
| `egress` | `sheets.googleapis.com`, the POS API host, the mail relay |

### Engine

| Piece | Work |
|---|---|
| Card types (`RuleCard`) | `reorder_point` (SKU group, threshold, order-up-to), `supplier_fallback` (late days → backup supplier), `expiry_markdown` (days before expiry → percent), `slow_mover_stop` (no sale in N days → stop reordering) as rules; `po_approval_threshold` (Rp) and `min_margin` (never below cost) as constraints; `stock_value_target` / `expiring_value_limit` as KPIs |
| LLM flat schema | Add the fields above to `FlatCard`; extend `toRuleCard` |
| Scenario | `packages/pipeline/src/scenario-minimarket.ts`: 24 items with cost, price, stock, batches and expiry dates; 30 days of POS sales with a weekday pattern; two suppliers with lead times; Supplier A runs 3 days late once |
| Engine | `runtime/reeve_runtime/packs/minimarket.py`: day loop of sales → stock → reorder check → supplier lateness → expiry markdowns → write-offs → KPI check. Events: `sale_day`, `po_created`, `po_approval_request`, `po_received`, `supplier_switched`, `markdown`, `stockout`, `writeoff`, `kpi_alert`, with `tenant_id` holding the SKU |
| Dispatch | `job.py` picks the engine by `rulebook.pack`; `Rulebook` gains an optional `pack` field (default `rent-collection`) |
| Builder codegen | `codegen/minimarket.ts`: constants and hooks (`reorder_due`, `order_quantity`, `markdown_percent`, `supplier_for`) plus Builder tests |
| Auditor spec | Reorder at exactly the threshold and not one above; PO over the limit becomes an approval request, never an order; markdown at H-30 and H-14 only; never below cost; switch supplier on day 3 of lateness, not day 2 |
| Constraints | Stock never negative; no markdown below cost; no PO above the limit without approval |
| Mutants | The existing numeric and operator mutants apply unchanged to the new `rules.py` |
| Owner view | `packages/core/src/packs/minimarket.ts` implementing the contract above, added to `PACKS` |
| Fixture | `fixtures/minimarket/` with an SOP in Bahasa, a hand-written rulebook, and the events of a real CreateOS run once it passes |

### Order of work

1. `Rulebook.pack` and dispatch in `job.py`; keep rent as the default so nothing breaks.
2. Card types and flat schema; a hand-written minimarket rulebook fixture.
3. Scenario and engine; Builder codegen and tests.
4. Auditor spec, constraints, mutation run; first PASS on CreateOS.
5. `minimarketPack` view on the real run events; the owner app picks it up with no UI change.
6. Landing: replace "Made for minimarkets" in the rotator with a second live example only once step 4 passes.

Estimate: about one working day. Steps 1–2 are half a day; the engine and spec are the rest.
