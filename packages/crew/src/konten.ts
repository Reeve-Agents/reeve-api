// Playbook C, the content closed loop: plan from business truth -> make (script and caption) ->
// Validator -> owner review -> publish (Log connector) -> measure (simulated metrics) -> learn
// (Meko memory of which hook brought chats, read back by the next plan).
import { createHash } from "node:crypto";
import { Crew, CrewError, type PasskeyProof, type ReviewItem } from "./crew";
import { KOS_FACILITIES, KOS_FACTS, KOS_LOCATION } from "./kos";
import { KOS_WHITELIST } from "./playbook";
import { AI_LABEL } from "./validator";

export const HOOKS = ["lokasi", "harga", "fasilitas", "suasana"] as const;
export type Hook = (typeof HOOKS)[number];

export interface RoomTruth {
  room: string;
  vacant_since: string;
}

export interface ContentPlan {
  date: string;
  room: string;
  days_vacant: number;
  hook: Hook;
  moments: string[];
  why: string;
}

export interface ContentPiece {
  id: string;
  plan: ContentPlan;
  script: { hook: string; beats: string[]; cta: string };
  caption: string;
  hashtags: string[];
  storyboard: { scene: number; seconds: number; shot: string; text: string }[];
  status: "draft" | "in_review" | "published" | "rejected";
  review?: string;
  metrics?: { views: number; wa_inquiries: number; viewings: number };
}

/** Moments that change what to post: paydays, the start of a month, the campus calendar. */
export function momentsOf(date: string): string[] {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  if (d >= 25 || d <= 2) out.push("gajian");
  if (d <= 5) out.push("awal_bulan");
  if (m === 7 || m === 8) out.push("maba_ganjil");
  if (m === 1 || m === 2) out.push("semester_genap");
  if (m === 12 && d >= 15) out.push("libur_akhir_tahun");
  return out;
}

const HOOK_LINE: Record<Hook, string> = {
  lokasi: "10 menit jalan kaki ke kampus ITS, nggak perlu motor.",
  harga: "Rp1.500.000 sebulan sudah kamar mandi dalam dan Wi-Fi.",
  fasilitas: "Kamar mandi dalam, Wi-Fi, kasur dan lemari: tinggal bawa koper.",
  suasana: "Kos yang tenang buat belajar, dekat warung dan laundry.",
};

export function contentTemplate(plan: ContentPlan): Pick<ContentPiece, "script" | "caption" | "hashtags" | "storyboard"> {
  const moment = plan.moments.includes("gajian") ? "Baru gajian? " : plan.moments.includes("semester_genap") ? "Cari kos buat semester genap? " : "";
  const hook = `${moment}${HOOK_LINE[plan.hook]}`;
  const beats = [`Kamar ${plan.room} Kos Melati kosong sekarang.`, `Fasilitas: ${KOS_FACILITIES.slice(0, 3).join(", ")}.`, `Sewa Rp1.500.000/bulan, deposit Rp500.000.`];
  const cta = "Chat untuk jadwal survei, Senin-Sabtu 10.00-16.00.";
  const caption = `${hook} ${beats.join(" ")} ${cta} (${AI_LABEL})`;
  const storyboard = [hook, ...beats, cta].map((text, i) => ({ scene: i + 1, seconds: i === 0 ? 3 : 4, shot: ["wajah pemilik di depan kos", "pintu kamar dibuka", "kamar mandi dalam", "papan harga", "tangan mengetik chat"][i]!, text }));
  return { script: { hook, beats, cta }, caption, hashtags: ["#kossurabaya", "#kosits", "#kosmelati", "#infokos"], storyboard };
}

/** Simulated reach for the demo: stable per piece, shaped by hook and moment (no real platform data). */
export function simulateMetrics(piece: Pick<ContentPiece, "id" | "plan">): { views: number; wa_inquiries: number; viewings: number } {
  const seed = createHash("sha256").update(piece.id).digest()[0]! / 255;
  const base: Record<Hook, number> = { lokasi: 4, harga: 3, fasilitas: 2, suasana: 1 };
  const bonus = piece.plan.moments.includes("gajian") ? 1 : 0;
  const views = Math.round(500 + seed * 700 + base[piece.plan.hook] * 80);
  const wa_inquiries = base[piece.plan.hook] + bonus + (seed > 0.7 ? 1 : 0);
  return { views, wa_inquiries, viewings: Math.floor(wa_inquiries / 2) };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export class KontenLoop extends Crew {
  get pieces(): Record<string, ContentPiece> {
    return (this.state.records.pieces ??= {}) as Record<string, ContentPiece>;
  }
  approveC(passkey: PasskeyProof) {
    const sample = contentTemplate({ date: "2026-12-01", room: "7", days_vacant: 3, hook: "lokasi", moments: [], why: "" }).caption;
    return this.approve({ facts: KOS_FACTS, whitelist: KOS_WHITELIST, good_draft: sample, passkey });
  }

  /**
   * c1: pick the room vacant longest and the hook that brought the most chats so far (from Meko
   * memory). Hooks never tried are tried first, in order, so the loop has something to learn from.
   */
  async plan(rooms: RoomTruth[]): Promise<ContentPlan> {
    this.assertRunning();
    if (!rooms.length) throw new CrewError("no vacant room to post about");
    const date = this.today();
    const room = [...rooms].sort((a, b) => a.vacant_since.localeCompare(b.vacant_since))[0]!;
    const op = await this.agent("operator", `Konten: ${this.state.playbook.title}`);
    const seen = await op.search("hasil hook konten chat calon penghuni", 20);
    const stats = new Map<Hook, { n: number; chats: number }>();
    const counted = new Set<string>(); // a promoted memory is a copy of the private one
    for (const m of seen.memory) {
      // Read from the text: shared memories lose their metadata in Meko.
      const r = m.text.match(/Konten (ct_[\w]+) hook "(\w+)".*?menghasilkan (\d+) chat/);
      if (!r) continue;
      const [, piece, hookText, chatsText] = r as unknown as [string, string, string, string];
      const hook = hookText as Hook;
      const chats = Number(chatsText);
      if (!HOOKS.includes(hook) || counted.has(piece)) continue;
      counted.add(piece);
      const s = stats.get(hook) ?? { n: 0, chats: 0 };
      stats.set(hook, { n: s.n + 1, chats: s.chats + chats });
    }
    const untried = HOOKS.find((h) => !stats.has(h));
    const ranked = [...stats].map(([h, s]) => ({ h, avg: s.chats / s.n })).sort((a, b) => b.avg - a.avg);
    const hook = untried ?? ranked[0]!.h;
    const moments = momentsOf(date);
    const why = untried
      ? `hook "${untried}" has no result in memory yet, so it is tried`
      : `memory shows "${ranked[0]!.h}" averaging ${ranked[0]!.avg.toFixed(1)} chats per post (${ranked.map((r) => `${r.h} ${r.avg.toFixed(1)}`).join(", ")})`;
    const plan: ContentPlan = { date, room: room.room, days_vacant: daysBetween(room.vacant_since, date), hook, moments, why };
    await this.record(op, {
      input: `rooms vacant: ${rooms.map((r) => `${r.room} since ${r.vacant_since}`).join(", ")}; date ${date}`,
      output: plan,
      reasoning: `Kamar ${room.room} has been vacant longest (${plan.days_vacant} days). Moments today: ${moments.join(", ") || "none"}. Hook: ${why}.`,
      action: "plan_content",
      action_class: "plan_content",
    });
    return plan;
  }

  /** c2 + c3: the Worker words the script and caption, the Validator checks, the owner reviews. */
  async make(plan: ContentPlan): Promise<{ piece: ContentPiece; review: ReviewItem }> {
    const step = this.step("c2_make");
    const base = contentTemplate(plan);
    const draft = await this.draft(step, {
      brief: `Tulis caption video pendek (hook "${plan.hook}") untuk kamar ${plan.room}.`,
      facts_text: [`Kamar ${plan.room}`, `Sewa Rp1.500.000/bulan, deposit Rp500.000`, `Fasilitas: ${KOS_FACILITIES.join(", ")}`, `Lokasi: ${KOS_LOCATION}`, `Momen: ${plan.moments.join(", ") || "-"}`].join("\n"),
      template: base.caption,
      facts: KOS_FACTS,
      subject: `konten kamar ${plan.room}`,
    });
    const piece: ContentPiece = { id: this.nextId("ct"), plan, ...base, caption: draft.text, status: "in_review" };
    this.pieces[piece.id] = piece;
    const review = this.queue({ step: "c3_publish", kind: "draft", subject: `konten ${plan.hook} kamar ${plan.room}`, text: piece.caption, receipt: this.state.decisions.at(-1)!.receipt_hash, hits: draft.hits, meta: { piece: piece.id } });
    piece.review = review.id;
    return { piece, review };
  }

  /** c3: owner approves (or rejects) a piece; approved pieces are published through the connector. */
  async review(reviewId: string, approve: boolean): Promise<ContentPiece> {
    const item = this.pending(reviewId);
    const piece = this.pieces[String(item.meta?.piece)]!;
    const step = this.step("c3_publish");
    item.status = approve ? "approved" : "rejected";
    piece.status = approve ? "published" : "rejected";
    const owner = await this.agent("owner", `Review konten: ${this.state.playbook.title}`);
    await this.record(owner, { input: `review ${piece.id}`, output: { verdict: item.status }, reasoning: approve ? "The owner approved the post unchanged." : "The owner rejected the post; it is not published.", action: `review_${item.status}`, action_class: step.action_class });
    if (!approve) return piece;
    const res = await this.exec(step, { caption: piece.caption, hashtags: piece.hashtags, storyboard: piece.storyboard });
    const op = await this.agent("operator", `Konten: ${this.state.playbook.title}`);
    await this.record(op, { input: `publish ${piece.id}`, output: { action: "publish", via: res.via }, reasoning: `Owner-approved, so ${step.publish!.tool} runs${res.via === "log" ? " on the Log connector (recorded, not posted)" : ""}.`, action: "publish", action_class: step.action_class });
    return piece;
  }

  /** c4 + c5: measure (simulated), then store what the hook did as shared memory for the next plan. */
  async measureAndLearn(pieceId: string): Promise<ContentPiece> {
    const piece = this.pieces[pieceId];
    if (!piece || piece.status !== "published") throw new CrewError(`${pieceId} is not published`);
    piece.metrics = simulateMetrics(piece);
    this.state.metric += piece.metrics.wa_inquiries;
    const op = await this.agent("operator", `Konten: ${this.state.playbook.title}`);
    await this.record(op, {
      input: `measure ${piece.id}`,
      output: { ...piece.metrics, simulated: true },
      reasoning: `Simulated metrics for the demo (no platform data yet): ${piece.metrics.views} views, ${piece.metrics.wa_inquiries} WhatsApp chats. wa_inquiries is now ${this.state.metric}/${this.state.playbook.goal.target}.`,
      action: "measure",
      action_class: "measure",
    });
    await op.remember(
      `Konten ${piece.id} hook "${piece.plan.hook}" untuk kamar ${piece.plan.room} (${piece.plan.date}, momen ${piece.plan.moments.join("/") || "-"}) menghasilkan ${piece.metrics.wa_inquiries} chat calon penghuni dari ${piece.metrics.views} views.`,
      { kind: "content_result", hook: piece.plan.hook, wa_inquiries: piece.metrics.wa_inquiries, views: piece.metrics.views, piece: piece.id },
      { promote: true },
    );
    await this.record(op, {
      input: `learn ${piece.id}`,
      output: { memory: "content_result", hook: piece.plan.hook, wa_inquiries: piece.metrics.wa_inquiries },
      reasoning: "The result is promoted to shared memory, so the next plan's context_search ranks hooks by chats per post.",
      action: "learn",
      action_class: "learn",
    });
    await this.checkStop();
    return piece;
  }
}
