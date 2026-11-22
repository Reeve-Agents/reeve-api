// Synthetic history for SOP Discovery: three months of a Kos Melati WhatsApp group export and the
// payments sheet. Every name is made up. The owner follows an unwritten SOP with a few slips
// (a fee a day early, a forgotten reminder, a waived fee for a sick tenant), so the replay has
// something real to show.

interface SampleTenant {
  room: number;
  name: string;
  call: string;
  since: string;
  /** Days late per month (Aug, Sep, Oct 2026); paid on day 1 + late. */
  late: [number, number, number];
}

const TENANTS: SampleTenant[] = [
  { room: 1, name: "Dimas Pratama", call: "Mas Dimas", since: "2024-03-01", late: [0, 0, 2] },
  { room: 2, name: "Rina Kusuma", call: "Mbak Rina", since: "2026-02-01", late: [0, 9, 1] },
  { room: 3, name: "Sinta Maharani", call: "Mbak Sinta", since: "2026-01-01", late: [2, 12, 0] },
  { room: 4, name: "Bagus Saputra", call: "Mas Bagus", since: "2025-06-01", late: [9, 0, 11] },
  { room: 5, name: "Nadia Putri", call: "Mbak Nadia", since: "2026-05-01", late: [0, 5, 0] },
  { room: 6, name: "Fajar Hidayat", call: "Mas Fajar", since: "2023-08-01", late: [0, 0, 0] },
  { room: 7, name: "Wulan Sari", call: "Mbak Wulan", since: "2026-03-01", late: [16, 1, 8] },
  { room: 8, name: "Andi Wijaya", call: "Mas Andi", since: "2025-08-01", late: [8, 0, 0] },
  { room: 9, name: "Laras Anggraini", call: "Mbak Laras", since: "2026-04-01", late: [0, 0, 5] },
  { room: 10, name: "Yoga Permana", call: "Mas Yoga", since: "2024-11-01", late: [1, 1, 1] },
  { room: 11, name: "Citra Lestari", call: "Mbak Citra", since: "2026-06-01", late: [0, 11, 0] },
  { room: 12, name: "Rizky Ramadhan", call: "Mas Rizky", since: "2025-12-01", late: [6, 0, 0] },
];

export const SAMPLE_OWNER = "Bu Ratna Melati";
export const SAMPLE_STAFF = "Pak Joko";
const RENT = 1_500_000;
const FEE = 75_000;
const MONTHS = [
  { ym: "2026-08", name: "Agustus" },
  { ym: "2026-09", name: "September" },
  { ym: "2026-10", name: "Oktober" },
];

function months(since: string, at: string): number {
  const [y1, m1] = since.split("-").map(Number) as [number, number];
  const [y2, m2] = at.split("-").map(Number) as [number, number];
  return (y2 - y1) * 12 + (m2 - m1);
}

export function kosDiscoverySample(): { chat: string; payments: string } {
  type Line = { at: string; from: string; text: string };
  const chat: Line[] = [];
  const pay: string[][] = [];
  const say = (ym: string, day: number, hm: string, from: string, text: string) => chat.push({ at: `${ym}-${String(day).padStart(2, "0")} ${hm}`, from, text });
  const row = (ym: string, day: number, t: SampleTenant, kind: string, amount: number, note = "") => pay.push([`${ym}-${String(day).padStart(2, "0")}`, String(t.room), t.name, kind, String(amount), note, t.since]);

  say("2026-08", 1, "07.10", SAMPLE_OWNER, "Info: denda telat paling banyak 10% dari sewa per tagihan ya, tidak numpuk.");
  MONTHS.forEach((mo, i) => {
    say(mo.ym, 1, "07.30", SAMPLE_OWNER, `Selamat pagi, tagihan sewa bulan ${mo.name} Rp1.500.000 sudah bisa dibayar ya. Transfer ke rekening biasa. Terima kasih 🙏`);
    say(mo.ym, 15, "19.00", SAMPLE_OWNER, `${SAMPLE_STAFF}, sampai hari ini sudah masuk berapa? Target bulan ini 18 juta.`);
    say(mo.ym, 15, "19.20", SAMPLE_STAFF, "Siap Bu, nanti saya rekap.");
    for (const t of TENANTS) {
      const late = t.late[i]!;
      const tenure = months(t.since, mo.ym);
      const feeDay = 7 + (tenure >= 12 ? 3 : 0);
      const sick = t.room === 3 && mo.ym === "2026-09";
      if (sick) say(mo.ym, 5, "20.15", SAMPLE_OWNER, `${t.call} kamar 3 lagi sakit, boleh telat sampai 15 hari bulan ini, nggak usah didenda.`);
      // Reminders at H+3 and H+10 while unpaid; the owner forgot one in August.
      for (const d of [3, 10])
        if (late > d && !(t.room === 12 && mo.ym === "2026-08")) say(mo.ym, 1 + d, "09.00", SAMPLE_OWNER, `${t.call} kamar ${t.room}, pengingat sewa ${mo.name} belum masuk ya 🙏`);
      if (late > feeDay && !sick) {
        // October: the owner charged room 7 one day early (H+6).
        const day = t.room === 7 && mo.ym === "2026-10" ? 7 : 1 + feeDay;
        say(mo.ym, day, "09.05", SAMPLE_OWNER, `${t.call} kamar ${t.room}, sewa ${mo.name} sudah lewat ${day - 1} hari, kena denda 5% Rp75.000 ya.`);
        row(mo.ym, day, t, "denda", FEE, "denda telat");
      }
      if (late > 14) say(mo.ym, 15, "09.10", SAMPLE_OWNER, `${t.call} kamar ${t.room}, sudah H+14 belum ada pembayaran. Ini surat peringatan, mohon segera dilunasi atau kosongkan kamar akhir bulan.`);
      if (late > 3) say(mo.ym, 1 + late, "18.40", t.name, late > 7 ? "Maaf Bu, baru gajian. Sudah saya transfer ya." : "Baik Bu, sudah saya transfer.");
      const amount = t.room === 10 && mo.ym === "2026-09" ? 1_600_000 : t.room === 10 && mo.ym === "2026-10" ? 1_400_000 : RENT;
      row(mo.ym, 1 + late, t, "sewa", amount, amount > RENT ? "lebih bayar" : amount < RENT ? "pakai saldo 100rb" : "");
    }
    if (mo.ym === "2026-08") {
      say(mo.ym, 20, "10.00", SAMPLE_STAFF, "Bu, refund token listrik kamar 5 Rp200.000 sudah saya transfer.");
      say(mo.ym, 20, "10.05", SAMPLE_OWNER, "Oke Pak, makasih.");
      pay.push(["2026-08-20", "5", "Nadia Putri", "refund", "-200000", "token listrik", "2026-05-01"]);
    }
    if (mo.ym === "2026-09") {
      say(mo.ym, 3, "08.00", SAMPLE_OWNER, "Mas Yoga kamar 10 kelebihan bayar 100rb, jadi saldo untuk tagihan bulan depan ya.");
      say(mo.ym, 22, "16.30", SAMPLE_STAFF, "Bu, Mbak Laras kamar 9 nanya refund deposit Rp600.000 kalau pindah bulan depan, boleh langsung saya transfer?");
      say(mo.ym, 22, "16.45", SAMPLE_OWNER, "Refund di atas 500rb harus tanya saya dulu ya Pak. Yang ini nanti saya cek sendiri.");
    }
  });
  chat.sort((a, b) => a.at.localeCompare(b.at));
  const txt = chat
    .map((l) => {
      const [d, hm] = l.at.split(" ") as [string, string];
      const [y, m, dd] = d.split("-") as [string, string, string];
      return `${dd}/${m}/${y.slice(2)} ${hm} - ${l.from}: ${l.text}`;
    })
    .join("\n");
  pay.sort((a, b) => a[0]!.localeCompare(b[0]!) || Number(a[1]) - Number(b[1]));
  const csv = ["tanggal,kamar,nama,jenis,jumlah,catatan,mulai_sewa", ...pay.map((r) => r.map((v) => (v.includes(",") ? `"${v}"` : v)).join(","))].join("\n");
  return { chat: `Pesan dan panggilan terenkripsi end-to-end.\n${txt}\n`, payments: `${csv}\n` };
}
