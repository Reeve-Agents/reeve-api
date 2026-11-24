// Public, read-only view of one Meko-traced demo workspace (Kos Melati): decisions, "explain this
// decision", verification and the Rapor Usaha. Only pseudonymised data lives there, so it is served
// without a session at /api/meko/public/*. Writing (seeding, storing a report) is the CLI's job.
import type { Rulebook } from "@reeve/core";
import { type CalendarRegistry, type JournalSyncResult, syncJournal, amendmentsEnabled, buildDigest, liveTick, markBillPaid, type MarkPaidResult, NoBills, type TickReport, UnknownBill, dryRun, type DigestSender, loadOutbox, Outbox, sendDigest, UNDO_WINDOW_MS, UndoRefused, wibDate, type ExecResult, type AskLlm, AskBusiness, approveAmendment, buildRapor, type History, loadAmendments, loadExceptions, localShortfalls, rejectAmendment, scanAmendments, verifyWeak, weakSearches, SHORTFALL_MIN, DEFAULT_POLICIES, type DiscoveryAudit, type DiscoveryState, kosDiscoverySample, KOS_FACTS, Ladder, listShares, loadLadderState, loadReview, paymentsFromRows, revokeShare, shareRapor, sharedRapor, parsePaymentsCsv, raporHtml, SopDiscovery, stepOf, validate } from "@reeve/crew";
import { type MekoMessage, type MekoTransport, MekoWorkspace, Pseudonymiser, verifyDecision } from "@reeve/meko";
import type { Ledger } from "@reeve/receipts";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

export interface MekoAppDeps {
  workspace: string;
  ledger: Ledger;
  connect: () => Promise<MekoTransport>;
  endpoint: { url: string; cloud: boolean };
  /** POST /ask writes an "explain" decision; off unless the deployment turns it on. */
  allowAsk?: boolean;
  /** Words answers to questions outside the ask patterns (Haiku by default); without it they get the template reply. */
  askLlm?: AskLlm;
  /** Anchor calldata encoder (@reeve/anchor), shown on the shared verify page. */
  encodeAnchor?: (root: string, leaves: number) => string;
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

  // A Rapor shared by the owner: metrics plus the ledger, for the public verify page. 404 once revoked.
  app.get("/shared/:token", async (c) => {
    const r = await sharedRapor(await open(), c.req.param("token"), deps.encodeAnchor);
    return r ? c.json(r) : c.json({ error: "Tautan ini tidak berlaku (dicabut pemilik atau tidak pernah ada)." }, 404);
  });

  app.post("/ask", async (c) => {
    if (!deps.allowAsk) return c.json({ error: "Tanya usaha belum dibuka untuk umum di server ini." }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { question?: string; role?: string; subject?: string };
    const role = body.role === "staff" || body.role === "owner" ? body.role : "tenant";
    if (!body.question || body.question.length > 300) return c.json({ error: "Tulis pertanyaan (maks. 300 karakter)." }, 400);
    const answer = await new AskBusiness(await open(), explainUrl, deps.askLlm).ask(body.question, { role, subject: body.subject?.slice(0, 8) });
    return c.json(answer);
  });

  return app;
}

export interface MekoOwnerDeps {
  /** Runs the normal pipeline audit (spec cases and planted defects) on a discovered rulebook. */
  audit?: (rb: Rulebook) => Promise<DiscoveryAudit>;
  /** The template SOP offered in "mode belajar". */
  template?: () => Rulebook;
  /** Absolute web origin for share links. */
  webOrigin?: string;
  /** Telegram tenant links and the wa.me fallback (meko-telegram.ts). */
  /** Store of the Meko workspace; the review queue and the autonomy ladder live under `data.meko_review` / `data.meko_ladder`. */
  store?: { data: object; save(): void };
  /** SOP amendments (self-learning loop). Default: the REEVE_SOP_AMENDMENTS flag, off unless set. */
  amend?: { enabled?: () => boolean; env?: Record<string, string | undefined>; history?: () => History | null };
  telegram?: { createLink(subject: string): unknown; createOwnerLink?(): unknown; ownerLinked?(): boolean; explainForWhatsApp(subject: string, question: string): Promise<unknown> };
  /** What runs a staged action once its 10-minute window has passed. Default: the Log connector (nothing is sent). The live tick's reminders go through it too (Telegram when configured, see liveExecutor). */
  outbox?: { execute?: (tool: string, args: Record<string, unknown>) => Promise<ExecResult> };
  /** Where the daily digest goes. Default: dry run (text only). Live Telegram needs TELEGRAM_BOT_TOKEN + REEVE_DIGEST=on. */
  digest?: { sender?: DigestSender };
  /** Bookkeeping to Google Sheets through Composio (REEVE_JOURNAL=on). Synced after each tick and paid mark, and on POST /api/meko/journal/sync. */
  journal?: { registry: CalendarRegistry | null; spreadsheetId?: string };
  now?: () => number;
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

  // Rapor share links (metrics only), revocable; live-or-not is read from the ledger.
  app.get("/rapor/shares", async (c) => c.json({ shares: listShares(await open()) }));
  app.post("/rapor/share", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { label?: string; from?: string; to?: string };
    const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const s = await shareRapor(await open(), { label: b.label?.slice(0, 60), from: date(b.from), to: date(b.to), by: `account ${c.env?.account ?? "?"}` });
    return c.json({ ...s, url: `${deps.webOrigin ?? ""}/?view=rapor&share=${s.token}` });
  });
  app.post("/rapor/revoke", async (c) => {
    const { subject } = (await c.req.json().catch(() => ({}))) as { subject?: string };
    return c.json({ receipt: await revokeShare(await open(), String(subject ?? ""), `account ${c.env?.account ?? "?"}`) });
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

  // Review queue and autonomy ladder (account level). State lives in the store; every decision is a
  // traced owner turn. Approving here sends nothing: the connector sends on the next run.
  const needStore = () => {
    if (!deps.store) throw new Error("Data tinjauan belum tersedia di server ini (tidak ada store).");
    return deps.store;
  };
  const by = (c: { env?: { account: string } }) => `account ${c.env?.account ?? "?"}`;
  let ladder: Ladder | null = null;
  const getLadder = async () => (ladder ??= new Ladder(await open(), loadLadderState(needStore().data)));
  const deciding = new Set<string>();

  const clock = () => deps.now?.() ?? Date.now();
  const logExec = deps.outbox?.execute ?? (async (): Promise<ExecResult> => ({ ok: true, via: "log" }));
  let box: Outbox | null = null;
  const getOutbox = async () => (box ??= new Outbox(await open(), needStore(), await getLadder()));
  /** Runs what is due (through the injected connector), then returns the outbox. */
  const settled = async () => {
    const b = await getOutbox();
    await b.flush(clock(), logExec);
    return b;
  };
  const sender = () => deps.digest?.sender ?? dryRun;
  const webOrigin = () => deps.webOrigin ?? "";
  const digestFor = async (date?: string) => {
    const ws = await open();
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : wibDate(clock());
    await settled();
    return buildDigest(ws, await getLadder(), needStore(), day, { webOrigin: webOrigin() });
  };

  const view = (i: ReturnType<typeof loadReview>[number]) => ({ ...i, action_class: stepOf(i.step)?.action_class ?? (i.kind === "contract" ? "accept_tenant" : "review"), step_title: stepOf(i.step)?.title ?? i.step });

  // Auto-run actions wait 10 minutes in the outbox; undo cancels one for real, after that it has run.
  app.get("/outbox", async (c) => {
    await settled();
    const now = clock();
    const label = (cls: string) => DEFAULT_POLICIES[cls]?.label ?? cls;
    const all = loadOutbox(needStore().data).map((i) => ({ id: i.id, action_class: i.action_class, label: label(i.action_class), tool: i.tool, subject: i.subject, status: i.status, staged_at: i.staged_at, due_at: i.due_at, seconds_left: i.status === "staged" ? Math.max(0, Math.ceil((Date.parse(i.due_at) - now) / 1000)) : 0, stage_receipt: i.stage_receipt, done_receipt: i.done_receipt, undo_receipt: i.undo_receipt, via: i.via }));
    const open_ = all.filter((i) => i.status === "staged" || i.status === "running").sort((a, b2) => a.seconds_left - b2.seconds_left);
    const recent = all.filter((i) => i.status !== "staged" && i.status !== "running").sort((a, b2) => (b2.staged_at < a.staged_at ? -1 : 1)).slice(0, 20);
    return c.json({ window_seconds: UNDO_WINDOW_MS / 1000, items: [...open_, ...recent], staged: open_.length });
  });

  app.post("/outbox/:id/undo", async (c) => {
    const b = await settled();
    try {
      const r = await b.undo(c.req.param("id"), clock());
      return c.json({ receipt: r.receipt, level: r.level, item: r.item, note: "Dibatalkan. Tindakan ini tidak pernah dikirim; kelasnya turun satu level." });
    } catch (e) {
      if (e instanceof UndoRefused) return c.json({ error: e.message }, e.code === "missing" ? 404 : 409);
      throw e;
    }
  });

  // The daily digest: built by code from ledger facts. Previewing sends nothing; the wa.me link is
  // opened by the owner. /digest/send is a dry run unless TELEGRAM_BOT_TOKEN and REEVE_DIGEST=on are set.
  app.get("/digest", async (c) => {
    const d = await digestFor(c.req.query("date"));
    const sent = (needStore().data as { meko_digest?: Record<string, { receipt: string; channel: string; delivered: boolean }> }).meko_digest?.[d.date] ?? null;
    return c.json({ ...d, wa_me: `https://wa.me/?text=${encodeURIComponent(d.text)}`, channel: { telegram_linked: deps.telegram?.ownerLinked?.() ?? false, live: sender().live, name: sender().channel }, sent });
  });

  app.post("/digest/send", async (c) => {
    const d = await digestFor();
    const r = await sendDigest({ ws: await open(), ladder: await getLadder(), store: needStore(), date: d.date, webOrigin: webOrigin() }, sender());
    return c.json({ ...r, note: r.delivered ? "Ringkasan terkirim lewat Telegram." : "Dry-run: tidak ada pesan terkirim. Buka tautan WhatsApp untuk mengirim sendiri." });
  });

  app.post("/telegram/owner-link", (c) => {
    if (!deps.telegram?.createOwnerLink) return c.json({ error: "Telegram belum diatur di server ini (TELEGRAM_WEBHOOK_SECRET)." }, 409);
    return c.json(deps.telegram.createOwnerLink());
  });

  app.get("/weak", async (c) => c.json(await weakSearches(await open())));
  app.post("/weak/verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { log_id?: string };
    if (!body.log_id || typeof body.log_id !== "string") return c.json({ error: "log_id wajib" }, 400);
    try {
      return c.json(await verifyWeak(await open(), body.log_id));
    } catch (e) {
      return c.json({ error: `Cek ulang gagal: ${String(e).slice(0, 120)}` }, 409);
    }
  });

  app.get("/review", (c) => {
    const items = loadReview(needStore().data);
    const rank = (i: { status: string }) => (i.status === "pending" ? 0 : 1);
    const sorted = [...items].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? "").localeCompare(a.decided_at ?? "")));
    return c.json({ items: sorted.slice(0, 100).map(view), pending: items.filter((i) => i.status === "pending").length });
  });

  app.post("/review/:id", async (c) => {
    const store = needStore();
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; text?: string };
    const action = body.action;
    if (action !== "approve" && action !== "reject" && action !== "edit") return c.json({ error: "Pilih tindakan: approve, reject atau edit." }, 400);
    const item = loadReview(store.data).find((i) => i.id === id);
    if (!item) return c.json({ error: "Item tinjauan tidak ditemukan." }, 404);
    if (item.status !== "pending" || deciding.has(id)) return c.json({ error: "Item ini sudah diputuskan." }, 409);
    const step = stepOf(item.step);
    let edited: string | undefined;
    if (action === "edit") {
      edited = String(body.text ?? "").trim();
      if (!edited || edited.length > 3000) return c.json({ error: "Tulis teks yang diubah (maks. 3000 karakter)." }, 400);
      // A changed draft passes the same Validator as the Worker's; nothing with a hit goes on.
      const hits = item.kind === "draft" ? validate(edited, KOS_FACTS, step?.checks) : [];
      if (hits.length) return c.json({ error: "Teks yang diubah belum lolos pemeriksaan.", hits }, 400);
    }
    deciding.add(id);
    try {
      const ws = await open();
      const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "edited";
      const subject = ws.pseudonyms.redact(item.subject);
      const owner = await ws.run(`run_review_${Date.now().toString(36)}`).agent("owner", `Tinjau: ${step?.title ?? item.step}`);
      const d = await owner.decide({
        input: `review ${item.id} (${item.kind}): ${subject}`,
        output: { item: item.id, kind: item.kind, status, draft_receipt: item.receipt, ...(edited ? { edited_text: edited } : {}), sent: false },
        reasoning: `The owner (${by(c)}) ${status === "approved" ? "approved the draft unchanged" : status === "rejected" ? "rejected the draft" : "edited the draft; the new text passed the same Validator checks"}. Nothing is sent here: the connector sends on the next run, and only an approved or edited item.`,
        action: `review_${action}`,
        action_class: step?.action_class ?? (item.kind === "contract" ? "accept_tenant" : "review"),
        subject,
      });
      if (edited) item.original_text = item.text;
      item.status = status;
      if (edited) {
        item.text = edited;
        item.hits = [];
      }
      item.decided_at = new Date().toISOString();
      item.decision_receipt = d.receipt_hash;
      store.save();
      return c.json({ receipt: d.receipt_hash, draft_receipt: item.receipt, item: view(item), note: "Belum ada pesan terkirim. Pengiriman lewat konektor terjadi di jalan berikutnya." });
    } finally {
      deciding.delete(id);
    }
  });

  app.get("/autonomy", async (c) => {
    const l = await getLadder();
    const classes = Object.entries(DEFAULT_POLICIES).map(([cls, p]) => {
      const ev = l.evidence(cls);
      const prop = l.proposal(cls);
      const locked = !Number.isFinite(p.promote_after);
      return {
        cls,
        label: p.label,
        level: l.level(cls),
        max_level: p.max_level,
        locked,
        promote_after: locked ? null : p.promote_after,
        evidence: { clean: ev.clean, bad: ev.bad, receipts: ev.receipts.slice(0, 5) },
        proposal: prop ? { question: prop.question, from: prop.from, to: prop.to } : null,
        needs: locked ? null : Math.max(0, p.promote_after - ev.clean),
      };
    });
    return c.json({ classes });
  });

  app.post("/autonomy/promote", async (c) => {
    const { cls } = (await c.req.json().catch(() => ({}))) as { cls?: string };
    const l = await getLadder();
    if (!cls || !DEFAULT_POLICIES[cls]) return c.json({ error: "Kelas tindakan tidak dikenal." }, 400);
    if (!l.proposal(cls)) return c.json({ error: "Belum cukup bukti bersih untuk naik level." }, 400);
    // Owner confirmed while signed in; a step-up passkey ceremony is a follow-up.
    const to = await l.promote(cls, { method: "session", credential_id: by(c) });
    needStore().save();
    return c.json({ cls, level: to });
  });

  app.post("/autonomy/demote", async (c) => {
    const { cls } = (await c.req.json().catch(() => ({}))) as { cls?: string };
    const l = await getLadder();
    if (!cls || !DEFAULT_POLICIES[cls]) return c.json({ error: "Kelas tindakan tidak dikenal." }, 400);
    if (l.level(cls) === "ask") return c.json({ error: "Sudah di level paling bawah (Tanya dulu)." }, 400);
    const to = await l.demote(cls, "override", `owner override (${by(c)})`);
    needStore().save();
    return c.json({ cls, level: to });
  });

  // SOP amendments: repeated owner exceptions -> a tested proposal -> the owner decides. With the
  // flag off the list is empty and nothing can be decided. Approving saves a rulebook version and sends nothing.
  const amendOn = () => (deps.amend?.enabled ?? (() => amendmentsEnabled(deps.amend?.env)))();
  const amendView = (a: ReturnType<typeof loadAmendments>[number]) => {
    const { rulebook_after: _rb, ...rest } = a;
    return rest;
  };
  const amending = new Set<string>();

  app.get("/amendments", (c) => {
    if (!amendOn()) return c.json({ enabled: false, items: [], pending: 0, threshold: SHORTFALL_MIN, exceptions: 0, open_shortfalls: 0 });
    const data = needStore().data;
    const items = loadAmendments(data);
    const rank = (i: { status: string }) => (i.status === "pending" ? 0 : 1);
    const sorted = [...items].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? "").localeCompare(a.decided_at ?? "")));
    return c.json({ enabled: true, items: sorted.slice(0, 50).map(amendView), pending: items.filter((i) => i.status === "pending").length, threshold: SHORTFALL_MIN, exceptions: loadExceptions(data).length, open_shortfalls: localShortfalls(loadExceptions(data)).length });
  });

  app.post("/amendments/scan", async (c) => {
    if (!amendOn()) return c.json({ enabled: false, error: "Usulan perubahan SOP belum diaktifkan di server ini." }, 409);
    if (!deps.audit) return c.json({ error: "Pengujian belum tersedia di server ini." }, 409);
    const store = needStore();
    const out = await scanAmendments(await open(), store.data, { audit: deps.audit, template: deps.template ?? (() => { throw new Error("Tidak ada SOP dasar di server ini."); }), history: deps.amend?.history?.() ?? null, env: deps.amend?.env });
    store.save();
    return c.json({ path: out.path, note: out.note, shortfalls: out.shortfalls.length, offered: out.results.filter((r) => r.result.offered).length });
  });

  for (const action of ["approve", "reject"] as const)
    app.post(`/amendments/:id/${action}`, async (c) => {
      if (!amendOn()) return c.json({ enabled: false, error: "Usulan perubahan SOP belum diaktifkan di server ini." }, 409);
      const store = needStore();
      const id = c.req.param("id");
      const item = loadAmendments(store.data).find((a) => a.id === id);
      if (!item) return c.json({ error: "Usulan tidak ditemukan." }, 404);
      if (item.status !== "pending" || amending.has(id)) return c.json({ error: "Usulan ini sudah diputuskan." }, 409);
      amending.add(id);
      try {
        const ws = await open();
        // Owner confirmed while signed in; a step-up passkey ceremony is a follow-up (as for the ladder).
        const done = action === "approve" ? await approveAmendment(ws, store.data, id, { method: "session", credential_id: by(c) }, by(c)) : await rejectAmendment(ws, store.data, id, by(c));
        store.save();
        return c.json({ receipt: done.decision_receipt, item: amendView(done), note: action === "approve" ? "Aturan baru disimpan sebagai versi SOP. Belum ada pesan terkirim." : "Usulan ditolak. SOP tidak berubah." });
      } finally {
        amending.delete(id);
      }
    });

  // Bookkeeping: one sync at a time (a second caller waits for the first), so no row is appended twice.
  let journaling: Promise<unknown> = Promise.resolve();
  const syncJournalNow = (): Promise<JournalSyncResult | undefined> => {
    const j = deps.journal;
    if (!j) return Promise.resolve(undefined);
    const origin = (deps.webOrigin ?? "").replace(/\/$/, "");
    const run = journaling.then(async () => syncJournal({ ws: await open(), store: needStore(), registry: j.registry, spreadsheetId: j.spreadsheetId, proofUrl: (r) => `${origin}/?view=jejak&receipt=${r}`, now: clock }));
    journaling = run.catch(() => undefined);
    return run;
  };
  /** After a tick or a paid mark the journal is synced too; a journal failure never fails the tick. */
  const withJournal = async <T extends object>(result: T): Promise<T & { journal?: JournalSyncResult | { status: "failed"; note: string } }> => {
    if (!deps.journal) return result;
    try {
      const journal = await syncJournalNow();
      return journal ? { ...result, journal } : result;
    } catch (e) {
      console.error(`meko journal sync failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      return { ...result, journal: { status: "failed", note: "Jurnal gagal disinkronkan; rinciannya ada di log server." } };
    }
  };

  // The live billing loop: today's tick over the stored bills (liveTick). One at a time; a second caller shares the run.
  let ticking: Promise<TickReport> | null = null;
  const tick = (): Promise<TickReport> => {
    ticking ??= (async () => withJournal(await liveTick({ ws: await open(), store: needStore(), ladder: await getLadder(), outbox: await getOutbox(), execute: logExec, now: clock })))().finally(() => (ticking = null));
    return ticking;
  };

  /** The owner records that a tenant paid this month (POST /api/meko/bills/:id/paid): the bill leaves the loop, the decision is traced. */
  const markPaid = async (id: string, who: string): Promise<MarkPaidResult> => withJournal(await markBillPaid({ ws: await open(), store: needStore(), outbox: await getOutbox(), now: clock }, id, who));

  return {
    app,
    syncJournal: syncJournalNow,
    fetch: (req: Request, account: string) => app.fetch(req, { account }),
    /** Digest text for today, for the owner's /ringkasan on Telegram. */
    digestText: async () => (await digestFor()).text,
    /** One billing tick for today in Asia/Jakarta; idempotent per day (POST /api/meko/tick, the scheduler). */
    tick,
    markPaid,
    /** Runs staged reminders whose 10-minute window has passed (the scheduler calls this every minute). */
    flush: async () => {
      await settled();
    },
  };
}

const sha = (v: string) => createHash("sha256").update(v).digest();

/**
 * The live billing loop's two secret-protected routes. Both cause real effects (a tick can send Telegram
 * messages; marking a bill paid stops them), so neither takes a session: there is no per-workspace owner for
 * this shared demo workspace, and any self-registered account could otherwise call them. The caller sends
 * the header `x-reeve-tick-secret` equal to REEVE_TICK_SECRET (constant-time compare); without the env both
 * routes answer 401 to everyone (the in-process scheduler, REEVE_MEKO_TICK=on, still ticks).
 * - POST /api/meko/tick: today's tick over the stored bills.
 * - POST /api/meko/bills/:id/paid: records that tenant :id (K05) paid this month.
 * Served without a session, as `fetch(req)`.
 */
export function createMekoTickApp(deps: { tick: () => Promise<TickReport>; markPaid: (id: string, by: string) => Promise<MarkPaidResult>; journal?: () => Promise<JournalSyncResult | undefined>; secret?: string }) {
  const app = new Hono().basePath("/api/meko");
  const allowed = (header: string | undefined) => !!deps.secret && !!header && timingSafeEqual(sha(header), sha(deps.secret));
  const denied = { error: "Kirim header x-reeve-tick-secret yang benar." };
  const generic = (what: string, e: unknown) => {
    console.error(`meko ${what} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    return { error: `${what === "tick" ? "Tick" : what === "journal" ? "Sinkron jurnal" : "Menandai lunas"} gagal dijalankan. Coba lagi sebentar lagi; rinciannya ada di log server.` };
  };
  app.post("/tick", async (c) => {
    if (!allowed(c.req.header("x-reeve-tick-secret"))) return c.json(denied, 401);
    try {
      return c.json(await deps.tick());
    } catch (e) {
      if (e instanceof NoBills) return c.json({ error: e.message }, 409);
      return c.json(generic("tick", e), 503);
    }
  });
  app.post("/bills/:id/paid", async (c) => {
    if (!allowed(c.req.header("x-reeve-tick-secret"))) return c.json(denied, 401);
    const id = c.req.param("id").toUpperCase();
    if (!/^K\d{2,3}$/.test(id)) return c.json({ error: "Kode penghuni harus seperti K05." }, 400);
    try {
      return c.json(await deps.markPaid(id, "pemilik (lewat kunci server)"));
    } catch (e) {
      if (e instanceof NoBills) return c.json({ error: e.message }, 409);
      if (e instanceof UnknownBill) return c.json({ error: e.message }, 404);
      return c.json(generic("mark paid", e), 503);
    }
  });
  app.post("/journal/sync", async (c) => {
    if (!allowed(c.req.header("x-reeve-tick-secret"))) return c.json(denied, 401);
    try {
      const r = await deps.journal?.();
      return r ? c.json(r) : c.json({ error: "Jurnal Google Sheets belum dinyalakan di server ini (REEVE_JOURNAL=on)." }, 404);
    } catch (e) {
      return c.json(generic("journal", e), 503);
    }
  });
  return { app, fetch: (req: Request) => app.fetch(req) };
}
