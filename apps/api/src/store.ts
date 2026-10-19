import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GenericOperationRecord, OperationRecord } from "@reeve/broker";
import type { ToolCheck } from "@reeve/connectors";
import type { Finding, JobResults, Receipt, Rulebook, RulebookIssue, Verdict } from "@reeve/core";

export interface RulebookRecord {
  id: string;
  sop: string;
  rulebook: Rulebook;
  issues: RulebookIssue[];
  provider: string;
  /** draft → audited (latest run passed) → approved (owner passkey) → superseded (a revision was approved) */
  status: "draft" | "audited" | "approved" | "superseded";
  /** Phase 4: the version this one revises, and the approved revision that replaced this one. */
  parentId?: string;
  supersededBy?: string;
  /** Generic pack: the records the rules run over, and whether each tool exists on a connected service. */
  datasetId?: string;
  toolChecks?: ToolCheck[];
  createdAt: string;
  lastRunId?: string;
  approval?: { at: string; credentialId: string; receiptHash: string; ledgerSeq: number };
}

export interface RunRecord {
  id: string;
  rulebookId: string;
  injectBug: boolean;
  status: "queued" | "running" | "done" | "error";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  backend?: string;
  sandboxId?: string;
  log: { ms: number; line: string }[];
  rulesPy?: string;
  verdict?: Verdict;
  results?: JobResults | null;
  receipt?: Receipt;
  ledgerSeq?: number;
  error?: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  records: Record<string, string | number | null>[];
  fields: { name: string; type: "number" | "text" | "date"; values?: string[] }[];
  /** Where the rows come from, when read from an app (re-read on every Operator step). */
  source?: { connector: string; tool: string; args: Record<string, unknown> };
  /** Field changes over the simulated month (sample data only). */
  updates?: { day: number; key: string; field: string; value: string | number | null }[];
  createdAt: string;
}

export interface PasskeyRecord {
  id: string; // base64url credential id
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: string[];
  createdAt: string;
}

export interface StoreData {
  ownerUserId: string; // base64url, stable WebAuthn user handle
  rulebooks: Record<string, RulebookRecord>;
  runs: Record<string, RunRecord>;
  /** Live runs of an approved rulebook on a payment rail (the Operator). */
  operations: Record<string, OperationRecord>;
  /** Live runs of an approved generic rulebook through connectors. */
  genericOperations: Record<string, GenericOperationRecord>;
  /** Owners' records for generic SOPs (a CSV upload or a connector read). */
  datasets: Record<string, DatasetRecord>;
  passkeys: PasskeyRecord[];
  challenges: {
    registration?: { challenge: string; at: number };
    approvals: Record<string, { challenge: string; receiptHash: string; runId: string; at: number }>;
    /** Keyed by `${operationId}:${exceptionId}`: the passkey challenge for one refund (or one held action). */
    refunds: Record<string, { challenge: string; amount: number; at: number }>;
  };
}

/** Small document store: a JSON file locally (atomic temp file + rename), or one Postgres row when DATABASE_URL is set. */
export class Store {
  data: StoreData;

  /**
   * `path` is the JSON file (null keeps everything in memory, for tests). With `persist`, the data
   * comes from `initial` and every save goes to `persist` instead (the Postgres store in pg.ts).
   */
  constructor(
    private readonly path: string | null,
    private readonly opts: { initial?: StoreData | null; persist?: (data: StoreData) => void } = {},
  ) {
    const loaded = opts.persist ? opts.initial : path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoreData) : null;
    if (loaded) {
      this.data = loaded;
      this.data.operations ??= {};
      this.data.genericOperations ??= {};
      this.data.datasets ??= {};
      this.data.challenges.refunds ??= {};
    } else {
      this.data = {
        ownerUserId: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
        rulebooks: {},
        runs: {},
        operations: {},
        genericOperations: {},
        datasets: {},
        passkeys: [],
        challenges: { approvals: {}, refunds: {} },
      };
      this.save();
    }
  }

  /** An approved revision replaces every earlier approved version of the same rulebook. */
  supersedeAncestors(id: string): void {
    for (let p = this.data.rulebooks[id]?.parentId; p && this.data.rulebooks[p]; p = this.data.rulebooks[p]!.parentId) {
      const older = this.data.rulebooks[p]!;
      if (older.status === "approved") Object.assign(older, { status: "superseded", supersededBy: id });
    }
  }

  save(): void {
    if (this.opts.persist) return this.opts.persist(this.data);
    if (!this.path) return; // in-memory (tests)
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function summarizeFindings(findings: Finding[]) {
  return {
    blockers: findings.filter((f) => f.severity === "blocker").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
}
