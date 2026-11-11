import { createHash } from "node:crypto";
import type { Connector, ConnectorRegistry, ToolInfo, ToolResult } from "@reeve/connectors";
import type { PaymentRail, RailEntry } from "@reeve/rails";

/**
 * Bill creation as connector tools, so a generic rule card can say "create an invoice" the same way it
 * says "send a Telegram message". The card still names the tool (that is the allow-list) and the
 * approval limit + passkey hold in GenericOperator still apply: this file only does the call.
 * Test-mode rails only; the keys stay in the rail entries and never reach a rule.
 */

/** tool slug → rail id */
export const PAYMENT_TOOLS: Record<string, "xendit" | "stripe" | "mock"> = {
  XENDIT_CREATE_INVOICE: "xendit",
  STRIPE_CREATE_INVOICE: "stripe",
  MOCK_CREATE_INVOICE: "mock",
};

const INPUT_SCHEMA = {
  properties: {
    amount: { type: "integer", description: "Whole rupiah" },
    description: { type: "string" },
    customer_name: { type: "string" },
    customer_email: { type: "string" },
    customer_ref: { type: "string", description: "Your id for the payer (room, customer id)" },
    due_date: { type: "string", description: "YYYY-MM-DD" },
  },
  required: ["amount", "description", "customer_name"],
};

const today = () => new Date().toISOString().slice(0, 10);

export class PaymentsConnector implements Connector {
  readonly id = "payments";
  readonly kind = "composio" as const; // sorted with the real connectors; it only ever answers the tools above
  readonly label = "Payment rails (test mode)";

  constructor(private readonly railFor: (id: string) => PaymentRail) {}

  async describeTool(tool: string): Promise<ToolInfo | null> {
    if (!PAYMENT_TOOLS[tool]) return null;
    return { slug: tool, connector: this.id, toolkit: undefined, description: `Create a hosted invoice on ${PAYMENT_TOOLS[tool]} (test mode) and return its payment link`, inputSchema: INPUT_SCHEMA };
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const railId = PAYMENT_TOOLS[tool];
    if (!railId) return { ok: false, error: `${tool} is not a payment tool` };
    const amount = Math.round(Number(args.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be a positive number of rupiah" };
    const name = String(args.customer_name ?? "").trim();
    if (!name) return { ok: false, error: "customer_name is required" };
    const description = String(args.description ?? "Invoice");
    const dueDate = String(args.due_date ?? "").trim() || today();
    const ref = String(args.customer_ref ?? name);
    const email = String(args.customer_email ?? "").trim();
    // Same card, same payer, same amount and day: the rail hands back the same invoice, never a second bill.
    const idempotencyKey = createHash("sha256").update(JSON.stringify([tool, ref, amount, dueDate, description])).digest("hex").slice(0, 32);
    try {
      const inv = await this.railFor(railId).createInvoice({ customer: { ref, name, ...(email ? { email } : {}) }, amount, description, dueDate, idempotencyKey });
      return { ok: true, data: { rail: railId, invoice_id: inv.invoiceId, status: inv.status, amount: inv.amount, pay_url: inv.payUrl ?? null } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

/**
 * The registry plus the payment tools. Everything else (list, linking apps, Composio/MCP lookups) is
 * the inner registry's; only a payment tool slug is answered here, and only when its rail is set up.
 */
export function withPayments(inner: ConnectorRegistry, rails: RailEntry[], railFor: (id: string) => PaymentRail): ConnectorRegistry {
  const payments = new PaymentsConnector(railFor);
  const available = (tool: string) => {
    const id = PAYMENT_TOOLS[tool];
    return id ? rails.find((r) => r.info.id === id)?.info.available === true : false;
  };
  const wrapped = Object.create(inner) as ConnectorRegistry;
  // Instance methods called on `wrapped` keep `this` = wrapped, so execute() and check() see this resolve().
  wrapped.resolve = async (hint: string, tool: string) => {
    if (available(tool)) {
      const info = await payments.describeTool(tool);
      if (info) return { connector: payments, info };
    }
    return inner.resolve(hint, tool);
  };
  wrapped.list = () => [...inner.list(), { id: payments.id, kind: payments.kind, label: payments.label }];
  return wrapped;
}
