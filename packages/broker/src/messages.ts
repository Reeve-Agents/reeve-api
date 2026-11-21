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
  /**
   * WhatsApp / phone number as written in the sheet. Reeve never sends on WhatsApp itself: it prepares a
   * wa.me link the owner opens from their own WhatsApp, and only when no automatic channel delivered.
   */
  whatsapp?: string;
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
/** Columns that hold a WhatsApp number, best first; a plain phone column is the fallback (most Indonesian phones have WhatsApp). */
const WHATSAPP = ["whatsapp", "wa", "nowa", "nomorwa", "nowhatsapp", "nomorwhatsapp", "whatsappnumber", "wanumber"];
const PHONE = ["phone", "phonenumber", "nohp", "nomorhp", "hp", "handphone", "telepon", "telp", "notelp", "nomortelepon", "mobile"];

export type PhoneCheck = { ok: true; digits: string } | { ok: false; reason: string };

/**
 * An Indonesian mobile number in the form wa.me wants: digits only, country code first, no plus.
 * "0812-3456-7890", "+62 812 3456 7890", "62812...", "0062812..." and "812..." (a spreadsheet that dropped
 * the leading zero) all become 62812.... A number with an explicit other country code (+65 ...) is kept as it
 * is. Anything else is refused with the reason, so the owner can fix the sheet.
 */
export function normalisePhone(raw: string | number | null | undefined): PhoneCheck {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "no phone number" };
  const plus = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (digits.length < 8) return { ok: false, reason: "the number is too short for a phone number" };
  if (digits.startsWith("00")) digits = digits.slice(2); // international call prefix
  else if (digits.startsWith("0")) digits = `62${digits.slice(1)}`; // 08... -> 628...
  else if (!plus && !digits.startsWith("62") && digits.startsWith("8")) digits = `62${digits}`; // 812... (leading zero lost in the sheet)
  if (digits.startsWith("620")) digits = `62${digits.slice(3)}`; // "+62 0812...": the zero does not belong after the country code
  if (digits.startsWith("62")) {
    // Indonesian mobile numbers: 62 8xx then 7 to 11 more digits. A landline cannot take WhatsApp.
    if (!/^628\d{7,11}$/.test(digits)) return { ok: false, reason: "the number is not an Indonesian mobile number (it should look like 0812 3456 7890)" };
    return { ok: true, digits };
  }
  if (plus && /^[1-9]\d{7,14}$/.test(digits)) return { ok: true, digits };
  return { ok: false, reason: "the number has no country code (write it as 08... or +62...)" };
}

/** The click-to-send link: WhatsApp opens a chat with this number and the text filled in; the owner presses send. */
export const whatsappLink = (digits: string, text: string) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;

/** The channel name used on the ledger and on prepared messages. */
export const WHATSAPP_CHANNEL = "whatsapp_link" as const;

/**
 * A message Reeve wrote but did not send: the owner opens `url` to send it from their own WhatsApp, then marks it
 * sent. Reeve cannot see WhatsApp, so "sent_by_owner" is the owner's word, never a delivery receipt.
 */
export interface PreparedMessage {
  id: string;
  at: string;
  channel: typeof WHATSAPP_CHANNEL;
  kind: MessageKind;
  /** Who it is for: the tenant (or, for a purchase order, the supplier) and their room (or the item). */
  tenant: string;
  name: string;
  room: string;
  /** Digits only, country code first. */
  to: string;
  text: string;
  amount?: number;
  url: string;
  /** e.g. "reminder:K01-2026-11" */
  ref: string;
  status: "prepared" | "sent_by_owner";
  sentAt?: string;
}

/** A message that can go out as a WhatsApp link instead of a log line: the number as written in the sheet, and the message itself. */
export interface WhatsAppOffer {
  number: string;
  message: Message;
}

/** The WhatsApp link for this message when the contact has a valid number; a reason when the number is unusable; null when there is none. */
export function prepareWhatsApp(
  msg: Message,
  contact: Contact | undefined,
  meta: { id: string; at: string; tenant: string; ref: string },
): { prepared: PreparedMessage } | { skipped: string } | null {
  if (!contact?.whatsapp?.trim()) return null;
  const phone = normalisePhone(contact.whatsapp);
  if (!phone.ok) return { skipped: phone.reason };
  return {
    prepared: {
      id: meta.id,
      at: meta.at,
      channel: WHATSAPP_CHANNEL,
      kind: msg.kind,
      tenant: meta.tenant,
      name: msg.facts.name,
      room: msg.facts.room,
      to: phone.digits,
      text: msg.body,
      amount: msg.facts.amount,
      url: whatsappLink(phone.digits, msg.body),
      ref: meta.ref,
      status: "prepared",
    },
  };
}

/** Contact columns of a tenant sheet, by row (same order as the tenants read from it). Rows without any contact are left out. */
export function contactsFromRecords(records: Record<string, string | number | null>[], tenantIds: string[]): Record<string, Contact> {
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const tg = columns.find((c) => TELEGRAM.includes(norm(c)));
  const em = columns.find((c) => EMAIL.includes(norm(c)));
  const wa = WHATSAPP.map((w) => columns.find((c) => norm(c) === w)).find(Boolean) ?? PHONE.map((w) => columns.find((c) => norm(c) === w)).find(Boolean);
  const out: Record<string, Contact> = {};
  records.forEach((r, i) => {
    const id = tenantIds[i];
    if (!id) return;
    const telegram = tg ? String(r[tg] ?? "").trim() : "";
    const email = em ? String(r[em] ?? "").trim() : "";
    const whatsapp = wa ? String(r[wa] ?? "").trim() : "";
    if (telegram || email || whatsapp) out[id] = { ...(telegram ? { telegram_chat_id: telegram } : {}), ...(email ? { email } : {}), ...(whatsapp ? { whatsapp } : {}) };
  });
  return out;
}
