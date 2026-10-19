import type { Hex, PublicClient, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { anchorFromEnv, ChainAnchor, decodeAnchor, encodeAnchor } from "../src/index";

const root = "ab".repeat(32);

describe("anchor calldata", () => {
  it("round-trips REEVE1 + root + receipt count", () => {
    const data = encodeAnchor(root, 42);
    expect(data.startsWith("0x524545564531")).toBe(true);
    expect(decodeAnchor(data)).toEqual({ root, leaves: 42 });
    expect(decodeAnchor("0xdeadbeef")).toBeNull();
    expect(() => encodeAnchor("xyz", 1)).toThrow(/32 bytes/);
  });
});

describe("ChainAnchor", () => {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;

  it("refuses unknown chains and mainnets", () => {
    expect(() => new ChainAnchor("ethereum", key)).toThrow(/unknown anchor chain/);
  });

  it("sends a zero-value self transaction carrying the root, then verifies it from the chain", async () => {
    const sent: { to?: string; value?: bigint; data?: Hex }[] = [];
    const txs = new Map<string, { from: Hex; input: Hex }>();
    const wallet = {
      account: privateKeyToAccount(key),
      sendTransaction: async (req: { to: Hex; value: bigint; data: Hex }) => {
        sent.push(req);
        txs.set("0x01", { from: me, input: req.data });
        return "0x01" as Hex;
      },
    } as unknown as WalletClient;
    const reader = {
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 123n }),
      getTransaction: async ({ hash }: { hash: string }) => txs.get(hash)!,
    } as unknown as PublicClient;
    const a = new ChainAnchor("monad-testnet", key, { wallet, reader });
    const r = await a.anchor(root, 7);
    expect(sent[0]).toMatchObject({ to: me, value: 0n });
    expect(r).toMatchObject({ chain: "monad-testnet", chainId: 10143, tx: "0x01", block: "123", explorer: "https://testnet.monadexplorer.com/tx/0x01" });
    expect(await a.verify("0x01", root)).toEqual({ ok: true, leaves: 7 });
    expect(await a.verify("0x01", "cd".repeat(32))).toEqual({ ok: false, reason: "root differs" });
    txs.set("0x02", { from: "0x0000000000000000000000000000000000000001", input: encodeAnchor(root, 7) });
    expect(await a.verify("0x02", root)).toEqual({ ok: false, reason: "sent by a different wallet" });
  });

  it("is off without a key, and defaults to Monad testnet", () => {
    expect(anchorFromEnv({})).toBeNull();
    const a = anchorFromEnv({ REEVE_ANCHOR_PRIVATE_KEY: key.slice(2) })!;
    expect([a.chainName, a.chain.id, a.address]).toEqual(["monad-testnet", 10143, me]);
  });
});
