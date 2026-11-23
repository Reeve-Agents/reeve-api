// The model behind "Tanya usaha" for questions outside the fixed patterns. Off unless REEVE_ASK_LLM=on,
// Haiku-class by default (never the default Opus/Sonnet parser), and capped per WIB day. The public
// route has no login, so it gets its own, smaller cap and cannot use up the chats' (Telegram) share.
import type { AskLlm } from "@reeve/crew";
import type { LLMProvider, ProviderRegistry } from "@reeve/llm";

export const ASK_MODEL = "anthropic:claude-haiku-5-5";
/** Model calls per WIB day: chats (Telegram, wa.me) and the public web route. */
export const ASK_DAILY_CAP = { chat: 200, public: 50 } as const;
export const ASK_MAX_TOKENS = 1500;
const WIB_MS = 7 * 3_600_000;

type Usage = { name: string; model: string; input_tokens: number; output_tokens: number };

export class AskCapReached extends Error {
  override name = "AskCapReached";
}

export class AskTruncated extends Error {
  override name = "AskTruncated";
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(message);
  }
}

/**
 * Wraps a provider that can complete text. Past `dailyCap` calls in one WIB day it throws, and the
 * ask agent falls back to its template. The counter is per process: a restart starts it again.
 */
export function askLlmFrom(provider: LLMProvider, opts: { dailyCap?: number; maxTokens?: number; now?: () => number } = {}): AskLlm | undefined {
  const complete = provider.completeText?.bind(provider);
  if (!complete) return undefined;
  const cap = opts.dailyCap ?? ASK_DAILY_CAP.chat;
  const now = opts.now ?? Date.now;
  let day = "";
  let calls = 0;
  const roll = () => {
    const today = new Date(now() + WIB_MS).toISOString().slice(0, 10);
    if (today !== day) [day, calls] = [today, 0];
  };
  const llm: AskLlm = async (system, user) => {
    roll();
    if (calls >= cap) throw new AskCapReached(`ask LLM cap of ${cap} calls per day reached`);
    calls++;
    let usage: Usage | undefined;
    // Haiku 5.5 thinks before it answers, and the thinking counts against this limit.
    const maxTokens = opts.maxTokens ?? ASK_MAX_TOKENS;
    let text: string;
    try {
      text = await complete(system, user, {
        maxTokens,
        onUsage: (u) => (usage = { name: "ask_answer", model: u.model, input_tokens: u.inputTokens, output_tokens: u.outputTokens }),
      });
    } catch (err) {
      // The tokens were spent even when the reply is unusable ("returned no text"); keep them for the receipt.
      if (usage && err instanceof Error) Object.assign(err, { usage });
      throw err;
    }
    // A reply cut off at the limit can end mid-claim; the ask agent then uses its template.
    if (usage && usage.output_tokens >= maxTokens) throw new AskTruncated(`ask answer hit the ${maxTokens}-token limit`, usage);
    return { text, usage };
  };
  llm.remaining = () => (roll(), Math.max(0, cap - calls));
  return llm;
}

/**
 * From env: REEVE_ASK_LLM=on turns it on, REEVE_ASK_MODEL picks another provider id, and
 * REEVE_ASK_LLM_DAILY / REEVE_ASK_LLM_DAILY_PUBLIC set the caps for chats and the public route.
 */
export function askLlmFromEnv(providers: ProviderRegistry, scope: "chat" | "public", env: NodeJS.ProcessEnv = process.env): AskLlm | undefined {
  if (env.REEVE_ASK_LLM !== "on") return undefined;
  let provider: LLMProvider;
  try {
    provider = providers.get(env.REEVE_ASK_MODEL || ASK_MODEL);
  } catch {
    return undefined;
  }
  const raw = scope === "public" ? env.REEVE_ASK_LLM_DAILY_PUBLIC : env.REEVE_ASK_LLM_DAILY;
  const cap = Number(raw);
  return askLlmFrom(provider, { dailyCap: raw && Number.isFinite(cap) && cap >= 0 ? cap : ASK_DAILY_CAP[scope] });
}
