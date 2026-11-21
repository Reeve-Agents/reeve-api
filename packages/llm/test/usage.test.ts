import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Rulebook } from "@reeve/core";
import {
  AnthropicProvider,
  claudeUsage,
  costUsd,
  DEFAULT_USD_IDR,
  FixtureProvider,
  fxRate,
  LLMRefusalError,
  OpenAICompatibleProvider,
  priceFor,
  usdToIdr,
  type LLMUsage,
} from "../src/index";

const use = (provider: string, model: string, inputTokens: number, outputTokens: number, extra: Partial<LLMUsage> = {}): LLMUsage => ({
  provider,
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  ...extra,
});
const M = 1_000_000;

describe("price table (platform.claude.com/docs/en/about-claude/pricing, checked 11 Nov 2026)", () => {
  it("prices each Claude model per million tokens", () => {
    expect(costUsd(use("anthropic:claude-opus-5-5", "claude-opus-5-5", M, M))).toBeCloseTo(4 + 20, 10);
    expect(costUsd(use("anthropic:claude-sonnet-5-5", "claude-sonnet-5-5", M, M))).toBeCloseTo(2 + 10, 10);
    // Haiku has a long-prompt tier above 100K tokens (below), so a million-token call is not its standard price: use 50K here.
    expect(costUsd(use("anthropic:claude-haiku-5-5", "claude-haiku-5-5", 50_000, 50_000))).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.5) / M, 12);
    expect(costUsd(use("anthropic:claude-fable-5-2", "claude-fable-5-2", M, M))).toBeCloseTo(8 + 40, 10);
    // Input and output are priced apart.
    expect(costUsd(use("anthropic:claude-opus-5-5", "claude-opus-5-5", 2_500, 700))).toBeCloseTo((2_500 * 4 + 700 * 20) / M, 12);
  });

  it("Haiku: prompts up to 100K tokens at 0.10/0.50, above that the whole call at 0.50/2.50", () => {
    const haiku = (input: number, output: number, extra: Partial<LLMUsage> = {}) => use("anthropic:claude-haiku-5-5", "claude-haiku-5-5", input, output, extra);
    expect(priceFor(haiku(100_000, 10))).toEqual({ input: 0.1, output: 0.5 }); // exactly 100K is still the low tier
    expect(priceFor(haiku(100_001, 10))).toEqual({ input: 0.5, output: 2.5 });
    expect(costUsd(haiku(100_000, 1_000))).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / M, 12);
    expect(costUsd(haiku(150_000, 1_000))).toBeCloseTo((150_000 * 0.5 + 1_000 * 2.5) / M, 12);
    // Cached prompt tokens count toward the prompt that picks the tier.
    expect(priceFor(haiku(40_000, 10, { cacheReadTokens: 70_000 }))).toEqual({ input: 0.5, output: 2.5 });
    // Other models have no long-prompt tier.
    expect(priceFor(use("anthropic:claude-sonnet-5-5", "claude-sonnet-5-5", 500_000, 10))).toEqual({ input: 2, output: 10 });
  });

  it("bills cache writes at 1.25x and cache reads at 0.1x the input price", () => {
    const u = use("anthropic:claude-opus-5-5", "claude-opus-5-5", 1_000, 100, { cacheWriteTokens: 2_000, cacheReadTokens: 10_000 });
    expect(costUsd(u)).toBeCloseTo((1_000 * 4 + 2_000 * 4 * 1.25 + 10_000 * 4 * 0.1 + 100 * 20) / M, 12);
  });

  it("knows a dated snapshot of a model, not a model it has never heard of", () => {
    expect(costUsd(use("anthropic:claude-haiku-5-5", "claude-haiku-5-5-20261001", 50_000, 0))).toBeCloseTo(0.005, 10);
    expect(costUsd(use("anthropic:claude-haiku-5-5", "claude-haiku-5-55", 50_000, 0))).toBeNull();
    expect(costUsd(use("anthropic:claude-mystery-9", "claude-mystery-9", M, M))).toBeNull();
  });

  it("other providers: tokens only, cost unknown (null), unless an override names a price", () => {
    const groq = use("groq:llama-x", "llama-x", M, M);
    expect(costUsd(groq, {})).toBeNull();
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: '{"groq:llama-x":{"input":0.5,"output":1.5}}' })).toBeCloseTo(2, 10);
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: '{"groq":{"input":1,"output":1}}' })).toBeCloseTo(2, 10); // by service id
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: '{"llama-x":{"input":0,"output":0}}' })).toBe(0); // by model: a free local model
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: "not json" })).toBeNull();
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: '{"groq":{"input":-1,"output":1}}' })).toBeNull();
    expect(costUsd(groq, { REEVE_PRICE_OVERRIDES: '{"openai":{"input":1,"output":1}}' })).toBeNull();
  });

  it("the offline sample costs nothing", () => {
    expect(costUsd(use("fixture", "fixture", 0, 0))).toBe(0);
  });
});

describe("Rupiah", () => {
  it("defaults to JISDOR BI 11 Nov 2026: Rp18.154 per USD", () => {
    expect(DEFAULT_USD_IDR).toEqual({ usdIdr: 18154, asOf: "2026-11-11", source: "JISDOR BI" });
    expect(fxRate({})).toEqual(DEFAULT_USD_IDR);
    expect(usdToIdr(2, fxRate({}))).toBe(36308);
    // 1M Opus input tokens = $4.
    expect(usdToIdr(costUsd(use("anthropic:claude-opus-5-5", "claude-opus-5-5", M, 0))!, fxRate({}))).toBeCloseTo(72_616, 6);
  });

  it("REEVE_USD_IDR replaces the rate; its date is unknown unless REEVE_USD_IDR_DATE says", () => {
    expect(fxRate({ REEVE_USD_IDR: "16500" })).toEqual({ usdIdr: 16500, asOf: null, source: "REEVE_USD_IDR" });
    expect(fxRate({ REEVE_USD_IDR: " 16500.5 ", REEVE_USD_IDR_DATE: "2026-12-01" })).toEqual({ usdIdr: 16500.5, asOf: "2026-12-01", source: "REEVE_USD_IDR" });
    for (const bad of ["", "abc", "0", "-5", "NaN"]) expect(fxRate({ REEVE_USD_IDR: bad })).toEqual(DEFAULT_USD_IDR);
  });
});

// ── Usage capture, by provider ──

const rentFlat = {
  business_name: "Kos Melati",
  cards: [{ id: "R1", kind: "rule", type: "invoice_schedule", title: "Tagihan tanggal 1", source_quote: "tanggal 1", day_of_month: 1, days_after_due: null, percent: null, basis: null, grace_min_months: null, grace_extra_days: null, policy: null, amount: null }],
  questions: [],
  assumptions: [],
};

function fakeClaude(reply: { model?: string; usage?: Record<string, number | null>; stop_reason?: string; content?: unknown[]; parsed_output?: unknown }) {
  return {
    messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: " Halo " }], ...reply }) },
    beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: rentFlat, ...reply }) } },
  } as unknown as Anthropic;
}

describe("usage capture: Anthropic", () => {
  it("reads input, output and cache tokens from the reply's own usage block", () => {
    expect(claudeUsage("anthropic:m", "m", { model: "m-snap", usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } })).toEqual({
      provider: "anthropic:m",
      model: "m-snap",
      inputTokens: 12,
      outputTokens: 3,
      cacheWriteTokens: 5,
      cacheReadTokens: 7,
    });
    // Null cache fields (caching not used) and a missing usage block are zeros, and the requested model stands in for a missing one.
    expect(claudeUsage("p", "asked", { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null } })).toMatchObject({ model: "asked", cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(claudeUsage("p", "asked", {})).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("completeText reports the tokens of the call", async () => {
    const seen: LLMUsage[] = [];
    const p = new AnthropicProvider("claude-haiku-5-5", fakeClaude({ model: "claude-haiku-5-5", usage: { input_tokens: 800, output_tokens: 60, cache_creation_input_tokens: null, cache_read_input_tokens: 100 } }));
    expect(await p.completeText("system", "user", { onUsage: (u) => seen.push(u) })).toBe("Halo");
    expect(seen).toEqual([{ provider: "anthropic:claude-haiku-5-5", model: "claude-haiku-5-5", inputTokens: 800, outputTokens: 60, cacheWriteTokens: 0, cacheReadTokens: 100 }]);
    expect(costUsd(seen[0]!)).toBeCloseTo((800 * 0.1 + 100 * 0.1 * 0.1 + 60 * 0.5) / M, 12);
    await p.completeText("system", "user"); // no listener is fine
  });

  it("parseSop reports the tokens of the Builder call", async () => {
    const seen: LLMUsage[] = [];
    const p = new AnthropicProvider("claude-opus-5-5", fakeClaude({ model: "claude-opus-5-5", usage: { input_tokens: 4_200, output_tokens: 1_900, cache_creation_input_tokens: null, cache_read_input_tokens: null } }));
    const rb = await p.parseSop("SOP", "rent-collection", undefined, { onUsage: (u) => seen.push(u) });
    expect(rb.cards).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: "anthropic:claude-opus-5-5", inputTokens: 4_200, outputTokens: 1_900 });
    expect(costUsd(seen[0]!)).toBeCloseTo((4_200 * 4 + 1_900 * 20) / M, 12);
  });

  it("a refusal still cost tokens, and they are reported before the error", async () => {
    const seen: LLMUsage[] = [];
    const p = new AnthropicProvider("claude-opus-5-5", fakeClaude({ stop_reason: "refusal", usage: { input_tokens: 300, output_tokens: 20 }, parsed_output: null }));
    await expect(p.parseSop("SOP", "rent-collection", undefined, { onUsage: (u) => seen.push(u) })).rejects.toBeInstanceOf(LLMRefusalError);
    expect(seen).toMatchObject([{ inputTokens: 300, outputTokens: 20 }]);
  });
});

describe("usage capture: OpenAI-compatible", () => {
  const server = (replies: { content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }[]) =>
    (async () => {
      const r = replies.shift()!;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: r.content } }], ...(r.usage ? { usage: r.usage } : {}) }), { status: 200 });
    }) as unknown as typeof fetch;
  const provider = (fetch: typeof globalThis.fetch) => new OpenAICompatibleProvider({ id: "groq", baseURL: "https://api.example.test/v1", model: "some-model", apiKey: "k", fetch });

  it("completeText reports prompt and completion tokens; cost is unknown without an override", async () => {
    const seen: LLMUsage[] = [];
    const p = provider(server([{ content: " ok ", usage: { prompt_tokens: 120, completion_tokens: 8 } }]));
    expect(await p.completeText("s", "u", { onUsage: (u) => seen.push(u) })).toBe("ok");
    expect(seen).toEqual([{ provider: "groq:some-model", model: "some-model", inputTokens: 120, outputTokens: 8, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
    expect(costUsd(seen[0]!, {})).toBeNull();
  });

  it("parseSop reports every call it makes, the repair turn included", async () => {
    const seen: LLMUsage[] = [];
    const p = provider(
      server([
        { content: '{"business_name":"x"}', usage: { prompt_tokens: 1_000, completion_tokens: 50 } }, // does not fit the schema
        { content: JSON.stringify(rentFlat), usage: { prompt_tokens: 1_200, completion_tokens: 400 } },
      ]),
    );
    const rb = await p.parseSop("SOP", "rent-collection", undefined, { onUsage: (u) => seen.push(u) });
    expect(rb.cards).toHaveLength(1);
    expect(seen.map((u) => [u.inputTokens, u.outputTokens])).toEqual([[1_000, 50], [1_200, 400]]);
  });

  it("a reply without a usage block counts as zero tokens, not as a guess", async () => {
    const seen: LLMUsage[] = [];
    await provider(server([{ content: "ok" }])).completeText("s", "u", { onUsage: (u) => seen.push(u) });
    expect(seen[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("usage capture: the offline sample", () => {
  it("reports zero tokens and costs nothing", async () => {
    const kos = Rulebook.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/kos-melati/rulebook.json", import.meta.url)), "utf8")));
    const seen: LLMUsage[] = [];
    await new FixtureProvider(kos).parseSop("", "rent-collection", undefined, { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
    expect(costUsd(seen[0]!)).toBe(0);
  });
});
