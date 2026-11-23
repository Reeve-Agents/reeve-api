// One calm daily message for the owner instead of a stream of notifications. The text is built by
// code from ledger facts (no LLM) and holds counts and pseudonymous facts only, never a name.
// Sending is behind an injected DigestSender: the default is a dry run that returns the text and
// sends nothing. A live Telegram push needs BOTH TELEGRAM_BOT_TOKEN and REEVE_DIGEST=on (plus the
// owner's chat id); the wa.me fallback is a link the owner opens and sends themselves.
import { createHash } from "node:crypto";
import type { MekoWorkspace } from "@reeve/meko";
import { loadAmendments } from "./amend";
import { DEFAULT_POLICIES, type Ladder } from "./ladder";
import { loadOutbox } from "./outbox";
import { loadReview } from "./owner-state";

export interface DigestCounts {
  /** auto_run decisions of the day per class label. */
  ran: Record<string, number>;
  ran_total: number;
  staged: number;
  review_pending: number;
  amendments_pending: number;
  ledger_intact: boolean;
}

export interface Digest {
  date: string;
  text: string;
  receipts: string[];
  counts: DigestCounts;
  hash: string;
}

type StoreLike = { data: object; save(): void };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** Calendar date in Jakarta (WIB, UTC+7) of an ISO time. */
export const wibDate = (at: string | number | Date): string => new Date(new Date(at).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

const prettyDate = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

export function buildDigest(ws: MekoWorkspace, ladder: Ladder, store: StoreLike, date: string, opts: { webOrigin?: string } = {}): Digest {
  const label = (cls: string) => ladder.policies[cls]?.label ?? DEFAULT_POLICIES[cls]?.label ?? cls;
  const ranToday = ws.decisions().filter((d) => d.action === "auto_run" && wibDate(d.at) === date);
  const ran: Record<string, number> = {};
  for (const d of ranToday) ran[label(d.action_class ?? "-")] = (ran[label(d.action_class ?? "-")] ?? 0) + 1;
  const counts: DigestCounts = {
    ran,
    ran_total: ranToday.length,
    staged: loadOutbox(store.data).filter((i) => i.status === "staged").length,
    review_pending: loadReview(store.data).filter((i) => i.status === "pending").length,
    amendments_pending: loadAmendments(store.data).filter((a) => a.status === "pending").length,
    ledger_intact: ws.ledger.verify() === null,
  };
  const link = `${(opts.webOrigin ?? "").replace(/\/$/, "")}/?view=kendali`;
  const lines = [`Ringkasan Reeve, ${prettyDate(date)}`];
  lines.push(counts.ran_total ? `Jalan sendiri hari ini: ${Object.entries(ran).map(([k, n]) => `${n} ${k}`).join(", ")}.` : "Belum ada yang jalan sendiri hari ini.");
  if (counts.staged) lines.push(`${counts.staged} tindakan menunggu 10 menit dan masih bisa dibatalkan.`);
  lines.push(counts.review_pending ? `Menunggu keputusan Anda: ${counts.review_pending} draf.` : "Tidak ada draf yang menunggu Anda.");
  if (counts.amendments_pending) lines.push(`Usulan perubahan SOP: ${counts.amendments_pending} menunggu persetujuan.`);
  lines.push(counts.ledger_intact ? "Catatan bukti: utuh." : "Catatan bukti: ADA YANG TIDAK COCOK, buka Reeve untuk memeriksa.");
  lines.push(`Buka: ${link}`);
  const text = lines.join("\n");
  const receipts = ranToday.slice(-20).map((d) => d.entry_hash);
  return { date, text, receipts, counts, hash: createHash("sha256").update(text).digest("hex") };
}

/** Where a digest goes. `live` is true only for a sender that really delivers. */
export interface DigestSender {
  channel: string;
  live: boolean;
  send(text: string): Promise<boolean>;
}

/** Default: nothing leaves the server; the owner sees the text in the app. */
export const dryRun: DigestSender = { channel: "dry-run", live: false, send: async () => false };

export function telegramSender(token: string, chatId: string, fetchFn: typeof fetch = fetch): DigestSender {
  return {
    channel: "telegram",
    live: true,
    send: async (text) => {
      const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }) });
      return res.ok;
    },
  };
}

/** Live Telegram only when TELEGRAM_BOT_TOKEN and REEVE_DIGEST=on are both set and the owner chat is known. */
export function digestSenderFromEnv(env: Record<string, string | undefined> = process.env): DigestSender {
  const chat = env.TELEGRAM_OWNER_CHAT_ID;
  return env.TELEGRAM_BOT_TOKEN && env.REEVE_DIGEST === "on" && chat ? telegramSender(env.TELEGRAM_BOT_TOKEN, chat) : dryRun;
}

export interface SentDigest {
  date: string;
  hash: string;
  channel: string;
  delivered: boolean;
  receipt: string;
  /** True when this date had already been handled: nothing was sent a second time. */
  repeat: boolean;
}

export async function sendDigest(deps: { ws: MekoWorkspace; ladder: Ladder; store: StoreLike; date: string; webOrigin?: string }, sender: DigestSender = dryRun): Promise<SentDigest & { text: string }> {
  const { ws, store, date } = deps;
  const d = store.data as { meko_digest?: Record<string, Omit<SentDigest, "repeat">> };
  const sent = (d.meko_digest ??= {});
  const digest = buildDigest(ws, deps.ladder, store, date, { webOrigin: deps.webOrigin });
  const first = sent[date];
  if (first) return { ...first, repeat: true, text: digest.text };
  // Claim the date before the await so two calls at once cannot both send.
  const claim = { date, hash: digest.hash, channel: sender.channel, delivered: false, receipt: "" };
  sent[date] = claim;
  let delivered = false;
  try {
    delivered = sender.live ? await sender.send(digest.text) : false;
  } catch {
    delivered = false;
  }
  const t = await ws.run(`run_digest_${date.replaceAll("-", "")}`).agent("operator", `Ringkasan harian ${date}`);
  const rec = await t.decide({
    input: `ringkasan ${date}`,
    output: { date, hash: digest.hash, channel: sender.channel, delivered },
    reasoning: sender.live ? `The daily digest was built by code from ledger facts and pushed through ${sender.channel}; delivered=${delivered}. One per day: a second call on the same date returns this receipt.` : "The daily digest was built by code from ledger facts. The channel is a dry run (live sending needs TELEGRAM_BOT_TOKEN and REEVE_DIGEST=on), so nothing was sent; the owner reads it in the app.",
    action: "send_digest",
    action_class: "digest",
  });
  Object.assign(claim, { delivered, receipt: rec.receipt_hash });
  store.save();
  return { ...claim, repeat: false, text: digest.text };
}
