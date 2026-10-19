import type { OperationAction, OperationException, OperationInvoice, OperationPayment, OperationRecord, Rulebook, Scenario, SimEvent, Tenant } from "@reeve/core";
import type { PaymentRail, RailEvent, RailInvoice } from "@reeve/rails";
import type { OperationBody } from "@reeve/receipts";

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
  now?: Date;
}): OperationRecord {
  return {
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
    this.say(`clock at ${toDate}: ${done.filter((a) => a.outcome === "invoiced").length} bills sent, ${done.filter((a) => a.outcome === "logged").length} messages logged, ${done.filter((a) => a.outcome === "raised").length} exceptions`);
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
        return { ...base, amount: due, outcome: "invoiced", detail: `${this.name(e.tenant_id)}: rent ${rp(due)} on ${op.rail} (${inv.invoiceId})` };
      }
      case "late_fee": {
        const inv = await this.bill(e.tenant_id, `${e.invoice_id}:fee:${e.date}`, "late_fee", e.amount ?? 0, `Denda keterlambatan ${e.invoice_id}`, 7);
        return { ...base, outcome: "invoiced", detail: `${this.name(e.tenant_id)}: late fee ${rp(e.amount ?? 0)} on ${op.rail} (${inv.invoiceId})` };
      }
      case "reminder":
      case "notice": {
        this.deps.record({ event: "message_logged", tenant: e.tenant_id, amount: e.amount, ref: `${e.type}:${e.invoice_id}` });
        const what = e.type === "reminder" ? `reminder, ${rp(e.amount ?? 0)} still due` : "formal notice to vacate";
        return { ...base, outcome: "logged", detail: `${this.name(e.tenant_id)}: ${what}. Logged, not sent: no WhatsApp or email connector yet` };
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
