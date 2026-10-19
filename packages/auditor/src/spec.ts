import { findCard, type Rulebook, type Scenario, type SimEvent } from "@reeve/core";

/**
 * The Auditor's independent specification.
 * Every expectation below is derived from the rulebook (what the owner asked for),
 * never from the Builder's code or tests. That separation is the "checker" in maker-checker.
 */

export interface SpecCase {
  name: string;
  card: string;
  scenario: Scenario;
  types: SimEvent["type"][];
  expect: Partial<SimEvent>[];
  ignore_amount?: SimEvent["type"][];
}

const RENT = 1_500_000;
const YEAR = 2026;
const MONTH = 11; // November: 30 days, so the next invoice lands exactly 30 days after the first
const MAX_WINDOW = 30;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const monthsBefore = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return iso(d);
};

/** Python's round() (half to even), so fee arithmetic matches the runtime's documented convention. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (Math.abs(diff - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

export function buildSpecCases(rb: Rulebook): { cases: SpecCase[]; skipped: string[] } {
  const cases: SpecCase[] = [];
  const skipped: string[] = [];
  const inv = findCard(rb, "invoice_schedule");
  const issue = iso(date(YEAR, MONTH, inv?.day_of_month ?? 1));
  const tenant = (id: string, tenureMonths: number, rent = RENT) => ({ id, name: id, room: id, rent, move_in: monthsBefore(issue, tenureMonths) });
  const scenario = (tenants: ReturnType<typeof tenant>[], days: number, payments: { tenant_id: string; day: number; amount: number }[] = [], start = issue): Scenario => ({
    start_date: start,
    days,
    tenants,
    payments,
  });

  if (inv) {
    cases.push({
      name: "invoice issued on schedule",
      card: inv.id,
      scenario: scenario([tenant("t1", 2)], 1, [{ tenant_id: "t1", day: 0, amount: RENT }]),
      types: ["invoice"],
      expect: [{ date: issue, tenant_id: "t1", type: "invoice", amount: RENT }],
    });
  }

  const rem = rb.cards.filter((c) => c.type === "reminder");
  const remDays = [...new Set(rem.flatMap((c) => (c.type === "reminder" ? c.days_after_due : [])))].filter((d) => d > 0).sort((a, b) => a - b);
  if (rem.length && remDays.length) {
    const days = Math.min(Math.max(...remDays) + 1, MAX_WINDOW);
    cases.push({
      name: "reminders while unpaid",
      card: rem[0]!.id,
      scenario: scenario([tenant("t1", 2)], days),
      types: ["reminder"],
      ignore_amount: ["reminder"],
      expect: remDays.filter((d) => d < days).map((d) => ({ date: addDays(issue, d), tenant_id: "t1", type: "reminder" as const })),
    });
    if (remDays.length > 1) {
      const first = remDays[0]!;
      cases.push({
        name: "reminders stop once paid",
        card: rem[0]!.id,
        scenario: scenario([tenant("t1", 2)], days, [{ tenant_id: "t1", day: first + 1, amount: RENT * 2 }]),
        types: ["reminder"],
        ignore_amount: ["reminder"],
        expect: [{ date: addDays(issue, first), tenant_id: "t1", type: "reminder" }],
      });
    }
  }

  const fee = findCard(rb, "late_fee");
  if (fee) {
    const amountOn = (base: number) => roundHalfEven((base * fee.percent) / 100);
    if (fee.days_after_due + 2 > MAX_WINDOW) {
      skipped.push(`${fee.id}: late fee day ${fee.days_after_due} is outside the ${MAX_WINDOW}-day test window`);
    } else {
      const days = fee.days_after_due + 2;
      cases.push({
        name: "late fee for a new tenant, charged once",
        card: fee.id,
        scenario: scenario([tenant("t1", 2)], days),
        types: ["late_fee"],
        expect: [{ date: addDays(issue, fee.days_after_due), tenant_id: "t1", type: "late_fee", amount: amountOn(RENT) }],
      });
      cases.push({
        name: "no fee when paid on the fee day",
        card: fee.id,
        scenario: scenario([tenant("t1", 2)], days, [{ tenant_id: "t1", day: fee.days_after_due, amount: RENT }]),
        types: ["late_fee"],
        expect: [],
      });
      cases.push({
        name: "fee basis after a partial payment",
        card: fee.id,
        scenario: scenario([tenant("t1", 2)], days, [{ tenant_id: "t1", day: 1, amount: RENT / 2 }]),
        types: ["late_fee"],
        expect: [{ date: addDays(issue, fee.days_after_due), tenant_id: "t1", type: "late_fee", amount: amountOn(fee.basis === "rent" ? RENT : RENT / 2) }],
      });
    }
    const g = fee.tenure_grace;
    if (g) {
      const vetDay = fee.days_after_due + g.extra_days;
      if (vetDay + 2 > MAX_WINDOW) {
        skipped.push(`${fee.id}: grace fee day ${vetDay} is outside the ${MAX_WINDOW}-day test window`);
      } else {
        const tenants = [tenant("veteran", g.min_months)];
        const expect: Partial<SimEvent>[] = [{ date: addDays(issue, vetDay), tenant_id: "veteran", type: "late_fee", amount: amountOn(RENT) }];
        if (g.min_months >= 1) {
          tenants.push(tenant("almost", g.min_months - 1));
          expect.push({ date: addDays(issue, fee.days_after_due), tenant_id: "almost", type: "late_fee", amount: amountOn(RENT) });
        }
        cases.push({
          name: `long-term tenants (>= ${g.min_months} months) get ${g.extra_days} extra days`,
          card: fee.id,
          scenario: scenario(tenants, vetDay + 2),
          types: ["late_fee"],
          expect,
        });
      }
    }
  }

  const notice = findCard(rb, "notice");
  if (notice) {
    if (notice.days_after_due + 1 > MAX_WINDOW) {
      skipped.push(`${notice.id}: notice day ${notice.days_after_due} is outside the ${MAX_WINDOW}-day test window`);
    } else {
      cases.push({
        name: "notice to vacate when still unpaid",
        card: notice.id,
        scenario: scenario([tenant("t1", 2)], notice.days_after_due + 1),
        types: ["notice"],
        expect: [{ date: addDays(issue, notice.days_after_due), tenant_id: "t1", type: "notice" }],
      });
    }
  }

  const over = findCard(rb, "overpayment");
  const approval = findCard(rb, "approval_threshold");
  if (over?.policy === "refund_with_approval") {
    const threshold = approval?.refund_above ?? null;
    const above = (threshold ?? 250_000) + 1;
    const at = threshold ?? 250_000;
    cases.push({
      name: "overpayment refunds respect the approval threshold",
      card: approval?.id ?? over.id,
      scenario: scenario([tenant("t1", 2), tenant("t2", 2)], 1, [
        { tenant_id: "t1", day: 0, amount: RENT + above },
        { tenant_id: "t2", day: 0, amount: RENT + at },
      ]),
      types: ["credit", "refund_request"],
      // No threshold card: every refund is auto-approved. With one: only amounts strictly above it need approval.
      expect: [
        { date: issue, tenant_id: "t1", type: "refund_request", amount: above, note: threshold !== null && above > threshold ? "approval_required" : "auto_approved" },
        { date: issue, tenant_id: "t2", type: "refund_request", amount: at, note: threshold !== null && at > threshold ? "approval_required" : "auto_approved" },
      ] satisfies Partial<SimEvent>[],
    });
  } else {
    cases.push({
      name: "overpayment becomes credit",
      card: over?.id ?? "default",
      scenario: scenario([tenant("t1", 2)], 1, [{ tenant_id: "t1", day: 0, amount: RENT + 250_000 }]),
      types: ["credit", "refund_request"],
      expect: [{ date: issue, tenant_id: "t1", type: "credit", amount: 250_000 }],
    });
  }

  const kpi = findCard(rb, "revenue_target");
  if (kpi) {
    const start = iso(date(YEAR, MONTH, 1));
    const alertDate = iso(date(YEAR, MONTH, kpi.alert_day));
    const mkey = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
    const invoicedBy = (day: number, rent: number) => ((inv?.day_of_month ?? 1) <= day ? rent : 0);
    const mk = (name: string, rent: number, paid: number) => {
      const value = kpi.basis === "collected" ? paid : invoicedBy(kpi.alert_day, rent);
      const alert = value < kpi.monthly_target;
      cases.push({
        name,
        card: kpi.id,
        scenario: scenario([tenant("t1", 2, rent)], kpi.alert_day, paid > 0 ? [{ tenant_id: "t1", day: 0, amount: paid }] : [], start),
        types: ["kpi_alert"],
        expect: alert ? [{ date: alertDate, tenant_id: "-", type: "kpi_alert", amount: paid, note: mkey }] : [],
      });
    };
    if (kpi.basis === "collected") {
      mk("KPI alert when collections are below target", RENT, kpi.monthly_target - 1);
      mk("no KPI alert when the target is met", RENT, kpi.monthly_target);
    } else {
      mk("KPI alert when invoicing is below target", kpi.monthly_target - 1, 0);
      mk("no KPI alert when invoicing meets target", kpi.monthly_target, 0);
    }
  }

  return { cases, skipped };
}
