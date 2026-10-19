import type { Scenario, Tenant } from "@reeve/core";

/** Kos Melati: 30 rooms over 45 days (two invoice cycles), with a realistic mix of payer behaviours. */
export function kosMelatiScenario(): Scenario {
  const rent = 1_500_000;
  const tenants: Tenant[] = [];
  const payments: Scenario["payments"] = [];
  const pay = (tenant_id: string, day: number, amount = rent) => payments.push({ tenant_id, day, amount });

  for (let i = 0; i < 30; i++) {
    const id = `K${String(i + 1).padStart(2, "0")}`;
    const veteran = i === 23 || i === 24;
    tenants.push({ id, name: `Penghuni ${i + 1}`, room: `Kamar ${i + 1}`, rent, move_in: veteran ? "2024-06-15" : `2026-0${3 + (i % 6)}-10` });
  }

  const ids = tenants.map((t) => t.id);
  for (let i = 0; i < 18; i++) {
    pay(ids[i]!, 0);
    pay(ids[i]!, 30); // December, on time again
  }
  for (const i of [18, 19, 20]) pay(ids[i]!, 5); // after the H+3 reminder
  for (const i of [21, 22]) pay(ids[i]!, 9); // new tenants, late: fee on H+7
  pay(ids[23]!, 9); // veteran, inside the 3-day grace: no fee
  pay(ids[24]!, 12); // veteran, past the grace: fee on H+10
  pay(ids[25]!, 2, 750_000); // partial payment...
  pay(ids[25]!, 20, 750_000 + 75_000); // ...settled after the notice
  // ids[26] never pays: reminders, fee, notice
  pay(ids[27]!, 0, rent + 250_000); // overpays: 250k credit applied to December
  pay(ids[28]!, 16, rent + 75_000); // pays after the notice, including the fee
  pay(ids[29]!, 0);
  pay(ids[29]!, 30);

  return { start_date: "2026-11-01", days: 45, tenants, payments };
}

type Behaviour = "on_time" | "after_reminder" | "late_fee" | "late_fee_long" | "partial" | "never" | "overpay" | "after_notice";

/**
 * A month for the owner's own tenants: every payer behaviour the rules must handle appears at least
 * once (when there are enough rooms), the rest pay on time. Amounts follow each tenant's own rent, so
 * the Auditor tests the rules on the real rents, not the sample's.
 */
export function rentScenario(tenants: Tenant[], start = "2026-11-01"): Scenario {
  const specials: Behaviour[] = ["after_reminder", "late_fee", "never", "overpay", "partial", "late_fee_long", "after_notice", "after_reminder", "late_fee"];
  const n = tenants.length;
  const k = Math.min(specials.length, Math.max(0, n - Math.ceil(n / 2)));
  const behaviours: Behaviour[] = tenants.map((_, i) => (i >= n - k ? specials[i - (n - k)]! : "on_time"));
  const payments: Scenario["payments"] = [];
  tenants.forEach((t, i) => {
    const pay = (day: number, amount = t.rent) => payments.push({ tenant_id: t.id, day, amount });
    switch (behaviours[i]) {
      case "on_time":
        pay(0);
        pay(30);
        break;
      case "after_reminder":
        pay(5);
        break;
      case "late_fee":
        pay(9);
        break;
      case "late_fee_long":
        pay(12);
        break;
      case "partial":
        pay(2, Math.round(t.rent / 2));
        pay(20, t.rent - Math.round(t.rent / 2) + Math.round(t.rent * 0.05));
        break;
      case "never":
        break;
      case "overpay":
        pay(0, t.rent + Math.round(t.rent / 6));
        break;
      case "after_notice":
        pay(16, t.rent + Math.round(t.rent * 0.05));
        break;
    }
  });
  return { start_date: start, days: 45, tenants, payments };
}

const ALIASES: Record<keyof Tenant, string[]> = {
  id: ["id", "tenant_id", "kode", "no", "nomor"],
  name: ["name", "nama", "penghuni", "tenant", "nama_penghuni"],
  room: ["room", "kamar", "unit", "no_kamar", "nomor_kamar"],
  rent: ["rent", "sewa", "harga", "harga_sewa", "biaya", "tarif"],
  move_in: ["move_in", "masuk", "tanggal_masuk", "tgl_masuk", "check_in", "mulai"],
};
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Tenants from an owner's sheet or CSV, matching common column names (English or Indonesian). */
export function tenantsFromRecords(records: Record<string, string | number | null>[]): { tenants: Tenant[]; problems: string[] } {
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const pick = (field: keyof Tenant) => columns.find((c) => ALIASES[field].includes(norm(c)));
  const col = { id: pick("id") ?? pick("room"), name: pick("name"), room: pick("room") ?? pick("id"), rent: pick("rent"), move_in: pick("move_in") };
  const problems: string[] = [];
  for (const [f, c] of Object.entries(col)) if (!c) problems.push(`no column for ${f} (try one of: ${ALIASES[f as keyof Tenant].join(", ")})`);
  if (problems.length) return { tenants: [], problems };
  const tenants: Tenant[] = [];
  const seen = new Set<string>();
  records.forEach((r, i) => {
    const id = String(r[col.id!] ?? "").trim();
    const rent = Number(String(r[col.rent!] ?? "").replace(/[^0-9]/g, ""));
    const moveIn = String(r[col.move_in!] ?? "").trim().slice(0, 10);
    const row = `row ${i + 2}`;
    if (!id) return problems.push(`${row}: no ${col.id}`);
    if (seen.has(id)) return problems.push(`${row}: ${col.id} ${id} appears twice`);
    if (!rent) return problems.push(`${row}: no ${col.rent} for ${id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveIn)) return problems.push(`${row}: ${col.move_in} for ${id} must be YYYY-MM-DD`);
    seen.add(id);
    tenants.push({ id, name: String(r[col.name!] ?? id), room: String(r[col.room!] ?? id), rent, move_in: moveIn });
  });
  if (!tenants.length && !problems.length) problems.push("no tenants in the data");
  return { tenants, problems };
}
