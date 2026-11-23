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
