# apps/api

Hono HTTP API behind the dashboard. Reuses `@reeve/pipeline` (the same pipeline as the CLI).

```bash
npm run dev -w @reeve/api
```

Reads `reeve/.env` (`REEVE_LLM`, `REEVE_SANDBOX`, keys). Listens on `:8787` (`REEVE_API_PORT`). WebAuthn origin `REEVE_WEB_ORIGIN` (default `http://localhost:5173`, rpID from its hostname).

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | LLM, sandbox, passkey count, ledger integrity |
| GET | `/api/fixtures/sop` | Demo SOP text |
| POST | `/api/sops` `{text}` | Builder: SOP → rulebook (+ questions) |
| GET | `/api/rulebooks`, `/api/rulebooks/:id` | Rulebooks (`draft` → `audited` → `approved`) |
| POST | `/api/rulebooks/:id/runs` `{injectBug?}` | Queue compile + audit in one sandbox job (one at a time) → 202 |
| GET | `/api/runs/:id` | Live log (glass box), verdict, results, receipt |
| GET | `/api/ledger` | Last 50 entries, chain integrity, latest Merkle root |
| POST | `/api/passkeys/register/options` · `/verify` | Register the owner passkey (WebAuthn, user verification required) |
| POST | `/api/rulebooks/:id/approve/options` · `/verify` | Approve the latest **passing** run; the challenge is `sha256(receipt_hash ‖ nonce)`, so the passkey signs exactly that run. Writes an `approval` entry to the ledger |

Storage: `.reeve/db.json` (atomic writes). Supabase replaces it later.
Security note: the API itself has no login yet; only approvals are passkey-gated. Run it on localhost only.
