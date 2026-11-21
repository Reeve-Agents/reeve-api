import { verifyDecision } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { HOOKS, KontenLoop, momentsOf, newState, playbookC, validate, KOS_FACTS, contentTemplate } from "../src/index";
import { DEMO_PASSKEY, testDeps } from "./helpers";

const rooms = [
  { room: "12", vacant_since: "2026-11-20" },
  { room: "7", vacant_since: "2026-11-02" },
];

describe("Playbook C: content loop", () => {
  it("plans, makes, gets approved, publishes, measures and learns which hook works", async () => {
    let day = Date.parse("2026-12-01T01:00:00Z");
    const { deps, ws, sent } = await testDeps({ now: () => new Date(day) });
    const loop = new KontenLoop(deps, newState(playbookC()));
    expect((await loop.approveC(DEMO_PASSKEY)).status).toBe("pass");

    const hooks: string[] = [];
    for (let i = 0; i < 6 && loop.state.status === "running"; i++) {
      const plan = await loop.plan(rooms);
      expect(plan.room).toBe("7");
      hooks.push(plan.hook);
      const { piece, review } = await loop.make(plan);
      expect(validate(piece.caption, KOS_FACTS)).toEqual([]);
      await loop.review(review.id, true);
      await loop.measureAndLearn(piece.id);
      day += 86_400_000;
    }
    // Tries each hook once, then exploits the best one.
    expect(hooks.slice(0, HOOKS.length)).toEqual([...HOOKS]);
    expect(hooks[HOOKS.length]).toBe("lokasi");
    expect(sent.filter((s) => s.tool === "INSTAGRAM_POST")).toHaveLength(hooks.length);
    expect(loop.state.metric).toBeGreaterThanOrEqual(15);
    expect(loop.state.status).toBe("stopped");
    const last = ws.decisions({ agent: "operator" }).filter((d) => d.action === "plan_content").at(-1)!;
    const check = await verifyDecision(ws, last.entry_hash);
    expect(check.ok).toBe(true);
    expect(check.message?.reasoning).toMatch(/memory shows "lokasi"/);
  });

  it("does not publish a rejected piece", async () => {
    const { deps, sent } = await testDeps();
    const loop = new KontenLoop(deps, newState(playbookC()));
    await loop.approveC(DEMO_PASSKEY);
    const { piece, review } = await loop.make(await loop.plan(rooms));
    await loop.review(review.id, false);
    expect(sent).toHaveLength(0);
    await expect(loop.measureAndLearn(piece.id)).rejects.toThrow(/not published/);
  });

  it("knows paydays and the campus calendar", () => {
    expect(momentsOf("2026-12-26")).toEqual(["gajian", "libur_akhir_tahun"]);
    expect(momentsOf("2027-02-01")).toEqual(["gajian", "awal_bulan", "semester_genap"]);
    const t = contentTemplate({ date: "2026-12-26", room: "7", days_vacant: 9, hook: "harga", moments: ["gajian"], why: "" });
    expect(t.script.hook).toMatch(/^Baru gajian\?/);
    expect(t.storyboard).toHaveLength(5);
  });
});
