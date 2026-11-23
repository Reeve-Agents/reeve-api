import { describe, expect, it } from "vitest";
import { ASK_SYSTEM, AskBusiness, type AskLlm, maskNames, numbersIn, rentTick, type TenantBill } from "../src/index";
import { testDeps } from "./helpers";

const bills = (): TenantBill[] => [
  { id: "K03", room: "3", due: "2026-12-01", paid: false, tenure_months: 4 },
  { id: "K05", room: "5", due: "2026-12-01", paid: false, tenure_months: 3 },
  { id: "K08", room: "8", due: "2026-12-01", paid: false, tenure_months: 14 },
];

async function seeded() {
  const { ws } = await testDeps();
  const run = ws.run("run_tick");
  const owner = await run.agent("owner", "Izin");
  await owner.remember("Kamar 3 boleh telat sampai 10 hari, izin pemilik.", { kind: "owner_exception", room: "3" }, { promote: true });
  await rentTick(run, bills(), "2026-12-09", { execute: async () => ({ ok: true, via: "log" }) });
  return ws;
}

/** A fake model that records what it was shown and replies with `reply` (or what `reply(user)` returns). */
function fakeLlm(reply: string | ((user: string) => string)) {
  const seen: { system: string; user: string }[] = [];
  const llm: AskLlm = async (system, user) => {
    seen.push({ system, user });
    return { text: typeof reply === "function" ? reply(user) : reply, usage: { name: "ask_answer", model: "claude-haiku-5-5", input_tokens: 900, output_tokens: 60 } };
  };
  return { llm, seen };
}

/** The tag of the first record whose header line contains `action`. */
const tagOf = (user: string, action: string) => user.split("\n").find((l) => l.startsWith("[R") && l.includes(`aksi ${action}`))!.match(/^\[(R\d+)\]/)![1]!;

const OPEN_Q = "Berapa total yang harus saya bayar bulan ini?";
const lastAsk = (ws: Awaited<ReturnType<typeof seeded>>) => ws.decisions({ agent: "ask" }).at(-1)!;

describe("Tanya usaha with an LLM for open questions", () => {
  it("without an LLM, an open question gets the template reply", async () => {
    const ws = await seeded();
    const a = await new AskBusiness(ws).ask(OPEN_Q, { role: "tenant", subject: "K05" });
    expect(a.kind).toBe("unknown");
    expect(a.proofs).toEqual([]);
  });

  it("answers from cited receipts, and a tenant is shown only their own decisions", async () => {
    const ws = await seeded();
    const { llm, seen } = fakeLlm((u) => `Anda kena denda Rp75.000 karena telat 8 hari [${tagOf(u, "charge_fee")}].`);
    const a = await new AskBusiness(ws, undefined, llm).ask(OPEN_Q, { role: "tenant", subject: "K05" });
    expect(a.kind).toBe("open");
    expect(a.model).toBe("claude-haiku-5-5");
    expect(a.text).toMatch(/^Anda kena denda Rp75\.000 karena telat 8 hari\./);
    expect(a.text).not.toMatch(/\[R\d+\]/);
    expect(a.text).toContain("(Jawaban ini disusun AI dari catatan yang dikutip.)");
    expect(a.proofs).toHaveLength(1);
    const cited = ws.decisions().find((d) => d.entry_hash === a.proofs[0]!.receipt);
    expect(cited?.subject).toBe("K05");
    expect(seen[0]!.system).toBe(ASK_SYSTEM);
    expect(seen[0]!.user).toContain("tentang K05");
    expect(seen[0]!.user).not.toMatch(/K03|K08/);
    expect(seen[0]!.user).not.toContain("Catatan bersama");
    const d = lastAsk(ws);
    expect(d.action).toBe("explain");
    const msg = (await ws.conversation(d.agent, d.conversation_id)).messages.find((m) => m.metadata?.reeve_receipt === d.entry_hash)!;
    expect(JSON.parse(msg.output)).toMatchObject({ kind: "open", answered_by: "claude-haiku-5-5", proofs: [a.proofs[0]!.receipt] });
    expect(msg.metadata?.reeve_usage).toMatchObject({ model: "claude-haiku-5-5", input_tokens: 900 });
    expect(msg.reasoning).toMatch(/cites 1 of them. Code checked/);
  });

  it("the owner sees every room and the shared notes", async () => {
    const ws = await seeded();
    const { llm, seen } = fakeLlm("Kamar 3 ditahan karena ada izin pemilik [R1, R2].");
    const a = await new AskBusiness(ws, undefined, llm).ask("Bulan ini apa saja yang terjadi di kamar 3?", { role: "owner" });
    expect(a.kind).toBe("open");
    expect(a.proofs.length).toBe(2);
    expect(seen[0]!.user).toContain("Catatan bersama");
    expect(seen[0]!.user.split("\n").find((l) => l.startsWith("[R1]"))).toContain("K03");
  });

  it.each([
    ["no citation", "Anda harus bayar Rp1.500.000."],
    ["only a made-up citation", "Anda harus bayar Rp1.500.000 [R99]."],
    ["the no-answer word", "TIDAK_ADA"],
    ["the no-answer word after an apology", "Maaf, TIDAK_ADA"],
    ["a valid tag next to one it was not shown", "Denda Anda tercatat [R1, R99]."],
    ["an amount its record does not hold", "Anda harus bayar Rp1.234.567 [R1]."],
    ["another room code", "Kamar Anda sama dengan K08 [R1]."],
  ])("drops an answer with %s and falls back to the template", async (_, reply) => {
    const ws = await seeded();
    const { llm } = fakeLlm(reply);
    const a = await new AskBusiness(ws, undefined, llm).ask(OPEN_Q, { role: "tenant", subject: "K05" });
    expect(a.kind).toBe("unknown");
    expect(a.proofs).toEqual([]);
    expect(a.text).toMatch(/Belum ada keputusan yang cocok/);
    const d = lastAsk(ws);
    const msg = (await ws.conversation(d.agent, d.conversation_id)).messages.find((m) => m.metadata?.reeve_receipt === d.entry_hash)!;
    expect(msg.reasoning).toMatch(/no LLM answer used/);
    expect(msg.metadata?.reeve_usage).toBeTruthy();
  });

  it("falls back when the model call fails, keeps the tokens it spent, and never asks for a tenant without a pseudonym", async () => {
    const ws = await seeded();
    const failing: AskLlm = async () => {
      throw Object.assign(new Error("returned no text"), { usage: { name: "ask_answer", model: "claude-haiku-5-5", input_tokens: 800, output_tokens: 1500 } });
    };
    const a = await new AskBusiness(ws, undefined, failing).ask(OPEN_Q, { role: "tenant", subject: "K05" });
    expect(a.kind).toBe("unknown");
    const d = lastAsk(ws);
    const msg = (await ws.conversation(d.agent, d.conversation_id)).messages.find((m) => m.metadata?.reeve_receipt === d.entry_hash)!;
    expect(msg.metadata?.reeve_usage).toMatchObject({ output_tokens: 1500 });
    const anon = fakeLlm("x [R1]");
    expect((await new AskBusiness(ws, undefined, anon.llm).ask(OPEN_Q, { role: "tenant" })).kind).toBe("unknown");
    expect(anon.seen).toHaveLength(0);
  });

  it("pattern questions never call the model", async () => {
    const ws = await seeded();
    const { llm, seen } = fakeLlm("x [R1]");
    const fee = await new AskBusiness(ws, undefined, llm).ask("Kenapa saya didenda?", { role: "tenant", subject: "K05" });
    expect(fee.kind).toBe("why_fee");
    expect(seen).toHaveLength(0);
  });

  it("skips the model and the Meko fetches once the daily cap is reached", async () => {
    const ws = await seeded();
    const { llm, seen } = fakeLlm("x [R1]");
    llm.remaining = () => 0;
    let fetches = 0;
    const conv = ws.conversation.bind(ws);
    ws.conversation = async (...args) => (fetches++, conv(...args));
    const a = await new AskBusiness(ws, undefined, llm).ask(OPEN_Q, { role: "owner" });
    expect(a.kind).toBe("unknown");
    expect(seen).toHaveLength(0);
    expect(fetches).toBe(0);
  });

  it("masks names in the question, and reads tags after a full stop and tag ranges", async () => {
    const ws = await seeded();
    const { llm, seen } = fakeLlm("Kamar 3 ditahan karena izin pemilik. [R1-R2] Catatan lain tidak ada.");
    const a = await new AskBusiness(ws, undefined, llm).ask("Apakah Budi Santoso di kamar 3 ditahan?", { role: "owner" });
    expect(seen[0]!.user).toContain("Pertanyaan: Apakah [nama] [nama] di kamar 3 ditahan?");
    expect(a.kind).toBe("open");
    expect(a.proofs).toHaveLength(2);
  });
});

describe("ask helpers", () => {
  it("normalises numbers", () => {
    expect(numbersIn("Rp75.000 dan Rp1.500.000, jatuh tempo 2026-12-01, 5%")).toEqual(["75000", "1500000", "2026", "12", "1", "5"]);
  });
  it("masks names but keeps question words, months and codes", () => {
    expect(maskNames("Kenapa Budi di Kamar 5 (K05) didenda Desember?")).toBe("Kenapa [nama] di Kamar 5 (K05) didenda Desember?");
  });
});
