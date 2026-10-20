import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "@reeve/receipts";
import { Store } from "./store";

/**
 * Where accounts and workspaces live. Each account owns one workspace (its own Store and Ledger).
 * The workspace "main" is the single-owner data from before accounts existed; the first account adopts it.
 */
export interface Persistence {
  readonly kind: string;
  loadAccounts(): Promise<unknown | null>;
  saveAccounts(data: unknown): void;
  /** True when the pre-accounts workspace "main" holds data. */
  hasLegacy(): Promise<boolean>;
  openWorkspace(id: string): Promise<{ store: Store; ledger: Ledger }>;
  close(): Promise<void>;
}

/** Files under REEVE_HOME: accounts.json, the legacy db.json/ledger.jsonl, and workspaces/<id>/. */
export function filePersistence(home: string): Persistence {
  const dir = (id: string) => (id === "main" ? home : join(home, "workspaces", id));
  const accountsPath = join(home, "accounts.json");
  return {
    kind: home,
    loadAccounts: async () => (existsSync(accountsPath) ? JSON.parse(readFileSync(accountsPath, "utf8")) : null),
    saveAccounts: (data) => {
      mkdirSync(dirname(accountsPath), { recursive: true });
      writeFileSync(`${accountsPath}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${accountsPath}.tmp`, accountsPath);
    },
    hasLegacy: async () => existsSync(join(home, "db.json")),
    openWorkspace: async (id) => ({ store: new Store(join(dir(id), "db.json")), ledger: new Ledger(join(dir(id), "ledger.jsonl")) }),
    close: async () => undefined,
  };
}
