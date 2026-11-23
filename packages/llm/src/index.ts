/**
 * The LLM only turns SOP text into structured rule cards. It never sees tenant data,
 * never writes the executable code directly, and is never called at runtime.
 * Swap providers here (e.g. a 0G TEE endpoint, or a cheaper model) without touching the Builder:
 * whatever the model, its output must fit the same flat schema and is checked by the same Auditor.
 */
export type { LLMProvider, LLMUsage, SopHints, UsageListener } from "./provider";
export { LLMRefusalError } from "./provider";
export { AnthropicProvider, CLAUDE_MODELS, claudeUsage } from "./anthropic";
export { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, CLAUDE_PRICES, DEFAULT_USD_IDR, PRICING_SOURCE, USAGE_PHASES, costUsd, fxRate, noUsage, priceFor, promptTokens, usdToIdr, type FxRate, type Price, type UsagePhase } from "./usage";
export { OpenAICompatibleProvider, extractJson, type OpenAICompatibleOptions } from "./openai-compatible";
export { FixtureProvider, ProviderRegistry, UnknownProviderError, providerEntries, type ProviderEntry, type ProviderInfo } from "./registry";
export { LLMOutputError, jsonSchemaFor, packSchema, rulebookFromJson, sharedHintsBlock } from "./schemas";
export { FlatCard, FlatRulebook, toRuleCard, toRulebook, CardConversionError } from "./flat";
export { FlatStockCard, FlatStockRulebook, supplierId, toStockCard, toStockRulebook } from "./flat-stock";
export { FlatGenericCard, FlatGenericRulebook, toGenericCard, toGenericRulebook } from "./flat-generic";
