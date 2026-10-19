import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Rulebook, type RuleCard } from "@reeve/core";
import {
  extractJson,
  FixtureProvider,
  jsonSchemaFor,
  LLMOutputError,
  LLMRefusalError,
  OpenAICompatibleProvider,
  ProviderRegistry,
  providerEntries,
  supplierId,
  toStockRulebook,
  UnknownProviderError,
  type FlatStockCard,
} from "../src/index";

const fixture = (name: string) =>
  Rulebook.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}/rulebook.json`, import.meta.url)), "utf8")));
const minimarket = fixture("minimarket");
const kos = fixture("kos-melati");

const blank = {
  below_units: null,
  order_up_to_units: null,
  supplier: null,
  late_days: null,
  backup_supplier: null,
  days_before_expiry: null,
  percent: null,
  no_sale_days: null,
  amount: null,
  window_days: null,
  check_weekday: null,
};

/** What a model would send back for a strict minimarket card: the flat form, nulls for the rest. */
function flatFromCard(c: RuleCard): FlatStockCard {
  const base = { id: c.id, kind: c.kind, title: c.title, source_quote: c.source_quote, ...blank };
  switch (c.type) {
    case "reorder_point":
      return { ...base, type: c.type, below_units: c.below_units, order_up_to_units: c.order_up_to_units, supplier: c.supplier };
    case "supplier_fallback":
      return { ...base, type: c.type, late_days: c.late_days, backup_supplier: c.backup_supplier };
    case "expiry_markdown":
      return { ...base, type: c.type, days_before_expiry: c.days_before_expiry, percent: c.percent };
    case "slow_mover_stop":
      return { ...base, type: c.type, no_sale_days: c.no_sale_days };
    case "po_approval_threshold":
      return { ...base, type: c.type, amount: c.po_above };
    case "markdown_floor":
      return { ...base, type: c.type };
    case "expiring_value_limit":
      return { ...base, type: c.type, amount: c.max_value, window_days: c.window_days, check_weekday: c.check_weekday };
    default:
      throw new Error(`not a minimarket card: ${c.type}`);
  }
}

const flatMinimarket = {
  business_name: minimarket.business_name,
  cards: minimarket.cards.map(flatFromCard),
  questions: minimarket.questions,
  assumptions: minimarket.assumptions,
};

interface Call {
  url: string;
  body: { model: string; messages: { role: string; content: string }[]; response_format: { type: string } };
}

/** A fake chat-completions server: each reply is a status and either message content or a raw body. */
function fakeServer(replies: ({ status?: number; content?: string; refusal?: string; finish?: string } | string)[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? { status: 500 };
    const reply = typeof r === "string" ? { content: r } : r;
    const status = reply.status ?? 200;
    const body =
      status === 200
        ? { choices: [{ finish_reason: reply.finish ?? "stop", message: { content: reply.content ?? null, refusal: reply.refusal ?? null } }] }
        : { error: { message: "response_format json_schema is not supported" } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const provider = (fetch: typeof globalThis.fetch, jsonMode?: "schema" | "object") =>
  new OpenAICompatibleProvider({ id: "groq", baseURL: "https://api.example.test/v1/", model: "some-model", apiKey: "k", jsonMode, fetch });

describe("minimarket flat schema", () => {
  it("round-trips the hand-written minimarket rulebook", () => {
    const rb = toStockRulebook(flatMinimarket);
    expect(rb.pack).toBe("minimarket");
    expect(rb.cards).toEqual(minimarket.cards);
  });

  it("writes suppliers by id, as the shop's supplier list does", () => {
    // Claude Opus 5.5 wrote "Supplier A" on its first live parse; the scenario knows "A".
    expect(supplierId("Supplier A")).toBe("A");
    expect(supplierId("pemasok B")).toBe("B");
    expect(supplierId("PT Sumber Rejeki")).toBe("PT Sumber Rejeki");
    const named = { ...flatMinimarket, cards: flatMinimarket.cards.map((c) => (c.supplier ? { ...c, supplier: `Supplier ${c.supplier}` } : c)) };
    expect(toStockRulebook(named).cards).toEqual(minimarket.cards);
  });

  it("strict JSON Schema: every field required, no extras, no $schema or ±2^53 bounds", () => {
    const schema = jsonSchemaFor("minimarket");
    const text = JSON.stringify(schema);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("9007199254740991");
    const card = (schema as any).properties.cards.items;
    expect(card.additionalProperties).toBe(false);
    expect(card.required).toEqual(Object.keys(card.properties));
    expect(card.properties.type.enum).toContain("expiry_markdown");
  });
});

describe("OpenAI-compatible provider", () => {
  it("asks for strict JSON Schema and returns strict rule cards", async () => {
    const server = fakeServer([JSON.stringify(flatMinimarket)]);
    const rb = await provider(server.fetch).parseSop("SOP text", "minimarket");
    expect(rb.cards).toEqual(minimarket.cards);
    expect(server.calls[0]!.url).toBe("https://api.example.test/v1/chat/completions");
    expect(server.calls[0]!.body.model).toBe("some-model");
    expect(server.calls[0]!.body.response_format.type).toBe("json_schema");
    expect(server.calls[0]!.body.messages[0]!.content).toContain("H-30");
  });

  it("falls back to JSON mode with the schema in the prompt when json_schema is rejected", async () => {
    const server = fakeServer([{ status: 400 }, "Here you go:\n```json\n" + JSON.stringify(flatMinimarket) + "\n```"]);
    const p = provider(server.fetch);
    await p.parseSop("SOP text", "minimarket");
    expect(server.calls[1]!.body.response_format.type).toBe("json_object");
    expect(server.calls[1]!.body.messages[0]!.content).toContain('"backup_supplier"');
    // remembered: the next SOP goes straight to JSON mode
    const again = fakeServer([JSON.stringify(flatMinimarket)]);
    (p as unknown as { fetch: typeof fetch }).fetch = again.fetch;
    await p.parseSop("SOP text", "minimarket");
    expect(again.calls[0]!.body.response_format.type).toBe("json_object");
  });

  it("gives the model one repair turn when a card is missing a field", async () => {
    const broken = structuredClone(flatMinimarket);
    broken.cards[0]!.below_units = null;
    const server = fakeServer([JSON.stringify(broken), JSON.stringify(flatMinimarket)]);
    const rb = await provider(server.fetch, "object").parseSop("SOP text", "minimarket");
    expect(rb.cards).toHaveLength(minimarket.cards.length);
    const repair = server.calls[1]!.body.messages.at(-1)!.content;
    expect(repair).toContain("missing below_units");
  });

  it("fails loudly when the repair is still wrong", async () => {
    const server = fakeServer(['{"business_name": 1}', '{"cards": "none"}']);
    await expect(provider(server.fetch).parseSop("SOP text", "minimarket")).rejects.toBeInstanceOf(LLMOutputError);
  });

  it("surfaces a refusal and a truncated reply", async () => {
    await expect(provider(fakeServer([{ refusal: "no" }]).fetch).parseSop("x")).rejects.toBeInstanceOf(LLMRefusalError);
    await expect(provider(fakeServer([{ content: "{", finish: "length" }]).fetch).parseSop("x")).rejects.toThrow(/ran out of output tokens/);
  });

  it("parses rent SOPs with the rent schema", async () => {
    const rentBlank = { days_after_due: null, percent: null, basis: null, grace_min_months: null, grace_extra_days: null, policy: null, amount: null };
    const flatRent = {
      business_name: "Kos Melati",
      cards: [{ id: "R1", kind: "rule", type: "invoice_schedule", title: "Tagihan tanggal 1", source_quote: "tanggal 1", day_of_month: 1, ...rentBlank }],
      questions: [],
      assumptions: [],
    };
    const server = fakeServer([JSON.stringify(flatRent)]);
    const rb = await provider(server.fetch).parseSop("SOP text", "rent-collection");
    expect(rb.pack ?? "rent-collection").toBe("rent-collection");
    expect(rb.cards[0]).toMatchObject({ type: "invoice_schedule", day_of_month: 1 });
    expect(server.calls[0]!.body.messages[0]!.content).toContain("recurring-billing");
  });

  it("pulls JSON out of fences and prose", () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a": {"b": 2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow(LLMOutputError);
  });
});

describe("provider registry", () => {
  const fixtures = [kos, minimarket];

  it("offers every Claude tier and each OpenAI-compatible service once it is set up", () => {
    const env = { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-model-id", OLLAMA_MODEL: "local-model" };
    const list = providerEntries(fixtures, env).map((e) => e.info);
    const ready = list.filter((p) => p.available).map((p) => p.id);
    expect(ready).toEqual(["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5", "gemini", "ollama", "fixture"]);
    expect(list.find((p) => p.id === "gemini")!.label).toBe("Google Gemini · gemini-model-id");
    expect(list.find((p) => p.id === "openai")).toMatchObject({ available: false, setup: "OPENAI_API_KEY and OPENAI_MODEL" });
  });

  it("REEVE_LLM picks the default and refuses one that is not set up", () => {
    expect(ProviderRegistry.fromEnv(fixtures, {}).defaultId).toBe("fixture");
    expect(ProviderRegistry.fromEnv(fixtures, { REEVE_LLM: "anthropic", ANTHROPIC_API_KEY: "a" }).defaultId).toBe("anthropic:claude-opus-5-5");
    expect(ProviderRegistry.fromEnv(fixtures, { REEVE_LLM: "anthropic", REEVE_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "a" }).defaultId).toBe("anthropic:claude-haiku-5-5");
    expect(ProviderRegistry.fromEnv(fixtures, { REEVE_LLM: "groq", GROQ_API_KEY: "k", GROQ_MODEL: "m" }).get().name).toBe("groq:m");
    expect(() => ProviderRegistry.fromEnv(fixtures, { REEVE_LLM: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => ProviderRegistry.fromEnv(fixtures, { REEVE_LLM: "bard" })).toThrow(UnknownProviderError);
  });

  it("the offline sample answers per pack", async () => {
    const p = new FixtureProvider(fixtures);
    expect((await p.parseSop("", "minimarket")).pack).toBe("minimarket");
    expect((await p.parseSop("", "rent-collection")).cards).toHaveLength(8);
    await expect(new FixtureProvider(kos).parseSop("", "minimarket")).rejects.toThrow(/no sample rulebook/);
  });
});
