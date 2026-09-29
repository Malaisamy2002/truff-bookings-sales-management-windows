// `fake-indexeddb/auto` installs a real (in-memory) IndexedDB implementation
// globally before Dexie opens the database, so these tests run against the
// actual `db`, the same way backup.test.ts does.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  db,
  sequentialTimestamps,
  type BillRow,
  type PaymentRow,
  type TurfBookingRow,
} from "./localdb";
import {
  cashOnlineSplit,
  effectivePaymentEntries,
  paymentsForParent,
  recordPayment,
  replacePaymentsForParent,
  reversePaymentsForParent,
  type PaymentSourceRecord,
  describePaymentSplit,
  receiptModeLabel,
  setReceiptPayments,
} from "./payments";

function bill(over: Partial<BillRow> = {}): BillRow {
  return {
    id: "b1",
    invoice_no: "INV-1",
    customer_name: "Ravi",
    customer_phone: "9876543210",
    items: [],
    subtotal: 1000,
    discount: 0,
    total: 1000,
    amount_paid: 0,
    status: "unpaid",
    payment_mode: null,
    bill_date: "2026-01-05",
    created_at: "2026-01-05T10:00:00.000Z",
    ...over,
  };
}

function booking(over: Partial<TurfBookingRow> = {}): TurfBookingRow {
  return {
    id: "bk1",
    booking_no: "BK-1",
    booking_date: "2026-01-05",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Court 1",
    hours: 1,
    rate_per_hour: 1000,
    total_amount: 1000,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Confirmed",
    discount: 0,
    notes: null,
    start_time: null,
    end_time: null,
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1000,
    created_at: "2026-01-05T10:00:00.000Z",
    ...over,
  };
}

beforeEach(async () => {
  await db.bills.clear();
  await db.turf_bookings.clear();
  await db.snack_sales.clear();
  await db.payments.clear();
});

describe("paymentsForParent — legacy data (no payment rows yet)", () => {
  it("reads a pre-existing bill as one implied payment", async () => {
    await db.bills.add(
      bill({ amount_paid: 700, payment_mode: "UPI", status: "partial" }),
    );
    const payments = await paymentsForParent("bill", "b1");
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount: 700,
      mode: "UPI",
      received_at: "2026-01-05",
    });
  });

  it("returns nothing for a bill with nothing collected yet", async () => {
    await db.bills.add(bill({ amount_paid: 0 }));
    expect(await paymentsForParent("bill", "b1")).toEqual([]);
  });

  it("never persists the implied row — reading twice stays read-only", async () => {
    await db.bills.add(bill({ amount_paid: 500 }));
    await paymentsForParent("bill", "b1");
    await paymentsForParent("bill", "b1");
    expect(await db.payments.count()).toBe(0);
  });
});

describe("recordPayment — split payments", () => {
  it("₹500 cash + ₹500 UPI on a ₹1000 booking shows ₹500 in each mode", async () => {
    await db.turf_bookings.add(booking({ advance_paid: 0 }));
    const result = await recordPayment({
      parentType: "turf_booking",
      parentId: "bk1",
      entries: [
        { amount: 500, mode: "Cash" },
        { amount: 500, mode: "UPI" },
      ],
    });
    expect(cashOnlineSplit(result.all)).toEqual({ cash: 500, online: 500 });
    expect(result.total).toBe(1000);

    const updated = await db.turf_bookings.get("bk1");
    expect(updated?.advance_paid).toBe(1000);
  });

  it("rejects a non-positive entry", async () => {
    await db.bills.add(bill());
    await expect(
      recordPayment({
        parentType: "bill",
        parentId: "b1",
        entries: [{ amount: 0, mode: "Cash" }],
      }),
    ).rejects.toThrow();
  });

  it("an edit that raises the advance appends a second row and derives the new total from both rows, not the patch", async () => {
    // Mirrors editing a booking that already took a ₹500 Cash advance and
    // raising it by ₹300 more (paid ₹200 Cash + ₹100 UPI) — the kind of
    // edit TurfTab's `finishAdvanceIncrease` performs.
    await db.turf_bookings.add(booking({ advance_paid: 0 }));
    await recordPayment({
      parentType: "turf_booking",
      parentId: "bk1",
      entries: [{ amount: 500, mode: "Cash" }],
    });
    const result = await recordPayment({
      parentType: "turf_booking",
      parentId: "bk1",
      entries: [
        { amount: 200, mode: "Cash" },
        { amount: 100, mode: "UPI" },
      ],
      // Other edited fields, deliberately with no advance_paid of its own —
      // the new total should come from the rows, not this patch.
      parentPatch: { notes: "Rescheduled" },
    });
    expect(result.total).toBe(800);
    expect(cashOnlineSplit(result.all)).toEqual({ cash: 700, online: 100 });
    const updated = await db.turf_bookings.get("bk1");
    expect(updated?.advance_paid).toBe(800);
    expect(updated?.notes).toBe("Rescheduled");
    const rows = await db.payments
      .filter((r) => r.parent_type === "turf_booking" && r.parent_id === "bk1")
      .toArray();
    expect(rows).toHaveLength(3);
  });

  it("a split's rows never tie on created_at, even written in one synchronous batch", async () => {
    await db.turf_bookings.add(booking({ advance_paid: 0 }));
    const result = await recordPayment({
      parentType: "turf_booking",
      parentId: "bk1",
      entries: [
        { amount: 500, mode: "Cash" },
        { amount: 500, mode: "UPI" },
      ],
    });
    const added = result.all.filter(
      (r) => r.mode === "Cash" || r.mode === "UPI",
    );
    expect(added).toHaveLength(2);
    expect(added[0]!.created_at).not.toBe(added[1]!.created_at);
  });
});

describe("recordPayment — backfilling old records", () => {
  it("saves the implied payment before the new one, and keeps amount_paid in sync", async () => {
    await db.bills.add(
      bill({ amount_paid: 400, payment_mode: "Cash", status: "partial" }),
    );
    const result = await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [{ amount: 600, mode: "UPI" }],
      receivedAt: "2026-02-01T09:00:00.000Z",
    });

    expect(result.all).toHaveLength(2);
    expect(result.total).toBe(1000);
    expect(result.all[0]).toMatchObject({ amount: 400, mode: "Cash" });
    expect(result.all[1]).toMatchObject({ amount: 600, mode: "UPI" });

    const updated = await db.bills.get("b1");
    expect(updated?.amount_paid).toBe(1000);

    // amount_paid on the record itself is unchanged in meaning — old
    // reports built purely from bills/turf_bookings still add up right.
    expect(await paymentsForParent("bill", "b1")).toHaveLength(2);
  });

  it("does not double-backfill on a second call", async () => {
    await db.bills.add(bill({ amount_paid: 400, payment_mode: "Cash" }));
    await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [{ amount: 300, mode: "UPI" }],
    });
    const second = await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [{ amount: 300, mode: "Card" }],
    });
    // implied(400) + 300 + 300 = 1000, not 400 counted twice.
    expect(second.total).toBe(1000);
    expect(await db.payments.count()).toBe(3);
  });
});

describe("payment rows always add up to the parent's amount_paid", () => {
  it("holds across a mix of implied + real, split payments", async () => {
    await db.bills.add(bill({ amount_paid: 250, payment_mode: "Cash" }));
    await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [
        { amount: 100, mode: "Cash" },
        { amount: 150, mode: "UPI" },
      ],
    });
    await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [{ amount: 500, mode: "Card" }],
    });

    const rows = await paymentsForParent("bill", "b1");
    const sum = rows.reduce((s, p) => s + p.amount, 0);
    const updated = await db.bills.get("b1");
    expect(sum).toBe(updated?.amount_paid);
    expect(sum).toBe(1000);
  });
});

describe("reversePaymentsForParent", () => {
  it("removes real payment rows and resets the parent's amount field", async () => {
    await db.turf_bookings.add(booking({ advance_paid: 0 }));
    await recordPayment({
      parentType: "turf_booking",
      parentId: "bk1",
      entries: [{ amount: 1000, mode: "Cash" }],
    });
    expect((await db.turf_bookings.get("bk1"))?.advance_paid).toBe(1000);

    const removed = await reversePaymentsForParent("turf_booking", "bk1");
    expect(removed).toBe(1);
    expect((await db.turf_bookings.get("bk1"))?.advance_paid).toBe(0);
    expect(await paymentsForParent("turf_booking", "bk1")).toEqual([]);
  });

  it("resets a legacy parent amount even when its implied payment was never persisted", async () => {
    await db.bills.add(bill({ amount_paid: 300 }));
    const removed = await reversePaymentsForParent("bill", "b1");
    expect(removed).toBe(0);
    expect((await db.bills.get("b1"))?.amount_paid).toBe(0);
  });
});

describe("sequentialTimestamps", () => {
  it("returns strictly increasing, 1ms-apart ISO timestamps", () => {
    const stamps = sequentialTimestamps(4);
    expect(stamps).toHaveLength(4);
    for (let i = 1; i < stamps.length; i++) {
      expect(Date.parse(stamps[i]!)).toBe(Date.parse(stamps[i - 1]!) + 1);
    }
  });

  it("returns an empty array for zero (or fewer) entries", () => {
    expect(sequentialTimestamps(0)).toEqual([]);
    expect(sequentialTimestamps(-1)).toEqual([]);
  });
});

describe("replacePaymentsForParent", () => {
  it("swaps a sale's real rows for a new split, keeping the original date and the parent row untouched", async () => {
    await db.snack_sales.add({
      id: "s1",
      bill_no: "SN-1",
      customer_name: "Priya",
      items: [],
      total: 400,
      profit: 0,
      payment_mode: "Cash",
      sale_date: "2026-02-10",
      notes: null,
      booking_id: null,
      booking_no: null,
      merged_into_bill_id: null,
      cancelled: false,
      created_at: "2026-02-10T10:00:00.000Z",
    } as never);
    await recordPayment({
      parentType: "snack_sale",
      parentId: "s1",
      entries: [{ amount: 400, mode: "Cash" }],
      receivedAt: "2026-02-10",
    });

    // Correction: it was really ₹150 Cash + ₹250 UPI.
    const rows = await replacePaymentsForParent(
      "snack_sale",
      "s1",
      [
        { amount: 150, mode: "Cash" },
        { amount: 250, mode: "UPI" },
      ],
      "2026-02-10",
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.received_at === "2026-02-10")).toBe(true);
    const stored = await paymentsForParent("snack_sale", "s1");
    expect(stored).toHaveLength(2);
    expect(cashOnlineSplit(stored)).toEqual({ cash: 150, online: 250 });
    // total (400) is unchanged — this is a mode correction, not new money.
    expect((await db.snack_sales.get("s1"))?.total).toBe(400);
  });

  it("clears existing rows entirely when given an empty split", async () => {
    await db.bills.add(bill());
    await recordPayment({
      parentType: "bill",
      parentId: "b1",
      entries: [{ amount: 300, mode: "Cash" }],
    });
    await replacePaymentsForParent("bill", "b1", [], "2026-01-01");
    const stored = await db.payments
      .filter((r) => r.parent_type === "bill" && r.parent_id === "b1")
      .toArray();
    expect(stored).toEqual([]);
  });
});

describe("effectivePaymentEntries", () => {
  const paymentRow = (over: Partial<PaymentRow> = {}): PaymentRow => ({
    id: Math.random().toString(36).slice(2),
    parent_type: "bill",
    parent_id: "b1",
    amount: 0,
    mode: "Cash",
    received_at: "2026-01-05",
    created_at: "2026-01-05",
    ...over,
  });

  const source = (
    over: Partial<PaymentSourceRecord> = {},
  ): PaymentSourceRecord => ({
    id: "b1",
    collected: 1000,
    mode: "Cash",
    date: "2026-01-05",
    ...over,
  });

  it("returns one implied entry for a parent with no real rows, from its own collected/mode/date", () => {
    const entries = effectivePaymentEntries({ bill: [source()] }, []);
    expect(entries).toEqual([
      {
        parent_type: "bill",
        parent_id: "b1",
        amount: 1000,
        mode: "Cash",
        received_at: "2026-01-05",
      },
    ]);
  });

  it("skips a parent with nothing collected, real rows or not", () => {
    expect(
      effectivePaymentEntries({ bill: [source({ collected: 0 })] }, []),
    ).toEqual([]);
  });

  it("uses real rows instead of the implied entry once any exist for that parent", () => {
    const entries = effectivePaymentEntries(
      { bill: [source({ collected: 1000, mode: "Cash", date: "2026-01-05" })] },
      [
        paymentRow({ amount: 600, mode: "Cash", received_at: "2026-02-10" }),
        paymentRow({ amount: 400, mode: "UPI", received_at: "2026-02-10" }),
      ],
    );
    expect(entries).toEqual([
      {
        parent_type: "bill",
        parent_id: "b1",
        amount: 600,
        mode: "Cash",
        received_at: "2026-02-10",
      },
      {
        parent_type: "bill",
        parent_id: "b1",
        amount: 400,
        mode: "UPI",
        received_at: "2026-02-10",
      },
    ]);
  });

  it("only matches a real row to its own parent_type — a turf_booking row never covers a bill with the same id", () => {
    const entries = effectivePaymentEntries({ bill: [source({ id: "x1" })] }, [
      paymentRow({
        parent_type: "turf_booking",
        parent_id: "x1",
        amount: 500,
        received_at: "2026-03-01",
      }),
    ]);
    // No real "bill" rows for x1, so it still falls back to the implied entry.
    expect(entries).toEqual([
      {
        parent_type: "bill",
        parent_id: "x1",
        amount: 1000,
        mode: "Cash",
        received_at: "2026-01-05",
      },
    ]);
  });

  it("handles multiple parent types and multiple parents in one call", () => {
    const entries = effectivePaymentEntries(
      {
        bill: [source({ id: "b1", collected: 200 })],
        turf_booking: [source({ id: "k1", collected: 300, mode: "UPI" })],
        snack_sale: [source({ id: "s1", collected: 0 })],
      },
      [],
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.parent_type).sort()).toEqual([
      "bill",
      "turf_booking",
    ]);
  });
});

describe("effectivePaymentEntries — rows that don't match the record", () => {
  const row = (over: Partial<PaymentRow>): PaymentRow => ({
    id: Math.random().toString(36).slice(2),
    parent_type: "bill",
    parent_id: "b1",
    amount: 0,
    mode: "Cash",
    received_at: "2026-03-01",
    created_at: "2026-03-01",
    ...over,
  });
  const rec = (collected: number): PaymentSourceRecord => ({
    id: "b1",
    collected,
    mode: "UPI",
    date: "2026-01-05",
  });

  it("counts a shortfall on the record's own date and mode", () => {
    // ₹300 cash recorded, but the bill was later toggled to fully paid (₹1000)
    const out = effectivePaymentEntries({ bill: [rec(1000)] }, [
      row({ amount: 300, mode: "Cash" }),
    ]);
    expect(out.map((e) => [e.amount, e.mode, e.received_at])).toEqual([
      [300, "Cash", "2026-03-01"],
      [700, "UPI", "2026-01-05"],
    ]);
    expect(out.reduce((s, e) => s + e.amount, 0)).toBe(1000);
  });

  it("takes an excess back from the newest rows first", () => {
    // ₹1000 recorded in two rows, then the paid amount was edited down to ₹700
    const out = effectivePaymentEntries({ bill: [rec(700)] }, [
      row({ amount: 500, mode: "Cash", received_at: "2026-03-01" }),
      row({ amount: 500, mode: "UPI", received_at: "2026-03-05" }),
    ]);
    expect(out.map((e) => [e.amount, e.mode])).toEqual([
      [500, "Cash"],
      [200, "UPI"],
    ]);
  });

  it("leaves matching rows untouched", () => {
    const out = effectivePaymentEntries({ bill: [rec(1000)] }, [
      row({ amount: 400 }),
      row({ amount: 600, mode: "UPI" }),
    ]);
    expect(out.reduce((s, e) => s + e.amount, 0)).toBe(1000);
    expect(out).toHaveLength(2);
  });
});

describe("receipt mode label", () => {
  const r = (over: Partial<PaymentRow>): PaymentRow => ({
    id: Math.random().toString(36).slice(2),
    parent_type: "turf_booking",
    parent_id: "bk1",
    amount: 0,
    mode: "Cash",
    received_at: "2026-03-01",
    created_at: "2026-03-01",
    ...over,
  });

  it("describes a split in the order of first use", () => {
    expect(
      describePaymentSplit([
        { amount: 700, mode: "Cash" },
        { amount: 100, mode: "UPI" },
        { amount: 200, mode: "UPI" },
      ]),
    ).toBe("Cash ₹700 + UPI ₹300");
  });

  it("returns null for a single mode or nothing paid", () => {
    expect(describePaymentSplit([{ amount: 500, mode: "UPI" }])).toBeNull();
    expect(describePaymentSplit([])).toBeNull();
  });

  it("uses the split for a record that has rows and the plain mode otherwise", () => {
    setReceiptPayments([
      r({ amount: 200, mode: "Cash" }),
      r({ amount: 300, mode: "UPI" }),
      r({ parent_id: "bk2", amount: 500, mode: "Card" }),
    ]);
    expect(receiptModeLabel("turf_booking", "bk1", "Cash")).toBe(
      "Cash ₹200 + UPI ₹300",
    );
    // one mode only → keep the record's own mode text
    expect(receiptModeLabel("turf_booking", "bk2", "Card")).toBe("Card");
    // unknown record → fallback
    expect(receiptModeLabel("turf_booking", "nope", "Pending")).toBe("Pending");
    setReceiptPayments([]);
  });
});
