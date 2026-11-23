import { describe, expect, it, vi } from "vitest";
import { msUntilNextTick, startMekoTicker } from "../src/meko-ticker";

const HOUR = 3_600_000;

describe("msUntilNextTick", () => {
  it("counts to the next 08:00 WIB (01:00 UTC)", () => {
    expect(msUntilNextTick(Date.parse("2026-12-04T00:00:00Z"))).toBe(1 * HOUR); // 07:00 WIB
    expect(msUntilNextTick(Date.parse("2026-12-04T01:00:00Z"))).toBe(24 * HOUR); // exactly 08:00: tomorrow
    expect(msUntilNextTick(Date.parse("2026-12-04T10:00:00Z"))).toBe(15 * HOUR); // 17:00 WIB
    expect(msUntilNextTick(Date.parse("2026-12-04T18:30:00Z"))).toBe(6.5 * HOUR); // 01:30 WIB next day
  });
});

describe("startMekoTicker", () => {
  it("ticks after the start delay, then at 08:00 WIB every day, flushing every minute; a failure is logged and does not stop it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-12-04T03:00:00Z")); // 10:00 WIB
      const ticks: string[] = [];
      const flushes: number[] = [];
      const logs: string[] = [];
      let fail = true;
      const t = startMekoTicker({
        tick: async () => {
          ticks.push(new Date().toISOString());
          if (fail) throw new Error("meko down");
        },
        flush: async () => void flushes.push(Date.now()),
        log: (l) => logs.push(l),
        startDelayMs: 30_000,
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(ticks).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ticks).toHaveLength(1);
      expect(logs).toEqual(["meko tick failed: meko down"]);
      fail = false;
      await vi.advanceTimersByTimeAsync(30_000); // 61 s since start: the first minute flush
      expect(flushes.length).toBe(1);
      // next tick: 08:00 WIB the next day = 2026-12-05T01:00Z
      await vi.advanceTimersByTimeAsync(Date.parse("2026-12-05T00:59:00Z") - Date.now());
      expect(ticks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(ticks).toHaveLength(2);
      expect(ticks[1]!.startsWith("2026-12-05T01:00")).toBe(true);
      t.stop();
      const n = flushes.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(flushes).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(2 * 24 * HOUR);
      expect(ticks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startMekoTicker: the start-up tick", () => {
  async function run(startAt: string, over: { isDone?: () => boolean } = {}, forMs = 2 * HOUR) {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(startAt));
      const ticks: string[] = [];
      const t = startMekoTicker({ tick: async () => void ticks.push(new Date().toISOString()), flush: async () => undefined, now: () => Date.now(), startDelayMs: 30_000, log: () => undefined, ...over });
      await vi.advanceTimersByTimeAsync(forMs);
      t.stop();
      return ticks;
    } finally {
      vi.useRealTimers();
    }
  }

  it("does not tick at night: a start at 03:00 WIB waits for 08:00 WIB", async () => {
    // 2026-12-04T20:00Z is 03:00 WIB on the 5th; 08:00 WIB is 01:00Z
    expect(await run("2026-12-04T20:00:00Z", {}, 4 * HOUR)).toEqual([]); // 07:00 WIB: still nothing
    const ticks = await run("2026-12-04T20:00:00Z", {}, 5 * HOUR + 60_000);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.startsWith("2026-12-05T01:00")).toBe(true);
  });

  it("a start just before 08:00 WIB ticks at 08:00, not 30 seconds after start", async () => {
    const ticks = await run("2026-12-04T00:59:00Z", {}, 2 * 60_000); // 07:59 WIB
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.startsWith("2026-12-04T01:00")).toBe(true);
  });

  it("ticks 30 seconds after start from 08:00 WIB on", async () => {
    const ticks = await run("2026-12-04T01:00:00Z", {}, 60_000); // exactly 08:00 WIB
    expect(ticks).toEqual(["2026-12-04T01:00:30.000Z"]);
    expect(await run("2026-12-04T15:00:00Z", {}, 60_000)).toHaveLength(1); // 22:00 WIB: still the same day's tick
  });

  it("does not tick at start-up when today's tick is already done; it waits for tomorrow's 08:00 WIB", async () => {
    expect(await run("2026-12-04T03:00:00Z", { isDone: () => true }, 2 * HOUR)).toEqual([]); // 10:00 WIB
    const ticks = await run("2026-12-04T03:00:00Z", { isDone: () => true }, 24 * HOUR);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.startsWith("2026-12-05T01:00")).toBe(true);
  });
});
