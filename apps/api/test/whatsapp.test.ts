import { describe, expect, it } from "vitest";
import { approvedRulebook, setup, waitForOperation } from "./helpers";

const ops = (h: ReturnType<typeof setup>) => h.ledger.entries().flatMap((e) => (e.kind === "operation" ? [e] : []));

describe("WhatsApp links: rent operation", () => {
  async function started() {
    const h = setup();
    const rb = await approvedRulebook(h);
    const op = (await h.call("POST", `/rulebooks/${rb.id}/operations`, { rail: "mock" })).json;
    // Contacts normally come from the tenant sheet's columns; here K01 has a WhatsApp number, K02 an unusable one, K03 none.
    (h.store.data.operations[op.id] as { contacts?: unknown }).contacts = { K01: { whatsapp: "0812-3456-7890" }, K02: { whatsapp: "12345" } };
    expect((await h.call("POST", `/operations/${op.id}/advance`, { to: "2026-11-01" })).status).toBe(202);
    return { h, op, state: await waitForOperation(h.call, op.id) };
  }

  it("prepares the link instead of the log line, records message_prepared on the ledger, and never says it was sent", async () => {
    const { h, op, state } = await started();
    expect(state.status).toBe("idle");
    expect(state.prepared).toHaveLength(1);
    const m = state.prepared[0];
    expect(m).toMatchObject({ tenant: "K01", kind: "bill", channel: "whatsapp_link", to: "6281234567890", status: "prepared" });
    expect(m.url).toBe(`https://wa.me/6281234567890?text=${encodeURIComponent(m.text)}`);
    expect(m.sentAt).toBeUndefined();
    expect(state.actions.find((a: { tenant: string; type: string }) => a.tenant === "K01" && a.type === "invoice").detail).toContain("prepared as a WhatsApp link, not sent");
    // The unusable number is said out loud and the message is logged, as before.
    expect(state.actions.find((a: { tenant: string; type: string }) => a.tenant === "K02" && a.type === "invoice").detail).toMatch(/WhatsApp link skipped: the number is too short/);

    const events = ops(h).filter((e) => e.operation_id === op.id);
    expect(events.filter((e) => e.event === "message_prepared")).toEqual([expect.objectContaining({ tenant: "K01", channel: "whatsapp_link", ref: expect.stringContaining("bill:") })]);
    expect(events.some((e) => e.event === "message_sent" && e.tenant === "K01")).toBe(false);
    expect(events.some((e) => e.event === "message_sent_by_owner")).toBe(false);
    expect(h.ledger.verify()).toBeNull();
  });

  it("POST /operations/:id/messages/:messageId/sent marks it sent by the owner, once, however often it is called", async () => {
    const { h, op, state } = await started();
    const path = `/operations/${op.id}/messages/${state.prepared[0].id}/sent`;

    const first = await h.call("POST", path);
    expect(first.status).toBe(200);
    expect(first.json.changed).toBe(true);
    expect(first.json.message).toMatchObject({ id: state.prepared[0].id, status: "sent_by_owner" });
    expect(typeof first.json.message.sentAt).toBe("string");
    expect(first.json.operation.prepared[0].status).toBe("sent_by_owner");

    const again = await h.call("POST", path);
    expect(again.status).toBe(200);
    expect(again.json.changed).toBe(false);
    expect(again.json.message.sentAt).toBe(first.json.message.sentAt);

    const owned = ops(h).filter((e) => e.event === "message_sent_by_owner");
    expect(owned).toEqual([expect.objectContaining({ operation_id: op.id, tenant: "K01", channel: "whatsapp_link" })]);
    expect((await h.call("GET", `/operations/${op.id}`)).json.prepared[0].status).toBe("sent_by_owner");
    expect(h.ledger.verify()).toBeNull();
  });

  it("answers 404 for an operation or a message that does not exist", async () => {
    const { h, op } = await started();
    expect((await h.call("POST", "/operations/op_nope/messages/wa-K01-1/sent")).status).toBe(404);
    expect((await h.call("POST", `/operations/${op.id}/messages/wa-nope/sent`)).status).toBe(404);
    // An operation that never prepared anything has nothing to mark.
    const rb = await approvedRulebook(h);
    const empty = (await h.call("POST", `/rulebooks/${rb.id}/operations`, { rail: "mock" })).json;
    expect((await h.call("POST", `/operations/${empty.id}/messages/wa-K01-1/sent`)).status).toBe(404);
  });
});

describe("WhatsApp links: minimarket purchase orders", () => {
  it("prepares links for orders that go out, holds the big one until the owner approves it, and marks them sent", async () => {
    const h = setup();
    const rb = await approvedRulebook(h, "minimarket");
    const op = (await h.call("POST", `/rulebooks/${rb.id}/operations`, { suppliers: { A: { whatsapp: "0812-1000-0001" }, B: { whatsapp: 62812100000002 } } })).json;
    expect(op.suppliers).toEqual({ A: { whatsapp: "0812-1000-0001" }, B: { whatsapp: "62812100000002" } });
    expect((await h.call("POST", `/operations/${op.id}/advance`, { to: "2026-11-03" })).status).toBe(202);
    const state = await waitForOperation(h.call, op.id);
    expect(state.status).toBe("idle");

    expect(state.prepared.length).toBeGreaterThan(0);
    expect(state.prepared.every((m: { kind: string; to: string; status: string }) => m.kind === "purchase_order" && m.to === "6281210000001" && m.status === "prepared")).toBe(true);
    // The order above the limit is held; nothing exists for it yet, and nothing was claimed as sent.
    const held = state.held.find((x: { kind: string }) => x.kind === "approval_request");
    expect(held).toMatchObject({ key: "S09", status: "open" });
    expect(state.prepared.some((m: { tenant: string }) => m.tenant === "S09")).toBe(false);
    expect(ops(h).some((e) => e.event === "message_sent")).toBe(false);

    const id = state.prepared[0].id;
    const sent = await h.call("POST", `/operations/${op.id}/messages/${id}/sent`);
    expect(sent.json).toMatchObject({ changed: true, message: { id, status: "sent_by_owner" } });
    expect((await h.call("POST", `/operations/${op.id}/messages/${id}/sent`)).json.changed).toBe(false);
    expect(ops(h).filter((e) => e.event === "message_sent_by_owner")).toHaveLength(1);
    // The rest are still waiting for the owner.
    expect((await h.call("GET", `/operations/${op.id}`)).json.prepared.filter((m: { status: string }) => m.status === "prepared").length).toBe(state.prepared.length - 1);
  });
});
