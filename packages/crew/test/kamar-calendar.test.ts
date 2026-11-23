import type { FakeMeko } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { CALENDAR_TOOL, calendarEventArgs, KamarKosong, Ladder, newState, playbookB, withCalendar, type CalendarRegistry, type CrewExec, type ExecResult } from "../src/index";
import { DEMO_PASSKEY, testDeps } from "./helpers";

const ASK = "Kapan bisa survei lihat kamar?";

/** What the Operator recorded for one action: the output JSON and the reasoning text. */
function turns(meko: FakeMeko, action: string) {
  return [...meko.convs.values()]
    .flatMap((c) => c.messages)
    .filter((m) => (m.metadata as { reeve_action?: string }).reeve_action === action)
    .map((m) => ({ output: JSON.parse(String(m.output)) as Record<string, unknown>, reasoning: String(m.reasoning) }));
}

async function start(execute: CrewExec) {
  const t = await testDeps({ execute });
  const crew = new KamarKosong(t.deps, newState(playbookB()));
  expect((await crew.approveB(DEMO_PASSKEY)).status).toBe("pass");
  return { ...t, crew };
}

describe("Playbook B, step b3_viewing: Google Calendar through Composio", () => {
  it("publishes through the composio connector, and the playbook audit still passes", () => {
    const b3 = playbookB().steps.find((s) => s.id === "b3_viewing")!;
    expect(b3.publish).toEqual({ connector: "composio", tool: "GOOGLECALENDAR_CREATE_EVENT" });
    expect(b3.review).toBe("auto_if_whitelisted_intent");
  });

  it("connected: the decision says the event was created via Composio, with its id", async () => {
    const calls: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
    const { crew, meko } = await start(async (connector, tool, args): Promise<ExecResult> => {
      calls.push({ connector, tool, args });
      return connector === "composio" ? { ok: true, via: "composio", ref: "evt_9" } : { ok: true, via: "log" };
    });
    const r = await crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);
    expect(r.replied).toBe(true);

    const cal = calls.filter((c) => c.tool === "GOOGLECALENDAR_CREATE_EVENT");
    expect(cal).toHaveLength(1);
    expect(cal[0]!.connector).toBe("composio");
    expect(cal[0]!.args).toMatchObject({ title: "Survei kamar 7: Prospek P1", duration_min: 30 });
    expect(JSON.stringify(cal[0]!.args)).not.toContain("Dewi");
    // and the real adapter turns exactly those args into the Composio shape
    expect(calendarEventArgs({ title: String(cal[0]!.args.title), start: String(cal[0]!.args.start) })).toMatchObject({ summary: "Survei kamar 7: Prospek P1", timezone: "Asia/Jakarta" });

    expect(crew.booked).toEqual([crew.prospects.p1!.viewing]);
    const [t] = turns(meko, "book_viewing");
    expect(t!.output).toMatchObject({ action: "book_viewing", via: "composio", ref: "evt_9" });
    expect(t!.reasoning).toContain("created in Google Calendar via Composio");
    expect(t!.reasoning).toContain("evt_9");
    expect(t!.reasoning).not.toContain("Log connector");
    expect(turns(meko, "book_viewing_failed")).toEqual([]);
  });

  it("not connected: the decision says Log connector, recorded, not booked", async () => {
    const asked: string[] = [];
    const { crew, meko } = await start(async (connector, tool) => (asked.push(`${connector}:${tool}`), { ok: true, via: "log" }));
    await crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);
    expect(asked).toContain("composio:GOOGLECALENDAR_CREATE_EVENT");
    const [t] = turns(meko, "book_viewing");
    expect(t!.output).toMatchObject({ via: "log" });
    expect(t!.output).not.toHaveProperty("ref");
    expect(t!.reasoning).toContain("Log connector: recorded, not booked, until Google Calendar is connected");
    expect(t!.reasoning).not.toContain("created in Google Calendar");
    // the slot is still held in Reeve, so two prospects never get the same one
    expect(crew.booked).toEqual([crew.prospects.p1!.viewing]);
  });

  it("failed: says it failed, does not hold the slot, asks the owner, and can be retried", async () => {
    let calendarOk = false;
    const { crew, meko, ws } = await start(async (_connector, tool): Promise<ExecResult> => {
      if (tool !== "GOOGLECALENDAR_CREATE_EVENT") return { ok: true, via: "log" };
      return calendarOk ? { ok: true, via: "composio", ref: "evt_1" } : { ok: false, via: "composio", error: "403 calendar says no" };
    });
    await crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);

    const [f] = turns(meko, "book_viewing_failed");
    expect(f!.output).toMatchObject({ action: "book_viewing_failed", via: "composio", error: "403 calendar says no" });
    expect(f!.reasoning).toMatch(/failed: 403 calendar says no/);
    expect(f!.reasoning).toContain("not held");
    expect(turns(meko, "book_viewing")).toEqual([]);

    // nothing pretends the viewing exists
    expect(crew.prospects.p1!.viewing).toBeUndefined();
    expect(crew.booked).toEqual([]);
    await expect(crew.viewingDone("p1", true)).rejects.toThrow(/has no viewing/);
    // and a failed booking is not a clean run for the earned-autonomy ladder
    expect(new Ladder(ws).evidence("book_viewing").clean).toBe(0);
    // the owner sees it
    const item = crew.state.queue.find((q) => q.step === "b3_viewing")!;
    expect(item).toMatchObject({ kind: "action", status: "pending", subject: "Prospek P1" });
    expect(item.text).toContain("belum masuk Google Calendar");
    expect(item.text).not.toContain("Dewi");
    expect(item.receipt).toBe(crew.state.decisions.find((d) => d.action === "book_viewing_failed")!.receipt_hash);

    // asking again retries, with the same slot (it was released)
    calendarOk = true;
    await crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);
    expect(turns(meko, "book_viewing")[0]!.output).toMatchObject({ via: "composio", ref: "evt_1" });
    expect(crew.booked).toHaveLength(1);
    await crew.viewingDone("p1", true);
    expect(crew.prospects.p1!.invoice!.amount).toBe(500_000);
  });

  it("an executor that throws is a failed booking, not a crash", async () => {
    const { crew, meko } = await start(async (_c, tool) => {
      if (tool === "GOOGLECALENDAR_CREATE_EVENT") throw new Error("socket hang up");
      return { ok: true, via: "log" };
    });
    const r = await crew.bookViewing(await seed(crew), "2026-12-03 10:00");
    expect(r).toEqual({ booked: false, via: "composio", error: "socket hang up" });
    expect(turns(meko, "book_viewing_failed")).toHaveLength(1);
    expect(crew.booked).toEqual([]);
  });

  it("holds the slot while the calendar answers, so a second prospect cannot get it", async () => {
    let release: (r: ExecResult) => void = () => {};
    const { crew } = await start((_c, tool) => (tool === "GOOGLECALENDAR_CREATE_EVENT" ? new Promise<ExecResult>((res) => (release = res)) : Promise.resolve({ ok: true, via: "log" })));
    const a = await seed(crew, "p1");
    const b = await seed(crew, "p2");
    const first = crew.bookViewing(a, "2026-12-03 10:00");
    await expect(crew.bookViewing(b, "2026-12-03 10:00")).rejects.toThrow(/taken/);
    release({ ok: true, via: "composio", ref: "evt_2" });
    expect(await first).toMatchObject({ booked: true, via: "composio", ref: "evt_2" });
  });

  it("end to end with the real wrapper and a fake Composio: connected books it, not connected logs it", async () => {
    const mk = (connected: number) => {
      const sent: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
      const registry: CalendarRegistry = {
        list: () => [{ id: "composio", kind: "composio" }],
        appStatus: async () => ({ googlecalendar: connected }),
        execute: async (connector, tool, args) => (sent.push({ connector, tool, args }), { ok: true, data: { response_data: { id: "evt_7" } }, connector: "composio" }),
      };
      const said: string[] = [];
      return { sent, said, ...withCalendar({ registry, fallback: async () => ({ ok: true, via: "log" }), say: (l) => said.push(l) }) };
    };
    const on = mk(1);
    const a = await start(on.execute);
    await a.crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);
    expect(on.sent).toHaveLength(1);
    expect(on.sent[0]).toMatchObject({ connector: "composio", tool: CALENDAR_TOOL, args: { summary: "Survei kamar 7: Prospek P1", timezone: "Asia/Jakarta", calendar_id: "primary", send_updates: "none" } });
    expect(turns(a.meko, "book_viewing")[0]!.output).toMatchObject({ via: "composio", ref: "evt_7" });

    const off = mk(0);
    const b = await start(off.execute);
    await b.crew.prospectMessage("p1", "Dewi Lestari", "7", ASK);
    expect(off.sent).toEqual([]);
    expect(off.said[0]).toMatch(/not connected/);
    expect(turns(b.meko, "book_viewing")[0]!.reasoning).toContain("Log connector: recorded, not booked, until Google Calendar is connected");
  });
});

/** Registers a prospect without booking: one message that is not a viewing request. */
async function seed(crew: KamarKosong, id = "p1"): Promise<string> {
  await crew.prospectMessage(id, id === "p1" ? "Dewi Lestari" : "Sari Wulandari", "7", "Halo, harga sewa kamarnya berapa?");
  return id;
}
