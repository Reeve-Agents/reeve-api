import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { PackId, Rulebook } from "@reeve/core";
import type { LLMProvider, LLMUsage, SopHints, UsageListener } from "./provider";
import { LLMRefusalError } from "./provider";
import { packSchema } from "./schemas";

/** Claude models offered for SOP parsing, most accurate first. Prices are the Claude API list price per million tokens. */
export const CLAUDE_MODELS = [
  { model: "claude-opus-5-5", label: "Claude Opus 5.5", price: "$4 / $20 per M tokens", note: "Most accurate. The default.", fallback: true },
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: "$2 / $10 per M tokens", note: "Half the price of Opus, close on structured extraction.", fallback: true },
  { model: "claude-haiku-5-5", label: "Claude Haiku 5.5", price: "$0.10 / $0.50 per M tokens ($0.50 / $2.50 above 100K prompt tokens)", note: "Cheapest Claude. Check the cards it writes more carefully.", fallback: false },
] as const;

/** The tokens of one Claude reply, from its own `usage` block (cache fields are null when caching is not used). */
export function claudeUsage(provider: string, requestedModel: string, response: { model?: string; usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null }): LLMUsage {
  const u = response.usage;
  return {
    provider,
    model: response.model || requestedModel,
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  };
}

/**
 * Claude via the official SDK, with structured outputs constrained to the pack's flat schema.
 * Opus and Sonnet opt into server-side fallback; Haiku has none.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private readonly client: Anthropic;

  /** `client` is for tests; by default the SDK reads ANTHROPIC_API_KEY. */
  constructor(
    private readonly model = "claude-opus-5-5",
    client?: Anthropic,
  ) {
    this.name = `anthropic:${model}`;
    this.client = client ?? new Anthropic();
  }

  async completeText(system: string, user: string, opts?: { maxTokens?: number; onUsage?: UsageListener }): Promise<string> {
    const response = await this.client.messages.create({ model: this.model, max_tokens: opts?.maxTokens ?? 600, system, messages: [{ role: "user", content: user }] });
    opts?.onUsage?.(claudeUsage(this.name, this.model, response));
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text) throw new Error(`${this.name} returned no text (stop_reason=${response.stop_reason}); the token limit may be too small`);
    return text;
  }

  async parseSop(sop: string, pack: PackId = "rent-collection", hints?: SopHints, opts?: { onUsage?: UsageListener }): Promise<Rulebook> {
    const { schema, toRulebook, system } = packSchema(pack, hints);
    const fallback = CLAUDE_MODELS.find((m) => m.model === this.model)?.fallback ?? false;
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: `SOP:\n\n${sop}` }],
    });
    // A refusal or an unusable reply still cost tokens, so report before judging the reply.
    opts?.onUsage?.(claudeUsage(this.name, this.model, response));
    if (response.stop_reason === "refusal") {
      throw new LLMRefusalError(`model declined to parse the SOP (${response.stop_details?.category ?? "unknown category"})`);
    }
    if (!response.parsed_output) throw new Error(`no structured output (stop_reason=${response.stop_reason})`);
    return toRulebook(response.parsed_output as never);
  }
}
