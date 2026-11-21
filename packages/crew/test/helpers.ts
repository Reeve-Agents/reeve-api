import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeMeko, MekoWorkspace, Pseudonymiser } from "@reeve/meko";
import { MockRail } from "@reeve/rails";
import { Ledger } from "@reeve/receipts";
import type { CrewDeps, ExecResult } from "../src/index";

export async function testDeps(over: Partial<CrewDeps> = {}) {
  const meko = new FakeMeko();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "crew-")), "ledger.jsonl"));
  const ws = await MekoWorkspace.open(meko, { workspace: "kos-melati", ledger, pseudonyms: new Pseudonymiser() });
  const sent: { connector: string; tool: string; args: Record<string, unknown> }[] = [];
  const rail = new MockRail();
  let t = Date.parse("2026-12-01T02:00:00Z");
  const deps: CrewDeps = {
    ws,
    rail,
    now: () => new Date((t += 60_000)),
    execute: async (connector, tool, args): Promise<ExecResult> => {
      sent.push({ connector, tool, args });
      return { ok: true, via: "log" };
    },
    ...over,
  };
  return { meko, ledger, ws, rail, sent, deps };
}

export const DEMO_PASSKEY = { method: "demo" as const, credential_id: "test-credential" };
