import type { LLMUsage } from "./provider";

/**
 * What a model call costs. Tokens come from the provider's own `usage` block (never estimated);
 * the price table is the Claude API list price, and anything else is "unknown" unless the owner says
 * what it costs. The Rupiah figure is the USD figure times one stated exchange rate, never a guess.
 */

/** Where in Reeve a model was called. Everything the Operator does besides these two is plain code. */
export type UsagePhase = "builder_compile" | "operator_draft" | "operator_classify";
export const USAGE_PHASES: readonly UsagePhase[] = ["builder_compile", "operator_draft", "operator_classify"];

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
}

export const PRICING_SOURCE = { url: "https://platform.claude.com/docs/en/about-claude/pricing", checked: "2026-11-11" } as const;

interface ClaudePrice {
  standard: Price;
  /** A prompt longer than this many tokens is billed, in full, at this price. */
  long?: { aboveTokens: number; price: Price };
}

/** Claude API list prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, checked 11 Nov 2026). */
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-opus-5-5": { standard: { input: 4, output: 20 } },
  "claude-sonnet-5-5": { standard: { input: 2, output: 10 } },
  "claude-haiku-5-5": { standard: { input: 0.1, output: 0.5 }, long: { aboveTokens: 100_000, price: { input: 0.5, output: 2.5 } } },
  "claude-fable-5-2": { standard: { input: 8, output: 40 } },
};

/** Prompt caching is billed as a multiple of the input price: a write costs 1.25x, a read 0.1x. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** The prompt of one call: fresh input plus everything read from or written to the cache. */
export const promptTokens = (u: Pick<LLMUsage, "inputTokens" | "cacheWriteTokens" | "cacheReadTokens">) => u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;

/** "claude-haiku-5-5" or a dated snapshot of it ("claude-haiku-5-5-20261001"); null for a model not in the table. */
function claudeKey(model: string): string | null {
  const m = model.trim().toLowerCase();
  return Object.keys(CLAUDE_PRICES).find((k) => m === k || m.startsWith(`${k}-`)) ?? null;
}

/**
 * REEVE_PRICE_OVERRIDES: JSON like {"groq:llama-3.3-70b":{"input":0.59,"output":0.79},"ollama":{"input":0,"output":0}},
 * USD per million tokens. A key is the provider's full name, its model, or just the service id (the part before ":").
 * It is the only way a non-Claude model gets a price, and it may also replace a Claude one.
 */
function overrideFor(u: Pick<LLMUsage, "provider" | "model">, env: NodeJS.ProcessEnv): Price | null {
  const raw = env.REEVE_PRICE_OVERRIDES?.trim();
  if (!raw) return null;
  let table: Record<string, { input?: unknown; output?: unknown }>;
  try {
    table = JSON.parse(raw) as typeof table;
  } catch {
    return null;
  }
  for (const key of [u.provider, u.model, u.provider.split(":")[0]!]) {
    const p = table?.[key];
    if (p && typeof p.input === "number" && typeof p.output === "number" && p.input >= 0 && p.output >= 0) return { input: p.input, output: p.output };
  }
  return null;
}

/** The price that applies to this call, or null when nobody knows it. */
export function priceFor(u: Pick<LLMUsage, "provider" | "model" | "inputTokens" | "cacheWriteTokens" | "cacheReadTokens">, env: NodeJS.ProcessEnv = process.env): Price | null {
  const override = overrideFor(u, env);
  if (override) return override;
  if (!u.provider.startsWith("anthropic")) return null;
  const key = claudeKey(u.model);
  const entry = key ? CLAUDE_PRICES[key] : undefined;
  if (!entry) return null;
  return entry.long && promptTokens(u) > entry.long.aboveTokens ? entry.long.price : entry.standard;
}

/** USD for one call: 0 for the offline sample provider, null when the model has no known price. */
export function costUsd(u: LLMUsage, env: NodeJS.ProcessEnv = process.env): number | null {
  if (u.provider === "fixture") return 0;
  const p = priceFor(u, env);
  if (!p) return null;
  const inputUnits = u.inputTokens + u.cacheWriteTokens * CACHE_WRITE_MULTIPLIER + u.cacheReadTokens * CACHE_READ_MULTIPLIER;
  return (inputUnits * p.input + u.outputTokens * p.output) / 1_000_000;
}

/** One exchange rate for converting USD to Rupiah, and where it comes from. */
export interface FxRate {
  usdIdr: number;
  /** The date the rate is from, or null when the owner set the rate without saying. */
  asOf: string | null;
  source: string;
}

export const DEFAULT_USD_IDR: FxRate = { usdIdr: 18154, asOf: "2026-11-11", source: "JISDOR BI" };

/** REEVE_USD_IDR (with REEVE_USD_IDR_DATE for the date), else the JISDOR BI rate of 11 Nov 2026. */
export function fxRate(env: NodeJS.ProcessEnv = process.env): FxRate {
  const raw = env.REEVE_USD_IDR?.trim();
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return { usdIdr: n, asOf: env.REEVE_USD_IDR_DATE?.trim() || null, source: "REEVE_USD_IDR" };
  return { ...DEFAULT_USD_IDR };
}

export const usdToIdr = (usd: number, rate: FxRate = fxRate()) => usd * rate.usdIdr;

/** A zeroed usage block, for providers that make no paid call (the offline sample). */
export const noUsage = (provider: string, model: string): LLMUsage => ({ provider, model, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
