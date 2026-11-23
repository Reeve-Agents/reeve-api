// The model behind "Tanya usaha" for questions outside the fixed patterns. Haiku-class by default,
// never the default Opus/Sonnet parser, and capped per day because the public ask route has no login.
import type { AskLlm } from "@reeve/crew";
import type { LLMProvider, ProviderRegistry } from "@reeve/llm";

export const ASK_MODEL = "anthropic:claude-haiku-5-5";
export const ASK_DAILY_CAP = 200;
export const ASK_MAX_TOKENS = 1500;

export class AskCapReached extends Error {
  override name = "AskCapReached";
}

export class AskTruncated extends Error {
  override name = "AskTruncated";
}

/** Wraps a provider that can complete text; past `dailyCap` calls in one UTC day it throws, and the ask agent falls back to its template. */
export function askLlmFrom(provider: LLMProvider, opts: { dailyCap?: number; maxTokens?: number; now?: () => number } = {}): AskLlm | undefined {
  const complete = provider.completeText?.bind(provider);
  if (!complete) return undefined;
  const cap = opts.dailyCap ?? ASK_DAILY_CAP;
  const now = opts.now ?? Date.now;
  let day = "";
  let calls = 0;
  return async (system, user) => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) [day, calls] = [today, 0];
    if (calls >= cap) throw new AskCapReached(`ask LLM cap of ${cap} calls per day reached`);
    calls++;
    let usage: { name: string; model: string; input_tokens: number; output_tokens: number } | undefined;
    // Haiku 5.5 thinks before it answers, and the thinking counts against this limit.
    const maxTokens = opts.maxTokens ?? ASK_MAX_TOKENS;
    const text = await complete(system, user, {
      maxTokens,
      onUsage: (u) => (usage = { name: "ask_answer", model: u.model, input_tokens: u.inputTokens, output_tokens: u.outputTokens }),
    });
    // A reply cut off at the limit can end mid-claim; the ask agent then uses its template.
    if (usage && usage.output_tokens >= maxTokens) throw new AskTruncated(`ask answer hit the ${maxTokens}-token limit`);
    return { text, usage };
  };
}

/** From env: REEVE_ASK_LLM=off turns it off, REEVE_ASK_MODEL picks another provider id, REEVE_ASK_LLM_DAILY sets the cap. */
export function askLlmFromEnv(providers: ProviderRegistry, env: NodeJS.ProcessEnv = process.env): AskLlm | undefined {
  if (env.REEVE_ASK_LLM === "off") return undefined;
  let provider: LLMProvider;
  try {
    provider = providers.get(env.REEVE_ASK_MODEL || ASK_MODEL);
  } catch {
    return undefined;
  }
  const cap = Number(env.REEVE_ASK_LLM_DAILY);
  return askLlmFrom(provider, { dailyCap: Number.isFinite(cap) && cap >= 0 && env.REEVE_ASK_LLM_DAILY ? cap : ASK_DAILY_CAP });
}
