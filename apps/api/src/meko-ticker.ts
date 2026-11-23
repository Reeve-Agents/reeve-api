// In-process scheduler for the live billing tick (REEVE_MEKO_TICK=on). No new dependency: timers, like
// the operation scheduler in app.ts. One tick shortly after start-up, then one every day at about
// 08:00 WIB (each wait is computed from the clock, so it does not drift). A tick is idempotent per
// day, so a restart on the same day does nothing twice. A second timer runs staged reminders whose
// 10-minute undo window has passed, every minute, so they go out without anyone opening the app.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WIB = 7 * HOUR;

/** Milliseconds from `now` to the next 08:00 (Asia/Jakarta is UTC+7, no daylight saving); a full day when it is 08:00 exactly. */
export function msUntilNextTick(now: number, hourWib = 8): number {
  const local = now + WIB;
  let target = Math.floor(local / DAY) * DAY + hourWib * HOUR;
  if (target <= local) target += DAY;
  return target - local;
}

export interface TickerDeps {
  tick: () => Promise<unknown>;
  flush: () => Promise<unknown>;
  now?: () => number;
  /** Wait before the first tick, so the server and Meko are up. */
  startDelayMs?: number;
  flushEveryMs?: number;
  log?: (line: string) => void;
  /** Injectable for tests. */
  timers?: { setTimeout: typeof setTimeout; setInterval: typeof setInterval; clearTimeout: typeof clearTimeout; clearInterval: typeof clearInterval };
}

export function startMekoTicker(deps: TickerDeps): { stop(): void } {
  const t = deps.timers ?? { setTimeout, setInterval, clearTimeout, clearInterval };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l) => console.log(l));
  let next: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const guarded = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      log(`meko ${what} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  };
  const arm = (ms: number) => {
    if (stopped) return;
    next = t.setTimeout(() => {
      void guarded("tick", deps.tick).then(() => arm(msUntilNextTick(now())));
    }, ms);
    next.unref?.();
  };
  arm(deps.startDelayMs ?? 30_000);
  const flushing = t.setInterval(() => void guarded("flush", deps.flush), deps.flushEveryMs ?? 60_000);
  flushing.unref?.();
  return {
    stop() {
      stopped = true;
      if (next) t.clearTimeout(next);
      t.clearInterval(flushing);
    },
  };
}
