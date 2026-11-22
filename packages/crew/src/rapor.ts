// Rapor Usaha / audit report, generated from the receipt ledger and the Meko traces (Meko's own
// audit-log export is a Pro feature). Every line is a recorded decision with its rule, approval,
// exception check, verification result and anchor. Stored as a Meko artifact by SHA-256.
import type { AnchorBody, DecisionBody, LedgerEntry } from "@reeve/receipts";
import { anchorProof, type MekoMessage, type MekoWorkspace, traceBodyOf, traceHash } from "@reeve/meko";

export interface RaporEntry {
  seq: number;
  at: string;
  run_id: string;
  agent: string;
  action?: string;
  action_class?: string;
  subject?: string;
  receipt: string;
  input: string;
  reasoning: string;
  /** "R3", "b4_deposit", "bound_cicilan" when the reasoning cites one. */
  rule?: string;
  looked_up: number;
  tokens_saved: number;
  usage?: { model: string; input_tokens: number; output_tokens: number };
  verified: boolean;
  anchored?: { seq: number; tx?: string; explorer?: string; proof_ok: boolean } | null;
}

export interface Rapor {
  workspace: string;
  generated_at: string;
  period: { from: string; to: string };
  ledger_intact: boolean;
  totals: { decisions: number; verified: number; tampered: number; anchored: number; by_agent: Record<string, number>; by_action: Record<string, number> };
  usaha: {
    fees: { count: number; amount_idr: number };
    exceptions_honoured: number;
    reminders: number;
    deposits: { count: number; amount_idr: number };
    rooms_filled: number;
    replies_auto: number;
    escalations: number;
    content_published: number;
    chats_from_content: number;
    payment_plans: number;
    autonomy_changes: number;
    explanations: number;
  };
  tokens: { llm_input: number; llm_output: number; context_tokens_saved: number; lookups: number; worker_calls: number };
  anchors: { seq: number; at: string; merkle_root: string; leaves: number; anchor: string; tx?: string; explorer?: string }[];
  decisions: RaporEntry[];
}

const RULE = /\b(R\d{1,2}\b|b\d_[a-z_]+|c\d_[a-z_]+|bound_[a-z_]+)/;

export async function buildRapor(ws: MekoWorkspace, opts: { from?: string; to?: string; now?: Date } = {}): Promise<Rapor> {
  const entries = ws.ledger.entries();
  const from = opts.from ?? "0000";
  const to = opts.to ?? "9999";
  const decisions = ws.decisions().filter((d) => d.at.slice(0, 10) >= from && d.at.slice(0, 10) <= to);
  const cache = new Map<string, MekoMessage[]>();
  const out: RaporEntry[] = [];
  for (const d of decisions) {
    const key = `${d.agent}:${d.conversation_id}`;
    if (!cache.has(key)) cache.set(key, (await ws.conversation(d.agent, d.conversation_id).catch(() => ({ messages: [] as MekoMessage[] }))).messages);
    const m = cache.get(key)!.find((x) => x.metadata?.reeve_receipt === d.entry_hash);
    const verified = !!m && traceHash(traceBodyOf(d, m)) === d.trace_hash;
    const usage = m?.metadata?.reeve_usage as RaporEntry["usage"] | undefined;
    out.push({
      seq: d.seq,
      at: d.at,
      run_id: d.run_id,
      agent: d.agent,
      action: d.action,
      action_class: d.action_class,
      subject: d.subject,
      receipt: d.entry_hash,
      input: m?.input ?? "",
      reasoning: m?.reasoning ?? "",
      rule: m?.reasoning?.match(RULE)?.[1],
      looked_up: ((m?.metadata?.reeve_lookups as unknown[]) ?? []).length,
      tokens_saved: Number(m?.metadata?.reeve_tokens_saved ?? 0),
      usage,
      verified,
      anchored: anchorProof(entries, d),
    });
  }
  const count = (f: (e: RaporEntry) => boolean) => out.filter(f).length;
  const tally = (k: "agent" | "action") => out.reduce<Record<string, number>>((acc, e) => ((acc[e[k] ?? "-"] = (acc[e[k] ?? "-"] ?? 0) + 1), acc), {});
  const fees = out.filter((e) => e.action === "charge_fee");
  const deposits = out.filter((e) => e.action === "deposit_bill");
  const measured = out.filter((e) => e.action === "measure");
  const anchors = entries.filter((e): e is LedgerEntry & AnchorBody => e.kind === "anchor").map((a) => ({ seq: a.seq, at: a.at, merkle_root: a.merkle_root, leaves: a.leaves, anchor: a.anchor, tx: a.tx, explorer: a.explorer }));
  return {
    workspace: ws.workspace,
    generated_at: (opts.now ?? new Date()).toISOString(),
    period: { from: decisions[0]?.at.slice(0, 10) ?? from, to: decisions.at(-1)?.at.slice(0, 10) ?? to },
    ledger_intact: ws.ledger.verify() === null,
    totals: { decisions: out.length, verified: count((e) => e.verified), tampered: count((e) => !e.verified), anchored: count((e) => !!e.anchored?.proof_ok), by_agent: tally("agent"), by_action: tally("action") },
    usaha: {
      fees: { count: fees.length, amount_idr: fees.reduce((s, e) => s + (Number(e.reasoning.match(/= Rp(\d+)/)?.[1]) || 0), 0) },
      exceptions_honoured: count((e) => e.action === "hold"),
      reminders: count((e) => e.action === "remind" || (e.action === "auto_run" && e.action_class === "reminder")),
      deposits: { count: deposits.length, amount_idr: deposits.reduce((s, e) => s + (Number(e.reasoning.match(/Deposit Rp(\d+)/)?.[1]) || 0), 0) },
      rooms_filled: count((e) => e.action === "accept_tenant"),
      replies_auto: count((e) => e.action === "reply"),
      escalations: count((e) => e.action === "escalate" || e.action === "ask_owner"),
      content_published: count((e) => e.action === "publish" && e.action_class === "content_publish"),
      chats_from_content: measured.reduce((s, e) => s + (Number(e.reasoning.match(/(\d+) WhatsApp chats/)?.[1]) || 0), 0),
      payment_plans: count((e) => e.action === "offer_plan"),
      autonomy_changes: count((e) => e.action === "autonomy_promote" || (["override", "complaint", "undo"].includes(e.action ?? "") && e.agent === "owner")),
      explanations: count((e) => e.action === "explain"),
    },
    tokens: {
      llm_input: out.reduce((s, e) => s + (e.usage?.input_tokens ?? 0), 0),
      llm_output: out.reduce((s, e) => s + (e.usage?.output_tokens ?? 0), 0),
      context_tokens_saved: out.reduce((s, e) => s + e.tokens_saved, 0),
      lookups: out.reduce((s, e) => s + e.looked_up, 0),
      worker_calls: count((e) => e.agent === "worker"),
    },
    anchors,
    decisions: out,
  };
}

/** Stores the report in Meko (artifact, SHA-256) as a traced Auditor turn; returns the content hash. */
export async function storeRapor(ws: MekoWorkspace, rapor: Rapor): Promise<{ content_hash: string; receipt: string }> {
  const t = await ws.run(`run_rapor_${rapor.generated_at.slice(0, 10).replaceAll("-", "")}_${Date.now().toString(36)}`).agent("auditor", `Rapor Usaha ${rapor.period.from} s/d ${rapor.period.to}`);
  const art = await t.artifact(`rapor-${ws.workspace}-${rapor.period.to}.json`, rapor);
  const d = await t.decide({
    input: `rapor ${rapor.period.from}..${rapor.period.to}`,
    output: { artifact: art.content_hash, decisions: rapor.totals.decisions, verified: rapor.totals.verified, tampered: rapor.totals.tampered },
    reasoning: `The report is built from ${rapor.totals.decisions} ledger decisions and their Meko traces; ${rapor.totals.verified} recompute to the hash in their receipt, ${rapor.totals.anchored} are inside an anchored Merkle root.`,
    action: "rapor",
  });
  return { content_hash: art.content_hash, receipt: d.receipt_hash };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

const ACTION_ID: Record<string, [string, string]> = {
  charge_fee: ["Denda", "Late fee"],
  hold: ["Ditahan (izin pemilik)", "Held (owner exception)"],
  remind: ["Pengingat", "Reminder"],
  reply: ["Balas calon penghuni", "Reply to prospect"],
  escalate: ["Ke pemilik", "To owner"],
  ask_owner: ["Tanya pemilik", "Asked owner"],
  deposit_bill: ["Tagih deposit", "Deposit bill"],
  accept_tenant: ["Terima penghuni", "Accept tenant"],
  publish: ["Terbit", "Published"],
  offer_plan: ["Tawaran cicilan", "Payment plan offer"],
  explain: ["Penjelasan", "Explanation"],
  approve_playbook: ["Setujui playbook", "Approve playbook"],
  audit_pass: ["Lulus audit", "Audit passed"],
  compile_playbook: ["Susun playbook", "Compile playbook"],
};

/** One self-contained page, Indonesian first with an English toggle. */
export function raporHtml(r: Rapor, opts: { explainUrl?: (receipt: string) => string } = {}): string {
  const t = (id: string, en: string) => `<span data-l="id">${esc(id)}</span><span data-l="en">${esc(en)}</span>`;
  const url = opts.explainUrl ?? ((h: string) => `/?view=jejak&receipt=${h}`);
  const u = r.usaha;
  const tiles: [string, string, string][] = [
    ["Keputusan tercatat", "Decisions recorded", String(r.totals.decisions)],
    ["Terverifikasi", "Verified", `${r.totals.verified}/${r.totals.decisions}`],
    ["Di dalam anchor", "Anchored", String(r.totals.anchored)],
    ["Kamar terisi", "Rooms filled", String(u.rooms_filled)],
    ["Deposit ditagih", "Deposits billed", rp(u.deposits.amount_idr)],
    ["Denda", "Late fees", `${u.fees.count} · ${rp(u.fees.amount_idr)}`],
    ["Izin pemilik dipatuhi", "Owner exceptions honoured", String(u.exceptions_honoured)],
    ["Chat dari konten", "Chats from content", String(u.chats_from_content)],
    ["Balasan otomatis", "Automatic replies", String(u.replies_auto)],
    ["Diteruskan ke pemilik", "Sent to owner", String(u.escalations)],
    ["Token konteks dihemat", "Context tokens saved", r.tokens.context_tokens_saved.toLocaleString("id-ID")],
    ["Panggilan Worker", "Worker calls", String(r.tokens.worker_calls)],
  ];
  const rows = r.decisions
    .map((d) => {
      const [id, en] = ACTION_ID[d.action ?? ""] ?? [d.action ?? "-", d.action ?? "-"];
      return `<tr><td>${esc(d.at.slice(0, 16).replace("T", " "))}</td><td>${esc(d.agent)}</td><td>${t(id, en)}</td><td>${esc(d.subject ?? "")}</td><td>${esc(d.rule ?? "")}</td><td class="why">${esc(d.reasoning)}</td><td>${d.verified ? t("cocok", "match") : `<b class="bad">${t("berubah", "changed")}</b>`}${d.anchored?.proof_ok ? ` · ${t("anchor", "anchored")}` : ""}</td><td><a href="${esc(url(d.receipt))}"><code>${esc(d.receipt.slice(0, 10))}</code></a></td></tr>`;
    })
    .join("");
  const anchors = r.anchors.map((a) => `<li><code>${esc(a.merkle_root.slice(0, 16))}…</code> · ${a.leaves} leaves · ${esc(a.anchor)}${a.explorer ? ` · <a href="${esc(a.explorer)}">tx</a>` : ""}</li>`).join("") || `<li>${t("Belum ada anchor.", "No anchor yet.")}</li>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor Usaha · ${esc(r.workspace)}</title>
<style>
:root{--bg:#000b16;--ink:#f6f7ed;--mute:#b9bdb4;--fill:#001f3f;--fill2:#012a52;--accent:#dbe64c;--on-accent:#001f3f;--blue:#1e488f;--link:#a9c1f2;--bad:#ff9b94;--sep:#1c2f45}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}.mute{color:var(--mute)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-top:16px}
.tile{background:var(--fill);border-radius:12px;padding:12px}.tile b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:8px 6px;vertical-align:top}tr+tr td{box-shadow:inset 0 1px 0 var(--sep)}thead th{color:var(--mute);font-weight:600}
.why{max-width:420px}.bad{color:var(--bad)}a{color:var(--link)}code{font-size:12px}
.wrap{overflow-x:auto}button{background:var(--accent);color:var(--on-accent);border:0;border-radius:22px;min-height:44px;padding:0 18px;font:inherit;font-weight:700;cursor:pointer;float:right}
.bars{display:grid;gap:6px;background:var(--fill);border-radius:12px;padding:12px}.bar{display:grid;grid-template-columns:110px 1fr 40px;gap:8px;align-items:center}
.bar i{display:block;height:14px;border-radius:4px;background:var(--blue)}.bar.ok i{background:var(--accent)}
html[data-lang=id] [data-l=en],html[data-lang=en] [data-l=id]{display:none}
</style></head><body><main>
<button onclick="var h=document.documentElement;h.dataset.lang=h.dataset.lang==='en'?'id':'en'">ID / EN</button>
<h1>${t("Rapor Usaha", "Business report")} · ${esc(r.workspace)}</h1>
<p class="mute">${t("Periode", "Period")} ${esc(r.period.from)} – ${esc(r.period.to)} · ${t("dibuat", "generated")} ${esc(r.generated_at.slice(0, 16).replace("T", " "))} UTC · ${t("Rantai ledger", "Ledger chain")}: ${r.ledger_intact ? t("utuh", "intact") : `<b class="bad">${t("rusak", "broken")}</b>`}</p>
<p>${t("Setiap baris adalah keputusan agen yang tercatat di Meko dan di ledger Reeve. Reeve menghitung ulang hash jejak dari Meko dan membandingkannya dengan receipt; anchor membuktikan receipt tidak diubah sesudahnya.", "Every row is an agent decision recorded in Meko and in the Reeve ledger. Reeve recomputes each trace hash from Meko and compares it with its receipt; the anchor proves the receipt was not changed afterwards.")}</p>
<div class="tiles">${tiles.map(([a, b, v]) => `<div class="tile">${t(a, b)}<b>${esc(v)}</b></div>`).join("")}</div>
<h2>${t("Keputusan per agen", "Decisions per agent")}</h2>
<div class="bars">${Object.entries(r.totals.by_agent)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `<div class="bar"><span>${esc(a)}</span><i style="width:${Math.max(2, Math.round((n / Math.max(1, r.totals.decisions)) * 100))}%"></i><b>${n}</b></div>`)
    .join("")}<div class="bar ok"><span>${t("terverifikasi", "verified")}</span><i style="width:${Math.round((r.totals.verified / Math.max(1, r.totals.decisions)) * 100)}%"></i><b>${r.totals.verified}</b></div></div>
<h2>${t("Keputusan", "Decisions")}</h2>
<div class="wrap"><table><thead><tr><th>${t("Waktu", "Time")}</th><th>${t("Agen", "Agent")}</th><th>${t("Tindakan", "Action")}</th><th>${t("Untuk", "About")}</th><th>${t("Aturan", "Rule")}</th><th>${t("Alasan (dari jejak)", "Reasoning (from trace)")}</th><th>${t("Cek", "Check")}</th><th>Receipt</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Anchor</h2><ul>${anchors}</ul>
<p class="mute">${t("Nama penghuni tidak pernah dikirim ke AI atau ke Meko; yang tampil adalah nama samaran.", "Tenant names are never sent to an AI model or to Meko; only pseudonyms appear.")} ${t("Metrik konten di demo ini simulasi.", "Content metrics in this demo are simulated.")}</p>
</main><script>document.documentElement.dataset.lang=new URLSearchParams(location.search).get("lang")==="en"?"en":"id"</script></body></html>`;
}
