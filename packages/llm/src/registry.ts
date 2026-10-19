import { packOf, Rulebook, type PackId } from "@reeve/core";
import { AnthropicProvider, CLAUDE_MODELS } from "./anthropic";
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible";
import type { LLMProvider } from "./provider";

/** Replays the hand-written rulebook for the pack. Offline and free; it ignores the SOP text. */
export class FixtureProvider implements LLMProvider {
  readonly name = "fixture";
  private readonly byPack = new Map<PackId, Rulebook>();

  constructor(rulebooks: Rulebook | Rulebook[]) {
    for (const rb of Array.isArray(rulebooks) ? rulebooks : [rulebooks]) this.byPack.set(packOf(rb), rb);
  }

  async parseSop(_sop: string, pack: PackId = "rent-collection"): Promise<Rulebook> {
    const rb = this.byPack.get(pack);
    if (!rb) throw new Error(`no sample rulebook for the ${pack} pack`);
    return Rulebook.parse(structuredClone(rb));
  }
}

/** What the studio shows in its model picker. Keys never leave the server. */
export interface ProviderInfo {
  id: string;
  label: string;
  vendor: string;
  model: string | null;
  price: string;
  note: string;
  available: boolean;
  /** When not available: what to add to reeve/.env. */
  setup?: string;
}

export interface ProviderEntry {
  info: ProviderInfo;
  create: () => LLMProvider;
}

export class UnknownProviderError extends Error {}

export class ProviderRegistry {
  private readonly built = new Map<string, LLMProvider>();

  constructor(
    private readonly entries: ProviderEntry[],
    readonly defaultId: string,
  ) {
    if (!entries.some((e) => e.info.id === defaultId && e.info.available)) {
      throw new UnknownProviderError(`default provider ${defaultId} is not configured`);
    }
  }

  list(): ProviderInfo[] {
    return this.entries.map((e) => e.info);
  }

  get(id: string = this.defaultId): LLMProvider {
    const entry = this.entries.find((e) => e.info.id === id);
    if (!entry) throw new UnknownProviderError(`unknown provider ${id}`);
    if (!entry.info.available) throw new UnknownProviderError(`${entry.info.label} is not set up: ${entry.info.setup}`);
    let p = this.built.get(id);
    if (!p) this.built.set(id, (p = entry.create()));
    return p;
  }

  /** A registry with only the given providers, all available (tests, the CLI). */
  static of(providers: LLMProvider[], defaultId = providers[0]?.name ?? "fixture"): ProviderRegistry {
    return new ProviderRegistry(
      providers.map((p) => ({ info: { id: p.name, label: p.name, vendor: "", model: null, price: "", note: "", available: true }, create: () => p })),
      defaultId,
    );
  }

  static fromEnv(fixtures: Rulebook[], env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
    const entries = providerEntries(fixtures, env);
    return new ProviderRegistry(entries, resolveDefault(entries, env));
  }
}

interface Preset {
  id: string;
  vendor: string;
  baseURL: string;
  /** Env var holding the key; undefined for a local server that needs none. */
  keyVar?: string;
  modelVar: string;
  note: string;
  jsonMode?: OpenAICompatibleOptions["jsonMode"];
  baseURLVar?: string;
}

/**
 * OpenAI-compatible services. Models change too often to hard-code, so each one takes its
 * model id from the environment, e.g. GROQ_MODEL, exactly as the service lists it.
 */
const PRESETS: Preset[] = [
  { id: "openrouter", vendor: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY", modelVar: "OPENROUTER_MODEL", note: "One key, hundreds of models, several with a free tier." },
  { id: "gemini", vendor: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyVar: "GEMINI_API_KEY", modelVar: "GEMINI_MODEL", note: "Generous free tier on the Flash models." },
  { id: "groq", vendor: "Groq", baseURL: "https://api.groq.com/openai/v1", keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", note: "Fast open-weight models, free tier with rate limits." },
  { id: "deepseek", vendor: "DeepSeek", baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY", modelVar: "DEEPSEEK_MODEL", note: "Low per-token price. JSON mode only, no schema.", jsonMode: "object" },
  { id: "openai", vendor: "OpenAI", baseURL: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", note: "Pay as you go." },
  { id: "ollama", vendor: "Ollama (on this computer)", baseURL: "http://localhost:11434/v1", modelVar: "OLLAMA_MODEL", baseURLVar: "OLLAMA_BASE_URL", note: "Free and private: the SOP never leaves the machine. Needs a capable model." },
  { id: "custom", vendor: "Any OpenAI-compatible server", baseURL: "", keyVar: "REEVE_OPENAI_API_KEY", modelVar: "REEVE_OPENAI_MODEL", baseURLVar: "REEVE_OPENAI_BASE_URL", note: "LM Studio, Together, Fireworks, Mistral, a self-hosted vLLM, ..." },
];

export function providerEntries(fixtures: Rulebook[], env: NodeJS.ProcessEnv = process.env): ProviderEntry[] {
  const hasClaudeKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const claude: ProviderEntry[] = CLAUDE_MODELS.map((m) => ({
    info: {
      id: `anthropic:${m.model}`,
      label: m.label,
      vendor: "Anthropic",
      model: m.model,
      price: m.price,
      note: m.note,
      available: hasClaudeKey,
      ...(hasClaudeKey ? {} : { setup: "ANTHROPIC_API_KEY" }),
    },
    create: () => new AnthropicProvider(m.model),
  }));

  const compatible: ProviderEntry[] = PRESETS.map((p) => {
    const model = env[p.modelVar]?.trim() || null;
    const key = p.keyVar ? env[p.keyVar]?.trim() : undefined;
    const baseURL = (p.baseURLVar && env[p.baseURLVar]?.trim()) || p.baseURL;
    // Ollama needs no key; the custom server's key is optional (a local LM Studio has none).
    const keyOk = !p.keyVar || p.id === "custom" || Boolean(key);
    const missing = [!keyOk && p.keyVar, !model && p.modelVar, !baseURL && p.baseURLVar].filter(Boolean) as string[];
    return {
      info: {
        id: p.id,
        label: model ? `${p.vendor} · ${model}` : p.vendor,
        vendor: p.vendor,
        model,
        price: p.id === "ollama" || (p.id === "custom" && !key) ? "Free (your hardware)" : "Your key, the service's price",
        note: p.note,
        available: missing.length === 0,
        ...(missing.length ? { setup: missing.join(" and ") } : {}),
      },
      create: () => new OpenAICompatibleProvider({ id: p.id, baseURL, model: model!, apiKey: key, jsonMode: p.jsonMode }),
    };
  });
  const fixture: ProviderEntry = {
    info: {
      id: "fixture",
      label: "Sample rulebook (offline)",
      vendor: "Reeve",
      model: null,
      price: "Free",
      note: "Replays the hand-written rule cards for the business type. Ignores the SOP text: for demos without a key.",
      available: fixtures.length > 0,
      ...(fixtures.length ? {} : { setup: "fixtures/*/rulebook.json" }),
    },
    create: () => new FixtureProvider(fixtures),
  };
  return [...claude, ...compatible, fixture];
}

/**
 * REEVE_LLM picks the default: "fixture", "anthropic" (REEVE_MODEL or Opus), a preset id
 * such as "groq", or a full id such as "anthropic:claude-haiku-5-5".
 */
function resolveDefault(entries: ProviderEntry[], env: NodeJS.ProcessEnv): string {
  const want = (env.REEVE_LLM ?? "fixture").trim();
  const id = want === "anthropic" ? `anthropic:${env.REEVE_MODEL ?? "claude-opus-5-5"}` : want;
  const entry = entries.find((e) => e.info.id === id);
  if (!entry) throw new UnknownProviderError(`REEVE_LLM=${want}: unknown provider (try fixture, anthropic, ${PRESETS.map((p) => p.id).join(", ")})`);
  if (!entry.info.available) throw new UnknownProviderError(`REEVE_LLM=${want} needs ${entry.info.setup} in reeve/.env`);
  return id;
}
