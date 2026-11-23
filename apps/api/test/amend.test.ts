import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendSampleHistory, loadAmendments, loadRulebookVersions, recordException } from "@reeve/crew";
import { FakeMeko } from "@reeve/meko";
import { loadFixtureRulebook } from "@reeve/pipeline";
import { Ledger } from "@reeve/receipts";
import { describe, expect, it } from "vitest";
import { createMekoOwnerApp, mekoOpener } from "../src/meko";
import { Store } from "../src/store";

async function amendSetup(enabled: boolean, exceptions = 3) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "meko-amend-")), "ledger.jsonl"));
  const store = new Store(null);
  const open = mekoOpener({ workspace: "kos-melati", ledger, connect: async () => meko });
  const ws = await open();
  for (let i = 0; i < exceptions; i++) await recordException(ws, store.data, { rule_id: "R3", reason: `Kamar ${3 + i} boleh telat sampai 15 hari`, subject: `K0${3 + i}`, month: `2026-0${8 + i}` });
  const audit = async () => ({ status: "pass", cases: 40, killed: 51, total: 51 });
  const owner = createMekoOwnerApp({ store, audit, template: () => loadFixtureRulebook("kos-melati"), amend: { enabled: () => enabled, history: () => amendSampleHistory() } }, open);
  const call = (p: string, body?: unknown) => owner.fetch(new Request(`http://x/api/meko/owner${p}`, body ? { method: "POST", body: JSON.stringify(body) } : {}), "acc1");
  return { ws, store, call };
}

describe("SOP amendments (self-learning loop)", () => {
  it("flag off: the list is empty with enabled:false and nothing can be decided", async () => {
    const { call } = await amendSetup(false);
    expect(await (await call("/amendments")).json()).toMatchObject({ enabled: false, items: [], pending: 0 });
    expect((await call("/amendments/scan", {})).status).toBe(409);
    expect((await call("/amendments/am_x/approve", {})).status).toBe(409);
  });

  it("scan offers one tested amendment from 3 exceptions; approve writes an owner receipt and a rulebook version", async () => {
    const { call, store, ws } = await amendSetup(true);
    const scan = (await (await call("/amendments/scan", {})).json()) as { path: string; shortfalls: number; offered: number };
    expect(scan).toMatchObject({ path: "local", shortfalls: 1, offered: 1 });
    const list = (await (await call("/amendments")).json()) as { enabled: boolean; pending: number; exceptions: number; items: { id: string; status: string; audit: { killed: number; total: number }; improvement: { improved: boolean }; rulebook_after?: unknown }[] };
    expect(list).toMatchObject({ enabled: true, pending: 1, exceptions: 3 });
    expect(list.items[0]).toMatchObject({ status: "pending", audit: { killed: 51, total: 51 }, improvement: { improved: true } });
    expect(list.items[0]!.rulebook_after).toBeUndefined();
    const id = list.items[0]!.id;
    const ok = (await (await call(`/amendments/${id}/approve`, {})).json()) as { receipt: string; item: { status: string }; note: string };
    expect(ok.item.status).toBe("approved");
    expect(ok.note).toContain("Belum ada pesan terkirim");
    expect(ws.decisions().find((d) => d.entry_hash === ok.receipt)).toMatchObject({ agent: "owner", action: "amend_approve" });
    expect(loadRulebookVersions(store.data)).toHaveLength(1);
    expect((await call(`/amendments/${id}/reject`, {})).status).toBe(409);
    expect((await call("/amendments/nope/approve", {})).status).toBe(404);
  });

  it("two exceptions give no amendment; reject keeps the SOP", async () => {
    const two = await amendSetup(true, 2);
    expect(await (await two.call("/amendments/scan", {})).json()).toMatchObject({ shortfalls: 0, offered: 0 });
    const { call, store } = await amendSetup(true);
    await call("/amendments/scan", {});
    const id = loadAmendments(store.data)[0]!.id;
    expect(((await (await call(`/amendments/${id}/reject`, {})).json()) as { item: { status: string } }).item.status).toBe("rejected");
    expect(loadRulebookVersions(store.data)).toHaveLength(0);
  });
});
