// Public, read-only view of one Meko-traced demo workspace (Kos Melati): decisions, "explain this
// decision", verification and the Rapor Usaha. Only pseudonymised data lives there, so it is served
// without a session at /api/meko/public/*. Writing (seeding, storing a report) is the CLI's job.
import { AskBusiness, buildRapor, raporHtml } from "@reeve/crew";
import { type MekoMessage, type MekoTransport, MekoWorkspace, Pseudonymiser, verifyDecision } from "@reeve/meko";
import type { Ledger } from "@reeve/receipts";
import { Hono } from "hono";

export interface MekoAppDeps {
  workspace: string;
  ledger: Ledger;
  connect: () => Promise<MekoTransport>;
  endpoint: { url: string; cloud: boolean };
  /** POST /ask writes an "explain" decision; off unless the deployment turns it on. */
  allowAsk?: boolean;
  /** Where the web app shows one decision. */
  explainUrl?: (receipt: string) => string;
}

export function createMekoApp(deps: MekoAppDeps) {
  const app = new Hono().basePath("/api/meko/public");
  let ws: Promise<MekoWorkspace> | null = null;
  const open = () => {
    ws ??= deps.connect().then((t) => MekoWorkspace.open(t, { workspace: deps.workspace, ledger: deps.ledger, pseudonyms: new Pseudonymiser() }));
    ws.catch(() => (ws = null));
    return ws;
  };
  const explainUrl = deps.explainUrl ?? ((r: string) => `/?view=jejak&receipt=${r}`);

  app.onError((err, c) => c.json({ error: `Meko belum bisa dihubungi: ${err.message.slice(0, 200)}` }, 503));

  app.get("/status", async (c) => {
    const w = await open();
    return c.json({ workspace: deps.workspace, datapack: w.datapackId, endpoint: deps.endpoint.cloud ? "cloud" : "local", decisions: w.decisions().length, ledger_intact: deps.ledger.verify() === null, ask: !!deps.allowAsk });
  });

  app.get("/decisions", async (c) => {
    const w = await open();
    const { agent, action, subject } = c.req.query();
    const list = w
      .decisions({ agent, subject })
      .filter((d) => !action || d.action === action)
      .reverse()
      .map((d) => ({ seq: d.seq, at: d.at, agent: d.agent, action: d.action, action_class: d.action_class, subject: d.subject, run_id: d.run_id, receipt: d.entry_hash }));
    return c.json({ decisions: list });
  });

  app.get("/decisions/:receipt", async (c) => {
    const w = await open();
    const receipt = c.req.param("receipt");
    const check = await verifyDecision(w, receipt);
    if (!check.decision) return c.json({ error: "Receipt ini tidak ada di ledger." }, 404);
    const msgs = new Map<string, MekoMessage[]>();
    const chain = [];
    for (const d of w.decisions({ run_id: check.decision.run_id })) {
      const key = `${d.agent}:${d.conversation_id}`;
      if (!msgs.has(key)) msgs.set(key, (await w.conversation(d.agent, d.conversation_id)).messages);
      const m = msgs.get(key)!.find((x) => x.metadata?.reeve_receipt === d.entry_hash);
      chain.push({ seq: d.seq, at: d.at, agent: d.agent, action: d.action, subject: d.subject, receipt: d.entry_hash, input: m?.input, output: m?.output, reasoning: m?.reasoning, current: d.entry_hash === receipt });
    }
    const m = check.message;
    return c.json({
      decision: { seq: check.decision.seq, at: check.decision.at, agent: check.decision.agent, action: check.decision.action, action_class: check.decision.action_class, subject: check.decision.subject, run_id: check.decision.run_id, receipt, trace_hash: check.decision.trace_hash, conversation_id: check.decision.conversation_id },
      trace: m ? { input: m.input, output: m.output, reasoning: m.reasoning, plan: m.plan, seen: m.metadata?.reeve_seen ?? [], usage: m.metadata?.reeve_usage ?? null, created_at: m.created_at } : null,
      verify: { ok: check.ok, problem: check.problem, checks: check.checks },
      chain,
      meko: { datapack: w.datapackId, endpoint: deps.endpoint.cloud ? "cloud" : "local" },
    });
  });

  app.get("/decisions/:receipt/verify", async (c) => {
    const w = await open();
    const check = await verifyDecision(w, c.req.param("receipt"));
    return c.json({ ok: check.ok, problem: check.problem, checks: check.checks }, check.decision ? 200 : 404);
  });

  app.get("/report", async (c) => c.json(await buildRapor(await open(), { from: c.req.query("from"), to: c.req.query("to") })));

  app.get("/report.html", async (c) => c.html(raporHtml(await buildRapor(await open(), { from: c.req.query("from"), to: c.req.query("to") }), { explainUrl })));

  app.post("/ask", async (c) => {
    if (!deps.allowAsk) return c.json({ error: "Tanya usaha belum dibuka untuk umum di server ini." }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { question?: string; role?: string; subject?: string };
    const role = body.role === "staff" || body.role === "owner" ? body.role : "tenant";
    if (!body.question || body.question.length > 300) return c.json({ error: "Tulis pertanyaan (maks. 300 karakter)." }, 400);
    const answer = await new AskBusiness(await open(), explainUrl).ask(body.question, { role, subject: body.subject?.slice(0, 8) });
    return c.json(answer);
  });

  return app;
}
