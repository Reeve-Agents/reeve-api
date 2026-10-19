# contracts

No contract is needed for the receipt anchor. Reeve publishes the ledger's Merkle root (`packages/receipts`)
as a **zero-value transaction from the anchor wallet to itself** whose data is:

```
"REEVE1" (6 bytes) + Merkle root (32 bytes) + number of receipts (uint32, 4 bytes)
```

Anyone can check it: open the transaction on the explorer, read the input data, and compare the root with
one recomputed from the receipts. `packages/anchor` does this (`ChainAnchor.verify`), and the API exposes it
at `GET /api/ledger/anchors/:seq/verify`.

- Chains: Monad testnet (10143) or Base Sepolia (84532), from viem's chain definitions. Mainnets are refused for now.
- Only hashes go on chain, never data. Anchoring is proof only; Reeve never takes crypto payments from
  Indonesian users (BI prohibition).
- Setup: `npm run anchor:wallet` (new testnet key into `.env`, address printed), faucet funds, then
  `npm run anchor:now` or `POST /api/ledger/anchor`.

A contract (an event log per business, ERC-8004 Auditor identity) can come later; the calldata format stays.
