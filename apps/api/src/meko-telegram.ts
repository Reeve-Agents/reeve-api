// "Kenapa saya didenda?" over Telegram, the inbound channel that works today. A tenant links their
// chat once with a code the owner made (t.me/<bot>?start=<code>); after that their questions go to
// the read-only ask agent, which answers from the Meko trace and the ledger with a "lihat bukti"
// link. The answer is a traced decision. The reply rides in the webhook response (Telegram's
// "reply with a method" feature), so no bot token is needed and nothing is sent to anyone else.
// WhatsApp stays a wa.me link the owner opens and sends themselves.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AskBusiness } from "@reeve/crew";
import type { MekoWorkspace } from "@reeve/meko";
import type { Store } from "./store";

export interface MekoLinks {
  /** HMAC of the chat id -> who it is (the chat id itself is never stored). */
  chats: Record<string, { subject: string; at: string }>;
  codes: Record<string, { subject: string; expires: number }>;
}

export interface MekoTelegramDeps {
  secret?: string;
  /** Store of the Meko demo workspace; links live under `data.meko_links`. */
  store: Store;
  open: () => Promise<MekoWorkspace>;
  /** Absolute web origin for "lihat bukti" links. */
  webOrigin: string;
  botUsername?: string;
  now?: () => number;
}

const SUBJECT = /^K\d{2,3}$/;
const CODE_TTL = 24 * 3_600_000;

export function mekoTelegram(deps: MekoTelegramDeps) {
  const now = deps.now ?? Date.now;
  const links = (): MekoLinks => {
    const d = deps.store.data as typeof deps.store.data & { meko_links?: MekoLinks };
    return (d.meko_links ??= { chats: {}, codes: {} });
  };
  const chatKey = (chat: string | number) => createHmac("sha256", deps.secret ?? "reeve").update(String(chat)).digest("hex").slice(0, 32);
  const proofUrl = (r: string) => `${deps.webOrigin.replace(/\/$/, "")}/?view=jejak&receipt=${r}`;
  const ask = async () => new AskBusiness(await deps.open(), proofUrl);

  /** Owner: a one-time code (24 h) that links one tenant's Telegram chat to their pseudonym. */
  function createLink(subject: string): { code: string; url: string | null; expires: string } {
    if (!SUBJECT.test(subject)) throw new Error("Kode penghuni harus seperti K05.");
    const code = randomBytes(6).toString("base64url");
    const l = links();
    for (const [k, v] of Object.entries(l.codes)) if (v.expires < now()) delete l.codes[k];
    l.codes[code] = { subject, expires: now() + CODE_TTL };
    deps.store.save();
    return { code, url: deps.botUsername ? `https://t.me/${deps.botUsername}?start=${code}` : null, expires: new Date(now() + CODE_TTL).toISOString() };
  }

  /** Owner: the same explanation as a wa.me link the owner sends themselves (no number, no API). */
  async function explainForWhatsApp(subject: string, question: string) {
    if (!SUBJECT.test(subject)) throw new Error("Kode penghuni harus seperti K05.");
    const a = await (await ask()).ask(question || "Kenapa saya didenda?", { role: "tenant", subject, channel: "wa.me (dikirim pemilik)" });
    return { ...a, wa_me: `https://wa.me/?text=${encodeURIComponent(a.text)}` };
  }

  /**
   * The Telegram webhook, tried before the workspaces. Null when the update is not for this demo
   * (unknown chat, no secret configured), so the workspaces still get it.
   */
  async function handle(req: Request): Promise<Response | null> {
    if (!deps.secret) return null;
    const sent = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? "");
    const want = Buffer.from(deps.secret);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return null;
    const update = (await req.json().catch(() => ({}))) as { message?: { chat?: { id?: number | string }; text?: string } };
    const chat = update.message?.chat?.id;
    const text = update.message?.text?.trim();
    if (chat === undefined || !text) return null;
    const reply = (t: string) => Response.json({ method: "sendMessage", chat_id: chat, text: t, link_preview_options: { is_disabled: true } });
    const l = links();
    const start = text.match(/^\/start\s+([A-Za-z0-9_-]{4,32})$/);
    if (start) {
      const c = l.codes[start[1]!];
      if (!c || c.expires < now()) return reply("Kode ini sudah tidak berlaku. Minta kode baru ke pemilik kos.");
      delete l.codes[start[1]!];
      l.chats[chatKey(chat)] = { subject: c.subject, at: new Date(now()).toISOString() };
      deps.store.save();
      return reply(`Terhubung. Anda bisa bertanya, misalnya "Kenapa saya didenda?". Jawaban diambil dari catatan keputusan Reeve, lengkap dengan buktinya.`);
    }
    const who = l.chats[chatKey(chat)];
    if (!who) return null;
    const a = await (await ask()).ask(text.slice(0, 300), { role: "tenant", subject: who.subject, channel: "telegram" });
    return reply(a.text.replace(/\nLihat bukti: /, "\n\nLihat bukti: "));
  }

  return { handle, createLink, explainForWhatsApp };
}
