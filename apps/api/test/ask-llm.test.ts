import type { LLMProvider } from "@reeve/llm";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@reeve/llm";
import { AskCapReached, askLlmFrom, askLlmFromEnv, AskTruncated } from "../src/ask-llm";

function provider(withText = true): LLMProvider & { calls: number } {
  const p = {
    name: "fake:haiku",
    calls: 0,
    parseSop: async () => {
      throw new Error("not used");
    },
    ...(withText
      ? {
          completeText: async (_s: string, _u: string, opts?: { onUsage?: (u: { provider: string; model: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }) => void }) => {
            p.calls++;
            opts?.onUsage?.({ provider: "fake:haiku", model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0 });
            return "jawaban [R1]";
          },
        }
      : {}),
  };
  return p as unknown as LLMProvider & { calls: number };
}

describe("ask LLM", () => {
  it("returns the text with billed usage", async () => {
    const llm = askLlmFrom(provider())!;
    expect(await llm("s", "u")).toEqual({ text: "jawaban [R1]", usage: { name: "ask_answer", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 5 } });
  });

  it("refuses a reply that hit the token limit, keeping its usage", async () => {
    const llm = askLlmFrom(provider(), { maxTokens: 5 })!;
    const err = await llm("s", "u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AskTruncated);
    expect((err as AskTruncated).usage).toMatchObject({ output_tokens: 5 });
  });

  it("is off unless REEVE_ASK_LLM=on, and the public route has the smaller cap", () => {
    const reg = ProviderRegistry.of([provider()]);
    expect(askLlmFromEnv(reg, "chat", { REEVE_ASK_MODEL: "fake:haiku" })).toBeUndefined();
    const pub = askLlmFromEnv(reg, "public", { REEVE_ASK_LLM: "on", REEVE_ASK_MODEL: "fake:haiku" })!;
    const chat = askLlmFromEnv(reg, "chat", { REEVE_ASK_LLM: "on", REEVE_ASK_MODEL: "fake:haiku", REEVE_ASK_LLM_DAILY: "7" })!;
    expect(pub.remaining!()).toBe(50);
    expect(chat.remaining!()).toBe(7);
  });

  it("is off for a provider that cannot complete text", () => {
    expect(askLlmFrom(provider(false))).toBeUndefined();
  });

  it("stops at the daily cap and starts again the next WIB day", async () => {
    let t = Date.parse("2026-12-09T10:00:00Z");
    const p = provider();
    const llm = askLlmFrom(p, { dailyCap: 2, now: () => t })!;
    await llm("s", "u");
    await llm("s", "u");
    await expect(llm("s", "u")).rejects.toBeInstanceOf(AskCapReached);
    expect(p.calls).toBe(2);
    expect(llm.remaining!()).toBe(0);
    t = Date.parse("2026-12-09T17:00:01Z"); // 00:00 WIB on 10 Dec
    expect(llm.remaining!()).toBe(2);
    await llm("s", "u");
    expect(p.calls).toBe(3);
  });
});
