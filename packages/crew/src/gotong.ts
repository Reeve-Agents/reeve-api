// Gotong Royong: businesses that consent pool what their first drafts taught the Builder, as
// anonymous aggregate patterns in one shared Meko datapack. A new business's Builder reads the
// pool before it drafts. No model decides anything here: consent, the k >= 2 floor, the leak check
// and which hint a pattern becomes are all plain code. Only counts and kinds are ever stored.
import { createHash } from "node:crypto";
import type { MekoWorkspace } from "@reeve/meko";

export const GOTONG_WORKSPACE = "gotong-royong";
const TAG = "[gotong]";

/** What a business can agree to share. Each kind is its own owner decision with its own receipt. */
export const SHARE_KINDS = ["defect_kinds", "first_draft_findings", "content_hooks", "reminder_times"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Consent {
  kind: ShareKind;
  receipt: string;
}

/** The owner's decision, per kind, in the business's own workspace: `consent_share_patterns`. */
export async function consentShare(ws: MekoWorkspace, business: string, kinds: ShareKind[], opts: { by?: string } = {}): Promise<Consent[]> {
  const out: Consent[] = [];
  const owner = await ws.run(`run_gotong_consent_${Date.now().toString(36)}`).agent("owner", "Gotong Royong: izin berbagi pola");
  for (const kind of kinds) {
    const d = await owner.decide({
      input: `share anonymous ${kind} patterns for ${business}`,
      output: { kind, business_hash: sha(business).slice(0, 12), only: "counts and kinds, k>=2, no names, no amounts" },
      reasoning: `The owner (${opts.by ?? "signed in"}) agreed to contribute anonymous ${kind} aggregates to the shared datapack. It can be revoked; no other kind is shared.`,
      action: "consent_share_patterns",
      action_class: "gotong",
      subject: `gotong:${kind}`,
    });
    out.push({ kind, receipt: d.receipt_hash });
  }
  return out;
}

export async function revokeConsent(ws: MekoWorkspace, kind: ShareKind, by?: string): Promise<string> {
  const owner = await ws.run(`run_gotong_revoke_${Date.now().toString(36)}`).agent("owner", "Gotong Royong: cabut izin");
  const d = await owner.decide({
    input: `stop sharing ${kind} patterns`,
    output: { kind },
    reasoning: `The owner (${by ?? "signed in"}) withdrew consent; from this entry on the business contributes nothing of this kind.`,
    action: "revoke_share_patterns",
    action_class: "gotong",
    subject: `gotong:${kind}`,
  });
  return d.receipt_hash;
}

/** The receipt of the live consent for a kind, or null when never given or revoked since. */
export function consentReceipt(ws: MekoWorkspace, kind: ShareKind): string | null {
  let live: string | null = null;
  for (const d of ws.decisions({ agent: "owner", subject: `gotong:${kind}` })) {
    if (d.action === "consent_share_patterns") live = d.entry_hash;
    else if (d.action === "revoke_share_patterns") live = null;
  }
  return live;
}

/** One first draft of one business, reduced to kinds and counts. */
export interface DraftRun {
  verdict: "pass" | "fail";
  mutation: { total: number; killed: number };
  /** How many planted defects of each kind the Auditor planted in this draft. */
  plantedByKind: Record<string, number>;
  /** Kinds of the planted defects that survived (one entry per survivor). */
  survivorKinds: string[];
  /** Blocking finding messages from the Auditor, reduced to classes by code (see findingClass). */
  blockers: { code: string; message: string }[];
}

interface AttemptLike {
  verdict: { status: "pass" | "fail"; findings: { severity: string; code: string; message: string }[] };
  plan: { mutants: { id: string; kind: string }[] };
  results: { mutation: { total: number; killed: number; survivors: { id: string }[] } } | null;
}

/** Reduces a real pipeline attempt (`runAttempt`) to a DraftRun. A job that produced no results has no mutation data and counts as a fail. */
export function draftRunFromAttempt(a: AttemptLike): DraftRun {
  const kindOf = new Map(a.plan.mutants.map((m) => [m.id, m.kind]));
  const plantedByKind: Record<string, number> = {};
  for (const m of a.plan.mutants) plantedByKind[m.kind] = (plantedByKind[m.kind] ?? 0) + 1;
  return {
    verdict: a.verdict.status,
    mutation: a.results ? { total: a.results.mutation.total, killed: a.results.mutation.killed } : { total: 0, killed: 0 },
    plantedByKind,
    survivorKinds: (a.results?.mutation.survivors ?? []).map((s) => kindOf.get(s.id) ?? "unknown"),
    blockers: a.verdict.findings.filter((f) => f.severity === "blocker").map((f) => ({ code: f.code, message: f.message })),
  };
}

/** What a blocker is, reduced to a class with no business wording. */
export function findingClass(f: { code: string; message: string }): string {
  if (f.code === "RULEBOOK_INVALID" && /approval limit can never apply/.test(f.message)) return "approval_limit_without_amount_field";
  if (f.code === "RULEBOOK_INVALID") return "rulebook_invalid_other";
  if (f.code === "MUTANT_SURVIVED") return "planted_defect_survived";
  if (f.code === "SPEC_MISMATCH") return "spec_mismatch";
  if (f.code === "BUILDER_TEST_FAILED") return "builder_test_failed";
  return "other_blocker";
}

const FINDING_HINT: Record<string, string> = {
  approval_limit_without_amount_field:
    "an approval-limit card (owner must agree above an amount) needs at least one rule whose action sets amount_field to the money field; without it the Auditor rejects the rulebook before anything runs",
  rulebook_invalid_other: "check every card against the pack's schema bounds before answering; the Auditor rejects an invalid rulebook before anything runs",
  planted_defect_survived: "state every threshold and day count exactly as the SOP words it; a vague boundary lets planted defects survive",
  spec_mismatch: "the compiled rules must match the spec cases; keep each card to one behaviour the SOP states",
  builder_test_failed: "keep each card to one behaviour the SOP states, so the Builder's own tests can check it",
  other_blocker: "re-read the SOP for any rule you left out",
};

export interface BusinessSource {
  /** The business's own workspace: its owner decisions say what it agreed to share. */
  ws: MekoWorkspace;
  drafts: DraftRun[];
  /** Content hooks and the chats each brought, when the business runs content (kos-melati). */
  hooks?: { hook: string; chats: number }[];
}

export interface Pattern {
  id: string;
  kind: ShareKind;
  /** Consenting businesses behind this aggregate (never named). */
  businesses: number;
  counts: Record<string, number>;
  /** The sentence the Builder gets. Composed by code from the counts. */
  hint: string;
  /** What is stored in the shared datapack. */
  text: string;
  /** Consent receipts (hashes) of the contributing businesses. */
  consents: string[];
}

export interface Extraction {
  patterns: Pattern[];
  /** Businesses left out of a kind because they never agreed (or withdrew). */
  withheld: { business: string; kind: ShareKind }[];
  /** Candidate patterns not published, and why. */
  dropped: { kind: ShareKind; what: string; reason: string }[];
}

const pattern = (kind: ShareKind, key: string, counts: Record<string, number>, businesses: number, consents: string[], hint: string): Pattern => {
  const text = `${TAG} ${hint}`;
  return { id: `${kind}:${key}:${sha(text).slice(0, 10)}`, kind, businesses, counts, hint, text, consents };
};

/** Parses "Konten ct_x hook \"h\" ... menghasilkan N chat" lines (the Kos Melati content memory) into hook results. */
export function hooksFromMemory(texts: string[]): { hook: string; chats: number }[] {
  const out: { hook: string; chats: number }[] = [];
  for (const t of texts) {
    const m = t.match(/hook "(\w+)".*?menghasilkan (\d+) chat/);
    if (m) out.push({ hook: m[1]!, chats: Number(m[2]) });
  }
  return out;
}

/**
 * Derives patterns from what the consenting businesses' real runs produced. A kind with no data
 * source is dropped and said so (nothing is invented); an aggregate behind fewer than `minBusinesses`
 * businesses is dropped too, because one business would be recognisable in it.
 */
export function extractPatterns(sources: BusinessSource[], opts: { minBusinesses?: number } = {}): Extraction {
  const min = opts.minBusinesses ?? 2;
  const withheld: Extraction["withheld"] = [];
  const dropped: Extraction["dropped"] = [];
  const patterns: Pattern[] = [];
  const consenting = (kind: ShareKind) => {
    const ok: { s: BusinessSource; receipt: string }[] = [];
    for (const s of sources) {
      const receipt = consentReceipt(s.ws, kind);
      if (receipt) ok.push({ s, receipt });
      else withheld.push({ business: s.ws.workspace, kind });
    }
    return ok;
  };

  // defect_kinds: which planted-defect kinds the Auditor planted and which survived, over first drafts.
  const dk = consenting("defect_kinds").filter((c) => c.s.drafts.length > 0);
  if (dk.length < min) dropped.push({ kind: "defect_kinds", what: "planted-defect profile", reason: `only ${dk.length} consenting business(es) with drafts, need ${min}` });
  else {
    const drafts = dk.flatMap((c) => c.s.drafts);
    const planted: Record<string, number> = {};
    const survived: Record<string, number> = {};
    for (const d of drafts) {
      for (const [k, n] of Object.entries(d.plantedByKind)) planted[k] = (planted[k] ?? 0) + n;
      for (const k of d.survivorKinds) survived[k] = (survived[k] ?? 0) + 1;
    }
    const total = Object.values(planted).reduce((a, b) => a + b, 0);
    const lost = Object.values(survived).reduce((a, b) => a + b, 0);
    const top = Object.entries(planted).sort((a, b) => b[1] - a[1])[0];
    const counts = { drafts: drafts.length, planted: total, survived: lost, ...Object.fromEntries(Object.entries(planted).map(([k, n]) => [`planted_${k}`, n])), ...Object.fromEntries(Object.entries(survived).map(([k, n]) => [`survived_${k}`, n])) };
    const hint =
      lost > 0
        ? `In ${drafts.length} first drafts from ${dk.length} businesses, ${lost} of ${total} planted defects survived the spec (${Object.entries(survived).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}); add guards and tests for those kinds.`
        : `In ${drafts.length} first drafts from ${dk.length} businesses, no planted defect survived (${total} planted, mostly ${top?.[0] ?? "boundary"}); the Auditor derives its spec from the cards, so state each threshold and day count exactly as the SOP words it.`;
    patterns.push(pattern("defect_kinds", "profile", counts, dk.length, dk.map((c) => c.receipt), hint));
  }

  // first_draft_findings: why first drafts were rejected, by class.
  const ff = consenting("first_draft_findings").filter((c) => c.s.drafts.length > 0);
  if (ff.length < min) dropped.push({ kind: "first_draft_findings", what: "first-draft blocker classes", reason: `only ${ff.length} consenting business(es) with drafts, need ${min}` });
  else {
    const drafts = ff.flatMap((c) => c.s.drafts);
    const byClass = new Map<string, number>();
    for (const d of drafts) for (const c of new Set(d.blockers.map(findingClass))) byClass.set(c, (byClass.get(c) ?? 0) + 1);
    if (byClass.size === 0) dropped.push({ kind: "first_draft_findings", what: "first-draft blocker classes", reason: `none of ${drafts.length} first drafts had a blocker, so there is nothing to learn` });
    for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
      const hint = `${n} of ${drafts.length} first drafts (${ff.length} businesses) were rejected by the Auditor for the same reason: ${FINDING_HINT[cls] ?? FINDING_HINT.other_blocker}.`;
      patterns.push(pattern("first_draft_findings", cls, { drafts: drafts.length, affected: n }, ff.length, ff.map((c) => c.receipt), hint));
    }
  }

  // content_hooks: only kos-melati runs content, and its reach numbers are simulated.
  const ch = consenting("content_hooks").filter((c) => (c.s.hooks?.length ?? 0) > 0);
  if (ch.length < min) dropped.push({ kind: "content_hooks", what: "which content hook brings chats", reason: ch.length === 0 ? "no business supplied hook results" : `only ${ch.length} business has hook results (k < ${min}), so the aggregate would identify it` });
  else {
    const chats = new Map<string, { n: number; chats: number }>();
    for (const c of ch) for (const h of c.s.hooks!) chats.set(h.hook, { n: (chats.get(h.hook)?.n ?? 0) + 1, chats: (chats.get(h.hook)?.chats ?? 0) + h.chats });
    const best = [...chats].sort((a, b) => b[1].chats / b[1].n - a[1].chats / a[1].n)[0]!;
    patterns.push(pattern("content_hooks", "ranking", Object.fromEntries([...chats].map(([k, v]) => [`chats_${k}`, v.chats])), ch.length, ch.map((c) => c.receipt), `Across ${ch.length} businesses the content hook "${best[0]}" brought the most chats per piece (${Math.round((best[1].chats / best[1].n) * 10) / 10}).`));
  }

  // reminder_times: no data source. The crew records the date of a reminder, never its time of day or whether it was read.
  dropped.push({ kind: "reminder_times", what: "which reminder times perform", reason: "no data source: runs and the ledger record the day of a reminder, not its time or whether it was read" });
  return { patterns, withheld, dropped };
}

/** Terms that must never reach the shared datapack: the businesses' names, aliases and amounts. */
export function leakCheck(text: string, forbidden: string[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const f of forbidden) if (f.trim().length >= 3 && lower.includes(f.trim().toLowerCase())) found.push(f);
  if (/\bRp\s?\d|\bIDR\s?\d|\d[\d.,]{4,}/i.test(text)) found.push("(an amount)");
  if (/\b\d{9,}\b|@\w+\.\w+/.test(text)) found.push("(a phone, id or email)");
  return found;
}

/** Everything about a business that must not appear in a shared pattern. */
export function forbiddenTerms(sources: BusinessSource[], extra: string[] = []): string[] {
  const out = new Set<string>(extra);
  for (const s of sources) {
    out.add(s.ws.workspace);
    for (const [real, alias] of Object.entries(s.ws.pseudonyms.entries())) {
      out.add(real);
      out.add(alias);
    }
  }
  return [...out];
}

export interface Published {
  id: string;
  receipt?: string;
  skipped?: "already_published";
}

/** Writes each pattern as promoted memory in the shared datapack, with a provenance receipt of counts and consent hashes only. */
export async function publish(sharedWs: MekoWorkspace, patterns: Pattern[], opts: { forbidden?: string[]; minBusinesses?: number } = {}): Promise<Published[]> {
  const min = opts.minBusinesses ?? 2;
  const out: Published[] = [];
  const agent = await sharedWs.run(`run_gotong_publish_${Date.now().toString(36)}`).agent("auditor", "Gotong Royong: pola bersama");
  for (const p of patterns) {
    if (p.businesses < min) throw new Error(`pattern ${p.id} rests on ${p.businesses} business(es); the floor is ${min}`);
    const leaks = leakCheck(p.text, opts.forbidden ?? []);
    if (leaks.length) throw new Error(`pattern ${p.id} would leak: ${leaks.join(", ")}`);
    if (sharedWs.decisions({ subject: p.id, action_class: "gotong" }).some((d) => d.action === "publish_pattern")) {
      out.push({ id: p.id, skipped: "already_published" });
      continue;
    }
    const mem = await agent.remember(p.text, { kind: "gotong_pattern", pattern_id: p.id, pattern_kind: p.kind, businesses: p.businesses }, { promote: true });
    const d = await agent.decide({
      input: `publish pattern ${p.id}`,
      output: { pattern_id: p.id, kind: p.kind, businesses: p.businesses, counts: p.counts, consent_receipts: p.consents, memory_id: mem.id, promoted: mem.promoted },
      reasoning: `Code published it: every contributing owner has a live consent_share_patterns receipt, ${p.businesses} >= ${min} businesses, and the leak check found no name or amount. Only counts and kinds are stored.`,
      action: "publish_pattern",
      action_class: "gotong",
      subject: p.id,
    });
    out.push({ id: p.id, receipt: d.receipt_hash });
  }
  return out;
}

/** A search query from the SOP's own words (letters only, no digits), plus the pool's tag words. */
export function queryFromSop(sopText: string): string {
  const words = [...new Set(sopText.toLowerCase().match(/\p{L}{4,12}/gu) ?? [])].slice(0, 20);
  return `gotong royong first drafts Auditor Builder ${words.join(" ")}`;
}

export interface SharedHints {
  hints: string[];
  /** Receipt of the read, in the shared workspace's ledger. */
  receipt: string;
  memory_ids: string[];
}

/** The Builder's read of the shared datapack, before it drafts: `context_search`, then one receipted decision. */
export async function readForNewBusiness(sharedWs: MekoWorkspace, sopText: string, opts: { limit?: number } = {}): Promise<SharedHints> {
  const agent = await sharedWs.run(`run_gotong_read_${Date.now().toString(36)}`).agent("builder", "Gotong Royong: baca pola");
  const lookup = await agent.search(queryFromSop(sopText), opts.limit ?? 8);
  const hits = lookup.memory.filter((m) => m.text.startsWith(TAG));
  const hints = [...new Set(hits.map((m) => m.text.slice(TAG.length).trim().slice(0, 400)))].slice(0, 5);
  const d = await agent.decide({
    input: "read shared patterns before drafting a new business's rulebook",
    output: { hints: hints.length, memory_ids: hits.map((m) => m.id) },
    reasoning: "Code read the pool and passes the hits to the Builder as advice; the SOP stays the only source of rules.",
    action: "read_shared_hints",
    action_class: "gotong",
  });
  return { hints, receipt: d.receipt_hash, memory_ids: hits.map((m) => m.id) };
}
