import { ConditionOp, Rulebook, type GenericCondition, type RuleCard, type Schedule } from "@reeve/core";
import { z } from "zod";
import { CardConversionError } from "./flat";

/**
 * One flat card type for the generic pack's structured outputs; toGenericRulebook() makes them strict.
 * Deliberately shallow (no nested nullable objects, values as text) to stay under the
 * structured-output grammar limit.
 */
const FlatCondition = z.object({
  field: z.string(),
  op: ConditionOp,
  value: z.string().describe("Number, text or day count as text; empty for empty/not_empty"),
});

export const FlatGenericCard = z.object({
  id: z.string(),
  kind: z.enum(["rule", "constraint", "kpi"]),
  type: z
    .enum(["generic_rule", "generic_approval", "generic_never", "generic_kpi"])
    .describe("generic_rule: on a schedule, for each matching record, run one tool; generic_approval: actions above an amount wait for the owner; generic_never: a tool never runs for matching records; generic_kpi: sum or count of matching records vs a threshold"),
  title: z.string(),
  source_quote: z.string(),
  every: z.enum(["day", "week", "month"]).nullable().describe("rule, kpi: how often it is checked"),
  weekday: z.number().nullable().describe("every=week: 0 = Monday ... 6 = Sunday"),
  day_of_month: z.number().nullable().describe("every=month: 1-28"),
  match: z.enum(["all", "any"]).nullable(),
  conditions: z.array(FlatCondition),
  connector: z.string().nullable().describe("rule: whatsapp, gmail, googlesheets, ... or log"),
  tool: z.string().nullable().describe("rule: the tool slug, or LOG; approval/never: the tool or *"),
  args: z.array(z.object({ name: z.string(), template: z.string() })).describe("rule: tool arguments with {field} placeholders"),
  amount_field: z.string().nullable().describe("rule: the record's money field, for approval limits"),
  once_per_record: z.boolean().nullable(),
  amount_above: z.number().nullable().describe("approval: limit in IDR"),
  aggregate: z.enum(["sum", "count"]).nullable(),
  field: z.string().nullable().describe("kpi sum: the numeric field"),
  alert_if: z.enum(["below", "above"]).nullable(),
  threshold: z.number().nullable(),
});
export type FlatGenericCard = z.infer<typeof FlatGenericCard>;

export const FlatGenericRulebook = z.object({
  business_name: z.string(),
  entity: z.string().describe("One record, e.g. Siswa, Customer, Order"),
  entity_plural: z.string(),
  key_field: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.enum(["number", "text", "date"]) })),
  source_connector: z.string().describe("Where the records live, e.g. googlesheets, csv"),
  source_tool: z.string().nullable(),
  cards: z.array(FlatGenericCard),
  questions: z.array(z.string()),
  assumptions: z.array(z.string()),
});
export type FlatGenericRulebook = z.infer<typeof FlatGenericRulebook>;

function need<T>(card: FlatGenericCard, field: keyof FlatGenericCard, value: T | null | undefined): T {
  if (value === null || value === undefined) throw new CardConversionError(`${card.id} (${card.type}): missing ${String(field)}`);
  return value;
}

const NUMERIC = new Set(["lt", "lte", "gt", "gte", "days_until_lte", "days_since_gte"]);
const condition = (c: z.infer<typeof FlatCondition>): GenericCondition => {
  if (c.op === "empty" || c.op === "not_empty") return { field: c.field, op: c.op, value: null };
  if (NUMERIC.has(c.op)) {
    const n = Number(c.value.replace(/[^0-9.-]/g, ""));
    if (c.value.trim() === "" || Number.isNaN(n)) throw new CardConversionError(`condition on ${c.field} (${c.op}) needs a number, got "${c.value}"`);
    return { field: c.field, op: c.op, value: n };
  }
  return { field: c.field, op: c.op, value: c.value };
};

const schedule = (c: FlatGenericCard): Schedule => ({
  every: need(c, "every", c.every),
  weekday: c.every === "week" ? need(c, "weekday", c.weekday) : null,
  day_of_month: c.every === "month" ? need(c, "day_of_month", c.day_of_month) : null,
});

export function toGenericCard(c: FlatGenericCard): RuleCard {
  const base = { id: c.id, title: c.title, source_quote: c.source_quote };
  const conditions = c.conditions.map(condition);
  switch (c.type) {
    case "generic_rule":
      return {
        ...base,
        kind: "rule",
        type: c.type,
        schedule: schedule(c),
        match: c.match ?? "all",
        conditions,
        action: { connector: c.connector ?? "log", tool: c.tool ?? "LOG", args: c.args, amount_field: c.amount_field },
        once_per_record: c.once_per_record ?? false,
      };
    case "generic_approval":
      return { ...base, kind: "constraint", type: c.type, tool: c.tool ?? "*", amount_above: need(c, "amount_above", c.amount_above) };
    case "generic_never":
      return { ...base, kind: "constraint", type: c.type, tool: c.tool ?? "*", match: c.match ?? "all", conditions };
    case "generic_kpi":
      return {
        ...base,
        kind: "kpi",
        type: c.type,
        schedule: schedule(c),
        aggregate: need(c, "aggregate", c.aggregate),
        field: c.field,
        match: c.match ?? "all",
        conditions,
        alert_if: need(c, "alert_if", c.alert_if),
        threshold: need(c, "threshold", c.threshold),
      };
  }
}

export function toGenericRulebook(flat: FlatGenericRulebook): Rulebook {
  return Rulebook.parse({
    pack: "generic",
    business_name: flat.business_name,
    currency: "IDR",
    data: {
      entity: flat.entity,
      entity_plural: flat.entity_plural,
      key_field: flat.key_field,
      fields: flat.fields,
      source: { connector: flat.source_connector, tool: flat.source_tool },
    },
    cards: flat.cards.map(toGenericCard),
    questions: flat.questions,
    assumptions: flat.assumptions,
  });
}
