import { verifyDecision } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { classify, demoBills, dueDateWib, KamarKosong, KOS_DUE_DAY, KOS_RENT_CARDS, lateFeeContractClause, Ladder, liveTick, loadBillBook, newState, nextSlot, Outbox, playbookB, rentTick, saveBillBook } from "../src/index";
import { DEMO_PASSKEY, testDeps } from "./helpers";

describe("Playbook B: kamar kosong terisi sendiri", () => {
  it("fills a room end to end, every step traced and verifiable", async () => {
    const { deps, meko, ws, rail, sent } = await testDeps();
    const crew = new KamarKosong(deps, newState(playbookB()));
    const audit = await crew.approveB(DEMO_PASSKEY);
    expect(audit.status).toBe("pass");
    expect(crew.state.status).toBe("running");

    const draft = await crew.roomVacant("7", "1 Desember");
    expect(draft.hits).toEqual([]);
    await crew.reviewListing(draft.id, { approve: true });
    expect(sent.map((s) => s.tool)).toContain("INSTAGRAM_POST");

    const price = await crew.prospectMessage("p1", "Dewi Lestari", "7", "Halo, harga sewa kamarnya berapa?");
    expect(price).toMatchObject({ intent: "harga", replied: true });
    expect(price.reply).toContain("Rp1.500.000");
    const nego = await crew.prospectMessage("p1", "Dewi Lestari", "7", "Bisa nego jadi lebih murah?");
    expect(nego.replied).toBe(false);
    expect(nego.escalated?.kind).toBe("escalation");
    const visit = await crew.prospectMessage("p1", "Dewi Lestari", "7", "Kapan bisa survei lihat kamar?");
    expect(visit.reply).toMatch(/\d{4}-\d\d-\d\d 10:00/);
    expect(sent.map((s) => s.tool)).toContain("GOOGLECALENDAR_CREATE_EVENT");

    await crew.viewingDone("p1", true);
    const invoice = crew.prospects.p1!.invoice!;
    expect(invoice.amount).toBe(500_000);
    await rail.simulatePayment(invoice.id);
    const contract = await crew.depositPaid("p1");
    expect(contract.text).toContain("Prospek P1");
    const done = await crew.acceptTenant(contract.id, DEMO_PASSKEY);
    expect(done).toEqual({ filled: 1, stopped: false });

    expect(JSON.stringify([...meko.convs.values()]) + JSON.stringify(meko.mems)).not.toContain("Dewi");
    const actions = ws.decisions().map((d) => d.action);
    expect(actions).toEqual(expect.arrayContaining(["compile_playbook", "audit_pass", "approve_playbook", "start_listing", "validator_pass", "publish", "reply", "escalate", "book_viewing", "deposit_bill", "contract_draft", "accept_tenant"]));
    for (const d of crew.state.decisions) expect((await verifyDecision(ws, d.receipt_hash)).ok).toBe(true);
  });

  it("writes the contract's late fee from the rule, the same amount rentTick charges", async () => {
    const { deps, rail, ws } = await testDeps();
    const crew = new KamarKosong(deps, newState(playbookB()));
    await crew.approveB(DEMO_PASSKEY);
    await crew.prospectMessage("p3", "Sari", "9", "jadwal survei kapan?");
    await crew.viewingDone("p3", true);
    await rail.simulatePayment(crew.prospects.p3!.invoice!.id);
    const contract = await crew.depositPaid("p3");
    const fee = Math.round((KOS_RENT_CARDS.rent_idr * KOS_RENT_CARDS.late_fee.percent) / 100);
    expect(fee).toBe(75_000);
    expect(contract.text).toContain(`denda ${KOS_RENT_CARDS.late_fee.percent}% dari sewa (Rp75.000)`);
    expect(contract.text).toContain("kecuali ada izin pemilik");
    expect(contract.text).toContain("minimal 12 bulan dapat toleransi 3 hari tambahan");
    expect(contract.text).not.toContain("Rp50.000");
    expect(lateFeeContractClause()).toContain(`Rp${fee.toLocaleString("id-ID")}`);
    // the rule really charges that amount for a tenant 8 days late
    const run = ws.run("run_contract_fee");
    const out = await rentTick(run, [{ id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 3 }], "2026-12-09", { execute: async () => ({ ok: true, via: "log" }) });
    expect(out[0]).toMatchObject({ action: "charge_fee", amount: fee });
  });

  it("states the same due day as the live bills, and counts the fee from it (SOP: bills go out on the 1st, fee at H+7)", async () => {
    const { deps, rail, ws } = await testDeps();
    const crew = new KamarKosong(deps, newState(playbookB()));
    await crew.approveB(DEMO_PASSKEY);
    await crew.prospectMessage("p4", "Rina", "11", "jadwal survei kapan?");
    await crew.viewingDone("p4", true);
    await rail.simulatePayment(crew.prospects.p4!.invoice!.id);
    const contract = await crew.depositPaid("p4");
    const day = Number(contract.text.match(/jatuh tempo setiap tanggal (\d+)/)?.[1]);
    expect(day).toBe(KOS_DUE_DAY);
    expect(contract.text).not.toContain("tanggal 5");
    expect(contract.text).toContain(`Belum lunas pada H+${KOS_RENT_CARDS.late_fee.days_after_due} sesudah jatuh tempo`);
    // the live bills (the seed's and the month roll's) are due on that same day
    const now = Date.parse("2026-12-04T01:00:00Z");
    const store = { data: {} as object, save() {} };
    const seeded = saveBillBook(store.data, demoBills(dueDateWib(now)), now);
    expect(seeded.bills.every((b) => Number(b.due.slice(8)) === day)).toBe(true);
    const ladder = new Ladder(ws);
    await liveTick({ ws, store, ladder, outbox: new Outbox(ws, store, ladder), execute: async () => ({ ok: true, via: "log" }), now: () => Date.parse("2027-01-04T01:00:00Z") });
    const rolled = loadBillBook(store.data)!;
    expect(rolled.period).toBe("2027-01");
    expect(rolled.bills.every((b) => Number(b.due.slice(8)) === day)).toBe(true);
  });

  it("stops itself when the target is reached", async () => {
    const { deps, rail } = await testDeps();
    const pb = playbookB();
    pb.goal.target = 1;
    const crew = new KamarKosong(deps, newState(pb));
    await crew.approveB(DEMO_PASSKEY);
    await crew.prospectMessage("p2", "Budi", "9", "jadwal survei kapan?");
    await crew.viewingDone("p2", true);
    await rail.simulatePayment(crew.prospects.p2!.invoice!.id);
    const c = await crew.depositPaid("p2");
    expect(await crew.acceptTenant(c.id, DEMO_PASSKEY)).toEqual({ filled: 1, stopped: true });
    expect(crew.state.status).toBe("stopped");
    await expect(crew.roomVacant("9", "x")).rejects.toThrow(/stopped/);
  });

  it("will not run a playbook the Auditor failed", async () => {
    const { deps } = await testDeps();
    const pb = playbookB();
    pb.steps[3]!.payment!.amount_idr = 9_000_000;
    const crew = new KamarKosong(deps, newState(pb));
    expect((await crew.approveB(DEMO_PASSKEY)).status).toBe("fail");
    await expect(crew.roomVacant("7", "x")).rejects.toThrow(/not running/);
  });

  it("falls back to the template when the Worker writes a wrong price", async () => {
    const { deps } = await testDeps({ worker: async () => ({ text: "Kamar murah Rp900.000 saja! (dibuat dengan bantuan AI)" }) });
    const crew = new KamarKosong(deps, newState(playbookB()));
    await crew.approveB(DEMO_PASSKEY);
    const draft = await crew.roomVacant("4", "2 Desember");
    expect(draft.text).toContain("Rp1.500.000");
    expect(crew.state.decisions.filter((d) => d.agent === "worker")).toHaveLength(1); // one call/day cap
  });

  it("classifies with escalations first and finds a free slot", () => {
    expect(classify("berapa harga? saya mau refund")).toBe("refund");
    expect(classify("wifi ada?")).toBe("fasilitas");
    expect(classify("halo")).toBe("tidak_jelas");
    expect(nextSlot("2026-12-05", ["2026-12-07 10:00"])).toBe("2026-12-07 11:00"); // 6 Dec is a Sunday
  });
});

describe("Worker failure", () => {
  it("falls back to the template when the model call throws", async () => {
    const { deps } = await testDeps({
      worker: async () => {
        throw new Error("rate limited");
      },
    });
    const crew = new KamarKosong(deps, newState(playbookB()));
    await crew.approveB(DEMO_PASSKEY);
    const draft = await crew.roomVacant("4", "2 Desember");
    expect(draft.text).toContain("Rp1.500.000");
    expect(crew.state.decisions.some((d) => d.action === "draft_failed")).toBe(true);
  });
});
