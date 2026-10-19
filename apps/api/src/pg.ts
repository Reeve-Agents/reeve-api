import type { LedgerBackend, LedgerEntry } from "@reeve/receipts";
import pg from "pg";
import type { StoreData } from "./store";

/**
 * Postgres persistence for a deployed API (DATABASE_URL). The Store and the Ledger keep their data in
 * memory and stay synchronous; this loads them once at start and writes every change back in order.
 * Run a single replica: two processes would each hold their own copy.
 *
 *   reeve_store  one row: the whole Store document (rulebooks, runs, operations, passkeys...)
 *   reeve_ledger one row per ledger entry, keyed by seq, so the hash chain is append-only
 */
export async function openPostgres(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await pool.query(`
    create table if not exists reeve_store (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
    create table if not exists reeve_ledger (seq integer primary key, entry jsonb not null, at timestamptz not null default now());
  `);

  const store = await pool.query<{ data: StoreData }>("select data from reeve_store where id = 'main'");
  const ledgerRows = await pool.query<{ entry: LedgerEntry }>("select entry from reeve_ledger order by seq");
  const entries = ledgerRows.rows.map((r) => r.entry);

  // One write at a time, in the order the API made them.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, fn: () => Promise<unknown>) => {
    queue = queue.then(fn).catch((e: unknown) => console.error(`postgres ${label} failed:`, e instanceof Error ? e.message : e));
  };

  // Saves come in bursts; only the latest snapshot needs writing.
  let pending: string | null = null;
  const persistStore = (data: StoreData) => {
    const first = pending === null;
    pending = JSON.stringify(data);
    if (!first) return;
    enqueue("store save", async () => {
      const json = pending!;
      pending = null;
      await pool.query(
        "insert into reeve_store (id, data, updated_at) values ('main', $1, now()) on conflict (id) do update set data = excluded.data, updated_at = now()",
        [json],
      );
    });
  };

  const ledger: LedgerBackend = {
    entries: () => entries,
    write: (entry) => {
      entries.push(entry);
      enqueue(`ledger #${entry.seq}`, () => pool.query("insert into reeve_ledger (seq, entry) values ($1, $2)", [entry.seq, JSON.stringify(entry)]));
    },
  };

  return {
    initialStore: store.rows[0]?.data ?? null,
    persistStore,
    ledger,
    /** Wait for every queued write, then close the pool (on shutdown). */
    close: async () => {
      await queue;
      await pool.end();
    },
  };
}
