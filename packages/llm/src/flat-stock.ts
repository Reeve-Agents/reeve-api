import { Rulebook, type RuleCard } from "@reeve/core";
import { z } from "zod";
import { CardConversionError } from "./flat";

/**
 * Flat card schema for the minimarket pack's structured outputs (one object type, nullable
 * fields), kept separate from the rent schema so neither grammar grows. toStockRulebook()
 * converts it into strict RuleCards.
 */
export const FlatStockCard = z.object({
  id: z.string().describe("M1, M2, ..."),
  kind: z.enum(["rule", "constraint", "kpi"]),
  type: z
    .enum(["reorder_point", "supplier_fallback", "expiry_markdown", "slow_mover_stop", "po_approval_threshold", "markdown_floor", "expiring_value_limit"])
    .describe(
      "reorder_point: reorder below a stock level, up to a target, from a supplier; supplier_fallback: switch to a backup supplier after N days late; expiry_markdown: discount N days before expiry (one card per step); slow_mover_stop: stop reordering after N days without a sale; po_approval_threshold: purchase orders above an amount need the owner (constraint); markdown_floor: discounts never below cost (constraint); expiring_value_limit: value of stock expiring soon must stay under a limit, checked on a weekday (kpi)",
    ),
  title: z.string().describe("One-line human-readable rule, in the SOP's language"),
  source_quote: z.string().describe("The exact SOP phrase this card comes from"),
  below_units: z.number().int().nullable().describe("reorder_point: reorder when shelf plus on-order stock is below this"),
  order_up_to_units: z.number().int().nullable().describe("reorder_point: order up to this many units"),
  supplier: z.string().nullable().describe('reorder_point: default supplier, by its id ("A" for "Supplier A")'),
  late_days: z.number().int().nullable().describe("supplier_fallback: days late before switching"),
  backup_supplier: z.string().nullable().describe('supplier_fallback: the backup supplier, by its id ("B" for "Supplier B")'),
  days_before_expiry: z.number().int().nullable().describe("expiry_markdown: H-n, e.g. 30"),
  percent: z.number().nullable().describe("expiry_markdown: discount percent, e.g. 20"),
  no_sale_days: z.number().int().nullable().describe("slow_mover_stop: days without a sale"),
  amount: z.number().int().nullable().describe("po_approval_threshold: PO value (IDR) above which the owner approves; expiring_value_limit: the limit (IDR)"),
  window_days: z.number().int().nullable().describe("expiring_value_limit: how many days ahead count as expiring"),
  check_weekday: z.number().int().nullable().describe("expiring_value_limit: 0 = Monday ... 6 = Sunday"),
});
export type FlatStockCard = z.infer<typeof FlatStockCard>;

export const FlatStockRulebook = z.object({
  business_name: z.string(),
  cards: z.array(FlatStockCard),
  questions: z.array(z.string()).describe("Clarifying questions for the owner where the SOP is ambiguous"),
  assumptions: z.array(z.string()).describe("Assumptions made to fill gaps"),
});
export type FlatStockRulebook = z.infer<typeof FlatStockRulebook>;

function need<T>(card: FlatStockCard, field: keyof FlatStockCard, value: T | null | undefined): T {
  if (value === null || value === undefined) throw new CardConversionError(`${card.id} (${card.type}): missing ${String(field)}`);
  return value;
}

/** "Supplier A" or "pemasok B" → "A", "B": the id the shop's supplier list uses. Other names stay as written. */
export function supplierId(name: string): string {
  return name.trim().replace(/^(supplier|suplier|pemasok)\s+/i, "") || name.trim();
}

export function toStockCard(c: FlatStockCard): RuleCard {
  const base = { id: c.id, title: c.title, source_quote: c.source_quote };
  switch (c.type) {
    case "reorder_point":
      return {
        ...base,
        kind: "rule",
        type: c.type,
        below_units: need(c, "below_units", c.below_units),
        order_up_to_units: need(c, "order_up_to_units", c.order_up_to_units),
        supplier: supplierId(need(c, "supplier", c.supplier)),
      };
    case "supplier_fallback":
      return { ...base, kind: "rule", type: c.type, late_days: need(c, "late_days", c.late_days), backup_supplier: supplierId(need(c, "backup_supplier", c.backup_supplier)) };
    case "expiry_markdown":
      return { ...base, kind: "rule", type: c.type, days_before_expiry: need(c, "days_before_expiry", c.days_before_expiry), percent: need(c, "percent", c.percent) };
    case "slow_mover_stop":
      return { ...base, kind: "rule", type: c.type, no_sale_days: need(c, "no_sale_days", c.no_sale_days) };
    case "po_approval_threshold":
      return { ...base, kind: "constraint", type: c.type, po_above: need(c, "amount", c.amount) };
    case "markdown_floor":
      return { ...base, kind: "constraint", type: c.type, floor: "cost" };
    case "expiring_value_limit":
      return {
        ...base,
        kind: "kpi",
        type: c.type,
        max_value: need(c, "amount", c.amount),
        window_days: need(c, "window_days", c.window_days),
        check_weekday: need(c, "check_weekday", c.check_weekday),
      };
  }
}

export function toStockRulebook(flat: FlatStockRulebook): Rulebook {
  return Rulebook.parse({
    pack: "minimarket",
    business_name: flat.business_name,
    currency: "IDR",
    cards: flat.cards.map(toStockCard),
    questions: flat.questions,
    assumptions: flat.assumptions,
  });
}
