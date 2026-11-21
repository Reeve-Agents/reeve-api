import type { AnyScenario, GenericOperationRecord, GenericScenario, HeldAction, Rulebook, SentAction, SimEvent } from "@reeve/core";
import { addDays, dayOffset, NeedsPasskeyError, OperatorError, type OperatorDeps } from "./index";
import { prepareWhatsApp, WHATSAPP_CHANNEL, type PreparedMessage, type WhatsAppOffer } from "./messages";

/**
 * The Operator for the generic pack. The approved rules run in the sandbox over the owner's current
 * records; every new decision becomes a connector tool call the broker makes (Composio, an MCP
 * server, or a log), but only for tools the approved rulebook names. Actions above an approval
 * limit wait for the owner's passkey; "never" decisions and KPI alerts are recorded for the owner.
 */

export type { GenericOperationRecord, HeldAction, SentAction } from "@reeve/core";

/** A generic operation with the messages Reeve prepared as WhatsApp links (purchase orders to suppliers with a WhatsApp number). */
export type GenericOperation = GenericOperationRecord & { prepared?: PreparedMessage[] };

export interface GenericDeps {
  runRules: (scenario: AnyScenario) => Promise<{ events: SimEvent[]; violations: string[] }>;
  /** Makes one tool call through the connector registry. */
  execute: (connector: string, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; connector: string; data?: unknown }>;
  /** Current records, re-read from the data source on every step. */
  records: () => Promise<GenericScenario["records"]>;
  /**
   * Another pack running on this path (minimarket purchase orders): the scenario to run up to a date,
   * a translation of that pack's events into tool calls and holds, and the tools it may call.
   */
  pack?: {
    scenarioFor: (toDate: string) => AnyScenario;
    translate: (e: SimEvent) => SimEvent | null;
    allowedTools: string[];
  };
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
    this.allowed = new Set(deps.pack ? deps.pack.allowedTools : rulebook.cards.flatMap((c) => (c.type === "generic_rule" ? [c.action.tool] : [])));
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
    let scenario: AnyScenario;
    if (this.deps.pack) {
      scenario = this.deps.pack.scenarioFor(toDate);
      this.say(`running the approved rules, ${op.startDate} → ${toDate}`);
    } else {
      const records = await this.deps.records();
      scenario = { pack: "generic", start_date: op.startDate, days: dayOffset(op.startDate, toDate) + 1, key_field: this.rulebook.data?.key_field ?? "id", records, updates: [] } satisfies GenericScenario;
      this.say(`running the approved rules over ${records.length} records, ${op.startDate} → ${toDate}`);
    }
    const { events: raw, violations } = await this.deps.runRules(scenario);
    const events = this.deps.pack ? raw.flatMap((e) => this.deps.pack!.translate(e) ?? []) : raw;
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
    const offer = (e as SimEvent & { whatsapp?: WhatsAppOffer }).whatsapp;
    if (e.type === "action") {
      await this.send({ ...base, tool: e.tool!, connector: (e as SimEvent & { connector?: string }).connector ?? "log", args: e.args ?? {}, amount: e.amount }, offer);
    } else if (e.type === "approval_request") {
      const id = `ap-${e.tenant_id}-${e.date}-${op.held.length + 1}`;
      const rule = this.rulebook.cards.find((c) => c.id === e.rule);
      op.held.push({
        id,
        ...base,
        kind: "approval_request",
        tool: e.tool,
        connector: rule?.type === "generic_rule" ? rule.action.connector : ((e as SimEvent & { connector?: string }).connector ?? "log"),
        args: e.args,
        amount: e.amount,
        text: `${e.tool} for ${e.tenant_id} is about ${rp(e.amount ?? 0)}, above your limit. Send it?`,
        status: "open",
        needsPasskey: true,
        // Kept with the held action: a WhatsApp link is prepared only if the owner approves it.
        ...(offer ? { whatsapp: offer } : {}),
      } as HeldAction);
      this.deps.record({ event: "exception_raised", tenant: e.tenant_id, amount: e.amount, ref: id });
    } else if (e.type === "blocked") {
      op.held.push({ id: `bl-${e.tenant_id}-${e.date}-${op.held.length + 1}`, ...base, kind: "blocked", tool: e.tool, text: `${e.tool} for ${e.tenant_id} was not sent: the rulebook forbids it.`, status: "noted", needsPasskey: false });
      this.deps.record({ event: "blocked", tenant: e.tenant_id, ref: `${e.rule}:${e.tool}` });
    } else if (e.type === "kpi_alert") {
      op.held.push({ id: `kpi-${e.date}-${e.rule}`, ...base, kind: "kpi_alert", amount: e.amount, text: `${e.rule}: the watched total is ${rp(e.amount ?? 0)}. A target, not a promise.`, status: "open", needsPasskey: false });
      this.deps.record({ event: "exception_raised", amount: e.amount, ref: `kpi:${e.rule}` });
    }
  }

  /**
   * The message is ready as a WhatsApp link for the owner to send from their own WhatsApp. Returns true when it was
   * (the action is recorded as done by "whatsapp_link", never as sent); otherwise the reason the number was unusable, if any.
   */
  private prepare(a: Omit<SentAction, "ok" | "via" | "error">, offer: WhatsAppOffer, why?: string): true | { skipped?: string } {
    const op = this.op as GenericOperation;
    const ref = `${offer.message.kind}:${a.key}`;
    const link = prepareWhatsApp(offer.message, { whatsapp: offer.number }, { id: `wa-${a.key}-${(op.prepared?.length ?? 0) + 1}`, at: (this.deps.now ?? (() => new Date()))().toISOString(), tenant: a.key, ref });
    if (!link || "skipped" in link) return { skipped: link?.skipped };
    (op.prepared ??= []).push(link.prepared);
    op.sent.push({ ...a, ok: true, via: WHATSAPP_CHANNEL, error: `prepared as a WhatsApp link, not sent${why ? `: ${why}` : ""}` });
    this.deps.record({ event: "message_prepared", tenant: a.key, amount: a.amount, ref, channel: WHATSAPP_CHANNEL });
    this.deps.save();
    return true;
  }

  private async send(a: Omit<SentAction, "ok" | "via" | "error">, offer?: WhatsAppOffer) {
    if (!this.allowed.has(a.tool)) {
      this.op.sent.push({ ...a, ok: false, error: `${a.tool} is not in the approved rulebook` });
      this.deps.record({ event: "blocked", tenant: a.key, ref: a.tool });
      return;
    }
    // No automatic channel on file (the Log tool): a WhatsApp link, when the contact has a valid number, instead of a log line.
    let skipped: string | undefined;
    if (offer && a.tool === "LOG") {
      const done = this.prepare(a, offer);
      if (done === true) return;
      skipped = done.skipped;
    }
    let r: Awaited<ReturnType<GenericDeps["execute"]>> = await this.deps.execute(a.connector, a.tool, a.args).catch((err) => ({ ok: false, connector: "none", error: err instanceof Error ? err.message : String(err) }));
    // A message that cannot be delivered (no account connected, no key) becomes a WhatsApp link when the contact has a number, else is kept on the Log connector, as in the rent path; the reason stays on the action.
    if (!r.ok && /SEND_MESSAGE|SEND_EMAIL/.test(a.tool)) {
      const reason = r.error ?? "not delivered";
      if (offer) {
        const done = this.prepare(a, offer, reason);
        if (done === true) return;
        skipped = done.skipped;
      }
      const note = skipped ? `${reason}; WhatsApp link skipped: ${skipped}` : reason;
      const logged = await this.deps.execute("log", "LOG", { tool: a.tool, rule: a.rule, key: a.key, ...a.args, not_sent_because: note }).catch(() => null);
      if (logged?.ok) r = { ok: true, connector: "log", error: `not sent, logged instead: ${note}` };
    }
    // A payment tool hands back the hosted link; keep it with the action so the owner (and the tenant message) can use it.
    const result = r.ok && r.data && typeof r.data === "object" && "pay_url" in r.data ? { pay_url: (r.data as { pay_url: string | null }).pay_url, invoice_id: (r.data as { invoice_id?: string }).invoice_id } : undefined;
    this.op.sent.push({ ...a, ok: r.ok, via: r.connector, ...(r.error ? { error: r.error } : {}), ...(result ? { result } : {}) } as SentAction);
    this.deps.record({ event: r.connector === "log" ? "message_logged" : r.ok ? (a.tool.endsWith("_CREATE_INVOICE") ? "invoice_created" : "message_sent") : "blocked", tenant: a.key, amount: a.amount, ref: `${a.tool}@${r.connector}${r.ok ? "" : ` failed: ${r.error}`}`.slice(0, 200) });
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
    await this.send({ date: h.date, key: h.key, rule: h.rule, tool: h.tool!, connector: h.connector ?? "log", args: h.args ?? {}, amount: h.amount }, (h as HeldAction & { whatsapp?: WhatsAppOffer }).whatsapp);
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
