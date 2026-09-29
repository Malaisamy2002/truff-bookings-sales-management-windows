/**
 * Independent expected-ledger oracle for the load-test dataset.
 *
 * This module intentionally does not import analytics.ts, dues.ts, biz.ts,
 * settings.ts, or other app money aggregators. It derives gross/tax/collection
 * from stored raw rows and the documented predicates, then exposes monthly,
 * daily-cash, mode-split and structural expectations for verify-loadtest.ts.
 */
import { rupees } from "./money";
import type {
  BillRow,
  ExpenseRow,
  PaymentRow,
  SnackSaleRow,
  TabEntryRow,
  TurfBookingRow,
  DayCloseRow,
} from "./localdb";

export type Modes = { Cash: number; UPI: number; Card: number };
export type MonthLedger = {
  net: number;
  tax: number;
  revenue: number;
  collected: number;
  tabCollected: number;
  forfeited: number;
  refundable: number;
  expenses: number;
  profit: number;
  dues: number;
  snackProfit: number;
  billsRevenue: number;
  billsCollected: number;
  billsDues: number;
  turfRevenue: number;
  snacksRevenue: number;
  split: Modes;
};
export type DayLedger = { cashIn: number; cashOut: number };
export type Ledger = {
  months: Record<string, MonthLedger>;
  days: Record<string, DayLedger>;
  payments: { byMode: Modes; rows: number; byParent: Record<string, number> };
};

const n = (v: unknown) => Number(v) || 0;
const monthOf = (v: string) => String(v).slice(0, 7);
const dayOf = (v: string) => String(v).slice(0, 10);
const zeroModes = (): Modes => ({ Cash: 0, UPI: 0, Card: 0 });

function blank(): MonthLedger {
  return {
    net: 0,
    tax: 0,
    revenue: 0,
    collected: 0,
    tabCollected: 0,
    forfeited: 0,
    refundable: 0,
    expenses: 0,
    profit: 0,
    dues: 0,
    snackProfit: 0,
    billsRevenue: 0,
    billsCollected: 0,
    billsDues: 0,
    turfRevenue: 0,
    snacksRevenue: 0,
    split: zeroModes(),
  };
}
// GST 18% (CGST = SGST, each rounded independently) + 5% service charge —
// this module's own fixture-based unit tests freeze `tax_amount` on every
// row and so never actually hit the live-fallback path below; this default
// only exists so those fixtures (and any other caller with no real live
// settings to consult) still get a deterministic number rather than a
// crash. A caller comparing against the real app (verify-loadtest.ts) must
// pass `liveTaxOf` with the app's own live tax settings — see the doc
// comment on `buildExpectedLedger`'s `liveTaxOf` parameter for why.
const DEFAULT_LIVE_TAX = (net: number) =>
  2 * rupees(net * 0.09) + rupees(net * 0.05);
function billPaid(b: BillRow, gross: number) {
  // "paid" status means the gross was collected, whatever amount_paid says; an
  // "On tab" bill only ever collected what its sources collected.
  if (b.payment_mode === "On tab") return Math.max(0, rupees(b.amount_paid));
  return b.status === "paid" ? gross : rupees(b.amount_paid);
}
function isFinancialBooking(b: TurfBookingRow) {
  return (
    b.status !== "Cancelled" && b.status !== "No-show" && !b.merged_into_bill_id
  );
}
function isFinancialSale(s: SnackSaleRow) {
  return !s.cancelled && !s.merged_into_bill_id;
}
function tabNet(entries: TabEntryRow[], type: string, id: string) {
  let x = 0;
  for (const e of entries)
    if (e.ref_type === type && e.ref_id === id)
      x += e.kind === "charge" ? n(e.amount) : -n(e.amount);
  return Math.max(0, rupees(x));
}

export function buildExpectedLedger(input: {
  bills: BillRow[];
  bookings: TurfBookingRow[];
  sales: SnackSaleRow[];
  expenses: ExpenseRow[];
  payments: PaymentRow[];
  tabEntries: TabEntryRow[];
  dayCloses?: DayCloseRow[];
  /**
   * Tax for a row with no frozen `tax_amount` (a "legacy" row saved before
   * the tax snapshot existed) is NOT an independently-derivable fact: the
   * real app computes it from whatever the LIVE global tax settings are at
   * READ time (see biz.ts's grossWithTax/bookingGrossTotal), which the
   * load-test deliberately never mutates (audit item F65: seeding must not
   * clobber the operator's real settings). So this oracle can't hardcode a
   * rate here without silently drifting from the app the moment the
   * account's real tax settings differ from the historical 18%+5%
   * default. Callers comparing against the live app (verify-loadtest.ts)
   * MUST pass the app's own current live-tax function; the 18%+5% default
   * below only covers this module's own fixture-based unit tests, which
   * control their own frozen tax_amount on every row and never exercise
   * this fallback for real.
   */
  liveTaxOf?: (net: number) => number;
}): Ledger {
  const liveTax = input.liveTaxOf ?? DEFAULT_LIVE_TAX;
  const taxOf = (net: number, frozen: unknown) =>
    frozen == null ? liveTax(net) : rupees(frozen as number);
  const months: Record<string, MonthLedger> = {};
  const days: Record<string, DayLedger> = {};
  const byMode = zeroModes();
  const byParent: Record<string, number> = {};

  const ensure = (m: string) => (months[m] ??= blank());
  const ensureDay = (d: string) => (days[d] ??= { cashIn: 0, cashOut: 0 });

  // Payments are the independent cash/UPI/Card receipt oracle.
  for (const p of input.payments) {
    const amount = rupees(p.amount);
    const mode = p.mode as keyof Modes;
    if (amount > 0 && mode in byMode) byMode[mode] += amount;
    const key = `${p.parent_type}:${p.parent_id}`;
    byParent[key] = (byParent[key] ?? 0) + amount;
    const d = dayOf(p.received_at);
    const day = ensureDay(d);
    if (mode === "Cash") day.cashIn += amount;
  }

  // Bills: sources rolled into a merged bill are excluded from their own
  // revenue, because the bill becomes the financial owner.
  for (const b of input.bills) {
    if (b.status === "cancelled") continue;
    const m = ensure(monthOf(b.bill_date));
    const net = rupees(b.total),
      tax = taxOf(net, b.tax_amount),
      gross = rupees(net + tax);
    const paid = billPaid(b, gross);
    const onTab =
      b.payment_mode === "On tab"
        ? gross - paid
        : tabNet(input.tabEntries, "bill", b.id);
    m.billsRevenue += net;
    m.billsCollected += paid;
    m.billsDues += Math.max(0, rupees(gross - paid - onTab));
    m.net += net;
    m.tax += tax;
    m.collected += paid;
    m.dues += Math.max(0, rupees(gross - paid - onTab));
  }

  for (const b of input.bookings) {
    const mkey = monthOf(b.booking_date);
    if (b.status === "Cancelled") {
      // K4 (fixed 2026-09): a refundable advance physically arrived — the
      // received-date pass below carries it in split + collected (liability,
      // never income). The liability KPI drops once the refund is paid.
      if (n(b.advance_paid) > 0 && b.is_refundable === true) {
        if (!b.refunded_at) {
          ensure(mkey).refundable += n(b.advance_paid);
        } else if ((b.refund_mode ?? "Cash") === "Cash") {
          // Refund paid back: drawer outflow on the refund day (never P&L).
          ensureDay(dayOf(b.refunded_at)).cashOut += n(b.advance_paid);
        }
      }
      continue;
    }
    // F-9: a paid no-show keeps its advance — the received-date pass tags it
    // as forfeited income. Merged bookings are counted once through their bill.
    if (b.merged_into_bill_id) continue;
    if (b.status === "No-show") continue;
    const m = ensure(mkey);
    const net = rupees(b.total_amount),
      tax = taxOf(net, b.tax_amount),
      gross = rupees(net + tax);
    const tab = tabNet(input.tabEntries, "turf_booking", b.id);
    const collected = Math.max(0, rupees(b.advance_paid - tab));
    const due = Math.max(0, rupees(gross - b.advance_paid - tab));
    m.turfRevenue += net;
    m.net += net;
    m.tax += tax;
    m.collected += collected;
    m.dues += due;
  }

  for (const s of input.sales) {
    if (!isFinancialSale(s)) continue;
    const m = ensure(monthOf(s.sale_date));
    const net = rupees(s.total),
      tax = taxOf(net, s.tax_amount);
    const collected =
      s.payment_mode === "On tab"
        ? 0
        : input.payments
            .filter(
              (p) => p.parent_type === "snack_sale" && p.parent_id === s.id,
            )
            .reduce((a, p) => a + rupees(p.amount), 0);
    m.snacksRevenue += net;
    m.snackProfit += rupees(s.profit);
    m.net += net;
    m.tax += tax;
    m.collected += collected;
    // Snack sales have no "dues" concept (calculation-rules.md §5): an "On tab"
    // sale is owed through its tab charge, never through period dues.
  }

  for (const e of input.expenses) {
    const m = ensure(monthOf(e.spent_at));
    const amount = rupees(e.amount);
    m.expenses += amount;
    const d = ensureDay(dayOf(e.spent_at));
    d.cashOut += e.payment_mode === "Cash" ? amount : rupees(e.cash_part ?? 0);
  }

  for (const e of input.tabEntries) {
    if (e.kind !== "payment" || e.ref_type) continue;
    const amount = rupees(e.amount);
    const m = ensure(monthOf(e.entry_date));
    m.tabCollected += amount;
    m.collected += amount;
    if (e.payment_mode === "Cash")
      ensureDay(dayOf(e.entry_date)).cashIn += amount;
  }

  // Mode split of money RECEIVED, keyed by the day it arrived (received_at).
  // Built parent-by-parent from the oracle's own collected figures and the raw
  // payment rows (never from paymentSplit()), following the documented rule in
  // lib/payments.ts: only financial parents contribute (a merged/no-show/
  // refundable-cancelled record's money lives elsewhere or is not received);
  // a parent with no rows implies one entry on its own date and mode; rows
  // that fall short of the collected figure are topped up on the parent's
  // date/mode, and rows that overshoot give the excess back, newest first.
  const rowsBy = new Map<string, PaymentRow[]>();
  for (const p of input.payments) {
    const k = `${p.parent_type}:${p.parent_id}`;
    (rowsBy.get(k) ?? rowsBy.set(k, []).get(k)!).push(p);
  }
  const addSplit = (when: string, mode: unknown, amount: number) => {
    if (amount > 0 && typeof mode === "string" && mode in byMode)
      ensure(monthOf(when)).split[mode as keyof Modes] += amount;
  };
  const received = (
    type: string,
    id: string,
    collected: number,
    when: string,
    mode: unknown,
    onEntry?: (when: string, amount: number) => void,
  ) => {
    if (!(collected > 0)) return;
    const put = (w: string, m: unknown, a: number) => {
      addSplit(w, m, a);
      onEntry?.(w, a);
    };
    const rows = rowsBy.get(`${type}:${id}`) ?? [];
    // An implied entry (no payment rows) must be normalised exactly like
    // payments.ts normalizeReceivedPaymentMode: only real received modes pass;
    // anything else — "Pending" (the advance arrived; only the BALANCE is
    // pending), "On tab", null — reads as Cash, the pre-payments-table
    // convention. Without this, a Pending booking's advance lands in a
    // phantom "Pending" bucket and the Cash split under-reports (WP7).
    const impliedMode =
      mode === "Cash" || mode === "UPI" || mode === "Card" ? mode : "Cash";
    if (!rows.length) return put(when, impliedMode, collected);
    const kept = rows.map((r) => ({ r, amount: rupees(r.amount) }));
    const diff = collected - kept.reduce((a, x) => a + x.amount, 0);
    if (diff < 0) {
      let excess = -diff;
      for (const x of [...kept].sort((a, b) =>
        String(b.r.received_at).localeCompare(String(a.r.received_at)),
      )) {
        if (excess <= 0) break;
        const cut = Math.min(x.amount, excess);
        x.amount -= cut;
        excess -= cut;
      }
    }
    for (const x of kept) put(x.r.received_at, x.r.mode, x.amount);
    if (diff > 0) put(when, impliedMode, diff);
  };
  for (const b of input.bills) {
    if (b.status === "cancelled") continue;
    const net = rupees(b.total);
    received(
      "bill",
      b.id,
      billPaid(b, rupees(net + taxOf(net, b.tax_amount))),
      b.bill_date,
      b.payment_mode,
    );
  }
  for (const b of input.bookings) {
    if (b.status === "Cancelled") {
      if (n(b.advance_paid) > 0 && b.is_refundable === true) {
        // K4 (fixed 2026-09): the refundable advance physically arrived — it
        // belongs in split + collected on its RECEIVED date. A liability,
        // never income (no net/revenue here).
        received(
          "turf_booking",
          b.id,
          n(b.advance_paid),
          b.booking_date,
          b.payment_mode,
          (w, a) => {
            ensure(monthOf(w)).collected += a;
          },
        );
      } else if (n(b.advance_paid) > 0) {
        // Forfeited advance: untaxed income (net, revenue, collected), dated
        // by the day the money arrived — not booking_date (rules §3).
        received(
          "turf_booking",
          b.id,
          n(b.advance_paid),
          b.booking_date,
          b.payment_mode,
          (w, a) => {
            const m = ensure(monthOf(w));
            m.forfeited += a;
            m.net += a;
            m.collected += a;
          },
        );
      }
      continue;
    }
    // F-9: a paid no-show keeps its advance — same forfeited treatment.
    if (b.status === "No-show") {
      if (n(b.advance_paid) > 0)
        received(
          "turf_booking",
          b.id,
          n(b.advance_paid),
          b.booking_date,
          b.payment_mode,
          (w, a) => {
            const m = ensure(monthOf(w));
            m.forfeited += a;
            m.net += a;
            m.collected += a;
          },
        );
      continue;
    }
    if (b.merged_into_bill_id) continue;
    const tab = tabNet(input.tabEntries, "turf_booking", b.id);
    received(
      "turf_booking",
      b.id,
      Math.max(0, rupees(b.advance_paid - tab)),
      b.booking_date,
      b.payment_mode,
    );
  }
  for (const s of input.sales) {
    if (!isFinancialSale(s) || s.payment_mode === "On tab") continue;
    received(
      "snack_sale",
      s.id,
      rupees(s.total) + taxOf(rupees(s.total), s.tax_amount),
      s.sale_date,
      s.payment_mode,
    );
  }
  for (const e of input.tabEntries) {
    if (e.kind !== "payment" || e.ref_type) continue;
    addSplit(e.entry_date, e.payment_mode ?? "Cash", rupees(e.amount));
  }

  for (const m of Object.values(months)) {
    m.revenue = rupees(m.net + m.tax);
    m.profit = rupees(m.net - m.expenses);
  }
  return {
    months,
    days,
    payments: { byMode, rows: input.payments.length, byParent },
  };
}
