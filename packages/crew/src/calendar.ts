// Viewing booking on Google Calendar through Composio (Playbook B, step b3_viewing).
// calendarEventArgs is pure: Reeve's { title, start, duration_min } to the arguments of Composio's
// GOOGLECALENDAR_CREATE_EVENT. withCalendar wraps a crew executor: that one tool goes to Composio when
// the owner's Google Calendar is connected, and to the Log connector (the fallback) when it is not.
// A real attempt that fails is returned as failed; it never falls back to the Log afterwards.
import type { ExecResult } from "./crew";

export const CALENDAR_TOOL = "GOOGLECALENDAR_CREATE_EVENT";
/** Composio's name for the toolkit CALENDAR_TOOL belongs to. */
export const CALENDAR_TOOLKIT = "googlecalendar";
export const VIEWING_TIMEZONE = "Asia/Jakarta";

export interface ViewingEvent {
  /** Pseudonymous: "Survei kamar 7: Prospek P1". */
  title: string;
  /** Local (WIB) slot as the playbook writes it: "2026-12-02 10:00". */
  start: string;
  duration_min?: number;
}

const SLOT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const DESCRIPTION = "Jadwal survei kamar kos, dibuat otomatis oleh Reeve (asisten AI), bukan oleh pemilik. Nama calon penghuni disamarkan. Tidak ada undangan yang dikirim ke siapa pun.";

const naive = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/**
 * Arguments for GOOGLECALENDAR_CREATE_EVENT (schema read from Composio): summary, start_datetime and
 * end_datetime as naive "YYYY-MM-DDTHH:MM:SS" plus an IANA timezone, calendar_id "primary". No attendees
 * and send_updates "none", so nothing is emailed; create_meeting_room false, because the viewing is in
 * person and Composio would otherwise add a Google Meet link. Throws on a slot it cannot read.
 */
export function calendarEventArgs(ev: ViewingEvent): Record<string, unknown> {
  const title = ev.title.trim();
  if (!title) throw new Error("the viewing has no title");
  const m = SLOT.exec(ev.start.trim());
  if (!m) throw new Error(`viewing slot "${ev.start}" is not YYYY-MM-DD HH:MM`);
  const minutes = ev.duration_min ?? 30;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error(`viewing length ${minutes} min is not a whole number of minutes between 1 and 1440`);
  const startMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const start = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
  // A date that does not exist (2026-02-31, 25:00) rolls over in Date.UTC and no longer round-trips.
  if (!Number.isFinite(startMs) || naive(startMs) !== start) throw new Error(`viewing slot "${ev.start}" is not a real date and time`);
  return {
    summary: title,
    start_datetime: start,
    end_datetime: naive(startMs + minutes * 60_000),
    timezone: VIEWING_TIMEZONE,
    calendar_id: "primary",
    description: DESCRIPTION,
    send_updates: "none",
    create_meeting_room: false,
  };
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The created event's id, wherever the tool answer puts it (response_data.id, data.id or id). Not the
 * htmlLink: its eid is the event id plus the calendar's address, which is the owner's email.
 */
export function eventRef(data: unknown): string | undefined {
  const o = rec(data);
  for (const c of [rec(o?.response_data), rec(o?.data), o]) if (typeof c?.id === "string" && c.id) return c.id;
  return undefined;
}

/** What withCalendar needs from the connector registry; ConnectorRegistry from @reeve/connectors fits, and tests pass a fake. */
export interface CalendarRegistry {
  list(): { id: string; kind: string }[];
  /** Active accounts per toolkit (action "list" only: it never starts a connection). */
  appStatus(toolkits: string[]): Promise<Record<string, number>>;
  execute(connector: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string; connector: string }>;
}

export type CrewExec = (connector: string, tool: string, args: Record<string, unknown>) => Promise<ExecResult>;

export interface CalendarStats {
  /** Events Composio created. */
  created: number;
  /** Real attempts that failed. */
  failed: number;
  /** Calendar calls that went to the fallback because Google Calendar could not be used. */
  logged: number;
  /** The registry was used at all (its connection may need closing). */
  touched: boolean;
}

const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/ck_[A-Za-z0-9_-]+/g, "[key]").replace(/\s+/g, " ").slice(0, 200);

/** Why Google Calendar cannot be used right now, or null when it can. */
async function unavailable(registry: CalendarRegistry | null): Promise<string | null> {
  if (!registry || !registry.list().some((c) => c.kind === "composio")) return "no Composio connector (COMPOSIO_API_KEY is not set)";
  try {
    return ((await registry.appStatus([CALENDAR_TOOLKIT]))[CALENDAR_TOOLKIT] ?? 0) > 0 ? null : "Google Calendar is not connected in Composio";
  } catch (e) {
    return `the Google Calendar connection could not be checked (${oneLine(e)})`;
  }
}

/**
 * Wraps a crew executor. connector "composio" with GOOGLECALENDAR_CREATE_EVENT books a real event when
 * Google Calendar is connected; every other call, and that one when it is not connected, goes to
 * `fallback` (the Log connector) exactly as before. `say` gets one line per calendar call.
 */
export function withCalendar(opts: { registry: CalendarRegistry | null; fallback: CrewExec; say?: (line: string) => void }): { execute: CrewExec; stats: CalendarStats } {
  const stats: CalendarStats = { created: 0, failed: 0, logged: 0, touched: false };
  const execute: CrewExec = async (connector, tool, args) => {
    if (connector !== "composio" || tool !== CALENDAR_TOOL) return opts.fallback(connector, tool, args);
    const registry = opts.registry;
    if (registry) stats.touched = true;
    const why = await unavailable(registry);
    if (why || !registry) {
      stats.logged++;
      opts.say?.(`calendar: ${why}; the viewing is recorded on the Log connector, not booked`);
      return opts.fallback("log", tool, args);
    }
    const fail = (error: string): ExecResult => {
      stats.failed++;
      opts.say?.(`calendar: Google Calendar via Composio failed: ${error}`);
      return { ok: false, via: "composio", error };
    };
    let mapped: Record<string, unknown>;
    try {
      mapped = calendarEventArgs({ title: String(args.title ?? ""), start: String(args.start ?? ""), duration_min: args.duration_min === undefined ? undefined : Number(args.duration_min) });
    } catch (e) {
      return fail(oneLine(e));
    }
    try {
      const r = await registry.execute("composio", tool, mapped);
      if (!r.ok) return fail(oneLine(r.error ?? "the tool failed"));
      stats.created++;
      const ref = eventRef(r.data);
      opts.say?.(`calendar: event created in Google Calendar via ${r.connector === "composio" ? "Composio" : r.connector}${ref ? ` (${ref})` : ""}`);
      return { ok: true, via: r.connector, ...(ref ? { ref } : {}) };
    } catch (e) {
      return fail(oneLine(e));
    }
  };
  return { execute, stats };
}
