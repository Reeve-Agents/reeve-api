# Reeve architecture

Reeve turns a business SOP into software that runs on its own and checks itself.
Two agents (Builder and Auditor) in a maker-checker pair, with the Owner as final approver.
Design notes live in the Obsidian vault: `vault/12 Brainstorm/Reeve - *.md`.

## Principles

1. **LLM understands, compiler writes, sandbox runs.** The LLM turns plain-language SOPs into structured rule cards. A deterministic compiler turns rule cards into Python code. Runtime never calls an LLM per transaction.
2. **Maker-checker.** The Auditor never reuses the Builder's tests. It derives its own expectations from the rulebook, then runs mutation tests against the Builder's code.
3. **Code goes to the data.** Generated code and data run inside a sandbox (CreateOS Firecracker microVM, egress locked). Only aggregates leave.
4. **Keyless agents.** Real API keys live only in the broker. Sandboxes get placeholders.
5. **Every run leaves a receipt.** Receipts hash code, inputs and results; a Merkle root per batch is appended to a ledger (local now, on-chain anchor next).
6. **Adapters at every edge.** LLM provider, sandbox, payment rail and anchor are interfaces, so Stripe ↔ Xendit/Midtrans or Anthropic ↔ 0G TEE swap without touching the core.

## Modules

```text
reeve/
├── apps/
│   ├── cli/        MVP entry point: run the full pipeline from the terminal (implemented)
│   ├── api/        BE: Hono API (SOPs, rulebooks, queued runs, passkey approvals, ledger) (implemented)
│   ├── web/        FE: Vite + React dashboard, live glass box, WebAuthn approvals (implemented)
│   └── broker/     Credential broker + egress proxy + mandate checks + payment execution (next)
├── packages/
│   ├── core/       Domain schemas (zod): rule cards, rulebook, scenario, events, verdict, receipt (implemented)
│   ├── pipeline/   Shared compile → audit → sandbox → verdict → receipt pipeline (implemented)
│   ├── llm/        LLMProvider interface: Anthropic (Claude) + offline fixture; 0G TEE later (implemented)
│   ├── builder/    SOP → rulebook (via llm) → Python rules + Builder tests (implemented)
│   ├── auditor/    Independent spec, mutation testing, constraint checks, verdict (implemented)
│   ├── sandbox/    Sandbox interface: CreateOS REST adapter + local dev runner (implemented)
│   ├── receipts/   Hashing, receipts, Merkle root, append-only ledger (implemented)
│   └── rails/      PaymentRail interface + mock rail; Stripe/Xendit/Midtrans adapters next (implemented: interface + mock)
├── runtime/
│   └── reeve_runtime/  Python simulation engine shipped into every sandbox run (implemented)
├── contracts/      On-chain receipt anchor (Solidity) (next)
└── docs/           This file + decisions
```

## MVP pipeline (implemented in this slice)

```text
SOP text ──▶ builder.parseSop (LLM or fixture) ──▶ Rulebook (rule cards + questions)
        ──▶ builder.compile ──▶ rules.py + test_builder.py
        ──▶ auditor.prepare ──▶ test_audit_spec.py + mutants/ + check_constraints.py
        ──▶ sandbox.run (one sandbox for the whole job) ──▶ results.json
        ──▶ auditor.verdict ──▶ pass/fail + findings
        ──▶ receipts ──▶ receipt.json + Merkle root appended to ledger.jsonl
```

One sandbox per job keeps the CreateOS Free plan happy (1 concurrent sandbox, 10/day).

## Data flow and trust boundaries

| Boundary | What crosses | What never crosses |
|---|---|---|
| LLM ← SOP text | SOP wording, rule-card schema | Tenant data, payments |
| Sandbox ← job bundle | Generated code, runtime, scenario data | API keys |
| Sandbox → host | `results.json` (aggregates, events) | Raw secrets |
| Broker → providers | Real keys, after mandate + approval checks | — |

## Environment

See `.env.example`. Defaults run fully offline (`REEVE_LLM=fixture`, `REEVE_SANDBOX=local`).
`REEVE_SANDBOX=createos` uses the CreateOS REST API (`https://api.sb.createos.sh`, header `X-Api-Key`).
