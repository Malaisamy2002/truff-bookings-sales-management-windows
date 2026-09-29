/**
 * WP1 money-core invariants — ported from the audit harness (2026-09-25).
 * Pure-function regression guards; every assertion was validated against the
 * real code under TZ=UTC / America/Los_Angeles / Asia/Kolkata.
 * See docs/calculation-rules.md for the rules these encode.
 */
import { describe, expect, it } from "vitest";
import { rupees, sumRupees, allocateWhole, money } from "./money";
import { DEFAULT_APP_SETTINGS, taxBreakdown } from "./settings";
import { freezeTax, bookingGrossTotal } from "./biz";
import {
  bookingForfeitedRevenue,
  bookingRefundableAdvance,
  bookingRefundOutflow,
  bookingRefundCashOut,
  isFinancialBooking,
} from "./dues";
import {
  effectivePaymentEntries,
  normalizeReceivedPaymentMode,
} from "./payments";
import {
  paymentSplit,
  periodStats,
  monthKey,
  dayKey,
  cashRefundOutflowOn,
} from "./analytics";
import { planRecurringPosts } from "./expenses";
import { allocateAcrossDues } from "./split-payment";

const s = { ...DEFAULT_APP_SETTINGS, gstEnabled: true, gstRate: 18 };

describe("R1 rounding", () => {
  it("rupees is half-away-from-zero", () => {
    expect(rupees(0.5)).toBe(1);
    expect(rupees(-0.5)).toBe(-1);
    expect(rupees(2.5)).toBe(3);
    expect(rupees(-2.5)).toBe(-3);
    expect(rupees(0.4)).toBe(0);
  });
  it("sumRupees rounds each value then sums", () => {
    expect(sumRupees([0.5, 0.5])).toBe(2);
    expect(sumRupees([0.4, 0.4])).toBe(0);
  });
  it("allocateWhole partitions exactly", () => {
    expect(allocateWhole([1, 1, 1], 100).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("money uses Indian digit grouping", () => {
    expect(money(123456)).toContain("1,23,456");
  });
});

describe("R3 GST halves + frozen snapshots", () => {
  it("CGST = SGST = rupees(taxable x rate / 200); lines sum to taxAmount", () => {
    const td = taxBreakdown(450, s);
    expect(td.taxAmount).toBe(82);
    const tdx = td as {
      taxLines?: { label: string; value: number }[];
      lines: { label: string; value: number }[];
    };
    const lines = tdx.taxLines ?? tdx.lines;
    expect(lines.map((l) => l.value)).toEqual([41, 41]);
  });
  it("freezeTax(450) freezes 82 with 41+41 lines", () => {
    const f = freezeTax(450, s);
    expect(f.taxAmount).toBe(82);
    expect(f.taxLines.map((l) => l.value)).toEqual([41, 41]);
  });
  it("gross prefers the frozen snapshot", () => {
    expect(
      bookingGrossTotal({ total_amount: 450, tax_amount: 82 } as never, s),
    ).toBe(532);
  });
});

describe("R12 IST bucketing", () => {
  it("boundary bill 2026-07-31T20:00Z lands in August", () => {
    expect(monthKey("2026-07-31T20:00:00.000Z")).toBe("2026-08");
    expect(dayKey("2026-07-31T20:00:00.000Z")).toBe("2026-08-01");
    expect(monthKey("2026-07-31T18:29:59.000Z")).toBe("2026-07");
  });
});

describe("R4/R6 + F-9 cancellations", () => {
  const mk = (over: object) =>
    ({
      id: "b1",
      status: "Cancelled",
      is_refundable: false,
      advance_paid: 500,
      ...over,
    }) as never;
  it("forfeited vs refundable are strict complements", () => {
    expect(bookingForfeitedRevenue(mk({}), [])).toBe(500);
    expect(bookingRefundableAdvance(mk({}), [])).toBe(0);
    expect(bookingForfeitedRevenue(mk({ is_refundable: true }), [])).toBe(0);
    expect(bookingRefundableAdvance(mk({ is_refundable: true }), [])).toBe(500);
  });
  it("F-9: a paid no-show keeps its advance; the slot still owes nothing", () => {
    expect(bookingForfeitedRevenue(mk({ status: "No-show" }), [])).toBe(500);
    expect(bookingRefundableAdvance(mk({ status: "No-show" }), [])).toBe(0);
    expect(isFinancialBooking(mk({ status: "No-show" }))).toBe(false);
  });
  it("isFinancialBooking exclusions", () => {
    expect(isFinancialBooking(mk({ status: "Completed" }))).toBe(true);
    expect(isFinancialBooking(mk({}))).toBe(false);
    expect(isFinancialBooking(mk({ status: "No-show" }))).toBe(false);
    expect(
      isFinancialBooking(mk({ status: "Completed", merged_into_bill_id: "x" })),
    ).toBe(false);
  });
});

describe("R7 payments reconciliation", () => {
  const B1 = {
    id: "B1",
    collected: 700,
    mode: "Cash",
    date: "2026-08-01T10:00:00.000Z",
  };
  const B2 = {
    id: "B2",
    collected: 1000,
    mode: "Card",
    date: "2026-08-01T10:00:00.000Z",
  };
  const rows = [
    {
      parent_type: "bill",
      parent_id: "B1",
      amount: 400,
      mode: "UPI",
      received_at: "2026-08-02T09:00:00.000Z",
      created_at: "2026-08-02T09:00:01.000Z",
    },
    {
      parent_type: "bill",
      parent_id: "B1",
      amount: 400,
      mode: "Cash",
      received_at: "2026-08-03T09:00:00.000Z",
      created_at: "2026-08-03T09:00:01.000Z",
    },
  ] as never[];
  it("excess is trimmed from the newest row", () => {
    const e = effectivePaymentEntries({ bill: [B1, B2] } as never, rows);
    const b1 = e.filter((x) => x.parent_id === "B1");
    expect(b1.reduce((a, x) => a + x.amount, 0)).toBe(700);
  });
  it("shortfall lands on the record date in its own mode", () => {
    const e = effectivePaymentEntries({ bill: [B1, B2] } as never, rows);
    const b2 = e.filter((x) => x.parent_id === "B2");
    expect(b2).toHaveLength(1);
    expect(b2[0]!.amount).toBe(1000);
    expect(b2[0]!.mode).toBe("Card");
    expect(b2[0]!.received_at).toBe("2026-08-01T10:00:00.000Z");
  });
  it("normalizeReceivedPaymentMode maps non-received modes to Cash", () => {
    expect(normalizeReceivedPaymentMode("Pending")).toBe("Cash");
    expect(normalizeReceivedPaymentMode("On tab")).toBe("Cash");
    expect(normalizeReceivedPaymentMode("UPI")).toBe("UPI");
  });
});

describe("R9 settle allocation", () => {
  it("cash-first then online; every due covered exactly", () => {
    const plan = allocateAcrossDues([700, 300], 800, "UPI");
    expect(plan[0]).toEqual([{ amount: 700, mode: "Cash" }]);
    expect(plan[1]).toEqual([
      { amount: 100, mode: "Cash" },
      { amount: 200, mode: "UPI" },
    ]);
    expect(
      allocateAcrossDues([333, 333, 334], 1000, "UPI").map((es) =>
        es.reduce((a, e) => a + e.amount, 0),
      ),
    ).toEqual([333, 333, 334]);
  });
});

describe("F-3 recurring catch-up", () => {
  const rule = {
    id: "r1",
    title: "Rent",
    business: "Turf",
    category: "Rent",
    amount: 15000,
    day_of_month: 5,
    is_active: true,
    last_posted_month: "2026-06",
  } as never;
  it("posts every missed month, gated on the current month's due day", () => {
    expect(
      planRecurringPosts([rule], new Date("2026-09-10T00:00:00.000Z")).map(
        (p) => p.spent_at,
      ),
    ).toEqual(["2026-07-05", "2026-08-05", "2026-09-05"]);
    expect(
      planRecurringPosts(
        [{ ...(rule as object), last_posted_month: null } as never],
        new Date("2026-09-10T00:00:00.000Z"),
      ).map((p) => p.spent_at),
    ).toEqual(["2026-09-05"]);
    expect(
      planRecurringPosts(
        [
          {
            ...(rule as object),
            day_of_month: 31,
            last_posted_month: "2026-08",
          } as never,
        ],
        new Date("2026-09-30T00:00:00.000Z"),
      ).map((p) => p.spent_at),
    ).toEqual(["2026-09-30"]);
  });
});

describe("K4 refundable advance lifecycle", () => {
  const mk = (over: object) =>
    ({
      id: "k1",
      status: "Cancelled",
      is_refundable: true,
      advance_paid: 500,
      booking_date: "2026-08-05T00:00:00.000Z",
      payment_mode: "Cash",
      ...over,
    }) as never;
  it("liability drops once refunded; refund outflow equals it", () => {
    expect(bookingRefundableAdvance(mk({}), [])).toBe(500);
    expect(bookingRefundOutflow(mk({}), [])).toBe(0);
    const refunded = mk({ refunded_at: "2026-08-10T10:00:00.000Z" });
    expect(bookingRefundableAdvance(refunded, [])).toBe(0);
    expect(bookingRefundOutflow(refunded, [])).toBe(500);
    expect(bookingRefundCashOut(refunded, [])).toBe(500);
    expect(
      bookingRefundCashOut(
        mk({ refunded_at: "2026-08-10T10:00:00.000Z", refund_mode: "UPI" }),
        [],
      ),
    ).toBe(0);
  });
  it("refundable advance is visible in split and collected, never revenue", () => {
    const b = mk({});
    const src = {
      bills: [],
      bookings: [b],
      sales: [],
      expenses: [],
      tabEntries: [],
      payments: [
        {
          parent_type: "turf_booking",
          parent_id: "k1",
          amount: 500,
          mode: "Cash",
          received_at: "2026-08-05T10:00:00.000Z",
          created_at: "2026-08-05T10:00:01.000Z",
        },
      ],
    } as never;
    expect(
      paymentSplit(src, () => true).find((x) => x.name === "Cash")?.value,
    ).toBe(500);
    const st = periodStats(
      src,
      (iso: string) => monthKey(iso) === "2026-08",
      s,
    );
    expect(st.collected).toBe(500);
    expect(st.revenue).toBe(0);
    expect(st.refundableAdvance).toBe(500);
  });
  it("cashRefundOutflowOn gates on day and mode", () => {
    const bk = [mk({ refunded_at: "2026-08-10T10:00:00.000Z" })];
    expect(cashRefundOutflowOn(bk, [], "2026-08-10")).toBe(500);
    expect(cashRefundOutflowOn(bk, [], "2026-08-11")).toBe(0);
  });
});
