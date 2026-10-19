import type { PackId, Rulebook } from "@reeve/core";
import { LLMRefusalError, type LLMProvider, type SopHints } from "./provider";
import { jsonSchemaFor, LLMOutputError, packSchema, rulebookFromJson } from "./schemas";

/**
 * Any server that speaks the OpenAI chat-completions protocol: OpenRouter, Groq, Gemini's
 * OpenAI endpoint, DeepSeek, OpenAI, a local Ollama or LM Studio. Lets an owner on a small
 * budget pick a cheaper or free model.
 *
 * Output is asked for as strict JSON Schema; a server that rejects `json_schema` is retried
 * once in plain JSON mode with the schema in the prompt. Whatever comes back is validated
 * against the same flat schema Claude uses, and a reply that does not fit gets one repair
 * turn quoting the problems. A model that still gets it wrong fails loudly: the Auditor
 * never sees half-formed rule cards.
 */
export interface OpenAICompatibleOptions {
  /** Short id, e.g. "groq". The provider's name is `${id}:${model}`. */
  id: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  /** "schema" sends response_format json_schema; "object" sends json_object (DeepSeek and older servers). */
  jsonMode?: "schema" | "object";
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Pull the JSON object out of a reply that may be wrapped in a code fence or a sentence. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new LLMOutputError("model reply contains no JSON object");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new LLMOutputError(`model reply is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private mode: "schema" | "object";
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = `${opts.id}:${opts.model}`;
    this.mode = opts.jsonMode ?? "schema";
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async parseSop(sop: string, pack: PackId = "rent-collection", hints?: SopHints): Promise<Rulebook> {
    const messages = (): ChatMessage[] => [
      { role: "system", content: this.system(pack, hints) },
      { role: "user", content: `SOP:\n\n${sop}` },
    ];
    let history = messages();
    let reply: string;
    try {
      reply = await this.complete(history, pack);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400 || this.mode !== "schema") throw err;
      this.mode = "object"; // this server does not take json_schema; remember for later calls
      history = messages();
      reply = await this.complete(history, pack);
    }

    try {
      return rulebookFromJson(pack, extractJson(reply));
    } catch (err) {
      if (!(err instanceof LLMOutputError)) throw err;
      history = [
        ...history,
        { role: "assistant", content: reply },
        { role: "user", content: `That JSON does not fit the schema: ${err.message}. Reply with the corrected JSON object only.` },
      ];
      return rulebookFromJson(pack, extractJson(await this.complete(history, pack)));
    }
  }

  private system(pack: PackId, hints?: SopHints): string {
    const { system } = packSchema(pack, hints);
    if (this.mode === "schema") return system;
    return `${system}\n\nReply with one JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(jsonSchemaFor(pack))}`;
  }

  private async complete(messages: ChatMessage[], pack: PackId): Promise<string> {
    const response_format =
      this.mode === "schema"
        ? { type: "json_schema", json_schema: { name: "rulebook", strict: true, schema: jsonSchemaFor(pack) } }
        : { type: "json_object" };
    const res = await this.fetch(`${this.opts.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify({ model: this.opts.model, messages, response_format, max_tokens: 16000 }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${this.opts.id} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    let body: ChatResponse;
    try {
      body = JSON.parse(text) as ChatResponse;
    } catch {
      throw new Error(`${this.opts.id} returned a non-JSON response`);
    }
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new LLMRefusalError(`model declined to parse the SOP (${choice.message.refusal})`);
    if (choice?.finish_reason === "length") throw new LLMOutputError(`${this.name} ran out of output tokens before finishing the rule cards`);
    const content = choice?.message?.content;
    if (!content) throw new LLMOutputError(`${this.name} returned no content${body.error?.message ? ` (${body.error.message})` : ""}`);
    return content;
  }
}
