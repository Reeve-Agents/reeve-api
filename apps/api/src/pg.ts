import { Ledger, type LedgerEntry } from "@reeve/receipts";
import pg from "pg";
import type { Persistence } from "./persistence";
import { Store, type StoreData } from "./store";

/**
 * Hosted Postgres (Supabase, Neon) asks for TLS with `sslmode=require`. Node does not trust their CA by
 * default, so the connection is encrypted without verifying the certificate; `sslmode=disable` (or no
 * sslmode, e.g. a local Docker database) connects without TLS.
 */
function connection(url: string): pg.PoolConfig {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  return { connectionString: u.toString(), ssl: mode && mode !== "disable" ? { rejectUnauthorized: false } : undefined };
}

/**
 * Postgres persistence for a deployed API (DATABASE_URL). Stores and ledgers keep their data in memory
 * and stay synchronous; each workspace is loaded once, on its first request, and every change is
 * written back in order. Run a single replica: two processes would each hold their own copy.
 *
 *   reeve_docs    one row per document: "accounts" (the account index) and "ws:<id>" (a workspace's Store)
 *   reeve_ledger  one row per ledger entry, keyed by (workspace, seq), so each hash chain is append-only
 *
 * Row Level Security is on with no policies: Supabase's public Data API (anon/authenticated keys) cannot
 * read or write these tables. Only this server's database role can.
 */
export async function openPostgres(url: string): Promise<Persistence> {
  const pool = new pg.Pool({ ...connection(url), max: 4 });
  await pool.query(`
    create table if not exists reeve_docs (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
    create table if not exists reeve_ledger (workspace text not null, seq integer not null, entry jsonb not null, at timestamptz not null default now(), primary key (workspace, seq));
    alter table reeve_docs enable row level security;
    alter table reeve_ledger enable row level security;
  `);

  // One write at a time, in the order the API made them.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, fn: () => Promise<unknown>) => {
    queue = queue.then(fn).catch((e: unknown) => console.error(`postgres ${label} failed:`, e instanceof Error ? e.message : e));
  };

  // Saves come in bursts; per document, only the latest snapshot needs writing.
  const pending = new Map<string, string>();
  const saveDoc = (id: string, data: unknown) => {
    const first = !pending.has(id);
    pending.set(id, JSON.stringify(data));
    if (!first) return;
    enqueue(`save ${id}`, async () => {
      const json = pending.get(id)!;
      pending.delete(id);
      await pool.query(
        "insert into reeve_docs (id, data, updated_at) values ($1, $2, now()) on conflict (id) do update set data = excluded.data, updated_at = now()",
        [id, json],
      );
    });
  };
  const loadDoc = async <T>(id: string) => (await pool.query<{ data: T }>("select data from reeve_docs where id = $1", [id])).rows[0]?.data ?? null;

  return {
    kind: "postgres",
    loadAccounts: () => loadDoc("accounts"),
    saveAccounts: (data) => saveDoc("accounts", data),
    hasLegacy: async () => (await loadDoc("ws:main")) !== null,
    openWorkspace: async (id) => {
      const doc = `ws:${id}`;
      const initial = await loadDoc<StoreData>(doc);
      const rows = await pool.query<{ entry: LedgerEntry }>("select entry from reeve_ledger where workspace = $1 order by seq", [id]);
      const entries = rows.rows.map((r) => r.entry);
      return {
        store: new Store(null, { initial, persist: (data) => saveDoc(doc, data) }),
        ledger: new Ledger({
          entries: () => entries,
          write: (entry) => {
            entries.push(entry);
            enqueue(`ledger ${id}#${entry.seq}`, () => pool.query("insert into reeve_ledger (workspace, seq, entry) values ($1, $2, $3)", [id, entry.seq, JSON.stringify(entry)]));
          },
        }),
      };
    },
    /** Wait for every queued write, then close the pool (on shutdown). */
    close: async () => {
      await queue;
      await pool.end();
    },
  };
}
