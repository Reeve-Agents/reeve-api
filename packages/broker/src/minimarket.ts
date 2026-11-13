import type { SimEvent, StockScenario } from "@reeve/core";
import type { GenericDeps } from "./generic";
import { dayOffset } from "./index";
import { messageFor, RENT_MESSAGE_TOOLS, toolCallFor, type Contact } from "./messages";

/**
 * Minimarket purchase orders on the generic Operator path. The approved minimarket rules (reorder
 * point, supplier fallback, PO approval threshold ...) run in the sandbox as before and emit
 * `po_created` / `po_approval_request` events. This turns them into what GenericOperator already
 * knows how to do: a connector tool call to the supplier (Telegram, Gmail, or the log when the
 * supplier has no contact), with orders above the owner's limit held for a passkey.
 *
 * The allow-list is the same as for rent messages: a purchase order may only ever be a Telegram
 * message, an email or a log line. Markdowns, write-offs and stock-outs stay in the simulation view;
 * the Operator does not act on them.
 */

/** Supplier id (as in the scenario) → how to reach them. Suppliers without an entry are logged, not messaged. */
export type SupplierContacts = Record<string, Contact>;

export function minimarketPack(scenario: StockScenario, suppliers: SupplierContacts): NonNullable<GenericDeps["pack"]> {
  const nameOf = (sku: string) => scenario.items.find((i) => i.id === sku)?.name ?? sku;
  return {
    allowedTools: [...RENT_MESSAGE_TOOLS],
    scenarioFor: (toDate) => ({ ...scenario, days: dayOffset(scenario.start_date, toDate) + 1 }),
    translate: (e: SimEvent): SimEvent | null => {
      if (e.type === "kpi_alert") return e;
      if (e.type !== "po_created" && e.type !== "po_approval_request") return null;
      const [supplier = "?", qtyText = ""] = (e.note ?? "").split(":");
      const msg = messageFor("purchase_order", { name: `Supplier ${supplier}`, room: nameOf(e.tenant_id), amount: e.amount ?? 0, qty: Number(qtyText) || undefined });
      const call = toolCallFor(msg, suppliers[supplier]);
      const args = Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, String(v)]));
      return { ...e, type: e.type === "po_created" ? "action" : "approval_request", rule: "PO", tool: call.tool, args, connector: call.connector } as SimEvent;
    },
  };
}
