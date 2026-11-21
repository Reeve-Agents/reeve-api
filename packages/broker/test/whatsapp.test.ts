import { describe, expect, it } from "vitest";
import { prepareAudit } from "@reeve/auditor";
import { compile } from "@reeve/builder";
import { kosMelatiScenario, loadFixtureRulebook, minimarketScenario, repoRoot, runOperate } from "@reeve/pipeline";
import { MockRail } from "@reeve/rails";
import { LocalSandbox } from "@reeve/sandbox";
import {
  contactsFromRecords,
  GenericOperator,
  markPreparedSent,
  messageFor,
  minimarketPack,
  newGenericOperation,
  newOperation,
  normalisePhone,
  Operator,
  OperatorError,
  prepareWhatsApp,
  whatsappLink,
  type GenericOperation,
  type ToolCall,
} from "../src/index";

describe("phone numbers", () => {
  it.each([
    ["0812-3456-7890", "6281234567890"],
    ["0812 3456 7890", "6281234567890"],
    ["+62 812-3456-7890", "6281234567890"],
    ["+6281234567890", "6281234567890"],
    ["6281234567890", "6281234567890"],
    ["0062 812 3456 7890", "6281234567890"],
    ["(0812) 3456.7890", "6281234567890"],
    ["+62 0812 3456 7890", "6281234567890"], // a zero after the country code does not belong there
    ["81234567890", "6281234567890"], // a sheet that stored the number as a number lost its leading zero
    [81234567890, "6281234567890"],
    ["+65 9123 4567", "6591234567"], // another country, written with its plus, is kept
  ])("%s -> %s", (raw, digits) => {
    expect(normalisePhone(raw)).toEqual({ ok: true, digits });
  });

  it.each([
    ["", /no phone/],
    [null, /no phone/],
    ["12345", /too short/],
    ["021-5551234", /not an Indonesian mobile/], // a landline has no WhatsApp
    ["0812 345", /too short|not an Indonesian mobile/],
    ["0812 3456 7890 1234 5678", /not an Indonesian mobile/],
    ["4155552671", /no country code/], // foreign, but without a plus we do not guess
  ])("refuses %s with a reason", (raw, reason) => {
    const r = normalisePhone(raw as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("never leaves the number itself in the reason (it goes on the ledger)", () => {
    const r = normalisePhone("021-5551234");
    expect(r.ok ? "" : r.reason).not.toContain("5551234");
  });
});

describe("wa.me link", () => {
  it("encodes the whole message: newlines, ampersands, question marks, hashes, quotes, accents and emoji", () => {
    const text = "Halo Budi & Ani (kamar A1)?\n\nBayar di: https://pay.example/x?a=1&b=2#top\n\"Terima kasih\" 🙏 — café";
    const url = whatsappLink("6281234567890", text);
    expect(url.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
    expect(url).not.toMatch(/[ \n&#"]/); // nothing that would end or break the query
    expect(url.split("?")).toHaveLength(2);
    expect(url).toContain("%0A%0A");
    expect(decodeURIComponent(new URL(url).searchParams.get("text")!)).toBe(text);
    expect(new URL(url).searchParams.get("text")).toBe(text);
  });

  it("is built from the message body, payment link included", () => {
    const msg = messageFor("reminder", { name: "Budi", room: "A1", amount: 1_500_000, payUrl: "https://pay.example/x?a=1&b=2" });
    const out = prepareWhatsApp(msg, { whatsapp: "0812-3456-7890" }, { id: "wa-1", at: "t", tenant: "K01", ref: "reminder:K01-2026-11" });
    expect(out && "prepared" in out).toBe(true);
    if (out && "prepared" in out) {
      expect(out.prepared).toMatchObject({ channel: "whatsapp_link", to: "6281234567890", status: "prepared", amount: 1_500_000 });
      expect(new URL(out.prepared.url).searchParams.get("text")).toBe(msg.body);
      expect(new URL(out.prepared.url).searchParams.get("text")).toContain("https://pay.example/x?a=1&b=2");
    }
  });

  it("is null without a number and explains an unusable one", () => {
    const msg = messageFor("bill", { name: "B", room: "A1", amount: 1 });
    const meta = { id: "wa-1", at: "t", tenant: "K01", ref: "bill:x" };
    expect(prepareWhatsApp(msg, undefined, meta)).toBeNull();
    expect(prepareWhatsApp(msg, { email: "a@b.id" }, meta)).toBeNull();
    expect(prepareWhatsApp(msg, { whatsapp: "  " }, meta)).toBeNull();
    expect(prepareWhatsApp(msg, { whatsapp: "123" }, meta)).toEqual({ skipped: expect.stringMatching(/too short/) });
  });
});

describe("contact columns", () => {
  it("reads whatsapp, wa, phone and no_hp from the tenant sheet, a WhatsApp column before a plain phone column", () => {
    const rows = (key: string) => contactsFromRecords([{ kamar: "A1", [key]: "0812-1111-2222" }, { kamar: "A2", [key]: "" }], ["A1", "A2"]);
    for (const key of ["whatsapp", "WhatsApp", "wa", "phone", "No HP", "no_hp", "Nomor WA", "telepon"]) expect(rows(key)).toEqual({ A1: { whatsapp: "0812-1111-2222" } });
    const both = contactsFromRecords([{ phone: "0811-0000-0000", wa: "0812-1111-2222", email: "a@b.id" }], ["A1"]);
    expect(both).toEqual({ A1: { email: "a@b.id", whatsapp: "0812-1111-2222" } });
    expect(contactsFromRecords([{ nama: "Budi", kamar: "A1" }], ["A1"])).toEqual({});
  });
});

// ── The rent Operator ──

const rulebook = loadFixtureRulebook();
const rulesPy = compile(rulebook).files["rules.py"];
const constraintsJson = prepareAudit(rulebook, rulesPy).files["constraints.json"]!;
const tenants = kosMelatiScenario().tenants;
const roomOf = (id: string) => tenants.find((t) => t.id === id)!.room;

function setup(contacts: Parameters<typeof newOperation>[0]["contacts"], send?: (c: ToolCall) => Promise<{ ok: boolean; connector: string; error?: string }>) {
  const ledger: { event: string; tenant?: string; ref?: string; channel?: string }[] = [];
  const op = newOperation({ id: "op_wa", rulebookId: "rb", receiptHash: "r".repeat(64), rail: "mock", startDate: "2026-11-01", tenants, contacts });
  const operator = new Operator(op, rulebook, tenants, {
    rail: new MockRail(),
    runRules: (scenario) => runOperate({ repoRoot, rulesPy, constraintsJson, scenario, sandbox: new LocalSandbox() }),
    record: (b) => ledger.push(b),
    save: () => undefined,
    send,
    now: () => new Date("2026-10-18T03:00:00Z"),
  });
  return { op, operator, ledger };
}

describe("rent messages as WhatsApp links", () => {
  const sent: ToolCall[] = [];
  const send = async (c: ToolCall) => {
    sent.push(c);
    if (c.connector === "log") return { ok: true, connector: "log" };
    return String(c.args.chat_id) === "9002" ? { ok: false, connector: "none", error: "no connected service has TELEGRAM_SEND_MESSAGE" } : { ok: true, connector: "composio" };
  };
  const contacts = {
    K01: { whatsapp: "0812-3456-7890" }, // no automatic channel -> link
    K02: { whatsapp: "12345" }, // unusable number -> log, with the reason
    K29: { telegram_chat_id: "9001", whatsapp: "0812-0000-0001" }, // Telegram delivers -> no link
    K30: { telegram_chat_id: "9002", whatsapp: "+62 812 0000 0002" }, // Telegram fails -> link
  };

  it("prepares a link when no automatic channel delivered, never claims it was sent, and keeps Log as the last fallback", async () => {
    const { op, operator, ledger } = setup(contacts, send);
    const day1 = await operator.advance("2026-11-01");
    expect(day1.filter((a) => a.outcome === "invoiced")).toHaveLength(30);
    const prepared = op.prepared ?? [];
    expect(prepared.map((m) => [m.tenant, m.kind, m.status])).toEqual([["K01", "bill", "prepared"], ["K30", "bill", "prepared"]]);
    const k01 = prepared[0]!;
    expect(k01).toMatchObject({ channel: "whatsapp_link", to: "6281234567890", room: roomOf("K01") });
    expect(k01.url).toBe(`https://wa.me/6281234567890?text=${encodeURIComponent(k01.text)}`);
    expect(k01.text).toContain(op.invoices.find((i) => i.tenant === "K01")!.payUrl); // the bill's payment link is in the message
    expect(prepared[1]!.to).toBe("6281200000002");

    // The ledger says "prepared" (channel whatsapp_link), never "message_sent", for these two.
    expect(ledger.filter((l) => l.event === "message_prepared").map((l) => [l.tenant, l.channel])).toEqual([["K01", "whatsapp_link"], ["K30", "whatsapp_link"]]);
    expect(ledger.some((l) => l.event === "message_sent" && (l.tenant === "K01" || l.tenant === "K30"))).toBe(false);
    expect(ledger.filter((l) => l.event === "message_sent").map((l) => l.tenant)).toEqual(["K29"]);
    // The prepared ones did not also go to the Log; the unusable number did, and says why.
    const logged = sent.filter((c) => c.tool === "LOG").map((c) => c.args.room);
    expect(logged).not.toContain(roomOf("K01"));
    expect(logged).not.toContain(roomOf("K30"));
    expect(logged).toContain(roomOf("K02"));
    expect(ledger.find((l) => l.event === "message_logged" && l.tenant === "K02")!.ref).toContain("WhatsApp link skipped");
    expect(op.actions.find((a) => a.tenant === "K02" && a.type === "invoice")!.detail).toContain("WhatsApp link skipped: the number is too short");
    expect(op.actions.find((a) => a.tenant === "K01" && a.type === "invoice")!.detail).toContain("prepared as a WhatsApp link, not sent");
    expect(sent.some((c) => c.tool === "TELEGRAM_SEND_MESSAGE" && c.args.chat_id === "9001")).toBe(true);
  });

  it("a reminder prepared as a link is outcome 'prepared', not 'sent' or 'logged'", async () => {
    const { op, operator } = setup(contacts, send);
    await operator.advance("2026-11-01");
    const day4 = await operator.advance("2026-11-04");
    const by = Object.fromEntries(day4.filter((a) => a.type === "reminder").map((a) => [a.tenant, a]));
    expect(by.K01!.outcome).toBe("prepared");
    expect(by.K30!.outcome).toBe("prepared");
    expect(by.K29!.outcome).toBe("sent");
    expect(by.K02!.outcome).toBe("logged");
    expect(by.K03!.outcome).toBe("logged"); // no contact at all
    expect((op.prepared ?? []).filter((m) => m.tenant === "K01").map((m) => m.kind)).toEqual(["bill", "reminder"]);
    expect(new Set((op.prepared ?? []).map((m) => m.id)).size).toBe(op.prepared!.length);
  });

  it("without any connector the WhatsApp link is still the outcome before the log", async () => {
    const { op, operator } = setup({ K01: { whatsapp: "081234567890" } });
    await operator.advance("2026-11-01");
    expect((op.prepared ?? []).map((m) => m.tenant)).toEqual(["K01"]);
  });

  it("a reminder held because the tenant promised to pay prepares nothing", async () => {
    const { op, operator } = setup({ K01: { whatsapp: "081234567890" } }, send);
    await operator.advance("2026-11-01");
    const before = op.prepared!.length;
    (op as { holds?: Record<string, string> }).holds = { "K01-2026-11": "2026-11-20" };
    const day4 = await operator.advance("2026-11-04");
    const k01 = day4.find((a) => a.type === "reminder" && a.tenant === "K01")!;
    expect(k01.outcome).toBe("logged");
    expect(k01.detail).toContain("held");
    expect(op.prepared).toHaveLength(before);
  });

  it("the owner marking a message sent is recorded once, however many times they tap", async () => {
    const { op, operator, ledger } = setup({ K01: { whatsapp: "081234567890" } }, send);
    await operator.advance("2026-11-01");
    const id = op.prepared![0]!.id;
    const ctx = { now: new Date("2026-11-02T01:00:00Z"), record: (b: Parameters<typeof ledger.push>[0]) => ledger.push(b), save: () => undefined };
    const first = markPreparedSent(op.prepared, id, ctx);
    expect(first.changed).toBe(true);
    expect(first.message).toMatchObject({ status: "sent_by_owner", sentAt: "2026-11-02T01:00:00.000Z" });
    const again = markPreparedSent(op.prepared, id, { ...ctx, now: new Date("2026-11-03T00:00:00Z") });
    expect(again.changed).toBe(false);
    expect(again.message.sentAt).toBe("2026-11-02T01:00:00.000Z"); // the first time stays
    expect(ledger.filter((l) => l.event === "message_sent_by_owner")).toEqual([expect.objectContaining({ tenant: "K01", channel: "whatsapp_link" })]);
    expect(() => markPreparedSent(op.prepared, "wa-nope", ctx)).toThrow(OperatorError);
    expect(() => markPreparedSent(undefined, id, ctx)).toThrow(OperatorError);
  });
});

// ── Purchase orders to suppliers (the generic Operator) ──

describe("minimarket purchase orders as WhatsApp links", () => {
  const rb = loadFixtureRulebook("minimarket");
  const mmRules = compile(rb).files["rules.py"];
  const mmConstraints = prepareAudit(rb, mmRules).files["constraints.json"]!;

  function mm(suppliers: Record<string, { whatsapp?: string; telegram_chat_id?: string }>) {
    const calls: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
    const ledger: { event: string; tenant?: string; channel?: string }[] = [];
    const scenario = minimarketScenario();
    const op = newGenericOperation({ id: "op_mm", rulebookId: "rb", receiptHash: "r", datasetId: "sample", startDate: scenario.start_date }) as GenericOperation;
    const operator = new GenericOperator(op, rb, {
      runRules: (s) => runOperate({ repoRoot, rulesPy: mmRules, constraintsJson: mmConstraints, scenario: s, sandbox: new LocalSandbox() }),
      execute: async (connector, tool, args) => {
        calls.push({ connector, tool, args });
        return tool === "LOG" ? { ok: true, connector: "log" } : { ok: false, connector: "none", error: `no connected service has ${tool}` };
      },
      records: async () => [],
      pack: minimarketPack(scenario, suppliers),
      record: (b) => ledger.push(b),
      save: () => undefined,
    });
    return { op, operator, calls, ledger };
  }

  it("prepares a link for orders that go out; an order held above the limit prepares nothing until the owner approves it", async () => {
    const { op, operator, calls, ledger } = mm({ A: { whatsapp: "0812-1000-0001" }, B: { whatsapp: "0812-1000-0002" } });
    await operator.advance("2026-11-03");
    const prepared = op.prepared ?? [];
    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.every((m) => m.kind === "purchase_order" && m.status === "prepared" && m.url.startsWith("https://wa.me/62812100000"))).toBe(true);
    // These orders went out as links: no log line for them, and the action is "done by whatsapp_link", not "sent".
    expect(calls.filter((c) => c.tool === "LOG")).toHaveLength(0);
    expect(op.sent.filter((s) => s.via === "whatsapp_link")).toHaveLength(prepared.length);
    expect(op.sent.every((s) => s.ok)).toBe(true);
    expect(ledger.filter((l) => l.event === "message_prepared")).toHaveLength(prepared.length);
    expect(ledger.some((l) => l.event === "message_sent")).toBe(false);

    // The big order (S09) is held: no link exists for it yet.
    const held = op.held.find((h) => h.kind === "approval_request")!;
    expect(held).toMatchObject({ key: "S09", status: "open", needsPasskey: true });
    expect(prepared.some((m) => m.tenant === "S09")).toBe(false);

    // Approved with the owner's passkey: now, and only now, its link is prepared.
    const before = prepared.length;
    await operator.approve(held.id, true);
    expect(op.prepared).toHaveLength(before + 1);
    expect(op.prepared!.at(-1)).toMatchObject({ tenant: "S09", kind: "purchase_order", status: "prepared" });
    // A declined held order never gets one.
  });

  it("Telegram is still tried first; when it fails, the supplier's WhatsApp link takes over before the log", async () => {
    const { op, operator, calls } = mm({ A: { telegram_chat_id: "777", whatsapp: "0812-1000-0001" } });
    await operator.advance("2026-11-03");
    expect(calls.some((c) => c.tool === "TELEGRAM_SEND_MESSAGE" && c.args.chat_id === "777")).toBe(true);
    expect(calls.some((c) => c.tool === "LOG")).toBe(false);
    expect((op.prepared ?? []).length).toBeGreaterThan(0);
    expect((op.prepared ?? []).every((m) => m.to === "6281210000001")).toBe(true);
    expect(op.sent.every((s) => s.via === "whatsapp_link" && /TELEGRAM_SEND_MESSAGE|no connected service/.test(s.error ?? ""))).toBe(true);
  });

  it("an unusable number is skipped with the reason, and the order is logged as before", async () => {
    const { op, operator, calls } = mm({ A: { whatsapp: "999" } });
    await operator.advance("2026-11-03");
    expect(op.prepared ?? []).toEqual([]);
    expect(calls.filter((c) => c.tool === "LOG").length).toBeGreaterThan(0);
    // A supplier with no contact at all behaves exactly as it did before WhatsApp links existed.
    const plain = mm({});
    await plain.operator.advance("2026-11-03");
    expect(plain.op.prepared ?? []).toEqual([]);
    expect(plain.calls.filter((c) => c.tool === "LOG").length).toBe(calls.filter((c) => c.tool === "LOG").length);
  });
});
