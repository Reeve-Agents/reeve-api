// Reeve's agents on Meko: one datapack per workspace, one conversation per agent per run, a shared
// run_id for the chain, and a tamper-evident link between each Meko turn and the Reeve ledger.
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type DecisionBody, type Ledger, type LedgerEntry } from "@reeve/receipts";
import type { MekoTransport } from "./client";
import { Pseudonymiser } from "./pseudonym";

export type AgentName = "builder" | "auditor" | "owner" | "operator" | "worker" | "validator" | "ask";

export interface MemoryHit {
  id: string;
  text: string;
  hash?: string;
  kind?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface Lookup {
  query: string;
  memory: MemoryHit[];
  knowledge: { id: string; text: string }[];
  tokens_saved?: number;
  tokens_sent?: number;
}

export interface TokenUsage {
  name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface TurnInput {
  input: string;
  output: unknown;
  reasoning: string;
  plan?: string[];
  action?: string;
  action_class?: string;
  /** Pseudonymous id of who the decision is about ("K03"). */
  subject?: string;
  usage?: TokenUsage;
}

export interface TracedDecision {
  seq: number;
  receipt_hash: string;
  trace_hash: string;
  run_id: string;
  agent: AgentName;
  conversation_id: string;
  message_id: string;
  action?: string;
}

/** What gets hashed: exactly the strings Meko stores, plus the lookups the agent saw. */
export interface TraceBody {
  agent: string;
  run_id: string;
  input: string;
  output: string;
  reasoning: string;
  plan: string[];
  lookups: { query: string; memory_ids: string[]; knowledge_ids: string[] }[];
}

export function traceHash(body: TraceBody): string {
  return sha256(canonicalJson(body));
}

export function lookupDigest(lookups: Lookup[]): TraceBody["lookups"] {
  return lookups.map((l) => ({
    query: l.query,
    memory_ids: l.memory.map((m) => m.id),
    knowledge_ids: l.knowledge.map((k) => k.id),
  }));
}

function str(v: unknown, ...keys: string[]): string {
  const o = (v ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  throw new Error(`meko: none of ${keys.join("/")} in ${JSON.stringify(v).slice(0, 200)}`);
}

export interface WorkspaceOptions {
  workspace: string;
  ledger: Ledger;
  pseudonyms?: Pseudonymiser;
  now?: () => Date;
}

export class MekoWorkspace {
  readonly pseudonyms: Pseudonymiser;
  private readonly now: () => Date;
  private constructor(
    readonly transport: MekoTransport,
    readonly workspace: string,
    readonly ledger: Ledger,
    readonly datapackId: string,
    readonly setupConversation: string,
    opts: WorkspaceOptions,
  ) {
    this.pseudonyms = opts.pseudonyms ?? new Pseudonymiser();
    this.now = opts.now ?? (() => new Date());
  }

  static datapackName(workspace: string): string {
    return `reeve-${workspace}`;
  }

  /** Finds or creates the workspace's datapack. Meko wants a conversation on every call, so open a setup one first. */
  static async open(transport: MekoTransport, opts: WorkspaceOptions): Promise<MekoWorkspace> {
    const setup = str(await transport.call("conversation_create", { agent_id: "reeve", title: `Reeve setup: ${opts.workspace}` }), "conversation_id", "id");
    const name = MekoWorkspace.datapackName(opts.workspace);
    const listed = await transport.call("datapack_list", { conversation_id: setup, query: name });
    const packs = (Array.isArray(listed) ? listed : ((listed as { datapacks?: unknown[] })?.datapacks ?? [])) as Record<string, unknown>[];
    const hit = packs.find((p) => p.name === name);
    const datapackId = hit ? str(hit, "datapack_id", "id") : str(await transport.call("datapack_create", { conversation_id: setup, name }), "datapack_id", "id");
    return new MekoWorkspace(transport, opts.workspace, opts.ledger, datapackId, setup, opts);
  }

  at(): string {
    return this.now().toISOString();
  }

  run(runId: string = `run_${this.now().toISOString().slice(0, 10).replaceAll("-", "")}_${randomUUID().slice(0, 8)}`): MekoRun {
    return new MekoRun(this, runId);
  }

  /** Every decision entry in the ledger for this workspace, oldest first. */
  decisions(filter: { run_id?: string; agent?: string; subject?: string; action_class?: string } = {}): (LedgerEntry & DecisionBody)[] {
    return this.ledger
      .entries()
      .filter((e): e is LedgerEntry & DecisionBody => e.kind === "decision" && (e as DecisionBody).workspace === this.workspace)
      .filter(
        (e) =>
          (!filter.run_id || e.run_id === filter.run_id) &&
          (!filter.agent || e.agent === filter.agent) &&
          (!filter.subject || e.subject === filter.subject) &&
          (!filter.action_class || e.action_class === filter.action_class),
      );
  }

  async conversation(agent: string, conversationId: string): Promise<MekoConversation> {
    const got = (await this.transport.call("conversation_get", {
      datapack_id: this.datapackId,
      conversation_id: conversationId,
      agent_id: agent,
      include_messages: true,
    })) as MekoConversation;
    return { ...got, messages: got.messages ?? [] };
  }
}

export interface MekoMessage {
  message_id: string;
  input: string;
  output: string;
  reasoning?: string;
  plan?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface MekoConversation {
  id: string;
  agent_id: string;
  run_id?: string | null;
  title?: string;
  messages: MekoMessage[];
}

export class MekoRun {
  private readonly agents = new Map<string, AgentTrace>();
  constructor(
    readonly ws: MekoWorkspace,
    readonly runId: string,
  ) {}

  /**
   * One conversation per agent per run. A Meko session belongs to the first agent that used it,
   * so each agent gets its own session; the shared run_id ties the chain together.
   */
  async agent(agent: AgentName, title: string): Promise<AgentTrace> {
    const key = `${agent}:${title}`;
    const known = this.agents.get(key);
    if (known) return known;
    const created = await this.ws.transport.call("conversation_create", {
      datapack_id: this.ws.datapackId,
      agent_id: agent,
      session_id: `${this.ws.workspace}:${agent}:${this.runId}`,
      run_id: this.runId,
      title,
      metadata: { reeve_run: this.runId, reeve_workspace: this.ws.workspace },
    });
    const trace = new AgentTrace(this, agent, str(created, "conversation_id", "id"));
    this.agents.set(key, trace);
    return trace;
  }
}

export class AgentTrace {
  /** Lookups since the last decision; they are attached to (and hashed into) the next one. */
  private pending: Lookup[] = [];
  readonly usage: TokenUsage[] = [];

  constructor(
    readonly run: MekoRun,
    readonly agent: AgentName,
    readonly conversationId: string,
  ) {}

  private base() {
    return { datapack_id: this.run.ws.datapackId, conversation_id: this.conversationId, agent_id: this.agent };
  }

  private clean(text: string): string {
    return this.run.ws.pseudonyms.redact(text);
  }

  /** `context_search` before deciding; Meko shows it as "Looked up" on the Decision trace card. */
  async search(query: string, limit = 5): Promise<Lookup> {
    const res = (await this.run.ws.transport.call("context_search", { ...this.base(), query: this.clean(query), limit })) as {
      results?: { memory?: Record<string, unknown>[]; knowledge_base?: Record<string, unknown>[] };
      token_savings?: { tokens_saved?: number; memory?: { tokens_sent?: number } };
    };
    const lookup: Lookup = {
      query: this.clean(query),
      memory: (res.results?.memory ?? []).map((m) => ({
        id: String(m.id),
        text: String(m.memory ?? ""),
        hash: m.hash as string | undefined,
        score: m.score as number | undefined,
        kind: (m.metadata as Record<string, unknown> | undefined)?.kind as string | undefined,
        metadata: m.metadata as Record<string, unknown> | undefined,
      })),
      knowledge: (res.results?.knowledge_base ?? []).map((k) => ({ id: String(k.id ?? k.chunk_id ?? ""), text: String(k.text ?? k.content ?? "") })),
      tokens_saved: res.token_savings?.tokens_saved,
      tokens_sent: res.token_savings?.memory?.tokens_sent,
    };
    this.pending.push(lookup);
    return lookup;
  }

  /** Adds a memory; `promote` makes it collective, so every agent in the workspace sees it. */
  async remember(text: string, metadata: Record<string, unknown>, opts: { promote?: boolean } = {}): Promise<{ id: string; promoted?: string }> {
    const res = (await this.run.ws.transport.call("memory_add", {
      ...this.base(),
      run_id: this.run.runId,
      text: this.clean(text),
      metadata: { ...metadata, reeve_run: this.run.runId },
    })) as { results?: { id: string }[] };
    const id = res.results?.[0]?.id ?? str(res, "id");
    if (!opts.promote) return { id };
    const p = (await this.run.ws.transport.call("memory_promote", { ...this.base(), memory_ids: [id] })) as { inserted_ids?: string[] };
    return { id, promoted: p.inserted_ids?.[0] };
  }

  /** Stores JSON as a Meko artifact; Meko addresses it by SHA-256 (`content_hash`). */
  async artifact(filename: string, value: unknown, contentType = "application/json"): Promise<{ content_hash: string; artifact_id?: string }> {
    const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const res = (await this.run.ws.transport.call("artifact_put", {
      ...this.base(),
      filename,
      content_type: contentType,
      content_base64: Buffer.from(this.clean(body)).toString("base64"),
    })) as { content_hash: string; artifact_id?: string };
    return { content_hash: res.content_hash, artifact_id: res.artifact_id };
  }

  /**
   * Records one decision: ledger entry first (its hash is the receipt), then the Meko message that
   * carries the receipt in metadata. Code has already decided; this only records it.
   */
  async decide(turn: TurnInput): Promise<TracedDecision> {
    const ws = this.run.ws;
    const lookups = this.pending;
    this.pending = [];
    const input = this.clean(turn.input);
    const output = this.clean(typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output));
    const reasoning = this.clean(turn.reasoning);
    const plan = (turn.plan ?? []).map((p) => this.clean(p));
    const body: TraceBody = { agent: this.agent, run_id: this.run.runId, input, output, reasoning, plan, lookups: lookupDigest(lookups) };
    const trace_hash = traceHash(body);
    const entry = ws.ledger.append({
      kind: "decision",
      at: ws.at(),
      workspace: ws.workspace,
      run_id: this.run.runId,
      agent: this.agent,
      conversation_id: this.conversationId,
      trace_hash,
      ...(turn.action ? { action: turn.action } : {}),
      ...(turn.action_class ? { action_class: turn.action_class } : {}),
      ...(turn.subject ? { subject: turn.subject } : {}),
    });
    const metadata: Record<string, unknown> = {
      reeve_receipt: entry.entry_hash,
      reeve_seq: entry.seq,
      reeve_run: this.run.runId,
      reeve_trace_hash: trace_hash,
      reeve_lookups: body.lookups,
      ...(turn.action ? { reeve_action: turn.action } : {}),
      ...(turn.action_class ? { reeve_action_class: turn.action_class } : {}),
      ...(turn.subject ? { reeve_subject: turn.subject } : {}),
      ...(turn.usage ? { reeve_usage: turn.usage } : {}),
    };
    const res = await ws.transport.call("conversation_add_message", { ...this.base(), input, output, reasoning, plan, metadata });
    const message_id = str(res, "message_id", "id");
    if (turn.usage) {
      this.usage.push(turn.usage);
      await trackTokenUsage(ws, this.conversationId, message_id, turn.usage);
    }
    return {
      seq: entry.seq,
      receipt_hash: entry.entry_hash,
      trace_hash,
      run_id: this.run.runId,
      agent: this.agent,
      conversation_id: this.conversationId,
      message_id,
      action: turn.action,
    };
  }
}

/** `track_token_usage` is a Meko Cloud tool; on local Meko the usage stays in message metadata only. */
export async function trackTokenUsage(ws: MekoWorkspace, conversationId: string, messageId: string, u: TokenUsage): Promise<boolean> {
  if (!(await ws.transport.tools()).includes("track_token_usage")) return false;
  await ws.transport.call("track_token_usage", {
    datapack_id: ws.datapackId,
    conversation_id: conversationId,
    message_id: messageId,
    name: u.name,
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
  });
  return true;
}
