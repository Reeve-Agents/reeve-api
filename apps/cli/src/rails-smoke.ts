/**
 * Live check of a payment rail in TEST mode: one small bill, paid, then half refunded.
 *   npm run rails:smoke -- --rail=stripe
 *   npm run rails:smoke -- --rail=xendit
 * Keys come from reeve/.env (STRIPE_SECRET_KEY sk_test_…, XENDIT_SECRET_KEY xnd_development_…); live keys are refused.
 */
import { railEntries, type PaymentRail, type RailInvoice } from "@reeve/rails";

const id = process.argv.find((a) => a.startsWith("--rail="))?.split("=")[1] ?? "stripe";
const entry = railEntries().find((r) => r.info.id === id);
if (!entry) throw new Error(`unknown rail ${id} (stripe, xendit, mock)`);
if (!entry.info.available) {
  console.error(`${entry.info.label} is not set up: add ${entry.info.setup} to reeve/.env`);
  process.exit(1);
}
const rail: PaymentRail = entry.create();
const stamp = Date.now().toString(36);
const today = new Date().toISOString().slice(0, 10);

const show = (label: string, inv: RailInvoice) => console.log(`${label.padEnd(10)} ${inv.invoiceId} · ${inv.status} · Rp${inv.amount.toLocaleString("id-ID")} paid Rp${inv.amountPaid.toLocaleString("id-ID")}${inv.payUrl ? ` · ${inv.payUrl}` : ""}`);

// --check=<id>: look at a bill paid by hand on the hosted page (Xendit), then refund half.
const check = process.argv.find((a) => a.startsWith("--check="))?.split("=")[1];
if (check) {
  const inv = await rail.getInvoice(check);
  show("fetched", inv);
  if (inv.status === "paid") {
    const r = await rail.refund(inv, 5_000, `smoke-${check}-refund`);
    console.log(`refund     ${r.refundId} · ${r.status} · Rp5.000`);
  }
  process.exit(0);
}

const inv = await rail.createInvoice({
  customer: { ref: "SMOKE", name: "Reeve smoke test" },
  amount: 10_000,
  description: "Reeve rail smoke test",
  dueDate: today,
  idempotencyKey: `smoke-${stamp}`,
});
show("created", inv);
show("fetched", await rail.getInvoice(inv.invoiceId));

let paid: RailInvoice | null = null;
try {
  paid = await rail.simulatePayment!(inv.invoiceId);
  show("paid", paid);
} catch (err) {
  console.log(`pay        ${err instanceof Error ? err.message : String(err)}`);
  console.log(`           open the link above, pay with a test channel, then run this again with --check=${inv.invoiceId}`);
}
if (paid?.status === "paid") {
  const r = await rail.refund(paid, 5_000, `smoke-${stamp}-refund`);
  console.log(`refund     ${r.refundId} · ${r.status} · Rp5.000`);
}
