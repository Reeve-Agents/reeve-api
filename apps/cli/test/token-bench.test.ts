import { describe, expect, it } from "vitest";
import { aggregate, assertPseudonymised, baselineUser, buildEvents, decideRent, exceptionFor, isCorrect, parseDecision, projectReeve, ratio, sampleHistory, scoreRun, stat, type RunRow } from "../src/token-bench-lib";

describe("ground truth", () => {
  const fee = { due: "2026-09-01", tenure_months: 3, fee_charged: false };
  it("follows the cards: reminders H+3 and H+10, fee H+7 (+3 for 12 months), notice H+14", () => {
    expect(decideRent(fee, "2026-09-04", null).action).toBe("remind");
    expect(decideRent(fee, "2026-09-06", null).action).toBe("none");
    expect(decideRent(fee, "2026-09-08", null)).toMatchObject({ action: "charge_fee", amount_idr: 75_000 });
    expect(decideRent({ ...fee, fee_charged: true }, "2026-09-11", null).action).toBe("remind");
    expect(decideRent({ ...fee, fee_charged: true }, "2026-09-15", null).action).toBe("notice");
    const vet = { ...fee, tenure_months: 14 };
    expect(decideRent(vet, "2026-09-08", null).action).toBe("none");
    expect(decideRent(vet, "2026-09-11", null).action).toBe("charge_fee");
  });
  it("holds a fee inside an owner exception, and charges once it runs out", () => {
    expect(decideRent(fee, "2026-09-08", 15).action).toBe("hold");
    expect(decideRent(fee, "2026-09-17", 15).action).toBe("charge_fee");
  });
});

describe("events of the Kos Melati history", () => {
  const h = sampleHistory();
  const events = buildEvents(h);
  it("covers the 36 bills, pseudonymised, with the planted exception", () => {
    expect(new Set(events.map((e) => `${e.month}${e.subject}`)).size).toBe(36);
    expect(JSON.stringify(h)).not.toMatch(/Sinta|Ratna/);
    expect(exceptionFor(h, "3", "2026-09-08")).toBe(15);
    expect(exceptionFor(h, "3", "2026-09-04")).toBeNull(); // the permission is not in the chat yet
    const holds = events.filter((e) => e.expected.action === "hold");
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((e) => e.subject === "K03" && e.month === "2026-09")).toBe(true);
  });
  it("has every kind of decision and charges a fee once per bill", () => {
    const kinds = new Set(events.map((e) => e.expected.action));
    for (const k of ["remind", "charge_fee", "hold", "notice", "none"]) expect(kinds.has(k as never)).toBe(true);
    const fees = events.filter((e) => e.expected.action === "charge_fee");
    expect(new Set(fees.map((e) => `${e.month}${e.subject}`)).size).toBe(fees.length);
    expect(fees.every((e) => e.expected.amount_idr === 75_000)).toBe(true);
  });
  it("shows the baseline prompt only history before the day, with no real name", () => {
    const e = events.find((x) => x.expected.action === "hold")!;
    const text = baselineUser("SOP", h, e);
    expect(() => assertPseudonymised(text)).not.toThrow();
    expect(text).toContain("boleh telat sampai 15 hari");
    expect(text).not.toContain("2026-10-");
    expect(() => assertPseudonymised("Mas Dimas")).toThrow();
  });
});

describe("scoring", () => {
  it("reads strict JSON, maps escalate to notice, rejects the rest", () => {
    expect(parseDecision('{"action":"charge_fee","amount_idr":75000,"message":"x"}')).toEqual({ action: "charge_fee", amount_idr: 75000 });
    expect(parseDecision('```json\n{"action":"escalate","amount_idr":null}\n```')).toEqual({ action: "notice" });
    expect(parseDecision('{"action":"charge_fee","amount_idr":"Rp75.000"}')).toEqual({ action: "charge_fee", amount_idr: 75000 });
    expect(parseDecision("remind")).toBeNull();
    expect(parseDecision('{"action":"call the police"}')).toBeNull();
  });
  it("needs the right fee amount, not only the right action", () => {
    expect(isCorrect({ action: "charge_fee", amount_idr: 75_000 }, { action: "charge_fee", amount_idr: 150_000 })).toBe(false);
    expect(isCorrect({ action: "charge_fee", amount_idr: 75_000 }, { action: "charge_fee", amount_idr: 75_000 })).toBe(true);
    expect(isCorrect({ action: "hold" }, { action: "charge_fee", amount_idr: 75_000 })).toBe(false);
    expect(isCorrect({ action: "none" }, null)).toBe(false);
  });
  it("scores a run per action and counts invalid replies", () => {
    const s = scoreRun([
      { expected: { action: "none" }, got: { action: "none" } },
      { expected: { action: "hold" }, got: { action: "charge_fee", amount_idr: 75_000 } },
      { expected: { action: "remind" }, got: null },
      { expected: { action: "charge_fee", amount_idr: 75_000 }, got: { action: "charge_fee", amount_idr: 75_000 } },
    ]);
    expect(s).toMatchObject({ total: 4, correct: 2, accuracy: 50, invalid: 1 });
    expect(s.byAction.hold).toEqual([0, 1]);
    expect(s.byAction.charge_fee).toEqual([1, 1]);
  });
});

describe("aggregation", () => {
  const row = (n: number, acc: number): RunRow => ({ arm: "baseline", run: n, calls: 10, input_tokens: n * 100, output_tokens: n, cost_usd: n / 1000, wall_ms: n, scored: { total: 10, correct: acc / 10, accuracy: acc, invalid: 0, byAction: {} as never } });
  it("computes mean, median, min and max", () => {
    expect(stat([4, 1, 3, 2])).toEqual({ n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
    expect(stat([])).toMatchObject({ n: 0, mean: null });
    const a = aggregate([row(1, 80), row(2, 90), row(6, 100)]);
    expect(a.input_tokens).toMatchObject({ mean: 300, median: 200, min: 100, max: 600 });
    expect(a.accuracy.mean).toBe(90);
  });
  it("pays the compile once and projects months from the measured one", () => {
    const p3 = projectReeve({ input: 1000, output: 2000, usd: 0.003 }, { input: 500, output: 100, usd: 0.0001 }, 3);
    expect(p3).toMatchObject({ months: 3, input: 2500, output: 2300 });
    expect(p3.usd).toBeCloseTo(0.0033);
    expect(ratio(10, 4)).toBe(2.5);
    expect(ratio(1, 0)).toBeNull();
  });
});
