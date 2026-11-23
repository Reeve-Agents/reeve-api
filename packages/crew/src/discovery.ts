// SOP Discovery: the owner has no written SOP, so Reeve reads what already happened (a WhatsApp
// chat export and the payments sheet) and proposes one. Names are pseudonymised first; the miner
// is code, so no LLM sees the history. The Builder proposes rulebook cards with a confidence and a
// cited line, the Auditor replays the history against them, the owner taps Ya/Tidak on each, and
// every step is a Meko trace bound to a receipt. Fewer than 3 confirmed rules: "mode belajar".
import { createHash, randomUUID } from "node:crypto";
import type { RuleCard, Rulebook } from "@reeve/core";
import type { MekoRun, MekoWorkspace, Pseudonymiser } from "@reeve/meko";

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────

export interface ChatLine {
  /** 1-based line number in the export, cited as `chat:<line>`. */
  line: number;
  /** "YYYY-MM-DD HH:MM" */
  at: string;
  from: string;
  text: string;
}

const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2})[.:](\d{2})(?:[.:]\d{2})? ?(?:[AP]M)? - ([^:]{1,60}): (.*)$/;
const IOS = /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2})[.:](\d{2})(?:[.:]\d{2})?(?: ?[AP]M)?\] ([^:]{1,60}): (.*)$/;

function ymd(d: string, m: string, y: string): string {
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** WhatsApp "Ekspor chat" (.txt), Android or iOS layout, Indonesian dates (day first). */
export function parseChatExport(txt: string): ChatLine[] {
  const out: ChatLine[] = [];
  txt.split(/\r?\n/).forEach((raw, i) => {
    const m = raw.match(ANDROID) ?? raw.match(IOS);
    if (m) {
      out.push({ line: i + 1, at: `${ymd(m[1]!, m[2]!, m[3]!)} ${m[4]!.padStart(2, "0")}:${m[5]}`, from: m[6]!.trim(), text: m[7]!.trim() });
    } else if (out.length && raw.trim()) {
      out[out.length - 1]!.text += `\n${raw.trim()}`; // a message that spans lines
    }
  });
  return out.filter((l) => !/^<(media|media tidak disertakan|media omitted)>$/i.test(l.text));
}

export interface PaymentRow {
  /** Row number in the sheet (header = 1), cited as `bayar:<line>`. */
  line: number;
  date: string;
  room: string;
  name: string;
  kind: "sewa" | "denda" | "refund" | "deposit" | "lain";
  amount: number;
  note: string;
  since?: string;
}

const HEADERS: Record<keyof Omit<PaymentRow, "line">, string[]> = {
  date: ["tanggal", "tgl", "date", "tanggalbayar"],
  room: ["kamar", "nokamar", "room", "unit"],
  name: ["nama", "penghuni", "name", "namapenghuni"],
  kind: ["jenis", "tipe", "kind", "type", "keterangan"],
  amount: ["jumlah", "nominal", "amount", "total", "jumlahrp"],
  note: ["catatan", "note", "notes", "memo"],
  since: ["mulaisewa", "mulai", "tanggalmasuk", "masuk", "since"],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function toDate(v: unknown): string {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10); // Excel serial
  const s = String(v ?? "").trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  return dm ? ymd(dm[1]!, dm[2]!, dm[3]!) : "";
}

function toAmount(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  const s = String(v ?? "").replace(/rp/i, "").trim();
  const neg = s.startsWith("-") || /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[^\d]/g, "") || 0);
  return neg ? -n : n;
}

function toKind(v: unknown): PaymentRow["kind"] {
  const s = String(v ?? "").toLowerCase();
  if (/denda|late/.test(s)) return "denda";
  if (/refund|kembali/.test(s)) return "refund";
  if (/deposit|jaminan/.test(s)) return "deposit";
  if (/sewa|rent|bulanan/.test(s)) return "sewa";
  return "lain";
}

/** Rows from a CSV or from an Excel sheet read in the browser (SheetJS `sheet_to_json`). */
export function paymentsFromRows(rows: Record<string, unknown>[]): PaymentRow[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]!);
  const pick = (key: keyof typeof HEADERS) => cols.find((c) => HEADERS[key].includes(norm(c)));
  const col = Object.fromEntries((Object.keys(HEADERS) as (keyof typeof HEADERS)[]).map((k) => [k, pick(k)])) as Record<keyof typeof HEADERS, string | undefined>;
  const out: PaymentRow[] = [];
  rows.forEach((r, i) => {
    const date = toDate(col.date ? r[col.date] : "");
    const room = String((col.room ? r[col.room] : "") ?? "").replace(/^kamar\s*/i, "").trim();
    if (!date || !room) return;
    out.push({
      line: i + 2,
      date,
      room,
      name: String((col.name ? r[col.name] : "") ?? "").trim(),
      kind: toKind(col.kind ? r[col.kind] : "sewa"),
      amount: toAmount(col.amount ? r[col.amount] : 0),
      note: String((col.note ? r[col.note] : "") ?? "").trim(),
      since: col.since ? toDate(r[col.since]) || undefined : undefined,
    });
  });
  return out;
}

export function parsePaymentsCsv(csv: string): PaymentRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0]?.split(";").length ?? 0) > (lines[0]?.split(",").length ?? 0) ? ";" : ",";
  const cells = (l: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === sep && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = cells(lines[0] ?? "");
  return paymentsFromRows(lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i] ?? `c${i}`, v]))));
}

// ── Pseudonymised history ───────────────────────────────────────────────────────────────────────

export type EventKind = "invoice" | "reminder" | "fee" | "notice" | "exception" | "overpay" | "fee_cap" | "refund_rule" | "target" | "other";

export interface HistoryEvent extends ChatLine {
  kind: EventKind;
  room?: string;
  /** Sender's alias: "Pemilik", "Penjaga", or a tenant's "K03". */
  role: string;
}

export interface History {
  business: string;
  rent: number;
  tenants: { subject: string; room: string; since?: string }[];
  events: HistoryEvent[];
  payments: (PaymentRow & { subject: string })[];
  months: string[];
}

export const subjectOf = (room: string) => `K${room.padStart(2, "0")}`;
const HONORIFIC = /^(bu|ibu|pak|bapak|mas|mbak|kak|bang|cik|ko|ci)\s+/i;

function classify(text: string): { kind: EventKind; room?: string } {
  const t = text.toLowerCase();
  const room = t.match(/kamar\s*(\d{1,3})/)?.[1];
  if (/kamar\s*\d+[^.]*boleh telat/.test(t)) return { kind: "exception", room };
  if (/denda/.test(t) && /(paling banyak|maksimal|maks\.?|tidak boleh lebih)/.test(t) && /\d+\s?%/.test(t)) return { kind: "fee_cap" };
  if (/refund/.test(t) && /(di atas|lebih dari)/.test(t) && /(tanya saya|izin saya|persetujuan|setujui)/.test(t)) return { kind: "refund_rule" };
  if (/target/.test(t) && /\d+\s*(jt|juta)/.test(t)) return { kind: "target" };
  if (/kelebihan/.test(t) && /saldo/.test(t)) return { kind: "overpay", room };
  if (room && /(surat peringatan|kosongkan kamar)/.test(t)) return { kind: "notice", room };
  if (room && /denda/.test(t) && /(kena|dikenakan)/.test(t)) return { kind: "fee", room };
  if (room && /(pengingat|jangan lupa|belum masuk|belum bayar|mengingatkan)/.test(t)) return { kind: "reminder", room };
  if (!room && /tagihan/.test(t) && /(bisa dibayar|bulan)/.test(t)) return { kind: "invoice" };
  return { kind: "other", room };
}

function mode<T>(xs: T[]): T | undefined {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Pseudonymises the history in place of the raw files: names never go further than this. */
export function buildHistory(chat: ChatLine[], payments: PaymentRow[], ps: Pseudonymiser, opts: { business?: string } = {}): History {
  const tenants = new Map<string, { subject: string; room: string; since?: string }>();
  for (const p of payments) {
    const subject = subjectOf(p.room);
    if (!tenants.has(p.room)) tenants.set(p.room, { subject, room: p.room, since: p.since });
    if (p.name) {
      ps.set(p.name, subject);
      const first = p.name.split(/\s+/)[0];
      if (first && first.length > 2) ps.set(first, subject);
    }
  }
  // The owner sends the monthly bill; everyone else who is not a tenant is staff.
  const tenantNames = new Set(payments.map((p) => p.name.toLowerCase()));
  const invoices = new Map<string, number>();
  for (const l of chat) if (classify(l.text).kind === "invoice") invoices.set(l.from, (invoices.get(l.from) ?? 0) + 1);
  const counts = new Map<string, number>();
  for (const l of chat) if (!tenantNames.has(l.from.toLowerCase())) counts.set(l.from, (counts.get(l.from) ?? 0) + 1);
  const owner = [...invoices].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  let staff = 0;
  for (const name of new Set(chat.map((l) => l.from))) {
    if (tenantNames.has(name.toLowerCase())) continue;
    const alias = name === owner ? "Pemilik" : staff++ ? `Penjaga ${staff}` : "Penjaga";
    ps.set(name, alias);
    const bare = name.replace(HONORIFIC, "");
    if (bare !== name) ps.set(name.split(/\s+/).slice(0, 2).join(" "), alias); // "Bu Ratna"
    const first = bare.split(/\s+/)[0];
    if (first && first.length > 2) ps.set(first, alias);
  }
  const events = chat.map((l) => {
    const text = ps.redact(l.text);
    return { ...l, from: ps.redact(l.from), role: ps.redact(l.from), text, ...classify(text) };
  });
  const sewa = payments.filter((p) => p.kind === "sewa" && p.amount > 0).map((p) => p.amount);
  const months = [...new Set([...events.filter((e) => e.kind === "invoice").map((e) => e.at.slice(0, 7)), ...payments.filter((p) => p.kind === "sewa").map((p) => p.date.slice(0, 7))])].sort();
  return {
    business: opts.business ?? "Kos",
    rent: mode(sewa) ?? 0,
    tenants: [...tenants.values()].sort((a, b) => Number(a.room) - Number(b.room)),
    events,
    payments: payments.map((p) => ({ ...p, name: subjectOf(p.room), subject: subjectOf(p.room), note: ps.redact(p.note) })),
    months,
  };
}

// ── Mining ──────────────────────────────────────────────────────────────────────────────────────

export interface Cite {
  /** `chat:<line>` or `bayar:<row>` */
  ref: string;
  /** Pseudonymised. */
  text: string;
}

export interface Candidate {
  id: string;
  kind: "card" | "exception";
  card?: RuleCard;
  exception?: { room: string; subject: string; days: number; month: string; text: string };
  /** The rule as a sentence the owner can say yes or no to. */
  title: string;
  confidence: number;
  support: number;
  counter: number;
  evidence: string;
  cites: Cite[];
}

const cite = (e: HistoryEvent): Cite => ({ ref: `chat:${e.line}`, text: e.text });
const citeRow = (p: PaymentRow): Cite => ({ ref: `bayar:${p.line}`, text: `${p.date} kamar ${p.room} ${p.kind} Rp${p.amount.toLocaleString("id-ID")}${p.note ? ` (${p.note})` : ""}` });
/** Laplace smoothing: 3 of 3 months is 0.8, not 1.0; one sentence said once is 0.67. */
const conf = (s: number, c: number) => Math.round(((s + 1) / (s + c + 2)) * 100) / 100;
const day = (at: string) => Number(at.slice(8, 10));
const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

function monthsBetween(since: string | undefined, at: string): number {
  if (!since) return 0;
  const [y1, m1, d1] = since.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = at.split("-").map(Number) as [number, number, number];
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

/** One bill per tenant per month, with what the owner actually did. */
export interface DiscoveryBill {
  month: string;
  room: string;
  subject: string;
  due: string;
  /** Days after due when paid (Infinity: not paid in the sheet). */
  late: number;
  tenure: number;
  reminders: { offset: number; e: HistoryEvent }[];
  fee?: { offset: number; amount: number; row?: PaymentRow; e?: HistoryEvent };
  notice?: { offset: number; e: HistoryEvent };
  paid_row?: PaymentRow;
}

export function billsOf(h: History, dueDay: number): DiscoveryBill[] {
  const out: DiscoveryBill[] = [];
  for (const month of h.months)
    for (const t of h.tenants) {
      const due = `${month}-${String(dueDay).padStart(2, "0")}`;
      const inMonth = (d: string) => d.slice(0, 7) === month;
      const paid = h.payments.find((p) => p.room === t.room && p.kind === "sewa" && inMonth(p.date));
      const ev = h.events.filter((e) => e.room === t.room && inMonth(e.at) && e.role === "Pemilik");
      const feeRow = h.payments.find((p) => p.room === t.room && p.kind === "denda" && inMonth(p.date));
      const feeEv = ev.find((e) => e.kind === "fee");
      const noticeEv = ev.find((e) => e.kind === "notice");
      if (!paid && !ev.length && !feeRow) continue;
      out.push({
        month,
        room: t.room,
        subject: t.subject,
        due,
        late: paid ? Math.max(0, day(paid.date) - dueDay) : Number.POSITIVE_INFINITY,
        tenure: monthsBetween(t.since, due),
        reminders: ev.filter((e) => e.kind === "reminder").map((e) => ({ offset: day(e.at) - dueDay, e })),
        fee: feeRow || feeEv ? { offset: day((feeRow?.date ?? feeEv!.at).slice(0, 10)) - dueDay, amount: feeRow?.amount ?? 0, row: feeRow, e: feeEv } : undefined,
        notice: noticeEv ? { offset: day(noticeEv.at) - dueDay, e: noticeEv } : undefined,
        paid_row: paid,
      });
    }
  return out;
}

export function mineCandidates(h: History): Candidate[] {
  const out: Candidate[] = [];
  const owner = h.events.filter((e) => e.role === "Pemilik");
  const byKind = (k: EventKind) => owner.filter((e) => e.kind === k);

  // R1: the day the monthly bill goes out.
  const inv = byKind("invoice");
  const dueDay = mode(inv.map((e) => day(e.at))) ?? 1;
  if (inv.length) {
    const s = inv.filter((e) => day(e.at) === dueDay);
    out.push({ id: "R1", kind: "card", card: { id: "R1", kind: "rule", type: "invoice_schedule", title: `Kirim tagihan sewa ke semua penghuni setiap tanggal ${dueDay}`, source_quote: s[0]!.text, day_of_month: dueDay }, title: `Tagihan sewa dikirim ke semua penghuni setiap tanggal ${dueDay}.`, support: s.length, counter: inv.length - s.length, confidence: conf(s.length, inv.length - s.length), evidence: `${s.length} dari ${inv.length} bulan`, cites: s.slice(0, 2).map(cite) });
  }
  const bills = billsOf(h, dueDay);

  // R2: reminder offsets that repeat.
  const offs = bills.flatMap((b) => b.reminders.map((r) => r.offset));
  const days = [...new Set(offs)].filter((d) => offs.filter((x) => x === d).length >= 2 && d > 0).sort((a, b) => a - b);
  if (days.length) {
    let s = 0;
    let c = 0;
    const misses: DiscoveryBill[] = [];
    for (const b of bills)
      for (const d of days)
        if (b.late > d) {
          if (b.reminders.some((r) => r.offset === d)) s++;
          else {
            c++;
            misses.push(b);
          }
        }
    const r = bills.flatMap((b) => b.reminders).filter((x) => days.includes(x.offset));
    out.push({ id: "R2", kind: "card", card: { id: "R2", kind: "rule", type: "reminder", title: `Kirim pengingat ${days.map((d) => `H+${d}`).join(" dan ")} jika belum lunas`, source_quote: r[0]!.e.text, days_after_due: days }, title: `Kalau belum bayar, kirim pengingat ${days.map((d) => `H+${d}`).join(" dan ")}.`, support: s, counter: c, confidence: conf(s, c), evidence: `${s} pengingat tepat waktu, ${c} terlewat`, cites: r.slice(0, 2).map((x) => cite(x.e)) });
  }

  // R3: late fee (day, percent of rent) and a longer grace for long-staying tenants.
  // A bill the owner excused out loud ("kamar 3 boleh telat") says nothing about the fee rule.
  const excused = new Set(byKind("exception").map((e) => `${e.room}|${e.at.slice(0, 7)}`));
  const feeBills = bills.filter((b) => !excused.has(`${b.room}|${b.month}`));
  const fees = feeBills.filter((b) => b.fee);
  if (fees.length && h.rent) {
    const pct = mode(fees.map((b) => Math.round((b.fee!.amount / h.rent) * 100)).filter((x) => x > 0)) ?? 5;
    const base = mode(fees.map((b) => b.fee!.offset)) ?? 7;
    // Bills late past the base day: did long tenure get extra days?
    const lateBills = feeBills.filter((b) => b.late > base);
    const graced = lateBills.filter((b) => !b.fee || b.fee.offset > base);
    const plain = lateBills.filter((b) => b.fee && b.fee.offset <= base);
    const extraFees = graced.filter((b) => b.fee).map((b) => b.fee!.offset - base);
    const extra = mode(extraFees) ?? (graced.length ? Math.max(...graced.map((b) => b.late)) - base : 0);
    const minG = Math.min(...graced.map((b) => b.tenure));
    const maxP = Math.max(-1, ...plain.map((b) => b.tenure));
    const grace = graced.length >= 2 && extra > 0 && minG > maxP ? { min_months: Math.max(maxP + 1, Math.floor(minG / 6) * 6), extra_days: extra } : { min_months: 0, extra_days: 0 };
    let s = 0;
    let c = 0;
    const counters: DiscoveryBill[] = [];
    for (const b of feeBills) {
      const feeDay = base + (grace.extra_days && b.tenure >= grace.min_months ? grace.extra_days : 0);
      const want = b.late > feeDay;
      const ok = want ? b.fee?.offset === feeDay : !b.fee;
      if (want || b.fee) {
        if (ok) s++;
        else {
          c++;
          counters.push(b);
        }
      }
    }
    const said = owner.find((e) => e.kind === "fee");
    const graceText = grace.extra_days ? ` Penghuni yang sudah tinggal minimal ${grace.min_months} bulan dapat toleransi ${grace.extra_days} hari tambahan.` : "";
    out.push({
      id: "R3",
      kind: "card",
      card: { id: "R3", kind: "rule", type: "late_fee", title: `Denda ${pct}% dari sewa pada H+${base}, sekali per tagihan${grace.extra_days ? `; penghuni ≥${grace.min_months} bulan dapat +${grace.extra_days} hari` : ""}`, source_quote: said?.text ?? `denda ${pct}%`, days_after_due: base, percent: pct, basis: "rent", tenure_grace: grace },
      title: `Lewat H+${base} belum lunas kena denda ${pct}% dari sewa (${rp(Math.round((h.rent * pct) / 100))}), sekali per tagihan.${graceText}`,
      support: s,
      counter: c,
      confidence: conf(s, c),
      evidence: `${s} tagihan cocok, ${c} berbeda`,
      cites: [...fees.slice(0, 1).flatMap((b) => (b.fee!.e ? [cite(b.fee!.e)] : b.fee!.row ? [citeRow(b.fee!.row)] : [])), ...counters.slice(0, 1).flatMap((b) => (b.fee?.e ? [cite(b.fee.e)] : b.paid_row ? [citeRow(b.paid_row)] : []))],
    });
  }

  // R4: notice to leave.
  const notices = bills.filter((b) => b.notice);
  if (notices.length) {
    const d = mode(notices.map((b) => b.notice!.offset))!;
    const s = notices.filter((b) => b.notice!.offset === d).length;
    const c = bills.filter((b) => b.late > d && !b.notice).length + notices.length - s;
    out.push({ id: "R4", kind: "card", card: { id: "R4", kind: "rule", type: "notice", title: `Kirim surat peringatan keluar pada H+${d} jika belum lunas`, source_quote: notices[0]!.notice!.e.text, days_after_due: d }, title: `H+${d} masih belum lunas, kirim surat peringatan untuk keluar.`, support: s, counter: c, confidence: conf(s, c), evidence: `${s} kali, ${c} terlewat`, cites: notices.slice(0, 1).map((b) => cite(b.notice!.e)) });
  }

  // R5: overpayment becomes credit.
  const over = byKind("overpay");
  if (over.length) {
    const used = h.payments.filter((p) => /saldo/i.test(p.note));
    const s = over.length + used.length;
    out.push({ id: "R5", kind: "card", card: { id: "R5", kind: "rule", type: "overpayment", title: "Kelebihan bayar menjadi saldo untuk tagihan berikutnya", source_quote: over[0]!.text, policy: "credit_next_invoice" }, title: "Kalau ada yang bayar lebih, kelebihannya jadi saldo untuk tagihan bulan depan.", support: s, counter: 0, confidence: conf(s, 0), evidence: `${over.length} pesan, ${used.length} saldo dipakai`, cites: [cite(over[0]!), ...used.slice(0, 1).map(citeRow)] });
  }

  // R6: fee cap.
  const cap = byKind("fee_cap")[0];
  if (cap) {
    const pct = Number(cap.text.match(/(\d+)\s?%/)![1]);
    const over6 = bills.filter((b) => b.fee && h.rent && b.fee.amount > (h.rent * pct) / 100).length;
    out.push({ id: "R6", kind: "card", card: { id: "R6", kind: "constraint", type: "max_fee", title: `Total denda per tagihan maksimal ${pct}% dari sewa`, source_quote: cap.text, max_percent_of_rent: pct }, title: `Total denda per tagihan tidak boleh lebih dari ${pct}% harga sewa.`, support: 1, counter: over6, confidence: conf(1, over6), evidence: over6 ? `${over6} tagihan melewati batas` : "disebut 1 kali, tidak pernah dilanggar", cites: [cite(cap)] });
  }

  // R7: refunds above a limit need the owner.
  const ref = byKind("refund_rule")[0];
  if (ref) {
    const m = ref.text.toLowerCase().match(/(?:di atas|lebih dari)\s*(?:rp\.?\s?)?([\d.,]+)\s*(rb|ribu|k|jt|juta)?/);
    const n = Number((m?.[1] ?? "0").replace(/[.,]/g, ""));
    const limit = m?.[2] && /rb|ribu|k/.test(m[2]) ? n * 1000 : m?.[2] && /jt|juta/.test(m[2]) ? n * 1_000_000 : n;
    const small = h.payments.filter((p) => p.kind === "refund" && Math.abs(p.amount) <= limit);
    out.push({ id: "R7", kind: "card", card: { id: "R7", kind: "constraint", type: "approval_threshold", title: `Refund di atas ${rp(limit)} wajib persetujuan pemilik`, source_quote: ref.text, refund_above: limit }, title: `Refund di atas ${rp(limit)} harus disetujui pemilik dulu.`, support: 1 + small.length, counter: 0, confidence: conf(1 + small.length, 0), evidence: `disebut 1 kali; ${small.length} refund kecil jalan tanpa tanya`, cites: [cite(ref), ...small.slice(0, 1).map(citeRow)] });
  }

  // R8: monthly target, checked on the same day each month.
  const tg = byKind("target");
  if (tg.length) {
    const m = tg[0]!.text.toLowerCase().match(/(\d+[.,]?\d*)\s*(jt|juta)/)!;
    const target = Math.round(Number(m[1]!.replace(",", ".")) * 1_000_000);
    const alert = mode(tg.map((e) => day(e.at)))!;
    const s = tg.filter((e) => day(e.at) === alert).length;
    out.push({ id: "R8", kind: "card", card: { id: "R8", kind: "kpi", type: "revenue_target", title: `Target pemasukan ${rp(target)} per bulan, dicek tanggal ${alert}`, source_quote: tg[0]!.text, monthly_target: target, basis: "collected", alert_day: alert }, title: `Target pemasukan ${rp(target)} per bulan; cek tanggal ${alert}, kabari pemilik kalau belum tercapai.`, support: s, counter: tg.length - s, confidence: conf(s, tg.length - s), evidence: `${s} dari ${tg.length} bulan`, cites: tg.slice(0, 1).map(cite) });
  }

  // Owner exceptions: kept as shared memory, not as a rule card.
  byKind("exception").forEach((e, i) => {
    const days = Number(e.text.match(/telat (?:sampai |hingga )?(\d+) hari/i)?.[1] ?? 0);
    if (!e.room || !days) return;
    out.push({ id: `X${i + 1}`, kind: "exception", exception: { room: e.room, subject: subjectOf(e.room), days, month: e.at.slice(0, 7), text: `Kamar ${e.room} boleh telat sampai ${days} hari (${e.at.slice(0, 7)}).` }, title: `Pengecualian: kamar ${e.room} boleh telat sampai ${days} hari pada ${e.at.slice(0, 7)}, tanpa denda.`, support: 1, counter: 0, confidence: conf(1, 0), evidence: "disebut 1 kali oleh pemilik", cites: [cite(e)] });
  });
  return out;
}

// ── Replay ──────────────────────────────────────────────────────────────────────────────────────

export interface ReplayDiff {
  month: string;
  subject: string;
  room: string;
  what: "reminder" | "fee" | "notice";
  rule: string;
  owner: string;
  cites: Cite[];
}

export interface Replay {
  bills: number;
  agree: number;
  rate: number;
  diffs: ReplayDiff[];
}

/** What the proposed cards would have done on each past bill, next to what the owner did. */
export function replayHistory(h: History, cands: Candidate[]): Replay {
  const card = <T extends RuleCard["type"]>(t: T) => cands.find((c) => c.card?.type === t)?.card as Extract<RuleCard, { type: T }> | undefined;
  const r1 = card("invoice_schedule");
  const r2 = card("reminder");
  const r3 = card("late_fee");
  const r4 = card("notice");
  const exc = cands.filter((c) => c.exception).map((c) => c.exception!);
  const bills = billsOf(h, r1?.day_of_month ?? 1);
  const diffs: ReplayDiff[] = [];
  let agree = 0;
  for (const b of bills) {
    const before = diffs.length;
    const late = Number.isFinite(b.late) ? `dibayar H+${b.late}` : "belum dibayar";
    const paidCite = b.paid_row ? [citeRow(b.paid_row)] : [];
    for (const d of r2?.days_after_due ?? []) {
      const want = b.late > d;
      const did = b.reminders.find((r) => r.offset === d);
      if (want && !did) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "reminder", rule: `kirim pengingat H+${d}`, owner: `tidak ada pengingat (${late})`, cites: paidCite });
    }
    if (r3) {
      const ex = exc.find((x) => x.room === b.room && x.month === b.month);
      const feeDay = r3.days_after_due + (r3.tenure_grace?.extra_days && b.tenure >= r3.tenure_grace.min_months ? r3.tenure_grace.extra_days : 0);
      const held = ex && b.late <= ex.days;
      const want = b.late > feeDay && !held;
      const amount = rp(Math.round((h.rent * r3.percent) / 100));
      const feeCite = b.fee?.e ? [cite(b.fee.e)] : b.fee?.row ? [citeRow(b.fee.row)] : [];
      if (want && !b.fee) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "fee", rule: `denda ${amount} di H+${feeDay}`, owner: `tidak menagih denda (${late})`, cites: [...paidCite, ...h.events.filter((e) => e.room === b.room && e.at.startsWith(b.month) && e.kind === "exception").map(cite)] });
      else if (!want && b.fee) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "fee", rule: held ? `tahan denda (pengecualian sampai H+${ex!.days})` : `tidak ada denda (${late}, batas H+${feeDay})`, owner: `menagih denda di H+${b.fee.offset}`, cites: feeCite });
      else if (want && b.fee && b.fee.offset !== feeDay) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "fee", rule: `denda ${amount} di H+${feeDay}`, owner: `menagih ${b.fee.offset < feeDay ? "lebih awal" : "lebih lambat"}, di H+${b.fee.offset}`, cites: feeCite });
    }
    if (r4) {
      const want = b.late > r4.days_after_due;
      if (want && !b.notice) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "notice", rule: `surat peringatan H+${r4.days_after_due}`, owner: `tidak dikirim (${late})`, cites: paidCite });
      if (!want && b.notice) diffs.push({ month: b.month, subject: b.subject, room: b.room, what: "notice", rule: "tidak ada surat peringatan", owner: `dikirim di H+${b.notice.offset}`, cites: [cite(b.notice.e)] });
    }
    if (diffs.length === before) agree++;
  }
  return { bills: bills.length, agree, rate: bills.length ? Math.round((agree / bills.length) * 100) / 100 : 0, diffs };
}

// ── Traced flow ─────────────────────────────────────────────────────────────────────────────────

export const MIN_CONFIRMED = 3;

export interface DiscoveryState {
  id: string;
  run_id: string;
  business: string;
  created_at: string;
  stats: { chat_lines: number; payment_rows: number; tenants: number; months: string[] };
  candidates: Candidate[];
  replay: Replay;
  answers: Record<string, { yes: boolean; receipt: string; at: string }>;
  receipts: { mine: string; replay: string };
  result?: DiscoveryResult;
}

export interface DiscoveryAudit {
  status: string;
  cases: number;
  killed: number;
  total: number;
}

export interface DiscoveryResult {
  mode: "aktif" | "belajar";
  confirmed: string[];
  rulebook?: Rulebook;
  rulebook_hash?: string;
  replay?: Replay;
  audit?: DiscoveryAudit;
  exceptions: string[];
  receipt: string;
  message: string;
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export class SopDiscovery {
  private readonly runs = new Map<string, MekoRun>();
  private readonly histories = new Map<string, History>();
  constructor(
    readonly ws: MekoWorkspace,
    readonly now: () => Date = () => new Date(),
  ) {}

  private run(state: DiscoveryState): MekoRun {
    let r = this.runs.get(state.id);
    if (!r) this.runs.set(state.id, (r = this.ws.run(state.run_id)));
    return r;
  }

  /** Builder mines candidate rules, then the Auditor replays the history against all of them. */
  async start(input: { chat: string; payments: PaymentRow[]; business?: string }): Promise<DiscoveryState> {
    const chat = parseChatExport(input.chat);
    if (!chat.length) throw new Error("Chat tidak terbaca. Pakai file .txt dari WhatsApp > Ekspor chat (tanpa media).");
    if (!input.payments.length) throw new Error("Data pembayaran kosong. Kolom minimal: tanggal, kamar, jumlah.");
    const h = buildHistory(chat, input.payments, this.ws.pseudonyms, { business: input.business });
    const candidates = mineCandidates(h);
    const replay = replayHistory(h, candidates);
    const id = `disc_${randomUUID().slice(0, 8)}`;
    const state: DiscoveryState = {
      id,
      run_id: `run_discovery_${this.now().toISOString().slice(0, 10).replaceAll("-", "")}_${id.slice(5)}`,
      business: h.business,
      created_at: this.now().toISOString(),
      stats: { chat_lines: chat.length, payment_rows: input.payments.length, tenants: h.tenants.length, months: h.months },
      candidates,
      replay,
      answers: {},
      receipts: { mine: "", replay: "" },
    };
    this.histories.set(id, h);
    const run = this.run(state);
    const builder = await run.agent("builder", `SOP Discovery: ${h.business}`);
    await builder.search(`aturan tagihan ${h.business}`);
    const art = await builder.artifact(`discovery-${id}.json`, { stats: state.stats, candidates });
    const mined = await builder.decide({
      input: `riwayat ${h.business}: ${chat.length} baris chat, ${input.payments.length} baris pembayaran, ${h.tenants.length} kamar, bulan ${h.months.join(", ")} (nama sudah disamarkan)`,
      output: { candidates: candidates.map((c) => ({ id: c.id, title: c.title, confidence: c.confidence, cites: c.cites.map((x) => x.ref) })), artifact: art.content_hash },
      reasoning: `Mined by code from the pseudonymised history, no LLM saw it: ${candidates.length} candidate rules, each with support and counter-examples counted from the chat and the payments sheet (confidence = (support+1)/(support+counter+2)) and a cited line.`,
      plan: candidates.map((c) => `${c.id} ${c.confidence}: ${c.title}`),
      action: "mine_rules",
      action_class: "discovery",
    });
    const auditor = await run.agent("auditor", `SOP Discovery replay: ${h.business}`);
    const replayed = await auditor.decide({
      input: `replay ${replay.bills} past bills against ${candidates.length} proposed rules (Builder receipt ${mined.receipt_hash.slice(0, 12)})`,
      output: { bills: replay.bills, agree: replay.agree, rate: replay.rate, diffs: replay.diffs.slice(0, 12).map((d) => `${d.month} ${d.subject} ${d.what}: aturan ${d.rule}; pemilik ${d.owner}`) },
      reasoning: `Replayed every bill month by month with the proposed cards applied by code: the rules agree with what the owner did on ${replay.agree} of ${replay.bills} bills; the ${replay.diffs.length} differences are shown to the owner with the cited lines before they confirm anything.`,
      action: "replay_history",
      action_class: "discovery",
    });
    state.receipts = { mine: mined.receipt_hash, replay: replayed.receipt_hash };
    return state;
  }

  /** One owner tap (Ya/Tidak) on one candidate: an owner turn plus a ledger decision. */
  async answer(state: DiscoveryState, candidateId: string, yes: boolean, by = "session"): Promise<string> {
    if (state.result) throw new Error("Discovery ini sudah selesai.");
    const c = state.candidates.find((x) => x.id === candidateId);
    if (!c) throw new Error(`Tidak ada usulan ${candidateId}.`);
    const owner = await this.run(state).agent("owner", `SOP Discovery: konfirmasi ${state.business}`);
    const d = await owner.decide({
      input: `${c.id}: ${c.title}`,
      output: { candidate: c.id, yes, card: c.card ?? null, exception: c.exception ?? null },
      reasoning: `The owner tapped ${yes ? "Ya" : "Tidak"} (signed in, ${by}) after seeing confidence ${c.confidence} (${c.evidence}) and the cited line ${c.cites[0]?.ref ?? "-"}.`,
      action: yes ? "confirm_rule" : "reject_rule",
      action_class: "discovery",
      subject: c.exception?.subject,
    });
    state.answers[c.id] = { yes, receipt: d.receipt_hash, at: this.now().toISOString() };
    return d.receipt_hash;
  }

  /**
   * Confirmed cards become a rulebook; the Auditor replays the history again with only those and
   * runs the normal pipeline audit (spec cases and planted defects). Fewer than 3 confirmed rules:
   * nothing runs on its own ("mode belajar").
   */
  async finish(state: DiscoveryState, audit?: (rb: Rulebook) => Promise<DiscoveryAudit>, fallback?: () => Rulebook): Promise<DiscoveryResult> {
    if (state.result) return state.result;
    const yes = state.candidates.filter((c) => state.answers[c.id]?.yes);
    const cards = yes.filter((c) => c.card).map((c) => c.card!);
    const exceptions = yes.filter((c) => c.exception);
    const run = this.run(state);
    const builder = await run.agent("builder", `SOP Discovery: ${state.business}`);
    const owner = await run.agent("owner", `SOP Discovery: konfirmasi ${state.business}`);
    for (const x of exceptions) await owner.remember(x.exception!.text, { kind: "owner_exception", room: x.exception!.room, subject: x.exception!.subject, month: x.exception!.month, source: "sop_discovery" }, { promote: true });
    const open = state.candidates.filter((c) => !state.answers[c.id]).map((c) => c.id);
    if (cards.length < MIN_CONFIRMED) {
      const tpl = fallback?.();
      const d = await builder.decide({
        input: `${cards.length} rules confirmed (${yes.map((c) => c.id).join(", ") || "none"}), ${open.length} unanswered`,
        output: { mode: "belajar", confirmed: yes.map((c) => c.id), template: tpl ? { business: tpl.business_name, cards: tpl.cards.length } : null },
        reasoning: `Fewer than ${MIN_CONFIRMED} rules were confirmed, so nothing runs on its own: Reeve keeps watching and suggesting, and offers the template SOP for the owner to edit. Confirmed exceptions are kept in shared memory.`,
        action: "discovery_fallback",
        action_class: "discovery",
      });
      state.result = { mode: "belajar", confirmed: yes.map((c) => c.id), exceptions: exceptions.map((c) => c.id), receipt: d.receipt_hash, message: `Baru ${cards.length} aturan yang Anda setujui (minimal ${MIN_CONFIRMED}). Reeve tetap dalam mode belajar: hanya mengamati dan memberi saran, tidak menagih sendiri. Anda bisa mulai dari SOP contoh lalu mengubahnya.` };
      return state.result;
    }
    const rb: Rulebook = {
      business_name: state.business,
      currency: "IDR",
      cards,
      questions: state.candidates.filter((c) => !state.answers[c.id]).map((c) => `Belum dijawab: ${c.title}`),
      assumptions: [`Disusun dari riwayat ${state.stats.months.join(", ")} (${state.stats.chat_lines} baris chat, ${state.stats.payment_rows} baris pembayaran) lewat SOP Discovery.`, "Jatuh tempo = tanggal tagihan dikirim."],
    };
    const h = this.histories.get(state.id);
    const replay = h ? replayHistory(h, yes) : undefined;
    const auditor = await run.agent("auditor", `SOP Discovery replay: ${state.business}`);
    if (replay)
      await auditor.decide({
        input: `replay with the ${yes.length} confirmed items only`,
        output: { bills: replay.bills, agree: replay.agree, rate: replay.rate, diffs: replay.diffs.length },
        reasoning: `With only the confirmed rules${exceptions.length ? ` and ${exceptions.length} confirmed exception(s)` : ""}, the rules agree with the owner on ${replay.agree} of ${replay.bills} past bills.`,
        action: "replay_confirmed",
        action_class: "discovery",
      });
    let result: DiscoveryAudit | undefined;
    if (audit) {
      result = await audit(rb);
      await auditor.decide({
        input: `audit discovered rulebook ${sha(rb).slice(0, 12)}`,
        output: result,
        reasoning: `${result.cases} spec cases written from the confirmed cards and ${result.killed}/${result.total} planted defects caught in the sandbox: ${result.status === "pass" ? "the rules can run" : "the rules are blocked until fixed"}.`,
        action: result.status === "pass" ? "audit_pass" : "audit_fail",
        action_class: "discovery",
      });
    }
    const pass = !result || result.status === "pass";
    const d = await builder.decide({
      input: `compile ${cards.length} confirmed cards`,
      output: { rulebook_hash: sha(rb), cards: cards.map((c) => c.id), exceptions: exceptions.map((c) => c.id), audit: result?.status ?? "skipped" },
      reasoning: `The owner confirmed ${cards.map((c) => c.id).join(", ")}; they become the rulebook${pass ? "" : ", held until the audit passes"}. Rejected or unanswered items stay out and are listed as open questions.`,
      action: pass ? "compile_discovered" : "discovery_blocked",
      action_class: "discovery",
    });
    state.result = {
      mode: pass ? "aktif" : "belajar",
      confirmed: yes.map((c) => c.id),
      rulebook: rb,
      rulebook_hash: sha(rb),
      replay,
      audit: result,
      exceptions: exceptions.map((c) => c.id),
      receipt: d.receipt_hash,
      message: pass ? `${cards.length} aturan dari kebiasaan Anda sudah lolos uji${result ? ` (${result.killed}/${result.total} cacat yang ditanam tertangkap)` : ""}. Reeve bisa menjalankannya.` : "Aturan belum lolos uji, jadi belum dijalankan.",
    };
    return state.result;
  }
}
