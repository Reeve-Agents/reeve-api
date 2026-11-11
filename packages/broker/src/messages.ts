/**
 * Outbound messages of the rent pack (bills, reminders, notices to vacate): what they say and which
 * connector tool carries them. The rulebook's cards decide whether, when and to whom; this file only
 * turns that decision into text and a tool call.
 *
 * Allow-list: a rent rulebook's reminder / notice / invoice cards authorise messages to the tenant, and
 * nothing else. The only tools the Operator will ever call for them are RENT_MESSAGE_TOOLS.
 */

export interface Contact {
  /** Telegram chat id of the tenant (a number as text). Preferred channel. */
  telegram_chat_id?: string;
  email?: string;
}

export type MessageKind = "bill" | "late_fee" | "reminder" | "notice" | "purchase_order";

export const RENT_MESSAGE_TOOLS = ["TELEGRAM_SEND_MESSAGE", "GMAIL_SEND_EMAIL", "LOG"] as const;

export interface MessageFacts {
  name: string;
  room: string;
  amount: number;
  /** Hosted payment link of the open bill, when there is one. */
  payUrl?: string;
  /** The bill's key, e.g. K01-2026-11. */
  invoice?: string;
  /** Purchase orders: units ordered. `name` is then the supplier and `room` the item. */
  qty?: number;
}

export interface Message {
  kind: MessageKind;
  facts: MessageFacts;
  subject: string;
  /** The approved template text; a drafter may rephrase it but never change the facts. */
  body: string;
}

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

/** The approved template for each message kind (Indonesian, polite and plain). */
export function messageFor(kind: MessageKind, facts: MessageFacts): Message {
  const hi = `Halo ${facts.name} (kamar ${facts.room}),`;
  const pay = facts.payUrl ? `\n\nBayar di sini: ${facts.payUrl}` : "";
  switch (kind) {
    case "bill":
      return { kind, facts, subject: `Tagihan sewa kamar ${facts.room}`, body: `${hi} tagihan sewa bulan ini sebesar ${rp(facts.amount)} sudah terbit.${pay}\n\nTerima kasih.` };
    case "late_fee":
      return { kind, facts, subject: `Denda keterlambatan kamar ${facts.room}`, body: `${hi} sewa Anda terlambat, sehingga dikenakan denda sebesar ${rp(facts.amount)}.${pay}\n\nTerima kasih.` };
    case "reminder":
      return { kind, facts, subject: `Pengingat sewa kamar ${facts.room}`, body: `${hi} kami mengingatkan bahwa sewa sebesar ${rp(facts.amount)} belum kami terima.${pay}\n\nBila sudah membayar, abaikan pesan ini. Terima kasih.` };
    case "purchase_order":
      return {
        kind,
        facts,
        subject: `Pesanan barang: ${facts.room}`,
        body: `Halo ${facts.name}, kami ingin memesan ${facts.qty ?? "?"} unit ${facts.room}, perkiraan nilai ${rp(facts.amount)}. Mohon konfirmasi ketersediaan dan tanggal pengiriman. Terima kasih.`,
      };
    case "notice":
      return {
        kind,
        facts,
        subject: `Pemberitahuan resmi kamar ${facts.room}`,
        body: `${hi} sewa sebesar ${rp(facts.amount)} masih belum kami terima setelah beberapa pengingat. Ini pemberitahuan resmi: bila tidak diselesaikan, kamar harus dikosongkan sesuai aturan kos.${pay}\n\nSilakan hubungi pemilik bila ada kendala.`,
      };
  }
}

export interface ToolCall {
  connector: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Which tool carries the message: Telegram when the tenant has a chat id, else Gmail, else the log. */
export function toolCallFor(msg: Message, contact: Contact | undefined): ToolCall {
  if (contact?.telegram_chat_id) return { connector: "telegram", tool: "TELEGRAM_SEND_MESSAGE", args: { chat_id: contact.telegram_chat_id, text: msg.body } };
  if (contact?.email) return { connector: "gmail", tool: "GMAIL_SEND_EMAIL", args: { recipient_email: contact.email, subject: msg.subject, body: msg.body } };
  return { connector: "log", tool: "LOG", args: { tenant: msg.facts.name, room: msg.facts.room, subject: msg.subject, body: msg.body } };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const TELEGRAM = ["telegramchatid", "chatid", "telegram", "telegramid"];
const EMAIL = ["email", "emailaddress", "surel"];

/** Contact columns of a tenant sheet, by row (same order as the tenants read from it). Rows without any contact are left out. */
export function contactsFromRecords(records: Record<string, string | number | null>[], tenantIds: string[]): Record<string, Contact> {
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const tg = columns.find((c) => TELEGRAM.includes(norm(c)));
  const em = columns.find((c) => EMAIL.includes(norm(c)));
  const out: Record<string, Contact> = {};
  records.forEach((r, i) => {
    const id = tenantIds[i];
    if (!id) return;
    const telegram = tg ? String(r[tg] ?? "").trim() : "";
    const email = em ? String(r[em] ?? "").trim() : "";
    if (telegram || email) out[id] = { ...(telegram ? { telegram_chat_id: telegram } : {}), ...(email ? { email } : {}) };
  });
  return out;
}
