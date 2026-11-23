// Shared machinery for running an approved playbook: budget, review queue, connectors with the
// Log fallback, the Worker (LLM wording with a template fallback) and the Validator, all traced
// on Meko. Code decides every action; the Worker only words text that the Validator then checks.
import type { AgentName, AgentTrace, MekoRun, MekoWorkspace, TokenUsage, TracedDecision } from "@reeve/meko";
import type { PaymentRail } from "@reeve/rails";
import { auditPlaybook, type PlaybookAudit } from "./audit";
import type { Playbook, PlaybookStep } from "./playbook";
import { validate, type ValidatorFacts, type ValidatorHit } from "./validator";

export interface ExecResult {
  ok: boolean;
  /** "log" when the Log connector recorded it instead of a real app. */
  via: string;
  /** The real app's id for what it created (a calendar event id), when it gave one. */
  ref?: string;
  /** Why a real attempt failed (ok is false). Never carries a key. */
  error?: string;
}

/** Words a brief; must return plain text. Usage is metered against the playbook budget. */
export type WorkerFn = (system: string, user: string) => Promise<{ text: string; usage?: TokenUsage }>;

/** Owner's passkey assertion, already verified by the API (or marked as the offline demo). */
export interface PasskeyProof {
  /**
   * "session": the owner confirmed while signed in on the web app (no new passkey ceremony yet; a
   * step-up passkey ceremony for autonomy changes is a follow-up).
   */
  method: "passkey" | "demo" | "session";
  credential_id: string;
  challenge_hash?: string;
}

/** Earned-autonomy gate per action class (milestone 5). Default: every step runs as its card says. */
export type Gate = (actionClass: string, unusual: boolean) => "auto" | "auto_digest" | "ask";

export interface CrewDeps {
  ws: MekoWorkspace;
  execute(connector: string, tool: string, args: Record<string, unknown>): Promise<ExecResult>;
  rail: PaymentRail;
  worker?: WorkerFn;
  gate?: Gate;
  now?: () => Date;
}

export interface ReviewItem {
  id: string;
  step: string;
  kind: "draft" | "escalation" | "contract" | "action";
  subject: string;
  text: string;
  status: "pending" | "approved" | "rejected" | "edited";
  receipt: string;
  /** Validator hits on the draft, if any. */
  hits?: ValidatorHit[];
  meta?: Record<string, unknown>;
}

export interface CrewState {
  playbook: Playbook;
  audit?: PlaybookAudit;
  approved?: { receipt: string; method: string; at: string };
  status: "draft" | "audited" | "running" | "stopped";
  stop_reason?: string;
  metric: number;
  spent_idr: number;
  worker_calls: number;
  calls_today: Record<string, number>;
  queue: ReviewItem[];
  decisions: TracedDecision[];
  /** Reeve-side facts that never go to Meko or an LLM raw (names stay here). */
  records: Record<string, Record<string, unknown>>;
}

export function newState(pb: Playbook): CrewState {
  return { playbook: pb, status: "draft", metric: 0, spent_idr: 0, worker_calls: 0, calls_today: {}, queue: [], decisions: [], records: {} };
}

export class CrewError extends Error {}

export class Crew {
  readonly run: MekoRun;
  private seq = 0;
  constructor(
    readonly deps: CrewDeps,
    readonly state: CrewState,
    runId?: string,
  ) {
    this.run = deps.ws.run(runId);
  }

  get ws(): MekoWorkspace {
    return this.deps.ws;
  }
  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  today(): string {
    return new Date(this.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  }
  step(id: string): PlaybookStep {
    const s = this.state.playbook.steps.find((x) => x.id === id);
    if (!s) throw new CrewError(`no step ${id}`);
    return s;
  }
  agent(name: AgentName, title: string): Promise<AgentTrace> {
    return this.run.agent(name, title);
  }
  async record(trace: AgentTrace, turn: Parameters<AgentTrace["decide"]>[0]): Promise<TracedDecision> {
    const d = await trace.decide(turn);
    this.state.decisions.push(d);
    return d;
  }
  nextId(prefix: string): string {
    return `${prefix}_${++this.seq}_${this.now().getTime().toString(36)}`;
  }

  /** Builder compiles, Auditor tests, owner approves with a passkey: three traced turns. */
  async approve(opts: { facts: ValidatorFacts; whitelist: readonly string[]; good_draft: string; passkey: PasskeyProof }): Promise<PlaybookAudit> {
    const pb = this.state.playbook;
    const builder = await this.agent("builder", `Compile playbook: ${pb.title}`);
    const b = await this.record(builder, {
      input: pb.source_quote,
      output: { id: pb.id, goal: pb.goal, steps: pb.steps.map((s) => `${s.id} (${s.when} -> ${s.emits.join("|") || "-"})`), budget: pb.budget },
      reasoning: `Owner target "${pb.source_quote}" becomes ${pb.steps.length} steps fired by events, goal ${pb.goal.metric} >= ${pb.goal.target} by ${pb.goal.by}, budget Rp${pb.budget.max_cost_idr}, payments at most Rp${pb.budget.max_payment_idr}.`,
      plan: pb.steps.map((s) => s.title),
      action: "compile_playbook",
    });
    const audit = auditPlaybook(pb, opts);
    this.state.audit = audit;
    const auditor = await this.agent("auditor", `Audit playbook: ${pb.title}`);
    const art = await auditor.artifact(`audit-${pb.id}.json`, audit);
    await this.record(auditor, {
      input: `playbook ${pb.id} (receipt ${b.receipt_hash.slice(0, 12)})`,
      output: { status: audit.status, findings: audit.findings.length, planted: `${audit.planted.caught}/${audit.planted.total}`, drafts: `${audit.drafts.caught}/${audit.drafts.total}`, artifact: art.content_hash },
      reasoning:
        audit.status === "pass"
          ? `Worst-case spend Rp${audit.worst_case.cost_idr} over ${audit.worst_case.days} days fits Rp${pb.budget.max_cost_idr}; every step is reachable; ${audit.planted.caught}/${audit.planted.total} planted violations and ${audit.drafts.caught}/${audit.drafts.total} bad drafts were caught, so the playbook can go to the owner.`
          : `Blocked: ${audit.findings.map((f) => f.code).join(", ") || "none"}; surviving plants ${[...audit.planted.survivors, ...audit.drafts.survivors].join(", ") || "none"}.`,
      action: audit.status === "pass" ? "audit_pass" : "audit_fail",
    });
    if (audit.status !== "pass") {
      this.state.status = "draft";
      return audit;
    }
    this.state.status = "audited";
    const owner = await this.agent("owner", `Approve playbook: ${pb.title}`);
    const d = await this.record(owner, {
      input: `approve ${pb.id}`,
      output: { approved: true, binds: audit.playbook_hash, audit_artifact: art.content_hash, method: opts.passkey.method },
      reasoning: `The owner approved with a ${opts.passkey.method === "passkey" ? "passkey" : "demo passkey (offline seed)"} after reading the audit; the approval binds the playbook hash and the audit report.`,
      action: "approve_playbook",
    });
    this.state.approved = { receipt: d.receipt_hash, method: opts.passkey.method, at: this.now().toISOString() };
    this.state.status = "running";
    return audit;
  }

  assertRunning(): void {
    if (this.state.status !== "running") throw new CrewError(`playbook ${this.state.playbook.id} is ${this.state.status}, not running`);
  }

  /** Charges one Worker call to the step and the playbook. False when a cap would be crossed. */
  charge(step: PlaybookStep): boolean {
    const key = `${this.today()}:${step.id}`;
    const used = this.state.calls_today[key] ?? 0;
    const pb = this.state.playbook;
    if (used >= step.budget.max_worker_calls_per_day) return false;
    if (this.state.spent_idr + step.budget.cost_idr_per_call > pb.budget.max_cost_idr) return false;
    if (this.state.worker_calls + 1 > pb.budget.max_worker_calls) return false;
    this.state.calls_today[key] = used + 1;
    this.state.spent_idr += step.budget.cost_idr_per_call;
    this.state.worker_calls += 1;
    return true;
  }

  /**
   * Worker words a draft from facts; the Validator checks it. A failing draft goes back once, then
   * the template (written by code, also validated) is used. Both turns are traced.
   */
  async draft(step: PlaybookStep, opts: { brief: string; facts_text: string; template: string; facts: ValidatorFacts; subject: string }): Promise<{ text: string; hits: ValidatorHit[]; by: "worker" | "template" }> {
    const worker = await this.agent("worker", `Drafts: ${this.state.playbook.title}`);
    const validator = await this.agent("validator", `Checks: ${this.state.playbook.title}`);
    let text = opts.template;
    let by: "worker" | "template" = "template";
    let hits = validate(text, opts.facts, step.checks);
    for (let attempt = 0; attempt < 2 && this.deps.worker && this.charge(step); attempt++) {
      const system = "Kamu menulis teks pendek untuk usaha kos. Pakai hanya fakta yang diberikan. Jangan menambah harga, klaim, tautan atau nama. Akhiri dengan: (dibuat dengan bantuan AI)";
      const user = this.ws.pseudonyms.redact(`${opts.brief}\n\nFakta:\n${opts.facts_text}${attempt ? `\n\nDraf sebelumnya ditolak: ${hits.map((h) => h.message).join("; ")}` : ""}`);
      let res: Awaited<ReturnType<WorkerFn>>;
      try {
        res = await this.deps.worker(system, user);
      } catch (err) {
        // A failed model call never blocks the step: the code template is used instead.
        await this.record(worker, { input: user, output: { error: String(err instanceof Error ? err.message : err).slice(0, 160) }, reasoning: "The Worker call failed, so the template written by code is used.", action: "draft_failed" });
        break;
      }
      const candidate = res.text.trim();
      const candidateHits = validate(candidate, opts.facts, step.checks);
      await this.record(worker, { input: user, output: candidate, reasoning: `Worker worded the ${step.recipe.skill} brief from code-supplied facts only (attempt ${attempt + 1}).`, action: "draft", usage: res.usage });
      if (candidateHits.length === 0) {
        text = candidate;
        hits = [];
        by = "worker";
        break;
      }
      hits = candidateHits;
    }
    if (by === "template") hits = validate(text, opts.facts, step.checks);
    await this.record(validator, {
      input: text,
      output: { pass: hits.length === 0, hits: hits.map((h) => h.rule), by },
      reasoning: hits.length === 0 ? `All ${step.checks.length} checks of step ${step.id} pass (${step.checks.join(", ")}).` : `Failed ${hits.map((h) => `${h.rule}: ${h.message}`).join("; ")}; the draft goes to the owner, not out.`,
      action: hits.length === 0 ? "validator_pass" : "validator_fail",
    });
    return { text, hits, by };
  }

  queue(item: Omit<ReviewItem, "id" | "status">): ReviewItem {
    const full: ReviewItem = { ...item, id: this.nextId("rv"), status: "pending" };
    this.state.queue.push(full);
    return full;
  }

  pending(id: string): ReviewItem {
    const item = this.state.queue.find((q) => q.id === id);
    if (!item || item.status !== "pending") throw new CrewError(`no pending review ${id}`);
    return item;
  }

  /** Runs a connector tool; the caller's `execute` already falls back to the Log connector. */
  async exec(step: PlaybookStep, args: Record<string, unknown>): Promise<ExecResult> {
    if (!step.publish) throw new CrewError(`step ${step.id} has no publish tool`);
    return this.deps.execute(step.publish.connector, step.publish.tool, args);
  }

  /** Target or budget reached: the Operator stops the playbook itself, as a traced decision. */
  async checkStop(): Promise<boolean> {
    const pb = this.state.playbook;
    const reason =
      pb.stop.on_target && this.state.metric >= pb.goal.target
        ? `target reached: ${pb.goal.metric} ${this.state.metric}/${pb.goal.target}`
        : pb.stop.on_budget && this.state.spent_idr >= pb.budget.max_cost_idr
          ? `budget used: Rp${this.state.spent_idr}`
          : pb.stop.by_date && this.today() > pb.stop.by_date
            ? `goal date ${pb.stop.by_date} passed`
            : null;
    if (!reason || this.state.status !== "running") return false;
    const op = await this.agent("operator", `Playbook: ${pb.title}`);
    await this.record(op, { input: `${pb.goal.metric}=${this.state.metric}, spent Rp${this.state.spent_idr}`, output: { action: "stop_playbook", reason }, reasoning: `The playbook stops itself: ${reason}.`, action: "stop_playbook" });
    this.state.status = "stopped";
    this.state.stop_reason = reason;
    return true;
  }

  gate(actionClass: string, unusual = false): "auto" | "auto_digest" | "ask" {
    return this.deps.gate?.(actionClass, unusual) ?? (unusual ? "ask" : "auto");
  }
}
