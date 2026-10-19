import { createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, monadTestnet } from "viem/chains";

/**
 * On-chain anchor for the ledger's Merkle roots: proof only, never payment ("Reeve - Sustainability and
 * Crypto Layer"). Each anchor is a zero-value transaction from the anchor wallet to itself whose data is
 * "REEVE1" + the 32-byte root + the number of receipts. No contract to deploy; anyone can check a root
 * by reading that transaction on the chain's explorer. Testnets only for now.
 */

export const CHAINS: Record<string, Chain> = { "monad-testnet": monadTestnet, "base-sepolia": baseSepolia };

const MAGIC = "5245455645" + "31"; // "REEVE1"

/** Calldata: magic (6 bytes) + root (32 bytes) + leaves (uint32, 4 bytes). */
export function encodeAnchor(root: string, leaves: number): Hex {
  if (!/^[0-9a-f]{64}$/i.test(root)) throw new Error("root must be 32 bytes of hex");
  if (!Number.isInteger(leaves) || leaves < 0 || leaves > 0xffffffff) throw new Error("leaves out of range");
  return `0x${MAGIC}${root.toLowerCase()}${leaves.toString(16).padStart(8, "0")}`;
}

export function decodeAnchor(data: Hex): { root: string; leaves: number } | null {
  const hex = data.slice(2).toLowerCase();
  if (!hex.startsWith(MAGIC) || hex.length !== MAGIC.length + 64 + 8) return null;
  return { root: hex.slice(MAGIC.length, MAGIC.length + 64), leaves: parseInt(hex.slice(MAGIC.length + 64), 16) };
}

export interface AnchorResult {
  chain: string;
  chainId: number;
  tx: Hex;
  from: Hex;
  block: string;
  explorer: string;
}

export class ChainAnchor {
  readonly chain: Chain;
  private readonly wallet: WalletClient;
  private readonly reader: PublicClient;
  readonly address: Hex;

  constructor(
    readonly chainName: string,
    privateKey: Hex,
    opts: { rpcUrl?: string; wallet?: WalletClient; reader?: PublicClient } = {},
  ) {
    const chain = CHAINS[chainName];
    if (!chain) throw new Error(`unknown anchor chain ${chainName} (${Object.keys(CHAINS).join(", ")})`);
    if (!chain.testnet) throw new Error("Reeve anchors on testnets only for now");
    this.chain = chain;
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    const transport = http(opts.rpcUrl);
    this.wallet = opts.wallet ?? createWalletClient({ account, chain, transport });
    this.reader = opts.reader ?? (createPublicClient({ chain, transport }) as PublicClient);
  }

  explorerTx(tx: string) {
    return `${this.chain.blockExplorers?.default.url ?? ""}/tx/${tx}`;
  }

  async balance(): Promise<bigint> {
    return this.reader.getBalance({ address: this.address });
  }

  /** Publish one root; waits for one confirmation. */
  async anchor(root: string, leaves: number): Promise<AnchorResult> {
    const hash = await this.wallet.sendTransaction({ account: this.wallet.account!, chain: this.chain, to: this.address, value: 0n, data: encodeAnchor(root, leaves) });
    const receipt = await this.reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`anchor transaction ${hash} failed`);
    return { chain: this.chainName, chainId: this.chain.id, tx: hash, from: this.address, block: receipt.blockNumber.toString(), explorer: this.explorerTx(hash) };
  }

  /** Read the transaction back and check it carries exactly this root, from this wallet. */
  async verify(tx: Hex, root: string): Promise<{ ok: boolean; reason?: string; leaves?: number }> {
    const t = await this.reader.getTransaction({ hash: tx });
    if (t.from.toLowerCase() !== this.address.toLowerCase()) return { ok: false, reason: "sent by a different wallet" };
    const d = decodeAnchor(t.input);
    if (!d) return { ok: false, reason: "not a Reeve anchor" };
    return d.root === root.toLowerCase() ? { ok: true, leaves: d.leaves } : { ok: false, reason: "root differs" };
  }
}

/** REEVE_ANCHOR_CHAIN (monad-testnet | base-sepolia), REEVE_ANCHOR_PRIVATE_KEY, optional REEVE_ANCHOR_RPC_URL. */
export function anchorFromEnv(env: NodeJS.ProcessEnv = process.env): ChainAnchor | null {
  const key = env.REEVE_ANCHOR_PRIVATE_KEY?.trim();
  if (!key) return null;
  return new ChainAnchor(env.REEVE_ANCHOR_CHAIN?.trim() || "monad-testnet", (key.startsWith("0x") ? key : `0x${key}`) as Hex, { rpcUrl: env.REEVE_ANCHOR_RPC_URL?.trim() || undefined });
}
