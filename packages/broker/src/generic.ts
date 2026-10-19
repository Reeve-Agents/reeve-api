import type { GenericOperationRecord, GenericScenario, HeldAction, Rulebook, SentAction, SimEvent } from "@reeve/core";
import { addDays, dayOffset, NeedsPasskeyError, OperatorError, type OperatorDeps } from "./index";

/**
 * The Operator for the generic pack. The approved rules run in the sandbox over the owner's current
 * records; every new decision becomes a connector tool call the broker makes (Composio, an MCP
 * server, or a log), but only for tools the approved rulebook names. Actions above an approval
 * limit wait for the owner's passkey; "never" decisions and KPI alerts are recorded for the owner.
 */

export type { GenericOperationRecord, HeldAction, SentAction } from "@reeve/core";

export interface GenericDeps {
  runRules: (scenario: GenericScenario) => Promise<{ events: SimEvent[]; violations: string[] }>;
  /** Makes one tool call through the connector registry. */
  execute: (connector: string, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; connector: string }>;
  /** Current records, re-read from the data source on every step. */
  records: () => Promise<GenericScenario["records"]>;
  record: OperatorDeps["record"];
  save: () => void;
  now?: () => Date;
}

export function newGenericOperation(input: { id: string; rulebookId: string; receiptHash: string; datasetId: string; startDate: string; now?: Date }): GenericOperationRecord {
  return { ...input, kind: "generic", clock: null, status: "idle", sent: [], held: [], log: [], createdAt: (input.now ?? new Date()).toISOString() };
}

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

export class GenericOperator {
  /** Tools the approved rulebook names: nothing else is ever called. */
  private readonly allowed: Set<string>;

  constructor(
    private readonly op: GenericOperationRecord,
    private readonly rulebook: Rulebook,
    private readonly deps: GenericDeps,
  ) {
    this.allowed = new Set(rulebook.cards.flatMap((c) => (c.type === "generic_rule" ? [c.action.tool] : [])));
  }

  private say(line: string) {
    this.op.log.push({ at: (this.deps.now ?? (() => new Date()))().toISOString(), line });
    this.deps.save();
  }

  async advance(toDate: string): Promise<SimEvent[]> {
    const op = this.op;
    if (op.clock !== null && toDate <= op.clock) throw new OperatorError(`the clock is already at ${op.clock}`);
    if (toDate < op.startDate) throw new OperatorError(`the run starts on ${op.startDate}`);
    const from = op.clock ?? addDays(op.startDate, -1);
    const records = await this.deps.records();
    const scenario: GenericScenario = { pack: "generic", start_date: op.startDate, days: dayOffset(op.startDate, toDate) + 1, key_field: this.rulebook.data?.key_field ?? "id", records, updates: [] };
    this.say(`running the approved rules over ${records.length} records, ${op.startDate} → ${toDate}`);
    const { events, violations } = await this.deps.runRules(scenario);
    if (violations.length) {
      this.deps.record({ event: "blocked", ref: violations.join("; ").slice(0, 200) });
      throw new OperatorError(`constraint violated, nothing sent: ${violations.join("; ")}`);
    }
    const fresh = events.filter((e) => e.date > from && e.date <= toDate);
    for (const e of fresh) await this.handle(e);
    op.clock = toDate;
    this.say(`clock at ${toDate}: ${fresh.filter((e) => e.type === "action").length} actions, ${fresh.filter((e) => e.type === "approval_request").length} waiting for you, ${fresh.filter((e) => e.type === "blocked").length} blocked`);
    return fresh;
  }

  private async handle(e: SimEvent) {
    const op = this.op;
    const base = { date: e.date, key: e.tenant_id, rule: e.rule ?? "?" };
    if (e.type === "action") {
      await this.send({ ...base, tool: e.tool!, connector: (e as SimEvent & { connector?: string }).connector ?? "log", args: e.args ?? {}, amount: e.amount });
    } else if (e.type === "approval_request") {
      const id = `ap-${e.tenant_id}-${e.date}-${op.held.length + 1}`;
      const rule = this.rulebook.cards.find((c) => c.id === e.rule);
      op.held.push({
        id,
        ...base,
        kind: "approval_request",
        tool: e.tool,
        connector: rule?.type === "generic_rule" ? rule.action.connector : "log",
        args: e.args,
        amount: e.amount,
        text: `${e.tool} for ${e.tenant_id} is about ${rp(e.amount ?? 0)}, above your limit. Send it?`,
        status: "open",
        needsPasskey: true,
      });
      this.deps.record({ event: "exception_raised", tenant: e.tenant_id, amount: e.amount, ref: id });
    } else if (e.type === "blocked") {
      op.held.push({ id: `bl-${e.tenant_id}-${e.date}-${op.held.length + 1}`, ...base, kind: "blocked", tool: e.tool, text: `${e.tool} for ${e.tenant_id} was not sent: the rulebook forbids it.`, status: "noted", needsPasskey: false });
      this.deps.record({ event: "blocked", tenant: e.tenant_id, ref: `${e.rule}:${e.tool}` });
    } else if (e.type === "kpi_alert") {
      op.held.push({ id: `kpi-${e.date}-${e.rule}`, ...base, kind: "kpi_alert", amount: e.amount, text: `${e.rule}: the watched total is ${rp(e.amount ?? 0)}. A target, not a promise.`, status: "open", needsPasskey: false });
      this.deps.record({ event: "exception_raised", amount: e.amount, ref: `kpi:${e.rule}` });
    }
  }

  private async send(a: Omit<SentAction, "ok" | "via" | "error">) {
    if (!this.allowed.has(a.tool)) {
      this.op.sent.push({ ...a, ok: false, error: `${a.tool} is not in the approved rulebook` });
      this.deps.record({ event: "blocked", tenant: a.key, ref: a.tool });
      return;
    }
    const r = await this.deps.execute(a.connector, a.tool, a.args);
    this.op.sent.push({ ...a, ok: r.ok, via: r.connector, ...(r.error ? { error: r.error } : {}) });
    this.deps.record({ event: r.connector === "log" ? "message_logged" : r.ok ? "invoice_created" : "blocked", tenant: a.key, amount: a.amount, ref: `${a.tool}@${r.connector}${r.ok ? "" : ` failed: ${r.error}`}`.slice(0, 200) });
    this.deps.save();
  }

  /** Release an action held above the limit. The caller must have verified the owner's passkey for exactly this one. */
  async approve(heldId: string, approved: boolean): Promise<HeldAction> {
    const h = this.op.held.find((x) => x.id === heldId);
    if (!h) throw new OperatorError(`no held action ${heldId}`);
    if (h.status !== "open") throw new OperatorError(`${heldId} is already ${h.status}`);
    if (h.kind !== "approval_request") {
      h.status = "noted";
      this.deps.save();
      return h;
    }
    if (!approved) throw new NeedsPasskeyError("sending an action above the limit needs the owner's passkey");
    h.status = "approved";
    await this.send({ date: h.date, key: h.key, rule: h.rule, tool: h.tool!, connector: h.connector ?? "log", args: h.args ?? {}, amount: h.amount });
    return h;
  }

  decline(heldId: string): HeldAction {
    const h = this.op.held.find((x) => x.id === heldId && x.status === "open");
    if (!h) throw new OperatorError(`no open held action ${heldId}`);
    h.status = h.kind === "approval_request" ? "declined" : "noted";
    this.deps.save();
    return h;
  }
}
