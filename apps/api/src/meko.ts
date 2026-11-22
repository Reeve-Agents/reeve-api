// Public, read-only view of one Meko-traced demo workspace (Kos Melati): decisions, "explain this
// decision", verification and the Rapor Usaha. Only pseudonymised data lives there, so it is served
// without a session at /api/meko/public/*. Writing (seeding, storing a report) is the CLI's job.
import type { Rulebook } from "@reeve/core";
import { AskBusiness, buildRapor, type DiscoveryAudit, type DiscoveryState, kosDiscoverySample, paymentsFromRows, parsePaymentsCsv, raporHtml, SopDiscovery } from "@reeve/crew";
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

/** One workspace connection shared by the public and the owner app; retried after a failure. */
export function mekoOpener(deps: Pick<MekoAppDeps, "workspace" | "ledger" | "connect">): () => Promise<MekoWorkspace> {
  let ws: Promise<MekoWorkspace> | null = null;
  return () => {
    ws ??= deps.connect().then((t) => MekoWorkspace.open(t, { workspace: deps.workspace, ledger: deps.ledger, pseudonyms: new Pseudonymiser() }));
    ws.catch(() => (ws = null));
    return ws;
  };
}

export function createMekoApp(deps: MekoAppDeps, open = mekoOpener(deps)) {
  const app = new Hono().basePath("/api/meko/public");
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
    // The chain: how the rule got approved (Builder, Auditor, owner, before this decision), then
    // every decision about the same person. Without a subject (a playbook run), the whole run.
    const cur = check.decision;
    const GOV = new Set(["builder", "auditor", "owner"]);
    const inChain = (d: typeof cur) => !cur.subject || d.subject === cur.subject || (GOV.has(d.agent) && !d.subject && d.seq < cur.seq);
    for (const d of w.decisions({ run_id: cur.run_id }).filter(inChain)) {
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

export interface MekoOwnerDeps {
  /** Runs the normal pipeline audit (spec cases and planted defects) on a discovered rulebook. */
  audit?: (rb: Rulebook) => Promise<DiscoveryAudit>;
  /** The template SOP offered in "mode belajar". */
  template?: () => Rulebook;
  /** Telegram tenant links and the wa.me fallback (meko-telegram.ts). */
  telegram?: { createLink(subject: string): unknown; explainForWhatsApp(subject: string, question: string): Promise<unknown> };
}

/**
 * Owner actions on the Meko workspace, behind the session (/api/meko/owner/*): SOP Discovery.
 * Called as `fetch(req, { account })`.
 */
export function createMekoOwnerApp(deps: MekoOwnerDeps, open: () => Promise<MekoWorkspace>) {
  const app = new Hono<{ Bindings: { account: string } }>().basePath("/api/meko/owner");
  let disc: SopDiscovery | null = null;
  const discovery = async () => (disc ??= new SopDiscovery(await open()));
  const states = new Map<string, DiscoveryState>();
  const keep = (st: DiscoveryState) => {
    states.set(st.id, st);
    while (states.size > 50) states.delete(states.keys().next().value!);
  };

  app.onError((err, c) => c.json({ error: err.message.slice(0, 300) }, /tidak|kosong|sudah|Tulis|Chat|Data/.test(err.message) ? 400 : 503));

  app.get("/discovery/sample", (c) => c.json({ business: "Kos Melati", ...kosDiscoverySample() }));

  app.post("/discovery", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { chat?: string; payments_csv?: string; payments_rows?: Record<string, unknown>[]; business?: string };
    if (typeof body.chat !== "string" || body.chat.length > 3_000_000) return c.json({ error: "Kirim isi chat WhatsApp (.txt, maks. 3 MB)." }, 400);
    const payments = Array.isArray(body.payments_rows) ? paymentsFromRows(body.payments_rows.slice(0, 20_000)) : typeof body.payments_csv === "string" ? parsePaymentsCsv(body.payments_csv.slice(0, 3_000_000)) : [];
    const st = await (await discovery()).start({ chat: body.chat, payments, business: body.business?.slice(0, 80) || undefined });
    keep(st);
    return c.json(st);
  });

  app.get("/discovery/:id", (c) => {
    const st = states.get(c.req.param("id"));
    return st ? c.json(st) : c.json({ error: "Sesi discovery tidak ditemukan (server mungkin baru dimulai ulang)." }, 404);
  });

  app.post("/discovery/:id/answer", async (c) => {
    const st = states.get(c.req.param("id"));
    if (!st) return c.json({ error: "Sesi discovery tidak ditemukan." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { candidate?: string; yes?: boolean };
    if (typeof body.candidate !== "string" || typeof body.yes !== "boolean") return c.json({ error: "Kirim candidate dan yes (true/false)." }, 400);
    const receipt = await (await discovery()).answer(st, body.candidate, body.yes, `account ${c.env?.account ?? "?"}`);
    return c.json({ receipt, answers: st.answers });
  });

  app.post("/discovery/:id/finish", async (c) => {
    const st = states.get(c.req.param("id"));
    if (!st) return c.json({ error: "Sesi discovery tidak ditemukan." }, 404);
    return c.json(await (await discovery()).finish(st, deps.audit, deps.template));
  });

  // "Kenapa saya didenda?": a Telegram link code for one tenant, or the answer as a wa.me link.
  app.post("/telegram/link", async (c) => {
    if (!deps.telegram) return c.json({ error: "Telegram belum diatur di server ini (TELEGRAM_WEBHOOK_SECRET)." }, 409);
    const { subject } = (await c.req.json().catch(() => ({}))) as { subject?: string };
    return c.json(deps.telegram.createLink(String(subject ?? "").toUpperCase()));
  });
  app.post("/explain/whatsapp", async (c) => {
    if (!deps.telegram) return c.json({ error: "Belum diatur." }, 409);
    const { subject, question } = (await c.req.json().catch(() => ({}))) as { subject?: string; question?: string };
    return c.json(await deps.telegram.explainForWhatsApp(String(subject ?? "").toUpperCase(), String(question ?? "").slice(0, 300)));
  });

  return { app, fetch: (req: Request, account: string) => app.fetch(req, { account }) };
}
