import { findCard, type Rulebook, type SimEvent, type StockScenario } from "@reeve/core";
import { roundHalfEven } from "./spec";

/**
 * The Auditor's independent specification for the minimarket pack. Every expectation is worked
 * out here from the rulebook and the engine's documented day order (deliveries, late suppliers,
 * sales, write-offs, markdowns, reorders, KPI), never from the Builder's code.
 */

export interface StockSpecCase {
  name: string;
  card: string;
  scenario: StockScenario;
  types: SimEvent["type"][];
  expect: Partial<SimEvent>[];
}

const MONDAY = "2026-11-02";
const FAR = 365;

const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type ItemOpts = { stock?: number; cost?: number; price?: number; expiresIn?: number; lastSold?: number };

/** The smallest order quantity q in [U-T+1, U] that divides `value`, or null. Orders are always that size. */
export function orderSizeFor(value: number, below: number, upTo: number): number | null {
  for (let q = upTo - below + 1; q <= upTo; q++) if (q > 0 && value % q === 0) return q;
  return null;
}

export function buildStockSpecCases(rb: Rulebook): { cases: StockSpecCase[]; skipped: string[] } {
  const cases: StockSpecCase[] = [];
  const skipped: string[] = [];
  const reorder = findCard(rb, "reorder_point");
  if (!reorder) return { cases, skipped: ["no reorder_point card: nothing to test"] };
  const T = reorder.below_units;
  const U = reorder.order_up_to_units;
  const S = reorder.supplier;
  const fallback = findCard(rb, "supplier_fallback");
  const backup = fallback && fallback.backup_supplier !== S ? fallback : undefined;

  const suppliers = [{ id: S, lead_days: 2 }, ...(backup ? [{ id: backup.backup_supplier, lead_days: 3 }] : [])];
  const item = (id: string, o: ItemOpts = {}, start = MONDAY) => ({
    id,
    name: id,
    cost: o.cost ?? 1,
    price: o.price ?? 2,
    shelf_life_days: FAR,
    batches: [{ units: o.stock ?? U, expires: addDays(start, o.expiresIn ?? FAR) }],
    last_sold_days_ago: o.lastSold ?? 0,
  });
  const scenario = (items: ReturnType<typeof item>[], days: number, extra: Partial<StockScenario> = {}, start = MONDAY): StockScenario => ({
    pack: "minimarket",
    start_date: start,
    days,
    suppliers,
    items,
    sales: [],
    delays: [],
    ...extra,
  });
  const q0 = U - (T - 1); // order size when stock is one below the reorder point and nothing is on order

  // Reorder point: exactly at the point is fine; one below orders up to the target from the default supplier.
  cases.push({
    name: "reorder only below the reorder point, up to the target",
    card: reorder.id,
    scenario: scenario([item("X", { stock: T }), item("Y", { stock: T - 1 })], 1),
    types: ["po_created"],
    expect: [{ date: MONDAY, tenant_id: "Y", type: "po_created", amount: q0, note: `${S}:${q0}` }],
  });

  // Stock on order counts: selling the shelf empty the next day reorders only if shelf plus order falls below
  // the point; and the delivery lands after the supplier's lead time.
  {
    const sold = T - 1;
    const position = q0; // shelf 0 + the open order
    const expect: Partial<SimEvent>[] = [
      { date: MONDAY, tenant_id: "Y", type: "po_created", amount: q0, note: `${S}:${q0}` },
      { date: addDays(MONDAY, 2), tenant_id: "Y", type: "po_received", amount: q0, note: `${S}:${q0}` },
    ];
    if (position < T) {
      const q1 = U - position;
      expect.push({ date: addDays(MONDAY, 1), tenant_id: "Y", type: "po_created", amount: q1, note: `${S}:${q1}` });
      expect.push({ date: addDays(MONDAY, 3), tenant_id: "Y", type: "po_received", amount: q1, note: `${S}:${q1}` });
    }
    cases.push({
      name: "stock on order counts; delivery after the lead time",
      card: reorder.id,
      scenario: scenario([item("Y", { stock: T - 1 })], 4, { sales: sold > 0 ? [{ item_id: "Y", day: 1, units: sold }] : [] }),
      types: ["po_created", "po_received"],
      expect,
    });
  }

  // Owner approval above the limit: an order worth exactly the limit goes out, one above waits.
  const po = findCard(rb, "po_approval_threshold");
  if (po) {
    const L = po.po_above;
    const items: ReturnType<typeof item>[] = [];
    const expect: Partial<SimEvent>[] = [];
    const exact = L > 0 ? orderSizeFor(L, T, U) : null;
    if (exact) {
      items.push(item("PA", { stock: U - exact, cost: L / exact }));
      expect.push({ date: MONDAY, tenant_id: "PA", type: "po_created", amount: L, note: `${S}:${exact}` });
    } else {
      skipped.push(`${po.id}: no order size can be worth exactly ${L}, so the boundary itself is not tested`);
    }
    const above = Math.floor(L / U) + 1;
    items.push(item("PB", { stock: 0, cost: above }));
    expect.push({ date: MONDAY, tenant_id: "PB", type: "po_approval_request", amount: U * above, note: `${S}:${U}` });
    cases.push({ name: "orders above the limit wait for the owner", card: po.id, scenario: scenario(items, 1), types: ["po_created", "po_approval_request"], expect });
  }

  // Supplier fallback: the order is cancelled and placed with the backup on the day it is D days late.
  if (backup) {
    const D = backup.late_days;
    const B = backup.backup_supplier;
    const sw = 2 + D;
    cases.push({
      name: "late supplier: cancel and re-order from the backup",
      card: backup.id,
      scenario: scenario([item("Y", { stock: T - 1 })], sw + 4, { delays: [{ supplier: S, from_day: 0, to_day: 0, extra_days: D + 1 }] }),
      types: ["po_created", "supplier_switched", "po_received"],
      expect: [
        { date: MONDAY, tenant_id: "Y", type: "po_created", amount: q0, note: `${S}:${q0}` },
        { date: addDays(MONDAY, sw), tenant_id: "Y", type: "supplier_switched", amount: q0, note: `${S}->${B}` },
        { date: addDays(MONDAY, sw), tenant_id: "Y", type: "po_created", amount: q0, note: `${B}:${q0}` },
        { date: addDays(MONDAY, sw + 3), tenant_id: "Y", type: "po_received", amount: q0, note: `${B}:${q0}` },
      ],
    });
  } else if (fallback) {
    skipped.push(`${fallback.id}: the backup supplier is the default supplier`);
  }

  // Markdowns before expiry: each step fires on the day the batch reaches H-n, never again.
  const steps = rb.cards.flatMap((c) => (c.type === "expiry_markdown" ? [{ id: c.id, days: c.days_before_expiry, percent: Math.trunc(c.percent) }] : []));
  if (steps.length) {
    const top = Math.max(...steps.map((s) => s.days));
    const life = top + 10;
    const markdownsFor = (id: string, price: number, cost: number, floor: boolean) => {
      const out: Partial<SimEvent>[] = [];
      let current = 0;
      for (let k = 0; k < life; k++) {
        const dte = life - k;
        const pct = Math.max(0, ...steps.filter((s) => dte <= s.days).map((s) => s.percent));
        if (pct > current) {
          current = pct;
          const raw = roundHalfEven((price * (100 - pct)) / 100);
          out.push({ date: addDays(MONDAY, k), tenant_id: id, type: "markdown", amount: floor ? Math.max(raw, cost) : raw, note: `${pct}% off, H-${dte}` });
        }
      }
      return out;
    };
    cases.push({
      name: "markdowns at each H-n step",
      card: steps.map((s) => s.id).join("+"),
      scenario: scenario([item("Q", { stock: 5, cost: 1_000, price: 20_000, expiresIn: life })], life + 1),
      types: ["markdown"],
      expect: markdownsFor("Q", 20_000, 1_000, false),
    });
    const floor = findCard(rb, "markdown_floor");
    if (floor) {
      cases.push({
        name: "a markdown never goes below cost",
        card: floor.id,
        scenario: scenario([item("W", { stock: 5, cost: 11_000, price: 12_000, expiresIn: life })], life + 1),
        types: ["markdown"],
        expect: markdownsFor("W", 12_000, 11_000, true),
      });
    }
  }

  // Write-off on the expiry date (engine behaviour, pinned so a broken engine is caught too).
  cases.push({
    name: "unsold stock is written off on its expiry date",
    card: reorder.id,
    scenario: scenario([item("E", { stock: 3, cost: 1_000, expiresIn: 5 })], 6),
    types: ["writeoff"],
    expect: [{ date: addDays(MONDAY, 5), tenant_id: "E", type: "writeoff", amount: 3_000, note: "3 units" }],
  });

  // Slow movers: no sale for N days stops reordering; N-1 days still reorders.
  const slow = findCard(rb, "slow_mover_stop");
  if (slow) {
    const N = slow.no_sale_days;
    cases.push({
      name: "slow movers are not reordered",
      card: slow.id,
      scenario: scenario([item("SA", { stock: T - 1, lastSold: N }), item("SB", { stock: T - 1, lastSold: N - 1 })], 1),
      types: ["po_created", "reorder_stopped"],
      expect: [
        { date: MONDAY, tenant_id: "SA", type: "reorder_stopped" },
        { date: MONDAY, tenant_id: "SB", type: "po_created", amount: q0, note: `${S}:${q0}` },
      ],
    });
  }

  // KPI: on the check weekday only, alert when stock expiring within the window is worth more than the limit.
  const kpi = findCard(rb, "expiring_value_limit");
  if (kpi) {
    const V = kpi.max_value;
    const W = kpi.window_days;
    const start = addDays(MONDAY, kpi.check_weekday);
    cases.push({
      name: "expiring-stock alert on the check day",
      card: kpi.id,
      scenario: scenario([item("K", { stock: 1, cost: V + 1, expiresIn: W }, start)], 7, {}, start),
      types: ["kpi_alert"],
      expect: [{ date: start, tenant_id: "-", type: "kpi_alert", amount: V + 1 }],
    });
    cases.push({
      name: "no alert at exactly the limit, or for stock just outside the window",
      card: kpi.id,
      scenario: scenario([item("KA", { stock: 1, cost: V, expiresIn: W }, start), item("KB", { stock: 1, cost: 5_000, expiresIn: W + 1 }, start)], 1, {}, start),
      types: ["kpi_alert"],
      expect: [],
    });
  }

  return { cases, skipped };
}
