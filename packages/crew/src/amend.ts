// Self-learning loop: the owner keeps making the same exception -> Reeve proposes an SOP amendment
// -> the Auditor tests it (spec cases + planted defects) -> the owner approves -> the improvement is
// shown from the history, never claimed without a computation.
//
// Everything that decides is code: clustering, the changed rulebook, the diff and the replay. Meko
// only stores the memory and the traced turns. Meko Cloud may offer `selflearning_shortfalls` and
// `selflearning_verify`; local Meko has no such tools (checked on 1.20261116), their schemas are not
// verified, so the adapter feature-detects them, calls them defensively and always falls back to the
// local path. Nothing changes until the owner approves; approving sends no message.
import { createHash, randomUUID } from "node:crypto";
import type { RuleCard, Rulebook } from "@reeve/core";
import { type AgentTrace, type MekoWorkspace, Pseudonymiser } from "@reeve/meko";
import type { PasskeyProof } from "./crew";
import { buildHistory, type Candidate, type DiscoveryAudit, type History, parseChatExport, parsePaymentsCsv, type Replay, replayHistory } from "./discovery";

/**
 * Distinct (tenant, month) exceptions of the same kind on the same rule before it is a shortfall.
 * One is a favour, two can be a coincidence, three is a pattern (same bar as SOP Discovery's
 * MIN_CONFIRMED). A tenant asking twice in one month counts once.
 */
export const SHORTFALL_MIN = 3;

type Env = Record<string, string | undefined>;
/** SOP amendments are off unless REEVE_SOP_AMENDMENTS is on/1/true. */
export const amendmentsEnabled = (env: Env = process.env): boolean => /^(on|1|true)$/i.test(env.REEVE_SOP_AMENDMENTS ?? "");
/** `cloud` asks Meko Cloud's selflearning_* tools first (when they exist); anything else is local. */
export const selfLearningMode = (env: Env = process.env): "cloud" | "local" => (env.REEVE_SELFLEARNING === "cloud" ? "cloud" : "local");

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Data = Record<string, unknown>;

// ── Stored state (next to meko_review / meko_ladder) ───────────────────────────────────────────

export interface OwnerException {
  id: string;
  rule_id: string;
  reason_class: string;
  /** Days the owner allowed, when the reason says it. */
  days: number | null;
  subject: string;
  month: string;
  text: string;
  /** The `owner_exception` decision receipt. */
  receipt: string;
  /** Receipt of an earlier grant this record was made from, if any. */
  source_receipt?: string;
  at: string;
}

export interface Shortfall {
  id: string;
  rule_id: string;
  reason_class: string;
  label: string;
  count: number;
  subjects: string[];
  receipts: string[];
  suggested: { field: "days_after_due"; to: number } | null;
}

export interface Improvement {
  replay: { bills: number; before: { agree: number; diffs: number; waived: number }; after: { agree: number; diffs: number; waived: number }; new_diffs: number } | null;
  improved: boolean;
  summary: string;
  search: { query: string; before: number; after: { hits: number; new: number; at: string } | null };
  cloud: { used: boolean; note: string };
}

export interface StoredAmendment {
  id: string;
  rule_id: string;
  reason_class: string;
  diff_id: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at?: string;
  decision_receipt?: string;
  run_id: string;
  /** Which path produced the shortfall: Meko Cloud's selflearning tool, or the local code. */
  path: "cloud" | "local";
  path_note: string;
  shortfall: { count: number; subjects: string[]; label: string };
  change: AmendChange;
  diff: { before: string[]; after: string[]; summary: string; notes: string[] };
  audit: DiscoveryAudit;
  evidence: string[];
  improvement: Improvement | null;
  rulebook_hash_before: string;
  rulebook_hash_after: string;
  rulebook_after: Rulebook;
  receipts: { propose: string; audit: string };
}

export interface RulebookVersion {
  version: number;
  at: string;
  hash: string;
  rulebook: Rulebook;
  amendment?: string;
  receipt?: string;
}

export const loadExceptions = (data: object) => ((data as Data).meko_exceptions ??= []) as OwnerException[];
export const loadAmendments = (data: object) => ((data as Data).meko_amend ??= []) as StoredAmendment[];
export const loadRulebookVersions = (data: object) => ((data as Data).meko_rulebooks ??= []) as RulebookVersion[];
/** The SOP in force: the last approved version, else the starting rulebook. */
export const currentRulebook = (data: object, fallback: () => Rulebook): Rulebook => loadRulebookVersions(data).at(-1)?.rulebook ?? fallback();

// ── 1. Exceptions ──────────────────────────────────────────────────────────────────────────────

/** Normalised reason: "boleh telat sampai 12 hari" and "... 15 hari" are one class, rounded up to 5 days. */
export function reasonClass(reason: string): { cls: string; days: number | null } {
  const days = Number(reason.match(/telat (?:sampai |hingga )?(\d+) hari/i)?.[1] ?? 0);
  return days > 0 ? { cls: `late_grace:${Math.ceil(days / 5) * 5}`, days } : { cls: "lainnya", days: null };
}

const roomOf = (subject: string) => String(Number(subject.replace(/\D/g, "")) || "");

/**
 * An owner exception becomes shared Meko memory (tagged with the rule and the reason class, in the
 * same sentence the Operator already reads) and an `owner_exception` decision with its receipt.
 * The same tenant and month on the same rule and class is recorded once.
 */
export async function recordException(
  ws: MekoWorkspace,
  data: object,
  input: { rule_id: string; reason: string; subject: string; month?: string; source_receipt?: string },
): Promise<{ receipt: string; duplicate: boolean; record: OwnerException }> {
  const rc = reasonClass(input.reason);
  const month = input.month ?? ws.at().slice(0, 7);
  const list = loadExceptions(data);
  const dup = list.find((e) => e.rule_id === input.rule_id && e.reason_class === rc.cls && e.subject === input.subject && e.month === month);
  if (dup) return { receipt: dup.receipt, duplicate: true, record: dup };
  const room = roomOf(input.subject);
  const text = rc.days && room ? `Kamar ${room} boleh telat sampai ${rc.days} hari (${month}).` : input.reason.slice(0, 300);
  const owner = await ws.run(`run_exception_${randomUUID().slice(0, 8)}`).agent("owner", `Pengecualian ${input.rule_id}`);
  const mem = await owner.remember(text, { kind: "owner_exception", rule_id: input.rule_id, reason_class: rc.cls, subject: input.subject, month, days: rc.days }, { promote: true });
  const d = await owner.decide({
    input: `${input.subject}: ${text}`,
    output: { rule_id: input.rule_id, reason_class: rc.cls, days: rc.days, month, memory: mem.id, ...(input.source_receipt ? { source_receipt: input.source_receipt } : {}) },
    reasoning: `The owner made an exception to ${input.rule_id} (reason class ${rc.cls}); it is promoted to shared memory so the Operator holds the fee, and counted so Reeve can notice when the same exception keeps coming back.`,
    action: "owner_exception",
    action_class: "exception",
    subject: input.subject,
  });
  const record: OwnerException = { id: `ex_${d.receipt_hash.slice(0, 10)}`, rule_id: input.rule_id, reason_class: rc.cls, days: rc.days, subject: input.subject, month, text, receipt: d.receipt_hash, ...(input.source_receipt ? { source_receipt: input.source_receipt } : {}), at: ws.at() };
  list.push(record);
  return { receipt: d.receipt_hash, duplicate: false, record };
}

/** Local clustering: rule + reason class, distinct (tenant, month), at least SHORTFALL_MIN. */
export function localShortfalls(exceptions: OwnerException[], min = SHORTFALL_MIN): Shortfall[] {
  const groups = new Map<string, OwnerException[]>();
  for (const e of exceptions) {
    const g = groups.get(`${e.rule_id}|${e.reason_class}`) ?? [];
    if (!g.some((x) => x.subject === e.subject && x.month === e.month)) g.push(e);
    groups.set(`${e.rule_id}|${e.reason_class}`, g);
  }
  const out: Shortfall[] = [];
  for (const [key, g] of groups) {
    if (g.length < min) continue;
    const [rule_id, cls] = key.split("|") as [string, string];
    const days = cls.startsWith("late_grace:") ? Number(cls.split(":")[1]) : null;
    out.push({
      id: `sf_${sha(key).slice(0, 8)}`,
      rule_id,
      reason_class: cls,
      label: days ? `izin telat sampai ${days} hari` : "izin lain",
      count: g.length,
      subjects: [...new Set(g.map((e) => e.subject))],
      receipts: g.map((e) => e.receipt),
      suggested: days ? { field: "days_after_due", to: days } : null,
    });
  }
  return out;
}

/**
 * Meko Cloud's self-learning tools, feature-detected. Their schema is unknown (they are not in the
 * local Meko), so the call is best effort and every failure or unknown answer falls back to the
 * local code, with the path that ran recorded.
 */
export class MekoSelfLearning {
  constructor(
    readonly ws: MekoWorkspace,
    readonly env: Env = process.env,
  ) {}

  async available(): Promise<{ shortfalls: boolean; verify: boolean }> {
    const tools = await this.ws.transport.tools().catch(() => [] as string[]);
    return { shortfalls: tools.includes("selflearning_shortfalls"), verify: tools.includes("selflearning_verify") };
  }

  private base() {
    return { conversation_id: this.ws.setupConversation, datapack_id: this.ws.datapackId };
  }

  async shortfalls(exceptions: OwnerException[]): Promise<{ shortfalls: Shortfall[]; path: "cloud" | "local"; note: string }> {
    const local = localShortfalls(exceptions);
    if (selfLearningMode(this.env) !== "cloud") return { shortfalls: local, path: "local", note: "Dihitung oleh kode Reeve (REEVE_SELFLEARNING bukan cloud)." };
    if (!(await this.available()).shortfalls) return { shortfalls: local, path: "local", note: "Meko ini tidak punya selflearning_shortfalls (hanya Meko Cloud); dihitung oleh kode Reeve." };
    try {
      const res = (await this.ws.transport.call("selflearning_shortfalls", { ...this.base(), min_occurrences: SHORTFALL_MIN, limit: 20 })) as unknown;
      const o = (res ?? {}) as Record<string, unknown>;
      const raw = (Array.isArray(res) ? res : (o.shortfalls ?? o.items ?? o.results)) as unknown;
      const items = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      const mapped: Shortfall[] = [];
      for (const it of items) {
        const rule = String(it.rule_id ?? it.rule ?? "");
        const count = Number(it.count ?? it.occurrences ?? it.n ?? 0);
        // Cloud tells which rule keeps being excepted; the change itself is still made by local code.
        const match = localShortfalls(exceptions, 1).find((s) => s.rule_id === rule && s.suggested);
        if (rule && count >= SHORTFALL_MIN && match && !mapped.some((m) => m.id === match.id)) mapped.push({ ...match, count });
      }
      if (!mapped.length) return { shortfalls: local, path: "local", note: "selflearning_shortfalls menjawab dengan bentuk yang tidak dikenal atau kosong; dihitung oleh kode Reeve." };
      return { shortfalls: mapped, path: "cloud", note: "Ditemukan oleh selflearning_shortfalls (Meko Cloud, skema belum terverifikasi); perubahannya tetap dibuat oleh kode Reeve." };
    } catch (e) {
      return { shortfalls: local, path: "local", note: `selflearning_shortfalls gagal (${(e as Error).message.slice(0, 80)}); dihitung oleh kode Reeve.` };
    }
  }

  /** Extra verification from Cloud when it exists. Never replaces the local replay. */
  async verify(payload: Record<string, unknown>): Promise<{ used: boolean; note: string }> {
    if (selfLearningMode(this.env) !== "cloud") return { used: false, note: "Hanya pemutaran ulang lokal." };
    if (!(await this.available()).verify) return { used: false, note: "Meko ini tidak punya selflearning_verify (hanya Meko Cloud); hanya pemutaran ulang lokal." };
    try {
      await this.ws.transport.call("selflearning_verify", { ...this.base(), ...payload });
      return { used: true, note: "selflearning_verify (Meko Cloud) dipanggil sebagai tambahan; jawabannya tidak dipakai untuk menyatakan hasil." };
    } catch (e) {
      return { used: false, note: `selflearning_verify gagal (${(e as Error).message.slice(0, 80)}); hanya pemutaran ulang lokal.` };
    }
  }
}

// ── 2. The change, as code ─────────────────────────────────────────────────────────────────────

export interface AmendChange {
  card_id: string;
  field: "days_after_due";
  from: number;
  to: number;
}

type LateFee = Extract<RuleCard, { type: "late_fee" }>;
const lateFee = (rb: Rulebook, id: string) => rb.cards.find((c): c is LateFee => c.id === id && c.type === "late_fee");

/** Only a later fee day is an amendment this code knows how to make. */
export function planChange(rb: Rulebook, sf: Shortfall): AmendChange | null {
  const card = lateFee(rb, sf.rule_id);
  if (!card || !sf.suggested || sf.suggested.to <= card.days_after_due) return null;
  return { card_id: card.id, field: "days_after_due", from: card.days_after_due, to: sf.suggested.to };
}

export function applyChange(rb: Rulebook, ch: AmendChange, diffId: string, sf: Shortfall): Rulebook {
  const cards = rb.cards.map((c) => (c.id === ch.card_id && c.type === "late_fee" ? { ...c, days_after_due: ch.to, title: c.title.replace(`H+${ch.from}`, `H+${ch.to}`) } : c));
  return { ...rb, cards, assumptions: [...rb.assumptions, `Usulan perubahan ${diffId}: denda mulai H+${ch.to} (sebelumnya H+${ch.from}) setelah ${sf.count} izin pemilik yang sama, disetujui pemilik.`] };
}

export function plainDiff(rb: Rulebook, ch: AmendChange, sf: Shortfall): StoredAmendment["diff"] {
  const card = lateFee(rb, ch.card_id)!;
  const notice = rb.cards.find((c) => c.type === "notice") as { days_after_due: number; id: string } | undefined;
  const notes = [`Persen denda (${card.percent}%) dan toleransi penghuni lama tidak berubah.`];
  if (notice && notice.days_after_due < ch.to) notes.push(`Surat peringatan (${notice.id}) tetap H+${notice.days_after_due}, jadi datang sebelum denda. Periksa apakah urutan ini yang Anda mau.`);
  return {
    before: [`Denda ${card.percent}% mulai H+${ch.from} jika belum lunas.`],
    after: [`Denda ${card.percent}% mulai H+${ch.to} jika belum lunas.`],
    summary: `Tenggang denda naik dari H+${ch.from} ke H+${ch.to}, karena Anda sudah ${sf.count} kali memberi izin telat sampai ${ch.to} hari.`,
    notes,
  };
}

// ── 3. Improvement, computed ───────────────────────────────────────────────────────────────────

const cardCandidates = (rb: Rulebook, types: RuleCard["type"][]): Candidate[] =>
  rb.cards.filter((c) => types.includes(c.type)).map((card) => ({ id: card.id, kind: "card", card, title: card.title, confidence: 1, support: 0, counter: 0, evidence: "", cites: [] }));

/** A bill the rule would charge but the owner let go: it needed an owner exception. */
const waived = (r: Replay) => r.diffs.filter((d) => d.what === "fee" && d.owner.startsWith("tidak menagih")).length;
const diffKey = (d: Replay["diffs"][number]) => `${d.month}|${d.room}|${d.what}`;

/** context_search hits on the exception text: how many times the owner's memory says the same thing. */
async function exceptionHits(trace: AgentTrace, sf: Shortfall): Promise<{ query: string; texts: Set<string> }> {
  const days = sf.suggested?.to;
  const query = days ? `boleh telat sampai ${days} hari izin pemilik` : "izin pemilik pengecualian";
  const look = await trace.search(query, 30);
  return { query: look.query, texts: new Set(look.memory.filter((m) => /telat|izin/i.test(m.text)).map((m) => m.text.trim())) };
}

/**
 * Replays the history under the old and the amended rulebook (only the cards that matter for the
 * change) and counts the bills that needed an owner exception. Also counts context_search hits on
 * the exception text; after approval, `after` counts new exceptions since. Nothing is claimed that
 * this function did not compute.
 */
export async function verifyImprovement(input: { trace: AgentTrace; before: Rulebook; after: Rulebook; history: History | null; shortfall: Shortfall; cloud?: MekoSelfLearning }): Promise<Improvement> {
  const types: RuleCard["type"][] = ["invoice_schedule", "late_fee"];
  const hits = await exceptionHits(input.trace, input.shortfall);
  let replay: Improvement["replay"] = null;
  if (input.history) {
    const b = replayHistory(input.history, cardCandidates(input.before, types));
    const a = replayHistory(input.history, cardCandidates(input.after, types));
    const seen = new Set(b.diffs.map(diffKey));
    replay = { bills: b.bills, before: { agree: b.agree, diffs: b.diffs.length, waived: waived(b) }, after: { agree: a.agree, diffs: a.diffs.length, waived: waived(a) }, new_diffs: a.diffs.filter((d) => !seen.has(diffKey(d))).length };
  }
  const improved = !!replay && replay.after.waived < replay.before.waived && replay.new_diffs === 0;
  const summary = !replay
    ? "Belum bisa dihitung: tidak ada riwayat tagihan untuk diputar ulang."
    : improved
      ? `Dari ${replay.bills} tagihan masa lalu, ${replay.before.waived} butuh izin pemilik; dengan aturan baru ${replay.after.waived}. Tidak ada tagihan lain yang jadi berbeda.`
      : `Belum terbukti memperbaiki: tagihan yang butuh izin ${replay.before.waived} menjadi ${replay.after.waived}, dan ${replay.new_diffs} tagihan lain jadi berbeda dari kebiasaan Anda.`;
  const cloud = input.cloud ? await input.cloud.verify({ rule_id: input.shortfall.rule_id, replay }) : { used: false, note: "Hanya pemutaran ulang lokal." };
  return { replay, improved, summary, search: { query: hits.query, before: hits.texts.size, after: null }, cloud };
}

// ── 4. Propose, audit, decide ──────────────────────────────────────────────────────────────────

export interface ProposeDeps {
  /** The normal pipeline audit (spec cases and planted defects) on a rulebook. */
  audit: (rb: Rulebook) => Promise<DiscoveryAudit>;
  /** History to replay for the improvement evidence; null when there is none. */
  history?: History | null;
  cloud?: MekoSelfLearning;
  path?: { path: "cloud" | "local"; note: string };
}

export type ProposeResult = { offered: true; amendment: StoredAmendment } | { offered: false; reason: string; audit?: DiscoveryAudit };

const auditPass = (a: DiscoveryAudit) => a.status === "pass" && a.total > 0 && a.killed === a.total;

/**
 * Builder makes the amended rulebook with code, the Auditor tests it, and only a rulebook that
 * catches every planted defect is offered to the owner. The audit decision is recorded either way.
 */
export async function proposeAmendment(ws: MekoWorkspace, data: object, rb: Rulebook, sf: Shortfall, deps: ProposeDeps): Promise<ProposeResult> {
  const change = planChange(rb, sf);
  if (!change) return { offered: false, reason: "Tidak ada perubahan aturan yang bisa dibuat otomatis untuk pola ini." };
  const diffId = `df_${sha({ rb: sha(rb), change }).slice(0, 10)}`;
  const known = loadAmendments(data).find((a) => a.diff_id === diffId);
  if (known) return { offered: false, reason: `Usulan ${known.id} untuk perubahan yang sama sudah ada (${known.status}).` };
  const after = applyChange(rb, change, diffId, sf);
  const diff = plainDiff(rb, change, sf);
  const runId = `run_amend_${diffId.slice(3)}`;
  const run = ws.run(runId);

  const builder = await run.agent("builder", `Usulan perubahan SOP: ${sf.rule_id}`);
  await builder.search(`izin pemilik ${sf.rule_id} ${sf.label}`);
  const proposed = await builder.decide({
    input: `${sf.count} owner exceptions to ${sf.rule_id} (${sf.reason_class}) from ${sf.subjects.join(", ")}`,
    output: { diff_id: diffId, change, summary: diff.summary, evidence: sf.receipts },
    reasoning: `The same exception came ${sf.count} times (distinct tenant and month, threshold ${SHORTFALL_MIN}). Code, not a model, changed ${change.field} of ${change.card_id} from ${change.from} to ${change.to}; nothing is applied until the owner approves and the Auditor has tested it.`,
    plan: [...diff.before.map((l) => `sebelum: ${l}`), ...diff.after.map((l) => `sesudah: ${l}`)],
    action: "amend_propose",
    action_class: "sop_amendment",
  });

  const auditor = await run.agent("auditor", `Uji usulan perubahan SOP: ${sf.rule_id}`);
  const audit = await deps.audit(after);
  const pass = auditPass(audit);
  const improvement = pass ? await verifyImprovement({ trace: auditor, before: rb, after, history: deps.history ?? null, shortfall: sf, cloud: deps.cloud }) : null;
  const audited = await auditor.decide({
    input: `audit amended rulebook ${sha(after).slice(0, 12)} (Builder receipt ${proposed.receipt_hash.slice(0, 12)})`,
    output: { status: audit.status, spec_cases: audit.cases, planted_defects: `${audit.killed}/${audit.total}`, offered: pass, ...(improvement ? { improved: improvement.improved, summary: improvement.summary } : {}) },
    reasoning: pass
      ? `${audit.cases} spec cases written from the amended rulebook and ${audit.killed}/${audit.total} planted defects caught in the sandbox, so the amendment may go to the owner. ${improvement!.summary}`
      : `Only ${audit.killed}/${audit.total} planted defects caught (status ${audit.status}): the amendment is not offered to the owner.`,
    action: "amend_audit",
    action_class: "sop_amendment",
  });
  if (!pass || !improvement) return { offered: false, reason: `Uji gagal (${audit.killed}/${audit.total} cacat tertangkap): usulan tidak ditawarkan ke pemilik.`, audit };

  const item: StoredAmendment = {
    id: `am_${diffId.slice(3, 11)}`,
    rule_id: sf.rule_id,
    reason_class: sf.reason_class,
    diff_id: diffId,
    status: "pending",
    created_at: ws.at(),
    run_id: runId,
    path: deps.path?.path ?? "local",
    path_note: deps.path?.note ?? "Dihitung oleh kode Reeve.",
    shortfall: { count: sf.count, subjects: sf.subjects, label: sf.label },
    change,
    diff,
    audit,
    evidence: sf.receipts,
    improvement,
    rulebook_hash_before: sha(rb),
    rulebook_hash_after: sha(after),
    rulebook_after: after,
    receipts: { propose: proposed.receipt_hash, audit: audited.receipt_hash },
  };
  loadAmendments(data).push(item);
  return { offered: true, amendment: item };
}

/** Finds shortfalls (cloud when asked and present, else local) and proposes an amendment for each. */
export async function scanAmendments(ws: MekoWorkspace, data: object, deps: { audit: ProposeDeps["audit"]; template: () => Rulebook; history?: History | null; env?: Env }) {
  const sl = new MekoSelfLearning(ws, deps.env);
  const found = await sl.shortfalls(loadExceptions(data));
  const results: { shortfall: Shortfall; result: ProposeResult }[] = [];
  for (const sf of found.shortfalls) {
    const rb = currentRulebook(data, deps.template);
    results.push({ shortfall: sf, result: await proposeAmendment(ws, data, rb, sf, { audit: deps.audit, history: deps.history, cloud: sl, path: { path: found.path, note: found.note } }) });
  }
  return { path: found.path, note: found.note, shortfalls: found.shortfalls, results };
}

/** Owner says yes while signed in: the amended rulebook is saved as a new version. Sends nothing. */
export async function approveAmendment(ws: MekoWorkspace, data: object, id: string, proof: PasskeyProof, by = "session"): Promise<StoredAmendment> {
  const item = loadAmendments(data).find((a) => a.id === id);
  if (!item) throw new Error("Usulan tidak ditemukan.");
  if (item.status !== "pending") throw new Error("Usulan ini sudah diputuskan.");
  const owner = await ws.run(item.run_id).agent("owner", `Setujui perubahan SOP: ${item.rule_id}`);
  // The count of matching memories right now, to compare with the one taken when it was proposed.
  const sf: Shortfall = { id: "", rule_id: item.rule_id, reason_class: item.reason_class, label: item.shortfall.label, count: item.shortfall.count, subjects: item.shortfall.subjects, receipts: item.evidence, suggested: { field: "days_after_due", to: item.change.to } };
  const hits = await exceptionHits(owner, sf);
  const versions = loadRulebookVersions(data);
  const d = await owner.decide({
    input: `approve amendment ${item.id}: ${item.diff.summary}`,
    output: { amendment: item.id, diff_id: item.diff_id, rulebook_hash: item.rulebook_hash_after, version: versions.length + 1, method: proof.method, audit: `${item.audit.killed}/${item.audit.total}`, sent: false },
    reasoning: `The owner (${by}) approved the amendment ${proof.method === "passkey" ? "with a passkey" : proof.method === "session" ? "while signed in (session confirmation, no passkey step-up yet)" : "with a demo passkey (offline seed)"} after seeing the diff, the audit (${item.audit.killed}/${item.audit.total} planted defects) and the replay. The amended rulebook is saved as version ${versions.length + 1}; nothing is sent.`,
    action: "amend_approve",
    action_class: "sop_amendment",
  });
  await owner.remember(`SOP berubah: denda mulai H+${item.change.to} (sebelumnya H+${item.change.from}), atas persetujuan pemilik.`, { kind: "sop_amendment", rule_id: item.rule_id, diff_id: item.diff_id }, { promote: true });
  versions.push({ version: versions.length + 1, at: ws.at(), hash: item.rulebook_hash_after, rulebook: item.rulebook_after, amendment: item.id, receipt: d.receipt_hash });
  item.status = "approved";
  item.decided_at = ws.at();
  item.decision_receipt = d.receipt_hash;
  if (item.improvement) item.improvement.search.after = { hits: hits.texts.size, new: Math.max(0, hits.texts.size - item.improvement.search.before), at: ws.at() };
  return item;
}

export async function rejectAmendment(ws: MekoWorkspace, data: object, id: string, by = "session"): Promise<StoredAmendment> {
  const item = loadAmendments(data).find((a) => a.id === id);
  if (!item) throw new Error("Usulan tidak ditemukan.");
  if (item.status !== "pending") throw new Error("Usulan ini sudah diputuskan.");
  const owner = await ws.run(item.run_id).agent("owner", `Tolak perubahan SOP: ${item.rule_id}`);
  const d = await owner.decide({
    input: `reject amendment ${item.id}: ${item.diff.summary}`,
    output: { amendment: item.id, diff_id: item.diff_id, sent: false },
    reasoning: `The owner (${by}) rejected the amendment; the rulebook stays as it is and the same change is not proposed again.`,
    action: "amend_reject",
    action_class: "sop_amendment",
  });
  item.status = "rejected";
  item.decided_at = ws.at();
  item.decision_receipt = d.receipt_hash;
  return item;
}

// ── 5. Synthetic history for the demo ──────────────────────────────────────────────────────────

/**
 * Three months of a made-up Kos Melati chat and payments sheet in which the owner follows the
 * SOP (fee after H+7) except for three tenants she allowed to pay up to 15 days late, in three
 * different months. The demo replays it against the old and the amended rule.
 */
export function amendSampleHistory(): History {
  const owner = "Bu Ratna Melati";
  const people = [
    { room: 1, name: "Dimas Pratama", call: "Mas Dimas", late: [0, 1, 0] },
    { room: 2, name: "Rina Kusuma", call: "Mbak Rina", late: [2, 0, 1] },
    { room: 3, name: "Sinta Maharani", call: "Mbak Sinta", late: [12, 0, 2] },
    { room: 4, name: "Bagus Saputra", call: "Mas Bagus", late: [0, 0, 3] },
    { room: 5, name: "Nadia Putri", call: "Mbak Nadia", late: [1, 14, 0] },
    { room: 6, name: "Fajar Hidayat", call: "Mas Fajar", late: [0, 0, 0] },
    { room: 7, name: "Wulan Sari", call: "Mbak Wulan", late: [3, 2, 1] },
    { room: 8, name: "Andi Wijaya", call: "Mas Andi", late: [0, 1, 14] },
  ];
  const months = [
    { ym: "2026-08", name: "Agustus" },
    { ym: "2026-09", name: "September" },
    { ym: "2026-10", name: "Oktober" },
  ];
  const chat: string[] = [];
  const pay: string[] = ["tanggal,kamar,nama,jenis,jumlah,catatan,mulai_sewa"];
  const line = (ym: string, day: number, hm: string, from: string, text: string) => chat.push(`${String(day).padStart(2, "0")}/${ym.slice(5)}/${ym.slice(2, 4)} ${hm} - ${from}: ${text}`);
  months.forEach((mo, i) => {
    line(mo.ym, 1, "07.30", owner, `Selamat pagi, tagihan sewa bulan ${mo.name} Rp1.500.000 sudah bisa dibayar ya. Terima kasih.`);
    for (const p of people) {
      const late = p.late[i]!;
      if (late > 7) line(mo.ym, 5, "20.15", owner, `${p.call} kamar ${p.room} lagi ada keperluan, boleh telat sampai 15 hari bulan ini, nggak usah didenda.`);
      pay.push(`${mo.ym}-${String(1 + late).padStart(2, "0")},${p.room},${p.name},sewa,1500000,,2026-01-01`);
    }
  });
  const rows = chat;
  return buildHistory(parseChatExport(`${rows.join("\n")}\n`), parsePaymentsCsv(`${pay.join("\n")}\n`), new Pseudonymiser(), { business: "Kos Melati" });
}
