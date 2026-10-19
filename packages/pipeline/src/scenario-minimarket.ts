import type { StockScenario } from "@reeve/core";

/**
 * Minimarket Berkah: 24 items over 30 days from Monday 2 November 2026, two suppliers,
 * Supplier A running 4 days late on orders placed 10-13 November. Deterministic: the same
 * seed gives the same month, so receipts and spec runs are reproducible.
 */

const START = "2026-11-02";
const DAYS = 30;

const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// [id, name, cost, price, shelf life days, units on the shelf, days until that batch expires, sales per day, days since last sale]
const ITEMS: [string, string, number, number, number, number, number, number, number][] = [
  ["S01", "Indomie Goreng", 2_700, 3_500, 240, 45, 200, 6, 0],
  ["S02", "Indomie Soto", 2_700, 3_500, 240, 30, 180, 3, 0],
  ["S03", "Susu UHT Full Cream 1L", 16_500, 19_900, 180, 18, 26, 1.5, 0],
  ["S04", "Teh Botol 450ml", 3_800, 5_000, 270, 40, 150, 5, 0],
  ["S05", "Air Mineral 600ml", 2_300, 3_500, 365, 55, 300, 8, 0],
  ["S06", "Kopi Sachet 10s", 11_500, 14_500, 365, 40, 35, 0.5, 0],
  ["S07", "Gula Pasir 1kg", 15_800, 18_500, 540, 24, 400, 1, 0],
  ["S08", "Minyak Goreng 2L", 34_000, 39_500, 540, 22, 420, 0.8, 0],
  ["S09", "Beras 5kg", 62_000, 72_000, 365, 12, 300, 0.6, 0],
  ["S10", "Kecap Manis 520ml", 18_500, 22_900, 365, 21, 33, 0.4, 0],
  ["S11", "Saus Sambal 335ml", 9_800, 12_500, 365, 22, 250, 0.6, 0],
  ["S12", "Sarden Kaleng 425g", 19_500, 23_900, 730, 26, 600, 0.4, 0],
  ["S13", "Biskuit Kelapa", 8_500, 10_500, 270, 28, 40, 1.5, 0],
  ["S14", "Wafer Coklat", 6_200, 8_000, 270, 34, 200, 2, 0],
  ["S15", "Sabun Mandi", 3_500, 4_500, 1_095, 30, 900, 1.5, 0],
  ["S16", "Sampo Sachet 12s", 9_500, 12_000, 1_095, 22, 900, 0.8, 0],
  ["S17", "Pasta Gigi 190g", 11_800, 14_500, 1_095, 21, 800, 0.7, 0],
  ["S18", "Tisu Wajah 250s", 12_500, 16_000, 1_095, 23, 900, 0.6, 0],
  ["S19", "Deterjen 800g", 17_500, 21_500, 1_095, 22, 900, 0.7, 0],
  ["S20", "Susu Kental Manis 370g", 10_800, 13_500, 365, 15, 18, 0.4, 0],
  ["S21", "Margarin 200g", 7_200, 9_000, 180, 21, 120, 0.5, 0],
  ["S22", "Selai Kacang 340g", 21_500, 26_500, 365, 8, 200, 0, 16],
  ["S23", "Mi Gelas", 1_300, 2_000, 240, 12, 150, 0, 14],
  ["S24", "Korek Api", 900, 1_500, 1_825, 26, 1_500, 0.3, 0],
];

/** Small deterministic generator (LCG), so no dependency and no Math.random. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function minimarketScenario(seed = 17): StockScenario {
  const rnd = lcg(seed);
  const sales: StockScenario["sales"] = [];
  for (let day = 0; day < DAYS; day++) {
    const weekday = new Date(`${addDays(START, day)}T00:00:00Z`).getUTCDay(); // 0 Sunday
    const weekend = weekday === 0 || weekday === 6 ? 1.4 : 1;
    for (const [id, , , , , , , perDay] of ITEMS) {
      if (perDay === 0) continue;
      const units = Math.floor(perDay * weekend * (0.5 + rnd()) + rnd());
      if (units > 0) sales.push({ item_id: id, day, units });
    }
  }
  return {
    pack: "minimarket",
    start_date: START,
    days: DAYS,
    suppliers: [
      { id: "A", lead_days: 2 },
      { id: "B", lead_days: 3 },
    ],
    items: ITEMS.map(([id, name, cost, price, shelf, units, expiresIn, , lastSold]) => ({
      id,
      name,
      cost,
      price,
      shelf_life_days: shelf,
      batches: [{ units, expires: addDays(START, expiresIn) }],
      last_sold_days_ago: lastSold,
    })),
    sales,
    delays: [{ supplier: "A", from_day: 8, to_day: 11, extra_days: 4 }],
  };
}
