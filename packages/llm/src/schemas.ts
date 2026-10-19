import type { PackId, Rulebook } from "@reeve/core";
import { z } from "zod";
import { CardConversionError, FlatRulebook, toRulebook } from "./flat";
import { FlatGenericRulebook, toGenericRulebook } from "./flat-generic";
import { FlatStockRulebook, toStockRulebook } from "./flat-stock";
import type { SopHints } from "./provider";

/** What the model is asked for, per domain pack: a flat schema, its converter, and the instructions. */
export interface PackSchema {
  schema: z.ZodType;
  toRulebook: (flat: never) => Rulebook;
  system: string;
}

/** The model's JSON did not fit the pack's schema (wrong shape, or a card missing a field its type needs). */
export class LLMOutputError extends Error {}

const COMMON = `Rules for the output:
- Classify every statement: "rule" (something to execute), "constraint" (something that must never happen), or "kpi" (a target or limit to monitor). A target such as a revenue goal is a KPI, never a rule.
- Use only the card types in the schema. Do not invent behaviour the SOP does not state. Leave fields that do not apply to a card as null.
- Quote the exact SOP phrase in source_quote.
- Where the SOP is ambiguous, choose the most conservative reading, record it under assumptions, and ask a clarifying question.
- Amounts are integer Indonesian rupiah.`;

const RENT = `You are Reeve's Builder. You convert a small business's standard operating procedure (SOP), written in plain language (often Indonesian), into structured rule cards for a recurring-billing workflow (rent, invoices, reminders, late fees).

${COMMON}
- Typical ambiguities: whether a fee is on the rent or the unpaid balance, and what happens on overpayment.`;

const STOCK = `You are Reeve's Builder. You convert a small shop's standard operating procedure (SOP) for stock, written in plain language (often Indonesian), into structured rule cards: reordering, suppliers, markdowns before expiry, slow movers, purchase-order approval.

${COMMON}
- "H-30" means 30 days before the expiry date. Write one expiry_markdown card per discount step.
- Weekdays are numbered 0 = Monday (Senin) ... 6 = Sunday (Minggu).
- Typical ambiguities: whether one reorder level fits every item, and whether stock already on order counts.`;

const GENERIC = `You are Reeve's Builder. You convert any small business's standard operating procedure (SOP), written in plain language (often Indonesian), into structured rule cards that run over the business's own records (rows of a spreadsheet, a CRM, a POS) and act through connected services.

${COMMON}
- A rule is: on a schedule (every day / week / month), for every record whose conditions hold, run one tool. Use generic_rule.
- Conditions only use the record's field names. "Due in 3 days or less" is days_until_lte 3 on the date field; "7 days overdue" is days_since_gte 7; "not paid" is neq "lunas" (or the value the data uses).
- Actions are connector tools. Prefer a service the owner connected. Use Composio tool slugs you are sure of (for example GMAIL_SEND_EMAIL); fill args with {field} placeholders. If you are not sure a tool exists, use connector "log" and tool "LOG", and ask a question. Reeve checks every tool against the connected services before anything runs.
- "Never do X when ..." is generic_never. "Above an amount needs my approval" is generic_approval, and the rule's action must name the amount_field. A target or limit to watch is generic_kpi.
- once_per_record is true when the SOP says once ("cukup sekali", "sekali saja"), false when it repeats every scheduled day.
- Card ids are R1, R2, ... in SOP order.
- When a field lists its values, compare with exactly those words, and use the field that holds them.
- Describe the data: the entity, its key field, every field you use with its type, and where the records live.`;

export function packSchema(pack: PackId, hints: SopHints = {}): PackSchema {
  if (pack === "generic") {
    const fields = hints.fields?.length ? `\n\nThe owner's records have these fields (names and types only):\n${hints.fields.map((f) => `- ${f.name} (${f.type})${f.values ? `: one of ${f.values.map((v) => JSON.stringify(v)).join(", ")}` : ""}`).join("\n")}` : "";
    const connectors = hints.connectors?.length ? `\n\nConnected services: ${hints.connectors.join(", ")}.` : "";
    const tools = hints.tools?.length
      ? `\n\nThese tools exist on the connected services. Use these exact slugs, and give every required argument (as {field} templates or fixed text):\n${hints.tools.map((t) => `- ${t.slug} (required: ${t.required.join(", ") || "none"})${t.description ? `: ${t.description}` : ""}`).join("\n")}`
      : "";
    return { schema: FlatGenericRulebook, toRulebook: toGenericRulebook as (flat: never) => Rulebook, system: GENERIC + fields + connectors + tools };
  }
  return pack === "minimarket"
    ? { schema: FlatStockRulebook, toRulebook: toStockRulebook as (flat: never) => Rulebook, system: STOCK }
    : { schema: FlatRulebook, toRulebook: toRulebook as (flat: never) => Rulebook, system: RENT };
}

/** Validate a model's raw JSON against the pack's flat schema and convert it to strict rule cards. */
export function rulebookFromJson(pack: PackId, raw: unknown): Rulebook {
  const { schema, toRulebook } = packSchema(pack);
  const flat = schema.safeParse(raw);
  if (!flat.success) {
    const issues = flat.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new LLMOutputError(`model output does not match the ${pack} schema: ${issues.join("; ")}`);
  }
  try {
    return toRulebook(flat.data as never);
  } catch (err) {
    if (err instanceof CardConversionError) throw new LLMOutputError(err.message);
    throw err;
  }
}

/**
 * JSON Schema for OpenAI-compatible `response_format` (strict mode): every property required,
 * no extra properties, no `$schema`, and no ±2^53 integer bounds (some providers reject them).
 */
export function jsonSchemaFor(pack: PackId): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) >= Number.MAX_SAFE_INTEGER) continue;
      out[k] = clean(v);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return clean(z.toJSONSchema(packSchema(pack).schema)) as Record<string, unknown>;
}
