// "Pencarian lemah": the searches Meko Cloud scored as weak (selflearning_*), read-only. Local Meko has no such tools.
// Owner exceptions are still clustered by Reeve's own code (amend.ts); this only reports what Meko measured.
import type { MekoWorkspace } from "@reeve/meko";

export interface WeakSearch {
  log_id: string;
  query: string;
  count: number;
  band: string;
  reason: string;
  /** Meko's own state for the shortfall ("open", ...). */
  state: string;
  /** Band after the last selflearning_verify replay, when one was run. */
  replay_band?: string;
}

export interface WeakSearches {
  source: "meko-cloud" | "none";
  /** Share of recent searches that found a strong match, as Meko reports it. */
  quality_pct?: number;
  searches?: number;
  items: WeakSearch[];
  note: string;
}

const TODOS = ["add_context", "clarify_prompts"];

export async function weakSearches(ws: MekoWorkspace, last = "30d"): Promise<WeakSearches> {
  const tools = await ws.transport.tools();
  if (!tools.includes("selflearning_status") || !tools.includes("selflearning_shortfalls")) return { source: "none", items: [], note: "Meko ini tidak punya selflearning_* (hanya Meko Cloud)." };
  try {
    const base = { datapack_id: ws.datapackId, conversation_id: ws.setupConversation };
    const status = (await ws.transport.call("selflearning_status", { ...base, last })) as { quality?: { pct?: number; searches?: number } };
    const items: WeakSearch[] = [];
    for (const todo_id of TODOS) {
      const res = (await ws.transport.call("selflearning_shortfalls", { ...base, todo_id, last })) as { searches?: Record<string, unknown>[] };
      for (const s of res.searches ?? [])
        items.push({
          log_id: String(s.log_id),
          query: String(s.query ?? ""),
          count: Number(s.count ?? 1),
          band: String(s.band ?? ""),
          reason: String(s.reason ?? ""),
          state: String(s.state ?? ""),
          ...(s.latest_run ? { replay_band: String((s.latest_run as { band?: string }).band) } : {}),
        });
    }
    return { source: "meko-cloud", quality_pct: status.quality?.pct, searches: status.quality?.searches, items, note: "Diukur Meko Cloud dari pencarian context_search; jalur cadangan knowledgebase_search milik Reeve tidak ikut terukur." };
  } catch (e) {
    return { source: "none", items: [], note: `selflearning_* gagal dibaca: ${String(e).slice(0, 120)}` };
  }
}

/** Replays one weak search (saves it as a Meko test prompt: the only write); run it after adding a memory, on the owner's request. */
export async function verifyWeak(ws: MekoWorkspace, log_id: string): Promise<{ outcome: string; before?: string; after?: string; hint?: string }> {
  const r = (await ws.transport.call("selflearning_verify", { datapack_id: ws.datapackId, conversation_id: ws.setupConversation, log_id })) as { outcome?: string; before?: { band?: string }; after?: { band?: string }; hint?: string };
  return { outcome: r.outcome ?? "unknown", before: r.before?.band, after: r.after?.band, hint: r.hint };
}
