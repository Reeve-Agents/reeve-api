// Kos Melati (synthetic sample kos, 30 rooms, Rp1.500.000/month): Playbook B "kamar kosong terisi
// sendiri" and Playbook C, the content loop. What the Builder would compile from the owner's targets.
import { KOS_WHITELIST, type Playbook } from "./playbook";
import { AI_LABEL, type ValidatorFacts } from "./validator";

export const KOS_RENT_IDR = 1_500_000;
export const KOS_DEPOSIT_IDR = 500_000;

export const KOS_FACTS: ValidatorFacts = {
  prices: [KOS_RENT_IDR, KOS_DEPOSIT_IDR],
  allowed_domains: ["wa.me"],
  competitors: ["Kos Mawar", "Kos Anggrek"],
  max_length: 600,
  evidence: [],
};

export const KOS_FACILITIES = ["kamar mandi dalam", "Wi-Fi", "kasur dan lemari", "parkir motor", "dapur bersama"];
export const KOS_LOCATION = "Jl. Melati 12, Keputih, Surabaya, 10 menit jalan kaki ke kampus ITS";

export function kosListingDraft(room: string, from: string): string {
  return `Kamar ${room} Kos Melati kosong mulai ${from}. Sewa Rp1.500.000/bulan, deposit Rp500.000. Fasilitas: ${KOS_FACILITIES.slice(0, 3).join(", ")}. Mau survei? Balas pesan ini. (${AI_LABEL})`;
}

const worker = (calls: number) => ({ max_worker_calls_per_day: calls, cost_idr_per_call: 40 });

export function playbookB(startsOn = "2026-12-01", by = "2026-12-31"): Playbook {
  return {
    id: "pb_kamar_kosong",
    title: "Kamar kosong terisi sendiri",
    workspace: "kos-melati",
    source_quote: "Kalau ada kamar kosong, pasang iklan, jawab calon penghuni, atur survei, tagih deposit Rp500.000, siapkan kontrak; saya yang terima penghuninya.",
    goal: { metric: "rooms_filled", target: 2, by },
    starts: ["room_vacant"],
    starts_on: startsOn,
    budget: { max_cost_idr: 25_000, max_worker_calls: 400, max_payment_idr: KOS_RENT_IDR },
    stop: { on_target: true, on_budget: true, by_date: by },
    steps: [
      {
        id: "b1_listing", title: "Pasang iklan kamar", source_quote: "pasang iklan", when: "room_vacant", emits: ["prospect_message"],
        trigger: { event: "room_vacant" }, recipe: { skill: "listing_post", brief: "Iklan kamar kosong dari data kamar", inputs: ["rooms.number", "rooms.price"] },
        checks: ["R01", "R03", "R04", "R08", "R10", "R15", "R19", "R22", "R24"], review: "owner_before_publish",
        publish: { connector: "log", tool: "INSTAGRAM_POST" }, budget: worker(1), action_class: "listing_post",
      },
      {
        id: "b2_cs", title: "Jawab calon penghuni", source_quote: "jawab calon penghuni", when: "prospect_message", emits: ["viewing_requested", "escalated"],
        trigger: { inbound: "whatsapp" }, recipe: { skill: "cs_reply", brief: "Jawab dari fakta kos, intent di daftar putih saja", inputs: ["rooms", "facilities", "location"] },
        checks: ["R01", "R03", "R10", "R15", "R22", "R24"], review: "auto_if_whitelisted_intent",
        publish: { connector: "log", tool: "WHATSAPP_REPLY" }, budget: worker(3), action_class: "cs_reply", whitelisted_intents: [...KOS_WHITELIST],
      },
      {
        id: "b3_viewing", title: "Atur jadwal survei", source_quote: "atur survei", when: "viewing_requested", emits: ["viewing_done"],
        trigger: { event: "viewing_requested" }, recipe: { skill: "book_viewing", brief: "Slot survei 10.00-17.00, Senin-Sabtu", inputs: ["calendar"] },
        checks: [], review: "auto_if_whitelisted_intent", publish: { connector: "composio", tool: "GOOGLECALENDAR_CREATE_EVENT" }, budget: worker(0), action_class: "book_viewing",
      },
      {
        id: "b4_deposit", title: "Tagih deposit", source_quote: "tagih deposit Rp500.000", when: "viewing_done", emits: ["deposit_paid"],
        trigger: { event: "viewing_done" }, recipe: { skill: "deposit_bill", brief: "Tagihan deposit lewat Xendit (mode test)", inputs: ["prospect"] },
        checks: [], review: "auto_within_bound", publish: null, payment: { amount_idr: KOS_DEPOSIT_IDR, rail: "xendit" }, budget: worker(0), action_class: "deposit_bill",
      },
      {
        id: "b5_contract", title: "Siapkan kontrak", source_quote: "siapkan kontrak", when: "deposit_paid", emits: ["contract_ready"],
        trigger: { event: "deposit_paid" }, recipe: { skill: "contract_draft", brief: "Draf kontrak dari template pemilik", inputs: ["prospect", "room"] },
        checks: ["R10", "R24"], review: "none", publish: null, budget: worker(1), action_class: "contract_draft",
      },
      {
        id: "b6_accept", title: "Pemilik terima penghuni", source_quote: "saya yang terima penghuninya", when: "contract_ready", emits: ["room_filled"],
        trigger: { event: "contract_ready" }, recipe: { skill: "accept_tenant", brief: "Pemilik menyetujui dengan passkey", inputs: ["contract"] },
        checks: [], review: "owner_passkey", publish: null, budget: worker(0), action_class: "accept_tenant",
      },
    ],
  };
}

export function playbookC(startsOn = "2026-12-01", by = "2026-12-31"): Playbook {
  return {
    id: "pb_konten",
    title: "Konten harian dari data kos",
    workspace: "kos-melati",
    source_quote: "Tiap hari bikin satu konten dari kamar yang kosong; saya cek dulu sebelum tayang. Target 15 chat calon penghuni bulan ini.",
    goal: { metric: "wa_inquiries", target: 15, by },
    starts: ["day_start"],
    starts_on: startsOn,
    budget: { max_cost_idr: 25_000, max_worker_calls: 200, max_payment_idr: 0 },
    stop: { on_target: true, on_budget: true, by_date: by },
    steps: [
      {
        id: "c1_plan", title: "Rencana dari data", source_quote: "dari kamar yang kosong", when: "day_start", emits: ["content_planned"],
        trigger: { schedule: { every: "day", slots: ["08:00"] } }, recipe: { skill: "plan_content", brief: "Kamar kosong terlama, tanggal gajian, kalender kampus", inputs: ["rooms", "calendar"] },
        checks: [], review: "none", publish: null, budget: worker(0), action_class: "plan_content",
      },
      {
        id: "c2_make", title: "Naskah dan caption", source_quote: "bikin satu konten", when: "content_planned", emits: ["draft_ready"],
        trigger: { event: "content_planned" }, recipe: { skill: "content_video", brief: "Hook, 3 beat, CTA, caption, hashtag", inputs: ["plan"] },
        checks: ["R01", "R02", "R03", "R04", "R08", "R09", "R10", "R14", "R15", "R19", "R22", "R24"], review: "none", publish: null, budget: worker(2), action_class: "content_make",
      },
      {
        id: "c3_publish", title: "Review lalu tayang", source_quote: "saya cek dulu sebelum tayang", when: "draft_ready", emits: ["published"],
        trigger: { event: "draft_ready" }, recipe: { skill: "listing_post", brief: "Antrian review pemilik", inputs: ["draft"] },
        checks: ["R15"], review: "owner_before_publish", publish: { connector: "log", tool: "INSTAGRAM_POST" }, budget: worker(0), action_class: "content_publish",
      },
      {
        id: "c4_measure", title: "Ukur hasil", source_quote: "target 15 chat", when: "published", emits: ["measured"],
        trigger: { event: "published" }, recipe: { skill: "measure", brief: "Views, chat WA, survei", inputs: ["metrics"] },
        checks: [], review: "none", publish: null, budget: worker(0), action_class: "measure",
      },
      {
        id: "c5_learn", title: "Belajar dari hasil", source_quote: "target 15 chat", when: "measured", emits: [],
        trigger: { event: "measured" }, recipe: { skill: "plan_content", brief: "Simpan hook yang berhasil ke memori Meko", inputs: ["metrics"] },
        checks: [], review: "none", publish: null, budget: worker(0), action_class: "learn",
      },
    ],
  };
}
