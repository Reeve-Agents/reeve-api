// Earned autonomy, per action class: ask -> ask_if_unusual -> auto_digest -> auto. A class moves up
// only with the owner's consent and only on evidence from receipts (clean runs, no override, no
// complaint). Any override, complaint or undo moves it down at once. Every change is a traced turn.
import type { AgentTrace, MekoWorkspace } from "@reeve/meko";
import type { PasskeyProof } from "./crew";

export const LEVELS = ["ask", "ask_if_unusual", "auto_digest", "auto"] as const;
export type Level = (typeof LEVELS)[number];

export interface ClassPolicy {
  /** Clean receipts needed before Reeve may ask the owner to move up one level. */
  promote_after: number;
  max_level: Level;
  label: string;
}

/** Fines, refunds, new exceptions and accepting a tenant stay manual until they have their own record. */
export const DEFAULT_POLICIES: Record<string, ClassPolicy> = {
  reminder: { promote_after: 20, max_level: "auto", label: "Pengingat bayar" },
  cs_reply: { promote_after: 20, max_level: "auto", label: "Balasan calon penghuni" },
  book_viewing: { promote_after: 10, max_level: "auto", label: "Jadwal survei" },
  deposit_bill: { promote_after: 10, max_level: "auto_digest", label: "Tagihan deposit" },
  listing_post: { promote_after: 15, max_level: "auto_digest", label: "Iklan kamar" },
  content_publish: { promote_after: 15, max_level: "auto_digest", label: "Konten harian" },
  late_fee: { promote_after: Number.POSITIVE_INFINITY, max_level: "ask", label: "Denda telat" },
  refund: { promote_after: Number.POSITIVE_INFINITY, max_level: "ask", label: "Refund" },
  accept_tenant: { promote_after: Number.POSITIVE_INFINITY, max_level: "ask", label: "Terima penghuni" },
};

export const UNDO_WINDOW_MS = 10 * 60_000;

export interface LadderState {
  levels: Record<string, { level: Level; since_seq: number }>;
}

/** Decisions that count as a clean run of their class. */
const CLEAN = new Set(["reply", "book_viewing", "deposit_bill", "publish", "remind", "auto_run"]);
const BAD = new Set(["override", "complaint", "undo"]);

export class Ladder {
  constructor(
    readonly ws: MekoWorkspace,
    readonly state: LadderState = { levels: {} },
    readonly policies: Record<string, ClassPolicy> = DEFAULT_POLICIES,
  ) {}

  level(cls: string): Level {
    return this.state.levels[cls]?.level ?? "ask";
  }

  /** What the Operator may do now for this class. Unusual cases always ask below "auto". */
  gate = (cls: string, unusual: boolean): "auto" | "auto_digest" | "ask" => {
    const l = this.level(cls);
    if (l === "ask") return "ask";
    if (unusual && l !== "auto") return "ask";
    if (l === "ask_if_unusual") return "auto";
    return l === "auto_digest" ? "auto_digest" : "auto";
  };

  /** Clean receipts of this class since its level last changed, read from the ledger. */
  evidence(cls: string): { clean: number; bad: number; receipts: string[] } {
    const since = this.state.levels[cls]?.since_seq ?? -1;
    const ds = this.ws.decisions({ action_class: cls }).filter((d) => d.seq > since);
    const clean = ds.filter((d) => CLEAN.has(d.action ?? ""));
    return { clean: clean.length, bad: ds.filter((d) => BAD.has(d.action ?? "")).length, receipts: clean.map((d) => d.entry_hash) };
  }

  /** The question Reeve may put to the owner, if the receipts earn it. */
  proposal(cls: string): { cls: string; from: Level; to: Level; question: string; clean: number } | null {
    const p = this.policies[cls];
    if (!p) return null;
    const from = this.level(cls);
    const i = LEVELS.indexOf(from);
    if (i >= LEVELS.indexOf(p.max_level)) return null;
    const ev = this.evidence(cls);
    if (ev.bad > 0 || ev.clean < p.promote_after) return null;
    const to = LEVELS[i + 1]!;
    const question =
      to === "ask_if_unusual"
        ? `${p.label} sudah ${ev.clean} kali jalan tanpa masalah. Boleh jalan sendiri mulai sekarang, kecuali yang tidak biasa?`
        : to === "auto_digest"
          ? `${p.label} boleh jalan sendiri dengan ringkasan harian?`
          : `${p.label} boleh jalan sepenuhnya sendiri?`;
    return { cls, from, to, question, clean: ev.clean };
  }

  private async trace(title: string): Promise<AgentTrace> {
    return this.ws.run(`run_ladder_${Date.now().toString(36)}`).agent("owner", title);
  }

  /** Owner says yes with a passkey; the level moves up one step and the evidence is in the receipt. */
  async promote(cls: string, passkey: PasskeyProof): Promise<Level> {
    const prop = this.proposal(cls);
    if (!prop) throw new Error(`${cls} has not earned a higher level`);
    const t = await this.trace(`Otonomi: ${this.policies[cls]!.label}`);
    const d = await t.decide({
      input: prop.question,
      output: { from: prop.from, to: prop.to, clean_receipts: prop.clean, method: passkey.method },
      reasoning: `${prop.clean} clean receipts of ${cls} since the last change, no override or complaint; the owner agreed with a ${passkey.method === "passkey" ? "passkey" : "demo passkey (offline seed)"}.`,
      action: "autonomy_promote",
      action_class: cls,
    });
    await t.remember(`${this.policies[cls]!.label} naik ke level ${prop.to} atas persetujuan pemilik.`, { kind: "autonomy_level", cls, level: prop.to }, { promote: true });
    this.state.levels[cls] = { level: prop.to, since_seq: d.seq };
    return prop.to;
  }

  /** Override, complaint or undo: down one level at once, no consent needed. */
  async demote(cls: string, why: "override" | "complaint" | "undo", detail: string): Promise<Level> {
    const from = this.level(cls);
    const to = LEVELS[Math.max(0, LEVELS.indexOf(from) - 1)]!;
    const t = await this.trace(`Otonomi: ${this.policies[cls]?.label ?? cls}`);
    const d = await t.decide({
      input: detail,
      output: { from, to, why },
      reasoning: `An ${why} on ${cls} (${detail}) drops the level from ${from} to ${to} automatically; it climbs back only on new clean receipts and the owner's consent.`,
      action: why,
      action_class: cls,
    });
    await t.remember(`${this.policies[cls]?.label ?? cls} turun ke ${to}: ${why} (${detail}).`, { kind: "autonomy_level", cls, level: to, why }, { promote: true });
    this.state.levels[cls] = { level: to, since_seq: d.seq };
    return to;
  }

  /** 10-minute undo on anything that ran by itself. */
  async undo(receiptHash: string, now: Date = new Date()): Promise<Level> {
    const d = this.ws.decisions().find((x) => x.entry_hash === receiptHash);
    if (!d?.action_class) throw new Error("no such automatic decision");
    if (now.getTime() - Date.parse(d.at) > UNDO_WINDOW_MS) throw new Error("undo window (10 menit) has passed");
    return this.demote(d.action_class, "undo", `undo ${receiptHash.slice(0, 12)}`);
  }

  /** One daily summary instead of a stream of notifications. */
  digest(date: string): string[] {
    return this.ws
      .decisions()
      .filter((d) => d.at.slice(0, 10) === date && d.action_class && this.level(d.action_class) !== "ask" && CLEAN.has(d.action ?? ""))
      .map((d) => `${d.at.slice(11, 16)} ${this.policies[d.action_class!]?.label ?? d.action_class}: ${d.action}${d.subject ? ` (${d.subject})` : ""}`);
  }
}
