import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS } from "@reeve/anchor";
import { anchorLeaves, Ledger, merkleRoot } from "@reeve/receipts";
import { mainnet } from "viem/chains";
import { describe, expect, it } from "vitest";
import { type AnchorSubmitter, chooseAnchor, preflightAnchor, seedSandbox, writeSeedAnchor } from "../src/seed-lib";

const ledgerWithReceipts = (n = 3) => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "seed-lib-")), "ledger.jsonl"));
  for (let i = 0; i < n; i++) ledger.append({ kind: "receipt", at: "2026-12-01T00:00:00Z", receipt_hash: `${i}`.padStart(64, "a"), run_id: `r${i}`, verdict: "pass" });
  return ledger;
};

function fakeSubmitter(over: Partial<AnchorSubmitter> = {}): AnchorSubmitter & { calls: { root: string; leaves: number }[] } {
  const calls: { root: string; leaves: number }[] = [];
  return {
    chainName: "monad-testnet",
    calls,
    balance: async () => 10n ** 18n,
    anchor: async (root, leaves) => {
      calls.push({ root, leaves });
      return { chain: "monad-testnet", chainId: 10143, tx: "0xfeed", from: "0x0000000000000000000000000000000000000001", block: "7", explorer: "https://testnet.monadexplorer.com/tx/0xfeed" };
    },
    verify: async () => ({ ok: true }),
    ...over,
  };
}

const KEYED = { REEVE_ANCHOR_PRIVATE_KEY: "0x" + "11".repeat(32) };

describe("seed sandbox", () => {
  it("reuses sandboxFromEnv: local by default, CreateOS when REEVE_SANDBOX=createos", () => {
    expect(seedSandbox({}).kind).toBe("local");
    expect(seedSandbox({ REEVE_SANDBOX: "createos", CREATEOS_API_KEY: "k" }).kind).toBe("createos");
    expect(seedSandbox({ REEVE_SANDBOX: "createos", CREATEOS_API_KEY: "k" }).sandbox.name).toBe("createos");
  });

  it("createos without a key fails loudly instead of falling back to local", () => {
    expect(() => seedSandbox({ REEVE_SANDBOX: "createos" })).toThrow(/CREATEOS_API_KEY/);
  });

  it("--sandbox= overrides the env and rejects anything else", () => {
    expect(seedSandbox({ REEVE_SANDBOX: "createos" }, "local").kind).toBe("local");
    expect(seedSandbox({ CREATEOS_API_KEY: "k" }, "createos").kind).toBe("createos");
    expect(() => seedSandbox({}, "docker")).toThrow(/not a sandbox/);
  });
});

describe("seed anchor selection", () => {
  it("no wallet key: a local Merkle root, labelled local, no tx", async () => {
    const choice = chooseAnchor({}, { make: () => fakeSubmitter() });
    expect(choice).toEqual({ mode: "local", why: "REEVE_ANCHOR_PRIVATE_KEY is not set" });
    expect(await preflightAnchor(choice)).toMatch(/local Merkle root only/);
    const ledger = ledgerWithReceipts();
    const r = await writeSeedAnchor(ledger, choice);
    expect(r.note).toMatch(/LOCAL Merkle root/);
    const a = ledger.entries().at(-1)!;
    expect(a).toMatchObject({ kind: "anchor", anchor: "local-ledger", leaves: 3, merkle_root: merkleRoot(anchorLeaves(ledger.entries().slice(0, 3))) });
    expect(a).not.toHaveProperty("tx");
  });

  it("--no-anchor writes nothing, even with a wallet", async () => {
    const choice = chooseAnchor(KEYED, { skip: true, make: () => fakeSubmitter() });
    expect(choice.mode).toBe("skip");
    const ledger = ledgerWithReceipts();
    const before = ledger.entries().length;
    expect((await writeSeedAnchor(ledger, choice)).entry).toBeUndefined();
    expect(ledger.entries()).toHaveLength(before);
  });

  it("wallet configured: submits THIS ledger's root and records tx and explorer on the anchor entry", async () => {
    const sub = fakeSubmitter();
    const choice = chooseAnchor({ ...KEYED, REEVE_ANCHOR_CHAIN: "monad-testnet" }, { make: () => sub });
    expect(choice.mode).toBe("onchain");
    expect(await preflightAnchor(choice)).toMatch(/testnet monad-testnet/);
    const ledger = ledgerWithReceipts(4);
    const r = await writeSeedAnchor(ledger, choice);
    const root = merkleRoot(anchorLeaves(ledger.entries().slice(0, 4)));
    expect(sub.calls).toEqual([{ root, leaves: 4 }]);
    expect(r.mode).toBe("onchain");
    expect(ledger.entries().at(-1)).toMatchObject({ kind: "anchor", merkle_root: root, leaves: 4, anchor: "monad-testnet", chain_id: 10143, tx: "0xfeed", explorer: "https://testnet.monadexplorer.com/tx/0xfeed" });
  });

  it("refuses a chain that is not a known testnet, and never falls back to a local root", () => {
    let built = false;
    const make = () => ((built = true), fakeSubmitter());
    expect(() => chooseAnchor({ ...KEYED, REEVE_ANCHOR_CHAIN: "ethereum" }, { make })).toThrow(/not an anchor chain/);
    CHAINS["test-mainnet"] = mainnet;
    try {
      expect(() => chooseAnchor({ ...KEYED, REEVE_ANCHOR_CHAIN: "test-mainnet" }, { make })).toThrow(/not a testnet/);
    } finally {
      delete CHAINS["test-mainnet"];
    }
    expect(built).toBe(false);
  });

  it("an unfunded wallet fails the preflight, before the seed does any work", async () => {
    const choice = chooseAnchor(KEYED, { make: () => fakeSubmitter({ balance: async () => 0n }) });
    await expect(preflightAnchor(choice)).rejects.toThrow(/no monad-testnet funds/);
  });

  it("a chain that does not carry the root is an error and nothing is recorded", async () => {
    const choice = chooseAnchor(KEYED, { make: () => fakeSubmitter({ verify: async () => ({ ok: false, reason: "root differs" }) }) });
    const ledger = ledgerWithReceipts();
    await expect(writeSeedAnchor(ledger, choice)).rejects.toThrow(/root differs/);
    expect(ledger.entries().some((e) => e.kind === "anchor")).toBe(false);
  });

  it("a failed submission is an error, not a silent local anchor", async () => {
    const choice = chooseAnchor(KEYED, { make: () => fakeSubmitter({ anchor: async () => Promise.reject(new Error("rpc down")) }) });
    const ledger = ledgerWithReceipts();
    await expect(writeSeedAnchor(ledger, choice)).rejects.toThrow(/rpc down/);
    expect(ledger.entries().some((e) => e.kind === "anchor")).toBe(false);
  });
});
