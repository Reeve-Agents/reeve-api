import { cloudArgs, cloudResult } from "@reeve/meko";
import { describe, expect, it } from "vitest";
import { exceptionDays } from "../src/tagihan";

describe("Meko Cloud differences", () => {
  it("sends metadata as a JSON string and reads it back as an object", () => {
    expect(cloudArgs({ metadata: { a: 1 }, title: "x" })).toEqual({ metadata: '{"a":1}', title: "x" });
    expect(cloudArgs({ title: "x" })).toEqual({ title: "x" });
    const back = cloudResult({ messages: [{ metadata: '{"reeve_receipt":"abc"}', plan: '["a","b"]', output: { x: 1 }, input: "plain" }] }) as { messages: { metadata: unknown; plan: unknown; output: unknown; input: unknown }[] };
    expect(back.messages[0]).toEqual({ metadata: { reeve_receipt: "abc" }, plan: ["a", "b"], output: '{"x":1}', input: "plain" });
  });

  it("counts only the owner's wording as an exception, not a fact Cloud distilled from a trace", () => {
    expect(exceptionDays("Kamar 3 boleh telat sampai 10 hari untuk tagihan Desember 2026, izin pemilik.", "3")).toBe(10);
    expect(exceptionDays("On November 22, 2026, the user recorded that K05 (kamar 5, room 5) is 10 days late ('telat 10 hari').", "5")).toBeNull();
    expect(exceptionDays("K05 kamar 5: jatuh tempo 2026-12-01, telat 7 hari", "5")).toBeNull();
  });
});
