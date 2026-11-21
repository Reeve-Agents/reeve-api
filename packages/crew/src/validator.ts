// Validator: code, not a model. Every draft a Worker writes passes these rules before anyone sees it.
// Rule numbers follow "Reeve - Content and CS Guardrails" (1-25); only the rules that can be checked
// on text are here. A failing draft goes back to the Worker once, then to the owner.

export interface ValidatorFacts {
  /** Every rupiah figure in a draft must be one of these. */
  prices: number[];
  /** Original prices for discounts (rule 9). */
  original_prices?: number[];
  halal_certificate?: string;
  /** Owner-uploaded evidence ids for testimonials and superlatives (rules 3, 14). */
  evidence?: string[];
  allowed_domains: string[];
  competitors?: string[];
  max_length: number;
}

export interface ValidatorHit {
  rule: string;
  message: string;
}

export const AI_LABEL = "dibuat dengan bantuan AI";

export const RULES: Record<string, string> = {
  R01: "Klaim kesehatan (menyembuhkan, obat, ajaib)",
  R02: "Klaim keamanan mutlak (100% aman)",
  R03: "Superlatif tanpa bukti",
  R04: "Menjelekkan pesaing",
  R08: "Halal tanpa nomor sertifikat",
  R09: "Diskon tanpa harga asli",
  R10: "Harga tidak sama dengan katalog",
  R14: "Testimoni tanpa bukti",
  R15: "Tanpa label AI",
  R19: "Terlalu panjang",
  R22: "Tautan ke domain asing",
  R24: "Data pribadi bocor (NIK, nomor HP, kartu)",
};

const HEALTH = /\b(menyembuhkan|mengobati|mencegah penyakit|obat|ajaib|mujarab)\b/i;
const ABSOLUTE = /\b(100% aman|tidak berbahaya|tanpa efek samping)\b/i;
const SUPERLATIVE = /\b(ter(murah|baik|bagus|lengkap|nyaman)|satu-satunya|nomor satu|paling (murah|bagus|nyaman))\b/i;
const TESTIMONIAL = /\b(testimoni|kata penghuni|review|ulasan)\b/i;
const DISCOUNT = /\b(diskon|potongan|promo \d+%|hemat \d+)/i;
const HALAL = /\bhalal\b/i;
const URL = /\bhttps?:\/\/([^\s/]+)|\b([a-z0-9-]+\.(?:com|id|net|org|co\.id|io|me|ly|xyz))\b/gi;
const NIK = /\b\d{16}\b/;
const PHONE = /(?:\+62|\b62|\b0)8\d{7,11}\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;

/** Rupiah figures in a text: "Rp1.500.000", "Rp 1,5 jt", "1,5 juta". */
export function rupiahIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:rp\.?\s?)(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k)?|(\d+(?:[.,]\d+)?)\s*(jt|juta)\b/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[3]!;
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    let n: number;
    if (unit) n = Number(raw.replace(",", ".")) * (unit.startsWith("j") ? 1_000_000 : 1_000);
    else n = Number(raw.replace(/[.,]/g, ""));
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n));
  }
  return out;
}

export function validate(text: string, facts: ValidatorFacts, checks: string[] = Object.keys(RULES)): ValidatorHit[] {
  const hits: ValidatorHit[] = [];
  const on = (r: string) => checks.includes(r);
  const hit = (rule: string, message: string) => hits.push({ rule, message });
  const lower = text.toLowerCase();
  if (on("R01") && HEALTH.test(text)) hit("R01", "Ada klaim kesehatan.");
  if (on("R02") && ABSOLUTE.test(text)) hit("R02", "Ada klaim keamanan mutlak.");
  if (on("R03") && SUPERLATIVE.test(text) && !(facts.evidence ?? []).length) hit("R03", "Superlatif tanpa bukti dari pemilik.");
  if (on("R04") && (facts.competitors ?? []).some((c) => lower.includes(c.toLowerCase()))) hit("R04", "Menyebut pesaing.");
  if (on("R08") && HALAL.test(text) && !facts.halal_certificate) hit("R08", "Kata halal tanpa nomor sertifikat.");
  if (on("R09") && DISCOUNT.test(text) && !(facts.original_prices ?? []).length) hit("R09", "Diskon tanpa harga asli tersimpan.");
  if (on("R10")) {
    const allowed = new Set([...facts.prices, ...(facts.original_prices ?? [])]);
    for (const n of rupiahIn(text)) if (!allowed.has(n)) hit("R10", `Harga Rp${n.toLocaleString("id-ID")} tidak ada di katalog.`);
  }
  if (on("R14") && TESTIMONIAL.test(text) && !(facts.evidence ?? []).length) hit("R14", "Testimoni tanpa bukti.");
  if (on("R15") && !lower.includes(AI_LABEL.toLowerCase())) hit("R15", `Tidak ada label "${AI_LABEL}".`);
  if (on("R19") && text.length > facts.max_length) hit("R19", `Panjang ${text.length} > ${facts.max_length} karakter.`);
  if (on("R22"))
    for (const m of text.matchAll(URL)) {
      const host = (m[1] ?? m[2] ?? "").toLowerCase().replace(/^www\./, "");
      if (!facts.allowed_domains.some((d) => host === d || host.endsWith(`.${d}`))) hit("R22", `Tautan ke ${host} tidak diizinkan.`);
    }
  if (on("R24") && (NIK.test(text) || PHONE.test(text) || CARD.test(text))) hit("R24", "Ada NIK, nomor HP atau nomor kartu.");
  return hits;
}

/** Planted bad drafts: the Auditor checks the Validator catches every one (rule -> draft). */
export function plantedDrafts(good: string, facts: ValidatorFacts): { rule: string; draft: string }[] {
  const wrongPrice = (facts.prices[0] ?? 1_000_000) - 100_000;
  return [
    { rule: "R10", draft: `${good} Sekarang cuma Rp${wrongPrice.toLocaleString("id-ID")}!` },
    { rule: "R01", draft: `${good} Udara segar di sini menyembuhkan stres.` },
    { rule: "R08", draft: `${good} Dapur bersama halal.` },
    { rule: "R04", draft: `${good} Lebih bersih dari ${facts.competitors?.[0] ?? "Kos Mawar"}.` },
    { rule: "R22", draft: `${good} Info: bit.ly/kos-murah` },
    { rule: "R19", draft: `${good} ${"Nyaman sekali. ".repeat(Math.ceil(facts.max_length / 14))}` },
    { rule: "R15", draft: good.replace(new RegExp(`\\s*${AI_LABEL}\\.?`, "i"), "").replace(/\(\s*\)/, "") },
    { rule: "R24", draft: `${good} Hubungi 081234567890.` },
    { rule: "R24", draft: `${good} NIK pemilik 3578012345678901.` },
    { rule: "R03", draft: `${good} Kos termurah di Surabaya.` },
    { rule: "R14", draft: `${good} Testimoni: "betah banget!"` },
    { rule: "R09", draft: `${good} Diskon spesial bulan ini.` },
  ];
}
