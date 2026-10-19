import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { PackId, Rulebook } from "@reeve/core";
import type { LLMProvider, SopHints } from "./provider";
import { LLMRefusalError } from "./provider";
import { packSchema } from "./schemas";

/** Claude models offered for SOP parsing, most accurate first. Prices are the Claude API list price per million tokens. */
export const CLAUDE_MODELS = [
  { model: "claude-opus-5-5", label: "Claude Opus 5.5", price: "$4 / $20 per M tokens", note: "Most accurate. The default.", fallback: true },
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: "$2 / $10 per M tokens", note: "Half the price of Opus, close on structured extraction.", fallback: true },
  { model: "claude-haiku-5-5", label: "Claude Haiku 5.5", price: "$0.10 / $0.50 per M tokens", note: "Cheapest Claude. Check the cards it writes more carefully.", fallback: false },
] as const;

/**
 * Claude via the official SDK, with structured outputs constrained to the pack's flat schema.
 * Opus and Sonnet opt into server-side fallback; Haiku has none.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(private readonly model = "claude-opus-5-5") {
    this.name = `anthropic:${model}`;
    this.client = new Anthropic();
  }

  async parseSop(sop: string, pack: PackId = "rent-collection", hints?: SopHints): Promise<Rulebook> {
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
    if (response.stop_reason === "refusal") {
      throw new LLMRefusalError(`model declined to parse the SOP (${response.stop_details?.category ?? "unknown category"})`);
    }
    if (!response.parsed_output) throw new Error(`no structured output (stop_reason=${response.stop_reason})`);
    return toRulebook(response.parsed_output as never);
  }
}
