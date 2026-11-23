import { describe, expect, it } from "vitest";
import { CALENDAR_TOOL, calendarEventArgs, eventRef, withCalendar, type CalendarRegistry, type CrewExec } from "../src/index";

const VIEWING = { title: "Survei kamar 7: Prospek P1", start: "2026-12-02 10:00", duration_min: 30 };

describe("calendarEventArgs", () => {
  it("maps a viewing slot to the arguments GOOGLECALENDAR_CREATE_EVENT takes", () => {
    const a = calendarEventArgs(VIEWING);
    expect(a).toMatchObject({
      summary: "Survei kamar 7: Prospek P1",
      start_datetime: "2026-12-02T10:00:00",
      end_datetime: "2026-12-02T10:30:00",
      timezone: "Asia/Jakarta",
      calendar_id: "primary",
      send_updates: "none",
      create_meeting_room: false,
    });
    // nobody is invited or emailed
    expect(a).not.toHaveProperty("attendees");
    expect(String(a.description)).toContain("Reeve");
    expect(String(a.description)).toMatch(/disamarkan/);
  });

  it("carries the end across the hour and the day, and takes a T separator", () => {
    expect(calendarEventArgs({ ...VIEWING, start: "2026-12-02 10:45" })).toMatchObject({ start_datetime: "2026-12-02T10:45:00", end_datetime: "2026-12-02T11:15:00" });
    expect(calendarEventArgs({ ...VIEWING, start: "2026-12-31T23:45" })).toMatchObject({ start_datetime: "2026-12-31T23:45:00", end_datetime: "2027-01-01T00:15:00" });
  });

  it("defaults to 30 minutes", () => {
    expect(calendarEventArgs({ title: "x", start: "2026-12-02 16:00" })).toMatchObject({ end_datetime: "2026-12-02T16:30:00" });
  });

  it("refuses a slot, length or title it cannot read instead of guessing", () => {
    expect(() => calendarEventArgs({ ...VIEWING, start: "besok jam 10" })).toThrow(/YYYY-MM-DD HH:MM/);
    expect(() => calendarEventArgs({ ...VIEWING, start: "2026-02-31 10:00" })).toThrow(/not a real date/);
    expect(() => calendarEventArgs({ ...VIEWING, start: "2026-12-02 25:00" })).toThrow(/not a real date/);
    expect(() => calendarEventArgs({ ...VIEWING, duration_min: 0 })).toThrow(/minutes/);
    expect(() => calendarEventArgs({ ...VIEWING, duration_min: 12.5 })).toThrow(/minutes/);
    expect(() => calendarEventArgs({ ...VIEWING, title: "  " })).toThrow(/title/);
  });
});

describe("eventRef", () => {
  it("reads the event id wherever Composio puts it, and never the link", () => {
    expect(eventRef({ response_data: { id: "evt_1", htmlLink: "https://www.google.com/calendar/event?eid=abc" } })).toBe("evt_1");
    expect(eventRef({ data: { id: "evt_2" } })).toBe("evt_2");
    expect(eventRef({ id: "evt_3" })).toBe("evt_3");
    expect(eventRef({ response_data: { htmlLink: "https://www.google.com/calendar/event?eid=abc" } })).toBeUndefined();
    expect(eventRef(null)).toBeUndefined();
    expect(eventRef("ok")).toBeUndefined();
  });
});

function fakeRegistry(over: Partial<CalendarRegistry> = {}) {
  const calls: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
  const statusCalls: string[][] = [];
  const registry: CalendarRegistry = {
    list: () => [{ id: "composio", kind: "composio" }, { id: "log", kind: "log" }],
    appStatus: async (toolkits) => {
      statusCalls.push(toolkits);
      return { googlecalendar: 1 };
    },
    execute: async (connector, tool, args) => {
      calls.push({ connector, tool, args });
      return { ok: true, data: { response_data: { id: "evt_42", htmlLink: "https://www.google.com/calendar/event?eid=secret" } }, connector: "composio" };
    },
    ...over,
  };
  return { registry, calls, statusCalls };
}

function setup(over: Partial<CalendarRegistry> = {}, registryOverride?: CalendarRegistry | null) {
  const f = fakeRegistry(over);
  const logged: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const fallback: CrewExec = async (connector, tool, args) => {
    logged.push({ connector, tool, args });
    return { ok: true, via: "log" };
  };
  const cal = withCalendar({ registry: registryOverride === undefined ? f.registry : registryOverride, fallback, say: (l) => said.push(l) });
  return { ...f, ...cal, logged, said };
}

const RAW = { title: VIEWING.title, start: VIEWING.start, duration_min: 30 };

describe("withCalendar", () => {
  it("connected: books the event on Composio with the mapped arguments and returns its id", async () => {
    const t = setup();
    const r = await t.execute("composio", CALENDAR_TOOL, RAW);
    expect(r).toEqual({ ok: true, via: "composio", ref: "evt_42" });
    expect(t.statusCalls).toEqual([["googlecalendar"]]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ connector: "composio", tool: CALENDAR_TOOL, args: calendarEventArgs(VIEWING) });
    expect(t.logged).toEqual([]);
    expect(t.stats).toMatchObject({ created: 1, failed: 0, logged: 0, touched: true });
    // the link (its eid embeds the owner's address) is not kept
    expect(JSON.stringify(r)).not.toContain("eid=");
  });

  it("not connected: Log connector, one line saying why, nothing sent to Composio", async () => {
    const t = setup({ appStatus: async () => ({ googlecalendar: 0 }) });
    const r = await t.execute("composio", CALENDAR_TOOL, RAW);
    expect(r).toEqual({ ok: true, via: "log" });
    expect(t.calls).toEqual([]);
    expect(t.logged).toEqual([{ connector: "log", tool: CALENDAR_TOOL, args: RAW }]);
    expect(t.said).toHaveLength(1);
    expect(t.said[0]).toMatch(/Google Calendar is not connected in Composio.*Log connector, not booked/);
    expect(t.stats).toMatchObject({ created: 0, failed: 0, logged: 1 });
  });

  it("no Composio connector (no key): Log connector, and the registry is never asked about accounts", async () => {
    const t = setup({ list: () => [{ id: "log", kind: "log" }] });
    expect(await t.execute("composio", CALENDAR_TOOL, RAW)).toEqual({ ok: true, via: "log" });
    expect(t.statusCalls).toEqual([]);
    expect(t.said[0]).toMatch(/COMPOSIO_API_KEY is not set/);
    const none = setup({}, null);
    expect(await none.execute("composio", CALENDAR_TOOL, RAW)).toEqual({ ok: true, via: "log" });
    expect(none.stats.touched).toBe(false);
  });

  it("cannot check the connection: Log connector, with the reason", async () => {
    const t = setup({ appStatus: async () => { throw new Error("network down"); } });
    expect(await t.execute("composio", CALENDAR_TOOL, RAW)).toEqual({ ok: true, via: "log" });
    expect(t.said[0]).toMatch(/could not be checked \(network down\)/);
    expect(t.calls).toEqual([]);
  });

  it("a real attempt that fails is reported failed and does NOT fall back to the Log", async () => {
    const t = setup({ execute: async () => ({ ok: false, error: "403 insufficient scopes for ck_abc123", connector: "composio" }) });
    const r = await t.execute("composio", CALENDAR_TOOL, RAW);
    expect(r).toEqual({ ok: false, via: "composio", error: "403 insufficient scopes for [key]" });
    expect(t.logged).toEqual([]);
    expect(t.stats).toMatchObject({ created: 0, failed: 1, logged: 0 });
    expect(t.said[0]).toMatch(/failed/);

    const boom = setup({ execute: async () => { throw new Error("socket hang up"); } });
    expect(await boom.execute("composio", CALENDAR_TOOL, RAW)).toEqual({ ok: false, via: "composio", error: "socket hang up" });
    expect(boom.logged).toEqual([]);
  });

  it("a slot it cannot map fails before anything is sent", async () => {
    const t = setup();
    const r = await t.execute("composio", CALENDAR_TOOL, { ...RAW, start: "besok" });
    expect(r).toMatchObject({ ok: false, via: "composio" });
    expect(r.error).toMatch(/YYYY-MM-DD HH:MM/);
    expect(t.calls).toEqual([]);
    expect(t.logged).toEqual([]);
  });

  it("every other call goes to the fallback untouched, even when Google Calendar is connected", async () => {
    const t = setup();
    expect(await t.execute("log", "WHATSAPP_REPLY", { to: "p1", text: "hai" })).toEqual({ ok: true, via: "log" });
    expect(await t.execute("log", "INSTAGRAM_POST", { caption: "x" })).toEqual({ ok: true, via: "log" });
    // an old playbook that still names the Log connector for the calendar stays on the Log
    expect(await t.execute("log", CALENDAR_TOOL, RAW)).toEqual({ ok: true, via: "log" });
    expect(t.logged.map((l) => [l.connector, l.tool])).toEqual([["log", "WHATSAPP_REPLY"], ["log", "INSTAGRAM_POST"], ["log", CALENDAR_TOOL]]);
    expect(t.statusCalls).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.stats.touched).toBe(false);
  });
});
