// In-memory Meko for tests and offline demos. It enforces the rules real Meko enforces (seen in the
// spike): every tool needs a conversation_id, a session belongs to its first agent, a conversation
// is read with the agent that created it. Search is a plain word-overlap score.
import { createHash, randomUUID } from "node:crypto";
import type { MekoTransport } from "./client";
import { MekoError } from "./client";

interface Conv {
  id: string;
  agent_id: string;
  datapack_id?: string;
  run_id?: string;
  session_id?: string;
  title?: string;
  metadata: Record<string, unknown>;
  messages: Record<string, unknown>[];
}
interface Mem {
  id: string;
  memory: string;
  hash: string;
  datapack_id?: string;
  agent_id: string;
  promoted: boolean;
  metadata: Record<string, unknown>;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

export class FakeMeko implements MekoTransport {
  readonly convs = new Map<string, Conv>();
  readonly mems: Mem[] = [];
  readonly packs = new Map<string, string>();
  readonly artifacts = new Map<string, { filename: string; content: string }>();
  readonly sessions = new Map<string, string>();
  readonly usage: Record<string, unknown>[] = [];
  calls: string[] = [];

  /** Emulates Meko Cloud: a conversation needs a datapack id, and datapack_search / datapack_create need some conversation_id. */
  requireDatapack = false;

  constructor(private readonly toolNames: string[] = []) {}

  async tools(): Promise<string[]> {
    return this.toolNames;
  }
  async close(): Promise<void> {}

  private conv(args: Record<string, unknown>, tool: string): Conv {
    const c = this.convs.get(String(args.conversation_id));
    if (!c) throw new MekoError(tool, "conversation_not_found");
    return c;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push(tool);
    if (tool !== "conversation_create" && !args.conversation_id) throw new MekoError(tool, "conversation_id is required");
    switch (tool) {
      case "conversation_create": {
        if (this.requireDatapack && !args.datapack_id) return { error: "datapack_id_required" };
        const agent = String(args.agent_id ?? "meko_agent");
        if (args.session_id) {
          const owner = this.sessions.get(String(args.session_id));
          if (owner && owner !== agent) throw new MekoError(tool, "agent_id_mismatch");
          this.sessions.set(String(args.session_id), agent);
        }
        const c: Conv = { id: randomUUID().replaceAll("-", ""), agent_id: agent, datapack_id: args.datapack_id as string, run_id: args.run_id as string, session_id: args.session_id as string, title: args.title as string, metadata: (args.metadata as Record<string, unknown>) ?? {}, messages: [] };
        this.convs.set(c.id, c);
        return { id: c.id, agent_id: agent, run_id: c.run_id ?? null, title: c.title, metadata: c.metadata };
      }
      case "datapack_list":
        return [...this.packs].filter(([, n]) => !args.query || n.includes(String(args.query))).map(([id, name]) => ({ datapack_id: id, datapack_name: name }));
      case "datapack_search": {
        const hits = [...this.packs].filter(([, n]) => (!args.name || n === args.name) && (!args.query || n.includes(String(args.query))));
        return { datapacks: hits.map(([id, name]) => ({ datapack_id: id, datapack_name: name })), has_more: false, next_cursor: "", total: null };
      }
      case "datapack_create": {
        const id = randomUUID();
        this.packs.set(id, String(args.name));
        return { datapack_id: id, name: args.name };
      }
      case "conversation_add_message": {
        const c = this.conv(args, tool);
        if (args.agent_id && args.agent_id !== c.agent_id) throw new MekoError(tool, "agent_id_mismatch");
        const m = { message_id: randomUUID().replaceAll("-", ""), conversation_id: c.id, input: args.input, output: args.output, reasoning: args.reasoning, plan: args.plan ?? [], metadata: args.metadata ?? {}, created_at: new Date().toISOString() };
        c.messages.push(m);
        return { status: "accepted", message_id: m.message_id, conversation_id: c.id };
      }
      case "conversation_get": {
        const c = this.conv(args, tool);
        if (args.agent_id !== c.agent_id) throw new MekoError(tool, "conversation_not_found");
        return { id: c.id, agent_id: c.agent_id, run_id: c.run_id ?? null, title: c.title, metadata: c.metadata, message_count: c.messages.length, messages: args.include_messages ? structuredClone(c.messages) : undefined };
      }
      case "memory_add": {
        const m: Mem = { id: randomUUID(), memory: String(args.text), hash: createHash("md5").update(String(args.text)).digest("hex"), datapack_id: args.datapack_id as string, agent_id: String(args.agent_id), promoted: false, metadata: (args.metadata as Record<string, unknown>) ?? {} };
        this.mems.push(m);
        return { results: [{ id: m.id, memory: m.memory, event: "ADD" }] };
      }
      case "memory_promote": {
        const ids: string[] = [];
        for (const id of args.memory_ids as string[]) {
          const m = this.mems.find((x) => x.id === id);
          if (!m) continue;
          const copy = { ...m, id: randomUUID(), promoted: true };
          this.mems.push(copy);
          ids.push(copy.id);
        }
        return { inserted_ids: ids };
      }
      case "context_search":
      case "memory_search": {
        const q = words(String(args.query));
        const hits = this.mems
          .filter((m) => m.datapack_id === args.datapack_id && (tool === "context_search" ? !m.promoted && m.agent_id === args.agent_id : m.promoted || m.agent_id === args.agent_id))
          .map((m) => ({ m, score: [...words(m.memory)].filter((w) => q.has(w)).length / Math.max(1, q.size) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(args.limit ?? 5))
          .map(({ m, score }) => ({ id: m.id, memory: m.memory, hash: m.hash, score, metadata: m.metadata }));
        if (tool === "memory_search") return { results: hits };
        // Like real Meko: promoted memories surface as knowledge-base chunks, metadata dropped.
        const shared = this.mems
          .filter((m) => m.datapack_id === args.datapack_id && m.promoted)
          .map((m) => ({ m, score: [...words(m.memory)].filter((w) => q.has(w)).length / Math.max(1, q.size) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(args.limit ?? 5))
          .map(({ m, score }) => ({ id: randomUUID(), chunk_text: m.memory, metadata_filters: { agent_id: m.agent_id, memory_id: m.id, source: "memory" }, rerank_score: score }));
        const sent = [...hits.map((h) => h.memory), ...shared.map((h) => h.chunk_text)].reduce((n, t) => n + Math.ceil(t.length / 4), 0);
        return { results: { knowledge_base: shared, memory: hits, conversation: { hits: [], thread: [] } }, token_savings: { memory: { tokens_sent: sent, tokens_saved: 10000 - sent }, tokens_saved: 10000 - sent } };
      }
      case "artifact_put": {
        const content = Buffer.from(String(args.content_base64), "base64").toString("utf8");
        const content_hash = createHash("sha256").update(content).digest("hex");
        this.artifacts.set(content_hash, { filename: String(args.filename), content });
        return { content_hash, artifact_id: content_hash.slice(0, 16), stored_in: "memory" };
      }
      case "artifact_get": {
        const a = this.artifacts.get(String(args.content_hash));
        if (!a) throw new MekoError(tool, "artifact_not_found");
        return { filename: a.filename, content_base64: Buffer.from(a.content).toString("base64") };
      }
      case "track_token_usage":
        this.usage.push(args);
        return { status: "recorded" };
      case "datapack_metrics":
        return { context_efficiency: { tokens_saved: 0, tokens_sent: 0, saved_pct: 0 }, searches: 0 };
      default:
        throw new MekoError(tool, "not implemented in FakeMeko");
    }
  }

  /** Test helper: edit a stored message the way an attacker with database access could. */
  tamper(receiptHash: string, patch: Record<string, unknown>): void {
    for (const c of this.convs.values())
      for (const m of c.messages) if ((m.metadata as Record<string, unknown>)?.reeve_receipt === receiptHash) Object.assign(m, patch);
  }
}
