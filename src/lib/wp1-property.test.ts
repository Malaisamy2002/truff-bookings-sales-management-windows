/* eslint-disable @typescript-eslint/no-explicit-any --
   Fixture dataset rows are intentionally loosely typed: the analytics
   functions under test accept the real DB row shapes, which these
   minimal fixtures deliberately do not model field-for-field. */
/**
 * WP1 property test — independent recomputation (ported from the audit
 * harness, 2026-09-25). For N seeded datasets of raw rows it recomputes
 * revenue, tax, collected, dues, profit and the Cash/Online split WITHOUT
 * importing the app logic under test (only ./money is shared, as sanctioned
 * by docs/calculation-rules.md), and asserts equality to the rupee.
 * Runs under any TZ: the generator uses explicit UTC timestamps and the
 * IST bucketing is part of what's being verified.
 */
import { describe, expect, it } from "vitest";
import { rupees, sumRupees } from "./money";
import { DEFAULT_APP_SETTINGS } from "./settings";
import { periodStats, paymentSplit, monthKey, dayKey } from "./analytics";

const R = rupees,
  SUM = sumRupees;
const istParts = (iso: string) => {
  const t = new Date(iso).getTime() + 330 * 60000;
  const d = new Date(t);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};
const iMonth = (iso: string) => {
  const [y, m] = istParts(iso);
  return y + "-" + String(m).padStart(2, "0");
};
const iDay = (iso: string) => {
  const [y, m, d] = istParts(iso);
  return (
    y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0")
  );
};
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r: () => number, arr: unknown[]) =>
  arr[Math.floor(r() * arr.length)];

const M = "2026-08";
function genDate(r: () => number, biasMonth = false) {
  const roll = r();
  let iso: string;
  if (roll < 0.55 || biasMonth) {
    const d = 1 + Math.floor(r() * 31);
    iso = `2026-08-${String(d).padStart(2, "0")}T${String(Math.floor(r() * 24)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}:00.000Z`;
  } else if (roll < 0.75) {
    const d = 1 + Math.floor(r() * 31);
    iso = `2026-07-${String(d).padStart(2, "0")}T${String(Math.floor(r() * 24)).padStart(2, "0")}:00:00.000Z`;
  } else if (roll < 0.85) {
    iso = pick(r, [
      "2026-07-31T18:29:59.000Z",
      "2026-07-31T20:00:00.000Z",
      "2026-07-31T19:59:59.000Z",
      "2026-08-31T18:30:00.000Z",
    ]) as string;
  } else {
    const d = 1 + Math.floor(r() * 30);
    iso = `2026-09-${String(d).padStart(2, "0")}T10:00:00.000Z`;
  }
  return iso;
}

function genDataset(seed: number) {
  const r = mulberry32(seed);
  const bookings: any[] = [],
    bills: any[] = [],
    sales: any[] = [],
    expenses: any[] = [],
    tabEntries: any[] = [],
    payments: any[] = [];
  const MODES3 = ["Cash", "UPI", "Card"];
  const tabNet: Record<string, number> = {};
  const addTab = (e: {
    kind: string;
    amount: number;
    ref_type: string | null;
    ref_id: string | null;
    entry_date: string;
    payment_mode?: string;
  }) => {
    tabEntries.push(e);
    const k = e.ref_type + ":" + e.ref_id;
    tabNet[k] = (tabNet[k] || 0) + (e.kind === "charge" ? e.amount : -e.amount);
  };
  const nb = 6 + Math.floor(r() * 10);
  for (let i = 0; i < nb; i++) {
    const id = "bk" + i;
    const total = 100 * (1 + Math.floor(r() * 40));
    const status = pick(r, [
      "Completed",
      "Completed",
      "Completed",
      "Confirmed",
      "Cancelled",
      "No-show",
    ]);
    const tax = R(total * 0.18);
    const gross = total + tax;
    const merged = r() < 0.1;
    const onTab =
      !merged && status !== "Cancelled" && status !== "No-show" && r() < 0.2;
    const mode =
      status === "Cancelled"
        ? pick(r, MODES3)
        : pick(r, ["Cash", "UPI", "Card", "Pending"]);
    let advance = 0,
      collected = 0;
    if (mode !== "Pending" && !merged) {
      if (status === "Cancelled") {
        advance = 100 * Math.floor(1 + r() * 5);
        collected = advance;
      } else if (onTab) {
        advance = gross;
        collected = 0;
        addTab({
          kind: "charge",
          amount: gross,
          ref_type: "turf_booking",
          ref_id: id,
          entry_date: genDate(r, true),
          payment_mode: "On tab",
        });
      } else {
        advance = 100 * Math.floor(r() * (gross / 100));
        collected = advance;
      }
    }
    bookings.push({
      id,
      booking_date: genDate(r),
      total_amount: total,
      advance_paid: advance,
      status,
      is_refundable: status === "Cancelled" ? r() < 0.5 : undefined,
      merged_into_bill_id: merged ? "mb" + i : null,
      payment_mode: mode,
      tax_amount: tax,
    });
    if (collected > 0) {
      const modes =
        r() < 0.4
          ? [pick(r, MODES3), pick(r, MODES3)]
          : [mode === "Pending" ? "Cash" : mode];
      let left = collected;
      modes.forEach((m, ix) => {
        const amt =
          ix === modes.length - 1
            ? left
            : Math.min(left, 100 * Math.floor(1 + r() * (left / 100)));
        left -= amt;
        if (amt > 0)
          payments.push({
            parent_type: "turf_booking",
            parent_id: id,
            amount: amt,
            mode: m,
            received_at: genDate(r),
            created_at: genDate(r),
          });
      });
    }
  }
  const nbi = 3 + Math.floor(r() * 8);
  for (let i = 0; i < nbi; i++) {
    const id = "bl" + i;
    const total = 100 * (1 + Math.floor(r() * 60));
    const tax = R(total * 0.18);
    const gross = total + tax;
    const status = pick(r, ["paid", "paid", "pending"]);
    const onTab = status === "pending" && r() < 0.25;
    const paid =
      status === "paid"
        ? gross
        : onTab
          ? 0
          : 100 * Math.floor(r() * (gross / 100));
    if (onTab)
      addTab({
        kind: "charge",
        amount: gross,
        ref_type: "bill",
        ref_id: id,
        entry_date: genDate(r, true),
        payment_mode: "On tab",
      });
    bills.push({
      id,
      bill_no: "B-" + (100 + i),
      bill_date: genDate(r),
      total,
      amount_paid: paid,
      payment_mode: onTab ? "On tab" : pick(r, MODES3),
      status,
      tax_amount: tax,
    });
    if (paid > 0)
      payments.push({
        parent_type: "bill",
        parent_id: id,
        amount: paid,
        mode: bills[i].payment_mode,
        received_at: genDate(r),
        created_at: genDate(r),
      });
  }
  const ns = 3 + Math.floor(r() * 8);
  for (let i = 0; i < ns; i++) {
    const id = "sl" + i;
    const total = 50 * (1 + Math.floor(r() * 20));
    const tax = R(total * 0.18);
    const onTab = r() < 0.25,
      cancelled = r() < 0.1,
      merged = !cancelled && r() < 0.1;
    const mode = onTab ? "On tab" : pick(r, ["Cash", "UPI"]);
    const collected = onTab || cancelled || merged ? 0 : total + tax;
    sales.push({
      id,
      bill_no: "S-" + (50 + i),
      sale_date: genDate(r),
      total,
      tax_amount: tax,
      profit: R(total * 0.3),
      payment_mode: mode,
      cancelled,
      merged_into_bill_id: merged ? "ms" + i : null,
    });
    if (onTab)
      addTab({
        kind: "charge",
        amount: total + tax,
        ref_type: "snack_sale",
        ref_id: id,
        entry_date: genDate(r, true),
        payment_mode: "On tab",
      });
    if (collected > 0)
      payments.push({
        parent_type: "snack_sale",
        parent_id: id,
        amount: collected,
        mode,
        received_at: genDate(r),
        created_at: genDate(r),
      });
  }
  const ne = 2 + Math.floor(r() * 6);
  for (let i = 0; i < ne; i++) {
    const mode = pick(r, ["Cash", "UPI", "Card", "Card"]);
    const amount = 100 * (1 + Math.floor(r() * 30));
    expenses.push({
      id: "ex" + i,
      spent_at: genDate(r),
      amount,
      payment_mode: mode,
      cash_part:
        mode === "Card" ? 100 * Math.floor(r() * (amount / 100)) : undefined,
      category: pick(r, ["Rent", "Staff Wages", "Other"]),
      business: "Turf",
    });
  }
  const ntp = Math.floor(r() * 4);
  for (let i = 0; i < ntp; i++)
    tabEntries.push({
      kind: "payment",
      amount: 100 * (1 + Math.floor(r() * 10)),
      ref_type: null,
      ref_id: null,
      entry_date: genDate(r),
      payment_mode: pick(r, ["Cash", "UPI"]),
    });
  return { bookings, bills, sales, expenses, tabEntries, payments, tabNet };
}

function independent(ds: ReturnType<typeof genDataset>, month: string) {
  const D = ds;
  const inM = (iso: string) => iMonth(iso) === month;
  const fin = (b: { status: string; merged_into_bill_id: string | null }) =>
    b.status !== "Cancelled" &&
    b.status !== "No-show" &&
    !b.merged_into_bill_id;
  const finSale = (s: {
    cancelled: boolean;
    merged_into_bill_id: string | null;
  }) => !s.cancelled && !s.merged_into_bill_id;
  const rowsOf = (pid: string) => D.payments.filter((p) => p.parent_id === pid);
  let billsRev = 0,
    turfRev = 0,
    snacksRev = 0,
    tax = 0,
    forfeited = 0,
    refundable = 0;
  let billsCollected = 0,
    billsDues = 0,
    turfCollected = 0,
    snacksCollected = 0,
    duesTotal = 0;
  for (const b of D.bills) {
    if (b.status === "cancelled" || !inM(b.bill_date)) continue;
    const gross = b.total + b.tax_amount;
    billsRev += b.total;
    tax += b.tax_amount;
    const onTabBill = b.payment_mode === "On tab";
    const paid = onTabBill
      ? Math.max(0, b.amount_paid)
      : b.status === "paid"
        ? gross
        : b.amount_paid;
    const tabOwns = onTabBill ? gross - paid : D.tabNet["bill:" + b.id] || 0;
    billsCollected += paid;
    billsDues += Math.max(0, gross - paid - tabOwns);
    duesTotal += Math.max(0, gross - paid - tabOwns);
  }
  for (const b of D.bookings) {
    const tab = D.tabNet["turf_booking:" + b.id] || 0;
    if (b.status === "Cancelled") {
      const c = Math.max(0, b.advance_paid - tab);
      if (b.is_refundable === true) {
        if (inM(b.booking_date)) refundable += c;
      } else {
        const rows = rowsOf(b.id);
        const inMR = rows
          .filter((x) => inM(x.received_at))
          .reduce((n: number, x: any) => n + x.amount, 0);
        forfeited +=
          rows.length > 0 ? Math.min(c, inMR) : inM(b.booking_date) ? c : 0;
      }
      continue;
    }
    if (b.status === "No-show") {
      const c2 = Math.max(0, b.advance_paid - tab);
      const rows2 = rowsOf(b.id);
      const inMR2 = rows2
        .filter((x) => inM(x.received_at))
        .reduce((n: number, x: any) => n + x.amount, 0);
      forfeited +=
        rows2.length > 0 ? Math.min(c2, inMR2) : inM(b.booking_date) ? c2 : 0;
      continue;
    }
    if (!fin(b) || !inM(b.booking_date)) continue;
    turfRev += b.total_amount;
    tax += b.tax_amount;
    const collected = Math.max(0, b.advance_paid - tab);
    turfCollected += collected;
    duesTotal += b.total_amount + b.tax_amount - b.advance_paid;
  }
  for (const s of D.sales) {
    if (!finSale(s) || !inM(s.sale_date)) continue;
    snacksRev += s.total;
    tax += s.tax_amount;
    if (s.payment_mode !== "On tab") snacksCollected += s.total + s.tax_amount;
  }
  let refundableCollected = 0;
  for (const b of D.bookings) {
    if (b.status !== "Cancelled" || b.is_refundable !== true) continue;
    const cr = Math.max(
      0,
      b.advance_paid - (D.tabNet["turf_booking:" + b.id] || 0),
    );
    const rowsr = rowsOf(b.id);
    refundableCollected +=
      rowsr.length > 0
        ? Math.min(
            cr,
            rowsr
              .filter((x) => inM(x.received_at))
              .reduce((n: number, x: any) => n + x.amount, 0),
          )
        : inM(b.booking_date)
          ? cr
          : 0;
  }
  const tabCollected = D.tabEntries
    .filter((e) => e.kind === "payment" && !e.ref_type && inM(e.entry_date))
    .reduce((n: number, e: any) => n + R(e.amount), 0);
  const netRevenue = billsRev + turfRev + snacksRev + forfeited;
  const spend = SUM(
    D.expenses.filter((e) => inM(e.spent_at)).map((e) => e.amount),
  );
  let cash = 0,
    online = 0;
  const kept = new Set(
    D.bookings.filter((b) => !b.merged_into_bill_id).map((b) => b.id),
  );
  const addMode = (m: string, amt: number) => {
    if (m === "Cash") cash += amt;
    else if (m === "UPI" || m === "Card") online += amt;
  };
  for (const p of D.payments) {
    if (p.parent_type === "turf_booking" && !kept.has(p.parent_id)) continue;
    addMode(p.mode, p.amount);
  }
  for (const e of D.tabEntries)
    if (e.kind === "payment" && !e.ref_type)
      addMode(e.payment_mode || "Cash", R(e.amount));
  const collected =
    billsCollected +
    turfCollected +
    snacksCollected +
    tabCollected +
    forfeited +
    refundableCollected;
  return {
    billsRev,
    turfRev,
    snacksRev,
    tax,
    forfeited,
    refundable,
    netRevenue,
    revenue: netRevenue + tax,
    spend,
    profit: netRevenue - spend,
    duesTotal,
    cash,
    online,
    collectedM: collected,
  };
}

const s = { ...DEFAULT_APP_SETTINGS, gstEnabled: true, gstRate: 18 };

describe("WP1 property: independent recomputation on seeded datasets", () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`dataset ${seed}: 13 figures + split + structural invariants match to the rupee`, () => {
      const ds = genDataset(seed);
      const src = {
        bills: ds.bills,
        bookings: ds.bookings,
        sales: ds.sales,
        expenses: ds.expenses,
        tabEntries: ds.tabEntries,
        payments: ds.payments,
      } as never;
      const st = periodStats(src, (iso: string) => monthKey(iso) === M, s);
      const ind = independent(ds, M);
      for (const [k, app, indep] of [
        ["billsRevenue", st.billsRevenue, ind.billsRev],
        ["turfRevenue", st.turfRevenue, ind.turfRev],
        ["snacksRevenue", st.snacksRevenue, ind.snacksRev],
        ["tax", st.tax, ind.tax],
        ["forfeitedRevenue", st.forfeitedRevenue, ind.forfeited],
        ["refundableAdvance", st.refundableAdvance, ind.refundable],
        ["netRevenue", st.netRevenue, ind.netRevenue],
        ["revenue", st.revenue, ind.revenue],
        ["expenses", st.expenses, ind.spend],
        ["profit", st.profit, ind.profit],
        ["collected", st.collected, ind.collectedM],
        ["dues", st.dues, ind.duesTotal],
      ] as const)
        expect(app, `${k} (seed ${seed})`).toBe(indep);
      expect(st.revenue).toBe(st.netRevenue + st.tax);
      expect(st.profit).toBe(st.netRevenue - st.expenses);
      for (const k of [
        "revenue",
        "tax",
        "netRevenue",
        "collected",
        "expenses",
        "profit",
        "dues",
        "forfeitedRevenue",
        "refundableAdvance",
      ] as const)
        expect(Number.isInteger(st[k])).toBe(true);
      const split = paymentSplit(src, () => true);
      expect(
        split.filter((x) => x.name === "Pending" || x.name === "Other"),
      ).toEqual([]);
      const appCash = SUM(
        split.filter((x) => x.name === "Cash").map((x) => x.value),
      );
      const appOnline = SUM(
        split
          .filter((x) => x.name === "UPI" || x.name === "Card")
          .map((x) => x.value),
      );
      expect(appCash).toBe(ind.cash);
      expect(appOnline).toBe(ind.online);
      for (const arr of [
        ds.bills.map((x) => x.bill_date),
        ds.bookings.map((x) => x.booking_date),
        ds.sales.map((x) => x.sale_date),
        ds.expenses.map((x) => x.spent_at),
        ds.payments.map((x) => x.received_at),
        ds.tabEntries.map((x) => x.entry_date),
      ])
        for (const iso of arr) {
          expect(monthKey(iso)).toBe(iMonth(iso));
          expect(dayKey(iso)).toBe(iDay(iso));
        }
    });
  }
});
