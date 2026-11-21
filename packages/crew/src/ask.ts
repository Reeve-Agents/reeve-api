// "Tanya usaha": a read-only agent. It searches Meko and the receipt ledger and explains decisions
// in plain Indonesian with a link to the proof. It has no connector and no rail: it never acts.
import type { DecisionBody, LedgerEntry } from "@reeve/receipts";
import type { MekoMessage, MekoWorkspace } from "@reeve/meko";

export interface AskAnswer {
  kind: "why_fee" | "why_hold" | "who_late" | "unknown";
  text: string;
  proofs: { receipt: string; url: string }[];
  receipt: string;
}

export interface Asker {
  role: "tenant" | "staff" | "owner";
  /** The tenant's pseudonymous id, for "kenapa saya didenda?". */
  subject?: string;
}

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

export function askKind(q: string): AskAnswer["kind"] {
  if (/kenapa .*(didenda|kena denda|denda)/i.test(q)) return "why_fee";
  if (/kenapa .*(boleh telat|tidak didenda|nggak didenda|ditahan)/i.test(q)) return "why_hold";
  if (/siapa .*(sering )?telat/i.test(q)) return "who_late";
  return "unknown";
}

export class AskBusiness {
  constructor(
    readonly ws: MekoWorkspace,
    readonly proofUrl: (receipt: string) => string = (r) => `/?view=explain&receipt=${r}`,
  ) {}

  private async message(d: LedgerEntry & DecisionBody): Promise<MekoMessage | undefined> {
    const conv = await this.ws.conversation(d.agent, d.conversation_id);
    return conv.messages.find((m) => m.metadata?.reeve_receipt === d.entry_hash);
  }

  private async latest(filter: (d: LedgerEntry & DecisionBody) => boolean, inputHas?: string): Promise<{ d: LedgerEntry & DecisionBody; m: MekoMessage } | null> {
    for (const d of this.ws.decisions().filter(filter).reverse()) {
      const m = await this.message(d);
      if (m && (!inputHas || m.input.includes(inputHas))) return { d, m };
    }
    return null;
  }

  async ask(question: string, who: Asker): Promise<AskAnswer> {
    const kind = askKind(question);
    const t = await this.ws.run(`run_ask_${Date.now().toString(36)}`).agent("ask", `Tanya: ${who.role}`);
    await t.search(question);
    let text = "Saya hanya bisa menjelaskan keputusan yang tercatat. Belum ada keputusan yang cocok dengan pertanyaan ini.";
    const proofs: AskAnswer["proofs"] = [];
    const room = question.match(/kamar\s+(\d+)/i)?.[1];
    if (kind === "why_fee") {
      const hit = await this.latest((d) => d.action === "charge_fee" && (!who.subject || d.subject === who.subject), room ? `kamar ${room}:` : undefined);
      if (hit) {
        const out = JSON.parse(hit.m.output) as { amount_idr?: number };
        const late = hit.m.input.match(/telat (\d+) hari/)?.[1];
        const sop = hit.m.reasoning?.match(/\("([^"]+)"\)/)?.[1] ?? "aturan denda yang disetujui pemilik";
        text = `Denda ${rp(out.amount_idr ?? 0)} karena tagihan terlambat ${late ?? "?"} hari. Aturannya dari SOP: "${sop}". Sebelum menagih, Reeve sudah memeriksa apakah pemilik memberi izin khusus untuk kamar Anda, dan tidak ada. Kalau ada keberatan, balas pesan ini dan pemilik akan membacanya.`;
        proofs.push({ receipt: hit.d.entry_hash, url: this.proofUrl(hit.d.entry_hash) });
      }
    } else if (kind === "why_hold") {
      const hit = await this.latest((d) => d.action === "hold" && (!who.subject || d.subject === who.subject), room ? `kamar ${room}:` : undefined);
      if (hit) {
        const exc = hit.m.reasoning?.match(/\("([^"]+)"\)/)?.[1];
        text = `Kamar ${room ?? hit.d.subject} tidak didenda karena ada izin dari pemilik${exc ? `: "${exc}"` : ""}. Reeve menemukan izin itu di catatan bersama sebelum memutuskan, jadi dendanya ditahan.`;
        proofs.push({ receipt: hit.d.entry_hash, url: this.proofUrl(hit.d.entry_hash) });
      }
    } else if (kind === "who_late") {
      if (who.role === "tenant") text = "Maaf, informasi penghuni lain tidak bisa dibagikan.";
      else {
        const counts = new Map<string, number>();
        for (const d of this.ws.decisions({ action_class: "late_fee" }).concat(this.ws.decisions({ action_class: "reminder" })))
          if (d.subject) counts.set(d.subject, (counts.get(d.subject) ?? 0) + 1);
        const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
        text = top.length ? `Yang paling sering telat: ${top.map(([s, n]) => `${s} (${n} catatan)`).join(", ")}. Nama asli ada di data Anda, tidak dikirim ke AI.` : "Belum ada catatan keterlambatan.";
        for (const [s] of top.slice(0, 3)) {
          const d = this.ws.decisions({ subject: s }).at(-1);
          if (d) proofs.push({ receipt: d.entry_hash, url: this.proofUrl(d.entry_hash) });
        }
      }
    }
    if (proofs.length) text += `\nLihat bukti: ${proofs.map((p) => p.url).join(" ")}`;
    const d = await t.decide({
      input: `${who.role}${who.subject ? ` ${who.subject}` : ""}: ${question}`,
      output: { kind, answer: text, proofs: proofs.map((p) => p.receipt) },
      reasoning: `Read-only answer of kind ${kind}, built from ${proofs.length} recorded decision(s); this agent has no tools that act.`,
      action: "explain",
      action_class: "ask",
      subject: who.subject,
    });
    return { kind, text, proofs, receipt: d.receipt_hash };
  }
}
