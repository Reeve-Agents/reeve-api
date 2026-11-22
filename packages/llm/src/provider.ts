import type { PackId, Rulebook } from "@reeve/core";

/** What the model may know besides the SOP: the data's field names and types (never values) and the connected services. */
export interface SopHints {
  fields?: { name: string; type: string; values?: string[] }[];
  connectors?: string[];
  /** Real tools found on the connected services for this SOP's actions, with the arguments each requires. */
  tools?: { slug: string; description?: string; required: string[] }[];
  /** Anonymised patterns learned across other businesses (Gotong Royong): short plain sentences, no names, no amounts. Absent means the prompt is unchanged. */
  sharedHints?: string[];
}

/** Tokens of one model call, as the provider reported them. The offline sample reports zeros. */
export interface LLMUsage {
  /** The provider's name, e.g. "anthropic:claude-haiku-5-5" or "groq:some-model". */
  provider: string;
  /** The model that answered, as the provider named it. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache writes and reads, when the provider reports them (Claude does). */
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Called once per model call, as soon as the reply is in (also when the reply turns out unusable: the tokens were still spent). */
export type UsageListener = (usage: LLMUsage) => void;

/** Turns a plain-language SOP into rule cards for one domain pack. */
export interface LLMProvider {
  readonly name: string;
  parseSop(sop: string, pack?: PackId, hints?: SopHints, opts?: { onUsage?: UsageListener }): Promise<Rulebook>;
  /**
   * Plain text completion, for the Operator's two narrow jobs (rephrasing an approved message,
   * classifying a customer's reply). Providers without it (the fixture provider) mean "no LLM":
   * the Operator then uses the plain template and sends every reply to the owner.
   */
  completeText?(system: string, user: string, opts?: { maxTokens?: number; onUsage?: UsageListener }): Promise<string>;
}

export class LLMRefusalError extends Error {}
