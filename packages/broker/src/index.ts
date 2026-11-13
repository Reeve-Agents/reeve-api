import type { OperationAction, OperationException, OperationInvoice, OperationPayment, OperationRecord, Rulebook, Scenario, SimEvent, Tenant } from "@reeve/core";
import type { PaymentRail, RailEvent, RailInvoice } from "@reeve/rails";
import type { OperationBody } from "@reeve/receipts";
import { messageFor, toolCallFor, type Contact, type Message, type MessageFacts, type MessageKind, type ToolCall } from "./messages";

export { minimarketPack, type SupplierContacts } from "./minimarket";
export { PAYMENT_TOOLS, PaymentsConnector, withPayments } from "./payments";
export { contactsFromRecords, messageFor, RENT_MESSAGE_TOOLS, toolCallFor, type Contact, type Message, type MessageFacts, type MessageKind, type ToolCall } from "./messages";

/** A rent operation with the contact details of its tenants (read from the owner's sheet when the run starts). */
export type RentOperationRecord = OperationRecord & { contacts?: Record<string, Contact>; replies?: ReplyRecord[]; holds?: Record<string, string> };

/** What the classifier made of a tenant's reply. Only these four exist; anything else is "unclear". */
export const REPLY_INTENTS = ["promise_to_pay", "already_paid", "asks_relief", "unclear"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** The only things the Operator may do about a reply; each was approved with the rulebook. Everything else is the owner's. */
export type ReplyAction = "reschedule_reminder" | "check_payment" | "hand_to_owner";

export interface ReplyRecord {
  id: string;
  at: string;
  tenant: string;
  text: string;
  intent: ReplyIntent;
  /** "llm" when a model classified it, "none" when no model is configured (then every reply goes to the owner). */
  source: "llm" | "none";
  action: ReplyAction;
  status: "actioned" | "waiting_owner" | "resolved";
  detail: string;
  /** Set when a model was configured but its call failed (then `source` is "none"). */
  error?: string;
  /** For reschedule_reminder: reminders for this bill are held through this date. */
  holdUntil?: string;
}

export type ReplyClassifier = (text: string, ctx: { name: string; room: string; amount: number; today: string }) => Promise<{ intent: string; promised_date?: string | null } | null>;

/** An action the Operator took that sent a real message. Core's union gains "sent"; until it ships, the value is cast. */
const SENT = "sent" as OperationAction["outcome"];

/**
 * The broker runs outside every sandbox and is the only part of Reeve that holds rail keys.
 *
 * The Operator loop: the approved rules.py (unchanged, hash-checked against the receipt) runs in
 * the sandbox over real tenants and the payments the rail has confirmed, up to Reeve's business
 * clock. The sandbox returns events; the broker turns only the new ones into rail calls, after
 * checking the rulebook's constraints. Irreversible steps (refunds above the rulebook's limit)
 * need the owner's passkey. Every step goes on the hash-chained ledger.
 */

export type { OperationAction, OperationException, OperationInvoice, OperationPayment, OperationRecord } from "@reeve/core";

export interface OperatorDeps {
  rail: PaymentRail;
  /** Runs the approved rules.py in the sandbox over this scenario. */
  runRules: (scenario: Scenario) => Promise<{ events: SimEvent[]; violations: string[] }>;
  /** Appends to the ledger. */
  record: (body: Omit<OperationBody, "at" | "operation_id" | "rail" | "receipt_hash">) => void;
  save: () => void;
  now?: () => Date;
  /**
   * Makes one tool call through the connector registry (Telegram, Gmail, ...). Without it every
   * message is only logged. When the call fails (no key, no account connected) the broker records
   * the message on the Log connector instead and says so.
   */
  send?: (call: ToolCall) => Promise<{ ok: boolean; connector: string; error?: string }>;
  /** Rephrases the approved template in the owner's tone. It may change wording, never the facts. Null keeps the template. */
  draft?: (msg: Message) => Promise<string | null>;
  /** Reads a tenant's reply into one of four intents. Absent (no LLM key) means every reply goes to the owner. */
  classify?: ReplyClassifier;
}

export class OperatorError extends Error {}
export class NeedsPasskeyError extends OperatorError {}

const DAY = 86_400_000;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const dayOffset = (start: string, date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY);
const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

/** Limits the broker enforces itself, read from the approved rulebook (not from the sandbox's output). */
export function policyFor(rulebook: Rulebook) {
  const threshold = rulebook.cards.find((c) => c.type === "approval_threshold");
  const overpay = rulebook.cards.find((c) => c.type === "overpayment");
  return {
    /** Refunds above this need the owner's passkey; with no such card, every refund does. */
    refundApprovalAbove: threshold?.type === "approval_threshold" ? threshold.refund_above : 0,
    overpaymentCard: overpay?.id,
  };
}

export function newOperation(input: {
  id: string;
  rulebookId: string;
  receiptHash: string;
  rail: string;
  startDate: string;
  tenants: Tenant[];
  contacts?: Record<string, Contact>;
  now?: Date;
}): RentOperationRecord {
  return {
    ...(input.contacts && Object.keys(input.contacts).length ? { contacts: input.contacts } : {}),
    id: input.id,
    rulebookId: input.rulebookId,
    receiptHash: input.receiptHash,
    rail: input.rail,
    startDate: input.startDate,
    clock: null,
    status: "idle",
    tenants: input.tenants.map(({ id, name, room, rent, move_in }) => ({ id, name, room, rent, move_in })),
    invoices: [],
    payments: [],
    actions: [],
    exceptions: [],
    seenEvents: [],
    log: [],
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/** A drafted text is only used if it still carries the payment link and the amount the template states. */
export function keepsFacts(text: string, facts: MessageFacts): boolean {
  if (facts.payUrl && !text.includes(facts.payUrl)) return false;
  const digits = (s: string) => s.replace(/[^0-9]/g, "");
  return facts.amount <= 0 || digits(text).includes(String(facts.amount));
}

/** The day a payment seen now counts on: the next business day not yet processed. */
const paymentDay = (op: OperationRecord) => (op.clock === null ? 0 : dayOffset(op.startDate, op.clock) + 1);

export class Operator {
  constructor(
    private readonly op: OperationRecord,
    private readonly rulebook: Rulebook,
    private readonly tenants: Tenant[],
    private readonly deps: OperatorDeps,
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private say(line: string) {
    this.op.log.push({ at: this.now().toISOString(), line });
    this.deps.save();
  }

  private name(tenant: string) {
    const t = this.op.tenants.find((x) => x.id === tenant);
    return t ? `${t.name} (${t.room})` : tenant;
  }

  /** Run the business clock forward to `toDate` (inclusive): audited rules in the sandbox, then rail calls. */
  async advance(toDate: string): Promise<OperationAction[]> {
    const op = this.op;
    if (op.clock !== null && toDate <= op.clock) throw new OperatorError(`the clock is already at ${op.clock}`);
    if (toDate < op.startDate) throw new OperatorError(`the cycle starts on ${op.startDate}`);
    const from = op.clock ?? addDays(op.startDate, -1);
    const scenario: Scenario = {
      start_date: op.startDate,
      days: dayOffset(op.startDate, toDate) + 1,
      tenants: this.tenants,
      payments: op.payments.map((p) => ({ tenant_id: p.tenant, day: p.day, amount: p.amount })),
    };
    this.say(`running the approved rules over ${op.payments.length} real payments, ${op.startDate} → ${toDate}`);
    const { events, violations } = await this.deps.runRules(scenario);

    if (violations.length) {
      const action: OperationAction = { date: toDate, tenant: "-", type: "invoice", outcome: "blocked", detail: `constraint violated, nothing sent: ${violations.join("; ")}` };
      op.actions.push(action);
      this.deps.record({ event: "blocked", ref: violations.join("; ").slice(0, 200) });
      this.say(action.detail);
      throw new OperatorError(action.detail);
    }

    const fresh = events.filter((e) => e.date > from && e.date <= toDate);
    const credit = new Map<string, number>();
    for (const e of fresh) if (e.type === "payment" && e.note === "applied credit") credit.set(`${e.tenant_id}|${e.date}`, (credit.get(`${e.tenant_id}|${e.date}`) ?? 0) + (e.amount ?? 0));

    const done: OperationAction[] = [];
    for (const e of fresh) {
      const action = await this.execute(e, credit);
      if (action) {
        op.actions.push(action);
        done.push(action);
      }
    }
    op.clock = toDate;
    this.say(`clock at ${toDate}: ${done.filter((a) => a.outcome === "invoiced").length} bills sent, ${done.filter((a) => a.outcome === SENT).length} reminders sent, ${done.filter((a) => a.outcome === "logged").length} messages logged, ${done.filter((a) => a.outcome === "raised").length} exceptions`);
    return done;
  }

  private async execute(e: SimEvent, credit: Map<string, number>): Promise<OperationAction | null> {
    const op = this.op;
    const base = { date: e.date, tenant: e.tenant_id, type: e.type, amount: e.amount };
    switch (e.type) {
      case "invoice": {
        const due = (e.amount ?? 0) - (credit.get(`${e.tenant_id}|${e.date}`) ?? 0);
        if (due <= 0) return { ...base, outcome: "covered_by_credit", detail: `${this.name(e.tenant_id)}: covered by credit, no bill sent` };
        const inv = await this.bill(e.tenant_id, `${e.invoice_id}`, "rent", due, `Sewa ${e.invoice_id}`, 14);
        const out = await this.notify(e.tenant_id, "bill", due, `${e.invoice_id}`, inv.payUrl);
        return { ...base, amount: due, outcome: "invoiced", detail: `${this.name(e.tenant_id)}: rent ${rp(due)} on ${op.rail} (${inv.invoiceId}). ${out.detail}` };
      }
      case "late_fee": {
        const inv = await this.bill(e.tenant_id, `${e.invoice_id}:fee:${e.date}`, "late_fee", e.amount ?? 0, `Denda keterlambatan ${e.invoice_id}`, 7);
        const out = await this.notify(e.tenant_id, "late_fee", e.amount ?? 0, `${e.invoice_id}`, inv.payUrl);
        return { ...base, outcome: "invoiced", detail: `${this.name(e.tenant_id)}: late fee ${rp(e.amount ?? 0)} on ${op.rail} (${inv.invoiceId}). ${out.detail}` };
      }
      case "reminder":
      case "notice": {
        // The link of the rent bill this reminder is about, so the tenant can pay straight from the message.
        const open = op.invoices.find((i) => i.key === e.invoice_id && i.status === "open");
        const hold = (op as RentOperationRecord).holds?.[`${e.invoice_id}`];
        if (hold && hold >= e.date) {
          this.deps.record({ event: "message_logged", tenant: e.tenant_id, amount: e.amount ?? 0, ref: `held:${e.type}:${e.invoice_id}` });
          return { ...base, outcome: "logged", detail: `${this.name(e.tenant_id)}: ${e.type} held, the tenant promised to pay by ${hold}.` };
        }
        const out = await this.notify(e.tenant_id, e.type, e.amount ?? 0, `${e.invoice_id}`, open?.payUrl);
        const what = e.type === "reminder" ? `reminder, ${rp(e.amount ?? 0)} still due` : "formal notice to vacate";
        return { ...base, outcome: out.sent ? SENT : "logged", detail: `${this.name(e.tenant_id)}: ${what}. ${out.detail}` };
      }
      case "credit":
      case "refund_request": {
        const limit = policyFor(this.rulebook).refundApprovalAbove;
        const amount = e.amount ?? 0;
        const ex: OperationException = {
          id: `ex-${e.tenant_id}-${e.date}-${op.exceptions.length + 1}`,
          date: e.date,
          tenant: e.tenant_id,
          kind: e.type === "credit" ? "overpayment" : "refund_request",
          amount,
          text:
            e.type === "credit"
              ? `${this.name(e.tenant_id)} paid ${rp(amount)} more than owed. Kept as credit for the next bill, as the rulebook says. Refund it instead?`
              : `${this.name(e.tenant_id)} is owed a refund of ${rp(amount)}.`,
          status: "open",
          needsPasskey: amount > limit,
        };
        op.exceptions.push(ex);
        this.deps.record({ event: "exception_raised", tenant: e.tenant_id, amount, ref: ex.id });
        return { ...base, outcome: "raised", detail: ex.text };
      }
      case "kpi_alert": {
        const ex: OperationException = {
          id: `kpi-${e.date}`,
          date: e.date,
          tenant: "-",
          kind: "kpi_alert",
          amount: e.amount ?? 0,
          text: `Collected ${rp(e.amount ?? 0)} so far this month: the revenue target is at risk. A target, not a promise.`,
          status: "open",
          needsPasskey: false,
        };
        op.exceptions.push(ex);
        this.deps.record({ event: "exception_raised", amount: ex.amount, ref: ex.id });
        return { ...base, outcome: "raised", detail: ex.text };
      }
      default:
        return null; // payments are what we fed in
    }
  }

  /**
   * Tell the tenant. The channel is the tenant's Telegram chat, else their email, else the log; a send
   * that fails (no connector key, no account connected) falls back to the Log connector and says so.
   */
  private async notify(tenant: string, kind: MessageKind, amount: number, invoice: string, payUrl?: string): Promise<{ sent: boolean; detail: string }> {
    const t = this.op.tenants.find((x) => x.id === tenant);
    const facts: MessageFacts = { name: t?.name ?? tenant, room: t?.room ?? tenant, amount, payUrl, invoice };
    const msg = messageFor(kind, facts);
    if (this.deps.draft) {
      const drafted = await this.deps.draft(msg).catch(() => null);
      if (drafted && keepsFacts(drafted, facts)) msg.body = drafted;
    }
    const call = toolCallFor(msg, (this.op as RentOperationRecord).contacts?.[tenant]);
    const ref = `${kind}:${invoice}`;
    const log = async (why: string) => {
      const logCall = toolCallFor(msg, undefined);
      await this.deps.send?.(logCall).catch(() => undefined);
      this.deps.record({ event: "message_logged", tenant, amount, ref });
      return { sent: false, detail: `Message logged, not sent: ${why}.` };
    };
    if (call.tool === "LOG" || !this.deps.send) return log(call.tool === "LOG" ? "no Telegram chat id or email for this tenant" : "no connector configured");
    const r = await this.deps.send(call).catch((err) => ({ ok: false, connector: "none", error: err instanceof Error ? err.message : String(err) }));
    if (r.ok && r.connector !== "log") {
      this.deps.record({ event: "message_sent", tenant, amount, ref: `${ref}@${call.tool}:${r.connector}`.slice(0, 200) });
      return { sent: true, detail: `${kind === "bill" ? "Bill" : "Message"} sent via ${call.tool} (${r.connector})${payUrl ? " with the payment link" : ""}.` };
    }
    return log(r.error ? `${call.tool} failed (${r.error})` : `${call.tool} has no connected account`);
  }

  private async bill(tenant: string, key: string, kind: OperationInvoice["kind"], amount: number, description: string, dueInDays: number) {
    const op = this.op;
    const existing = op.invoices.find((i) => i.key === key);
    if (existing) return existing;
    const t = this.tenants.find((x) => x.id === tenant);
    const inv = await this.deps.rail.createInvoice({
      customer: { ref: tenant, name: t?.name ?? tenant },
      amount,
      description: `${description} · ${t?.room ?? tenant}`,
      dueDate: addDays(this.now().toISOString().slice(0, 10), dueInDays),
      idempotencyKey: `${op.id}:${key}`,
    });
    const row: OperationInvoice = {
      key,
      tenant,
      kind,
      amount,
      date: op.clock === null ? op.startDate : addDays(op.clock, 1),
      invoiceId: inv.invoiceId,
      status: inv.status,
      amountPaid: inv.amountPaid,
      payUrl: inv.payUrl,
      paymentRef: inv.paymentRef,
    };
    op.invoices.push(row);
    this.deps.record({ event: "invoice_created", tenant, amount, ref: inv.invoiceId });
    this.deps.save();
    return row;
  }

  private markPaid(row: OperationInvoice, inv: Pick<RailInvoice, "amountPaid" | "paymentRef">, source: OperationPayment["source"]) {
    if (row.status === "paid") return false;
    row.status = "paid";
    row.amountPaid = inv.amountPaid;
    row.paymentRef = inv.paymentRef ?? row.paymentRef;
    this.op.payments.push({ tenant: row.tenant, day: paymentDay(this.op), amount: inv.amountPaid, source, ref: row.invoiceId, at: this.now().toISOString() });
    this.deps.record({ event: "payment_received", tenant: row.tenant, amount: inv.amountPaid, ref: row.invoiceId });
    this.say(`${this.name(row.tenant)} paid ${rp(inv.amountPaid)} (${row.invoiceId})`);
    return true;
  }

  /**
   * A tenant answered one of our messages. The classifier only picks an intent; the action each
   * intent maps to is fixed here, and bounded by the approved rulebook:
   *  - promise_to_pay -> hold reminders until that date (needs a reminder rule, a date within 30
   *    days, and an amount at or under the rulebook's approval limit; no limit card means 0)
   *  - already_paid -> ask the rail; if it does not show the payment, the owner decides
   *  - asks_relief, unclear, no model, no open bill, amount over the limit -> the owner
   * No message goes back to the tenant from here. Every step is on the ledger.
   */
  async handleReply(tenantId: string, text: string): Promise<ReplyRecord> {
    const op = this.op as RentOperationRecord;
    const t = op.tenants.find((x) => x.id === tenantId);
    if (!t) throw new OperatorError(`no tenant ${tenantId} in this operation`);
    const today = op.clock === null ? op.startDate : addDays(op.clock, 1);
    const open = [...op.invoices].reverse().find((i) => i.tenant === tenantId && i.kind === "rent" && i.status === "open");
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
    // A model that fails is not the same as no model: keep the error, show it, record it.
    let modelError: string | undefined;
    const verdict = this.deps.classify
      ? await this.deps.classify(clean, { name: t.name, room: t.room, amount: open?.amount ?? 0, today }).catch((err) => {
          modelError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          return null;
        })
      : null;
    const intent: ReplyIntent = verdict && (REPLY_INTENTS as readonly string[]).includes(verdict.intent) ? (verdict.intent as ReplyIntent) : "unclear";
    const rec: ReplyRecord = {
      id: `reply-${tenantId}-${(op.replies?.length ?? 0) + 1}`,
      at: this.now().toISOString(),
      tenant: tenantId,
      text: clean,
      intent,
      source: verdict ? "llm" : "none",
      action: "hand_to_owner",
      status: "waiting_owner",
      detail: "",
      ...(modelError ? { error: modelError } : {}),
    };
    (op.replies ??= []).push(rec);
    this.deps.record({ event: "reply_received", tenant: tenantId, amount: open?.amount, ref: `${rec.id}:${intent}${modelError ? `:model_error ${modelError}` : ""}`.slice(0, 200) });
    if (modelError) console.warn(`[reeve] reply classifier failed: ${modelError}`);

    const owner = (why: string) => {
      rec.detail = `${this.name(tenantId)} replied: "${clean.slice(0, 120)}". ${why} Waiting for the owner.`;
    };
    const limit = policyFor(this.rulebook).refundApprovalAbove;
    const hasReminder = this.rulebook.cards.some((c) => c.type === "reminder");
    if (modelError) owner(`The language model failed (${modelError}), so this reply goes to the owner.`);
    else if (!verdict) owner("No language model is configured, so every reply goes to the owner.");
    else if (!open) owner("No open rent bill for this tenant.");
    else if (open.amount > limit) owner(`The bill (${rp(open.amount)}) is above the owner-approval limit (${rp(limit)}).`);
    else if (intent === "promise_to_pay") {
      const date = verdict.promised_date ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > addDays(today, 30)) owner("The promised date is missing or outside the next 30 days.");
      else if (!hasReminder) owner("The rulebook has no reminder rule to reschedule.");
      else {
        op.holds = { ...op.holds, [open.key]: date };
        rec.action = "reschedule_reminder";
        rec.status = "actioned";
        rec.holdUntil = date;
        rec.detail = `${this.name(tenantId)} promised to pay by ${date}. Reminders for ${open.key} are held until then.`;
      }
    } else if (intent === "already_paid") {
      await this.refresh();
      rec.action = "check_payment";
      if (open.status === "open") owner("The rail does not show a payment yet.");
      else {
        rec.status = "actioned";
        rec.detail = `${this.name(tenantId)} said it paid; the rail confirms the bill is ${open.status}.`;
      }
    } else owner(intent === "asks_relief" ? "They asked for relief, which only the owner can grant." : "The reply is unclear.");

    this.deps.record({ event: "reply_actioned", tenant: tenantId, amount: open?.amount, ref: `${rec.id}:${rec.action}:${rec.status}`.slice(0, 200) });
    this.say(rec.detail);
    return rec;
  }

  /** The owner has dealt with a reply that was waiting for them. */
  resolveReply(id: string): ReplyRecord {
    const rec = (this.op as RentOperationRecord).replies?.find((r) => r.id === id);
    if (!rec) throw new OperatorError(`no reply ${id}`);
    rec.status = "resolved";
    this.deps.save();
    return rec;
  }

  /** Ask the rail for every open bill's status (for local runs without a public webhook URL). */
  async refresh(): Promise<number> {
    let paid = 0;
    for (const row of this.op.invoices.filter((i) => i.status === "open")) {
      const inv = await this.deps.rail.getInvoice(row.invoiceId);
      if (inv.status === "paid" && this.markPaid(row, inv, "rail")) paid++;
      else if (inv.status !== "open") row.status = inv.status;
    }
    this.deps.save();
    return paid;
  }

  /** A verified webhook from the rail. Duplicates are ignored. Returns false if the bill is not in this operation. */
  handleEvent(event: RailEvent): boolean {
    const row = this.op.invoices.find((i) => i.invoiceId === event.invoiceId);
    if (!row) return false;
    if (this.op.seenEvents.includes(event.eventId)) return true;
    this.op.seenEvents.push(event.eventId);
    if (event.type === "invoice.paid") this.markPaid(row, { amountPaid: event.amount, paymentRef: event.paymentRef }, "rail");
    else row.status = "expired";
    this.deps.save();
    return true;
  }

  /** Test mode: pay a bill as the tenant would. */
  async simulatePayment(invoiceId: string): Promise<OperationInvoice> {
    const row = this.op.invoices.find((i) => i.invoiceId === invoiceId);
    if (!row) throw new OperatorError(`no bill ${invoiceId} in this operation`);
    if (!this.deps.rail.simulatePayment) throw new OperatorError(`${this.op.rail} cannot simulate payments`);
    const inv = await this.deps.rail.simulatePayment(invoiceId);
    if (inv.status === "paid") this.markPaid(row, inv, "rail");
    this.deps.save();
    return row;
  }

  /** A bank transfer the owner saw outside the rail (tenants often transfer directly). */
  recordTransfer(tenant: string, amount: number): OperationPayment {
    if (!this.op.tenants.some((t) => t.id === tenant)) throw new OperatorError(`unknown tenant ${tenant}`);
    if (!Number.isInteger(amount) || amount <= 0) throw new OperatorError("amount must be a positive whole number of rupiah");
    const p: OperationPayment = { tenant, day: paymentDay(this.op), amount, source: "transfer", ref: `transfer-${this.op.payments.length + 1}`, at: this.now().toISOString() };
    this.op.payments.push(p);
    this.deps.record({ event: "payment_received", tenant, amount, ref: p.ref });
    this.say(`transfer recorded: ${this.name(tenant)} ${rp(amount)}; the rules see it on the next business day`);
    return p;
  }

  keepCredit(exceptionId: string): OperationException {
    const ex = this.openException(exceptionId);
    ex.status = ex.kind === "kpi_alert" ? "noted" : "kept_as_credit";
    this.deps.record({ event: "credit_kept", tenant: ex.tenant, amount: ex.amount, ref: ex.id });
    this.deps.save();
    return ex;
  }

  /**
   * Refund an overpayment on the rail. Above the rulebook's limit the caller must have verified the
   * owner's passkey for exactly this exception (`approved`). The payment history is netted down so
   * the rules no longer count the refunded amount as credit.
   */
  async refund(exceptionId: string, approved: boolean): Promise<OperationException> {
    const ex = this.openException(exceptionId);
    if (ex.kind === "kpi_alert") throw new OperatorError("a KPI alert has nothing to refund");
    if (ex.needsPasskey && !approved) throw new NeedsPasskeyError(`refunds above ${rp(policyFor(this.rulebook).refundApprovalAbove)} need the owner's passkey`);
    const paid = [...this.op.invoices].reverse().find((i) => i.tenant === ex.tenant && i.status === "paid" && i.amountPaid >= ex.amount);
    if (!paid) throw new OperatorError(`no payment on ${this.op.rail} from ${this.name(ex.tenant)} large enough to refund ${rp(ex.amount)}`);
    const r = await this.deps.rail.refund(
      { invoiceId: paid.invoiceId, status: "paid", amount: paid.amount, amountPaid: paid.amountPaid, paymentRef: paid.paymentRef },
      ex.amount,
      `${this.op.id}:${ex.id}:refund`,
    );
    let left = ex.amount;
    for (const p of [...this.op.payments].reverse()) {
      if (left <= 0) break;
      if (p.tenant !== ex.tenant) continue;
      const cut = Math.min(p.amount, left);
      p.amount -= cut;
      left -= cut;
    }
    ex.status = "refunded";
    ex.refundId = r.refundId;
    this.deps.record({ event: "refund_issued", tenant: ex.tenant, amount: ex.amount, ref: r.refundId });
    this.say(`refunded ${rp(ex.amount)} to ${this.name(ex.tenant)} (${r.refundId}, ${r.status})`);
    return ex;
  }

  private openException(id: string) {
    const ex = this.op.exceptions.find((x) => x.id === id);
    if (!ex) throw new OperatorError(`no exception ${id}`);
    if (ex.status !== "open") throw new OperatorError(`exception ${id} is already ${ex.status}`);
    return ex;
  }
}

export { GenericOperator, newGenericOperation, type GenericDeps, type GenericOperationRecord, type HeldAction, type SentAction } from "./generic";
