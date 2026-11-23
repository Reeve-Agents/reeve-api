// Beli bareng (group buying): several minimarkets that buy from the same supplier (pseudonymised
// S1) batch their purchase orders to reach the supplier's volume tiers. Plain code does all the
// math: batching per sku, the tier price, each owner's line total and saving. No model decides
// anything. Each owner consents (`consent_group_buy`) and approves only their own line
// (`approve_group_line`, in their own workspace, input holds nothing of the others). The batched
// order (`place_group_order`, in the shared workspace) lists receipt hashes and per-sku totals, no
// business names, and goes out through the Log connector (no real send). Tiers are assumptions.
import type { MekoWorkspace } from "@reeve/meko";
import { verifyDecision } from "@reeve/meko";
import type { ExecResult } from "./crew";

export const GROUP_WORKSPACE = "gb-groupbuy";
export const GROUP_SUPPLIER = "S1";
const CLASS = "groupbuy";

/** Supplier volume tiers (assumption): batch qty of one sku >= min gets this discount off the list price. */
export const SUPPLIER_TIERS = [
  { min: 100, discount: 0.08 },
  { min: 50, discount: 0.05 },
] as const;

export interface PoLine {
  sku: string;
  qty: number;
  /** Supplier list price per unit (IDR). */
  unit_price: number;
}
export interface PurchaseOrder {
  /** Workspace id of the business (never printed in shared output). */
  business: string;
  lines: PoLine[];
}

/** Unit price for a total batch qty of one sku. */
export function tierPrice(listPrice: number, qty: number): { unit_price: number; discount: number } {
  const t = SUPPLIER_TIERS.find((x) => qty >= x.min);
  const discount = t?.discount ?? 0;
  return { unit_price: Math.round(listPrice * (1 - discount)), discount };
}

export interface OwnLine {
  sku: string;
  qty: number;
  unit_price: number;
  total: number;
  /** What this line costs when the business buys alone (supplier tiers on its own qty). */
  alone_total: number;
}
export interface Quote {
  business: string;
  lines: OwnLine[];
  total: number;
  alone_total: number;
  saving: number;
}
export interface BatchSku {
  sku: string;
  qty: number;
  list_price: number;
  unit_price: number;
  discount: number;
}
export interface Batch {
  skus: BatchSku[];
  quotes: Quote[];
  total: number;
  saving: number;
}

/** Batches the POs of the included businesses per sku and prices every line at the batch tier. */
export function batchPOs(pos: PurchaseOrder[], included: string[] = pos.map((p) => p.business)): Batch {
  const inc = pos.filter((p) => included.includes(p.business));
  const qty = new Map<string, number>();
  const list = new Map<string, number>();
  for (const p of inc)
    for (const l of p.lines) {
      qty.set(l.sku, (qty.get(l.sku) ?? 0) + l.qty);
      list.set(l.sku, l.unit_price);
    }
  const skus: BatchSku[] = [...qty].sort(([a], [b]) => a.localeCompare(b)).map(([sku, q]) => ({ sku, qty: q, list_price: list.get(sku)!, ...tierPrice(list.get(sku)!, q) }));
  const price = new Map(skus.map((s) => [s.sku, s.unit_price]));
  const quotes: Quote[] = inc.map((p) => {
    const lines: OwnLine[] = p.lines
      .filter((l) => l.qty > 0)
      .map((l) => ({ sku: l.sku, qty: l.qty, unit_price: price.get(l.sku)!, total: l.qty * price.get(l.sku)!, alone_total: l.qty * tierPrice(l.unit_price, l.qty).unit_price }));
    const total = lines.reduce((a, l) => a + l.total, 0);
    const alone_total = lines.reduce((a, l) => a + l.alone_total, 0);
    return { business: p.business, lines, total, alone_total, saving: alone_total - total };
  });
  return { skus, quotes, total: quotes.reduce((a, q) => a + q.total, 0), saving: quotes.reduce((a, q) => a + q.saving, 0) };
}

/** Deterministic fixture: three minimarkets, one supplier, five skus. Quantities are invented, not real orders. */
export function fixturePOs(): PurchaseOrder[] {
  const price = { "BRS-5KG": 68000, "MYK-2L": 36000, "GLA-1KG": 17500, "TEH-25": 9800, "MIE-40": 118000 };
  const po = (business: string, q: Record<keyof typeof price, number>): PurchaseOrder => ({
    business,
    lines: (Object.keys(price) as (keyof typeof price)[]).filter((s) => q[s] > 0).map((s) => ({ sku: s, qty: q[s], unit_price: price[s] })),
  });
  return [
    po("minimarket-1", { "BRS-5KG": 20, "MYK-2L": 40, "GLA-1KG": 10, "TEH-25": 30, "MIE-40": 60 }),
    po("minimarket-2", { "BRS-5KG": 20, "MYK-2L": 40, "GLA-1KG": 15, "TEH-25": 25, "MIE-40": 30 }),
    po("minimarket-3", { "BRS-5KG": 15, "MYK-2L": 30, "GLA-1KG": 10, "TEH-25": 0, "MIE-40": 20 }),
  ];
}

let seq = 0;
const runId = (tag: string) => `run_gb_${tag}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** The owner's decision `consent_group_buy` in their own workspace. Returns the receipt. */
export async function consentGroupBuy(ws: MekoWorkspace, label: string, opts: { by?: string } = {}): Promise<string> {
  const owner = await ws.run(runId("consent")).agent("owner", "Beli bareng: izin");
  const d = await owner.decide({
    input: `join group buy with supplier ${GROUP_SUPPLIER} for ${label}`,
    output: { supplier: GROUP_SUPPLIER, shares: "own purchase order lines only, to a batch that other consenting businesses join" },
    reasoning: `The owner (${opts.by ?? "signed in"}) agreed that this business's PO joins the batch. Each line still needs its own approval. The others never see these quantities.`,
    action: "consent_group_buy",
    action_class: CLASS,
    subject: `groupbuy:${GROUP_SUPPLIER}`,
  });
  return d.receipt_hash;
}

/** Receipt of the consent, or null when the owner never gave it. */
export function groupConsentReceipt(ws: MekoWorkspace): string | null {
  const d = ws.decisions({ agent: "owner", subject: `groupbuy:${GROUP_SUPPLIER}` }).filter((x) => x.action === "consent_group_buy");
  return d.length ? d[d.length - 1]!.entry_hash : null;
}

/** The owner's approval of their own line, nothing else in the input. */
export async function approveGroupLine(ws: MekoWorkspace, quote: Quote): Promise<string> {
  const owner = await ws.run(runId("approve")).agent("owner", "Beli bareng: setujui baris");
  const d = await owner.decide({
    input: JSON.stringify({ supplier: GROUP_SUPPLIER, lines: quote.lines.map((l) => ({ sku: l.sku, qty: l.qty, unit_price: l.unit_price })) }),
    output: { line: { lines: quote.lines, total: quote.total, saving: quote.saving } },
    reasoning: "The owner approved their own line at the batch price. Code computed the price from the tiers; no other business's quantity is part of this decision.",
    action: "approve_group_line",
    action_class: CLASS,
    subject: `groupbuy:${GROUP_SUPPLIER}`,
  });
  return d.receipt_hash;
}

export async function refuseGroupLine(ws: MekoWorkspace, quote: Quote): Promise<string> {
  const owner = await ws.run(runId("refuse")).agent("owner", "Beli bareng: tolak baris");
  const d = await owner.decide({
    input: JSON.stringify({ supplier: GROUP_SUPPLIER, lines: quote.lines.map((l) => ({ sku: l.sku, qty: l.qty, unit_price: l.unit_price })) }),
    output: { refused: true },
    reasoning: "The owner refused the batch price for their line; it leaves the batch and the price is recomputed for the rest.",
    action: "refuse_group_line",
    action_class: CLASS,
    subject: `groupbuy:${GROUP_SUPPLIER}`,
  });
  return d.receipt_hash;
}

export interface GroupBuyer {
  ws: MekoWorkspace;
  po: PurchaseOrder;
  /** Pseudonymous label ("M1"), used only in the owner's own workspace. */
  label: string;
  consent: boolean;
  /** The owner's choice for their quote (a person, in production). */
  decide: (quote: Quote) => "approve" | "refuse";
}

export interface GroupBuyResult {
  batch: Batch;
  /** Businesses (ids) left out, with the reason. */
  excluded: { business: string; reason: "no_consent" | "refused" }[];
  /** Receipt of each approved line, by business. */
  approvals: { business: string; receipt: string }[];
  /** Receipt of `place_group_order`, or null when fewer than 2 approved. */
  order: { receipt: string; exec: ExecResult } | null;
  rounds: number;
}

/** The whole scenario: consent gate, approvals, recompute on refusal, order after at least 2 approvals. */
export async function runGroupBuy(shared: MekoWorkspace, buyers: GroupBuyer[], execute: (connector: string, tool: string, args: Record<string, unknown>) => Promise<ExecResult>): Promise<GroupBuyResult> {
  const excluded: GroupBuyResult["excluded"] = [];
  let active = buyers.filter((b) => {
    const ok = b.consent && groupConsentReceipt(b.ws) !== null;
    if (!ok) excluded.push({ business: b.po.business, reason: "no_consent" });
    return ok;
  });
  let rounds = 0;
  for (;;) {
    rounds++;
    const batch = batchPOs(buyers.map((b) => b.po), active.map((b) => b.po.business));
    const approvals: GroupBuyResult["approvals"] = [];
    const refused: GroupBuyer[] = [];
    for (const b of active) {
      const q = batch.quotes.find((x) => x.business === b.po.business)!;
      if (b.decide(q) === "approve") approvals.push({ business: b.po.business, receipt: await approveGroupLine(b.ws, q) });
      else {
        await refuseGroupLine(b.ws, q);
        refused.push(b);
      }
    }
    if (refused.length === 0 || active.length - refused.length < 2) {
      for (const r of refused) excluded.push({ business: r.po.business, reason: "refused" });
      const keep = approvals;
      const finalBatch = refused.length ? batchPOs(buyers.map((b) => b.po), keep.map((a) => a.business)) : batch;
      if (keep.length < 2) return { batch: finalBatch, excluded, approvals: keep, order: null, rounds };
      return { batch: finalBatch, excluded, approvals: keep, order: await placeGroupOrder(shared, finalBatch, keep.map((a) => a.receipt), execute), rounds };
    }
    for (const r of refused) excluded.push({ business: r.po.business, reason: "refused" });
    active = active.filter((b) => !refused.includes(b));
  }
}

/** `place_group_order` in the shared workspace; goes through the Log connector (nothing real is sent). */
export async function placeGroupOrder(shared: MekoWorkspace, batch: Batch, receipts: string[], execute: (connector: string, tool: string, args: Record<string, unknown>) => Promise<ExecResult>): Promise<{ receipt: string; exec: ExecResult }> {
  if (receipts.length < 2) throw new Error(`group order needs at least 2 approvals, got ${receipts.length}`);
  const skus = batch.skus.map((s) => ({ sku: s.sku, qty: s.qty, unit_price: s.unit_price }));
  const exec = await execute("log", "place_group_order", { supplier: GROUP_SUPPLIER, skus, approvals: receipts.length });
  const agent = await shared.run(runId("order")).agent("operator", "Beli bareng: pesanan gabungan");
  const d = await agent.decide({
    input: `place the batched order with ${GROUP_SUPPLIER}`,
    output: { supplier: GROUP_SUPPLIER, receipts, skus, total: batch.total, via: exec.via, ok: exec.ok },
    reasoning: `Code batched the approved lines and priced them at the supplier tiers. ${receipts.length} owners approved their own line (receipts listed). The call went through the ${exec.via} connector.`,
    action: "place_group_order",
    action_class: CLASS,
    subject: `groupbuy:${GROUP_SUPPLIER}`,
  });
  return { receipt: d.receipt_hash, exec };
}

export interface GroupVerification {
  ok: boolean;
  problems: string[];
  /** Approvals found and checked. */
  approvals: number;
}

/**
 * Re-reads the order and every approval from the ledger and Meko: each receipt must exist, be an
 * `approve_group_line` after a `consent_group_buy` in the same workspace, match its stored trace, and
 * the lines must sum to the batch qty, price and total of the order.
 */
export async function verifyGroupOrder(shared: MekoWorkspace, owners: MekoWorkspace[], orderReceipt: string): Promise<GroupVerification> {
  const problems: string[] = [];
  const order = await verifyDecision(shared, orderReceipt);
  if (!order.ok || !order.message || order.decision?.action !== "place_group_order") return { ok: false, problems: [`order receipt: ${order.problem ?? "not a place_group_order decision"}`], approvals: 0 };
  const out = JSON.parse(String(order.message.output)) as { receipts: string[]; skus: { sku: string; qty: number; unit_price: number }[]; total: number };
  const sum = new Map<string, { qty: number; price: Set<number> }>();
  let total = 0;
  let found = 0;
  for (const r of out.receipts) {
    const ws = owners.find((w) => w.decisions({ action_class: CLASS }).some((d) => d.entry_hash === r));
    const dec = ws?.decisions({ action_class: CLASS }).find((d) => d.entry_hash === r);
    if (!ws || !dec) {
      problems.push(`approval ${r.slice(0, 8)} not found in any owner ledger`);
      continue;
    }
    const chk = await verifyDecision(ws, r);
    if (!chk.ok || !chk.message) {
      problems.push(`approval ${r.slice(0, 8)}: ${chk.problem ?? "trace does not match"}`);
      continue;
    }
    if (dec.action !== "approve_group_line") problems.push(`receipt ${r.slice(0, 8)} is ${dec.action}, not an approval`);
    const consent = ws.decisions({ action_class: CLASS }).find((d) => d.action === "consent_group_buy" && d.seq < dec.seq);
    if (!consent) problems.push(`approval ${r.slice(0, 8)} has no earlier consent`);
    found++;
    const line = (JSON.parse(String(chk.message.output)) as { line: { lines: OwnLine[]; total: number } }).line;
    let own = 0;
    for (const l of line.lines) {
      const e = sum.get(l.sku) ?? { qty: 0, price: new Set<number>() };
      e.qty += l.qty;
      e.price.add(l.unit_price);
      sum.set(l.sku, e);
      if (l.total !== l.qty * l.unit_price) problems.push(`approval ${r.slice(0, 8)}: line ${l.sku} total is not qty x price`);
      own += l.total;
    }
    if (own !== line.total) problems.push(`approval ${r.slice(0, 8)}: lines do not add up to the line total`);
    total += own;
  }
  for (const s of out.skus) {
    const e = sum.get(s.sku);
    if (!e || e.qty !== s.qty) problems.push(`sku ${s.sku}: approved lines sum to ${e?.qty ?? 0}, order says ${s.qty}`);
    if (e && (e.price.size !== 1 || !e.price.has(s.unit_price))) problems.push(`sku ${s.sku}: approved price differs from the order price`);
  }
  for (const k of sum.keys()) if (!out.skus.some((s) => s.sku === k)) problems.push(`sku ${k} approved but not in the order`);
  if (total !== out.total) problems.push(`approved lines total ${total}, order says ${out.total}`);
  return { ok: problems.length === 0, problems, approvals: found };
}
