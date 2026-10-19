import { z } from "zod";
import { Rulebook, type RuleCard } from "@reeve/core";

/**
 * Flat card schema used only for LLM structured outputs.
 * The canonical RuleCard is a discriminated union of 8 types; compiled into a grammar that is
 * too large for structured outputs ("compiled grammar is too large"). This flat shape has one
 * object type with nullable fields; toRulebook() converts it into strict RuleCards.
 */
export const FlatCard = z.object({
  id: z.string().describe("R1, R2, ..."),
  kind: z.enum(["rule", "constraint", "kpi"]),
  type: z
    .enum(["invoice_schedule", "reminder", "late_fee", "notice", "overpayment", "max_fee", "approval_threshold", "revenue_target"])
    .describe(
      "invoice_schedule: when invoices go out; reminder: reminder days; late_fee: fee once overdue; notice: notice to vacate; overpayment: what happens to extra money; max_fee: cap on fees (constraint); approval_threshold: refunds above an amount need owner approval (constraint); revenue_target: monthly target (kpi)",
    ),
  title: z.string().describe("One-line human-readable rule, in the SOP's language"),
  source_quote: z.string().describe("The exact SOP phrase this card comes from"),
  day_of_month: z.number().int().nullable().describe("invoice_schedule: invoice day; revenue_target: the day to check the target"),
  days_after_due: z
    .array(z.number().int())
    .nullable()
    .describe("reminder: every reminder day; late_fee and notice: a single value, e.g. [7]"),
  percent: z.number().nullable().describe("late_fee: fee percent; max_fee: maximum total fee as a percent of rent"),
  basis: z
    .enum(["rent", "outstanding", "collected", "invoiced"])
    .nullable()
    .describe("late_fee: rent or outstanding; revenue_target: collected or invoiced"),
  grace_min_months: z.number().int().nullable().describe("late_fee: tenants staying at least this many months get extra days"),
  grace_extra_days: z.number().int().nullable().describe("late_fee: extra days for long-term tenants"),
  policy: z.enum(["credit_next_invoice", "refund_with_approval"]).nullable().describe("overpayment only"),
  amount: z.number().int().nullable().describe("approval_threshold: refund amount above which approval is needed; revenue_target: monthly target (IDR)"),
});
export type FlatCard = z.infer<typeof FlatCard>;

export const FlatRulebook = z.object({
  business_name: z.string(),
  cards: z.array(FlatCard),
  questions: z.array(z.string()).describe("Clarifying questions for the owner where the SOP is ambiguous"),
  assumptions: z.array(z.string()).describe("Assumptions made to fill gaps"),
});
export type FlatRulebook = z.infer<typeof FlatRulebook>;

export class CardConversionError extends Error {}

function need<T>(card: FlatCard, field: keyof FlatCard, value: T | null | undefined): T {
  if (value === null || value === undefined) throw new CardConversionError(`${card.id} (${card.type}): missing ${String(field)}`);
  return value;
}

function one(card: FlatCard): number {
  const days = need(card, "days_after_due", card.days_after_due);
  if (days.length !== 1) throw new CardConversionError(`${card.id} (${card.type}): expected exactly one value in days_after_due`);
  return days[0]!;
}

export function toRuleCard(c: FlatCard): RuleCard {
  const base = { id: c.id, title: c.title, source_quote: c.source_quote };
  switch (c.type) {
    case "invoice_schedule":
      return { ...base, kind: "rule", type: c.type, day_of_month: need(c, "day_of_month", c.day_of_month) };
    case "reminder":
      return { ...base, kind: "rule", type: c.type, days_after_due: need(c, "days_after_due", c.days_after_due) };
    case "late_fee": {
      const basis = need(c, "basis", c.basis);
      if (basis !== "rent" && basis !== "outstanding") throw new CardConversionError(`${c.id} (late_fee): basis must be rent or outstanding`);
      const grace = c.grace_min_months !== null && c.grace_extra_days !== null ? { min_months: c.grace_min_months, extra_days: c.grace_extra_days } : null;
      return { ...base, kind: "rule", type: c.type, days_after_due: one(c), percent: need(c, "percent", c.percent), basis, tenure_grace: grace };
    }
    case "notice":
      return { ...base, kind: "rule", type: c.type, days_after_due: one(c) };
    case "overpayment":
      return { ...base, kind: "rule", type: c.type, policy: need(c, "policy", c.policy) };
    case "max_fee":
      return { ...base, kind: "constraint", type: c.type, max_percent_of_rent: need(c, "percent", c.percent) };
    case "approval_threshold":
      return { ...base, kind: "constraint", type: c.type, refund_above: need(c, "amount", c.amount) };
    case "revenue_target": {
      const basis = need(c, "basis", c.basis);
      if (basis !== "collected" && basis !== "invoiced") throw new CardConversionError(`${c.id} (revenue_target): basis must be collected or invoiced`);
      return { ...base, kind: "kpi", type: c.type, monthly_target: need(c, "amount", c.amount), basis, alert_day: need(c, "day_of_month", c.day_of_month) };
    }
  }
}

export function toRulebook(flat: FlatRulebook): Rulebook {
  return Rulebook.parse({
    business_name: flat.business_name,
    currency: "IDR",
    cards: flat.cards.map(toRuleCard),
    questions: flat.questions,
    assumptions: flat.assumptions,
  });
}
