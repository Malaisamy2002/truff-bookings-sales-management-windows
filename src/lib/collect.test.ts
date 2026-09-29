import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { db, type BillRow, type TurfBookingRow } from "./localdb";
import { collectBillPayment, collectBookingPayment } from "./collect";
import { buildBackup, restoreBackup } from "./backup";
import { mergeIntoBill, unmergeBill } from "./merge";
import { settleAndCloseTab } from "./tabs";
import { paymentsForParent, recordInitialPayments } from "./payments";
import { cashOnlineSplit } from "./payments";
import type { Bill } from "./biz";
import type { TurfBooking } from "./ops";

function billRow(over: Partial<BillRow> = {}): BillRow {
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

function bookingRow(over: Partial<TurfBookingRow> = {}): TurfBookingRow {
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
  await db.payments.clear();
});

describe("collectBillPayment", () => {
  it("records ₹500 cash + ₹500 UPI and settles a ₹1000 bill", async () => {
    const row = billRow();
    await db.bills.add(row);
    await collectBillPayment({
      bill: row as unknown as Bill,
      entries: [
        { amount: 500, mode: "Cash" },
        { amount: 500, mode: "UPI" },
      ],
      receivedAt: "2026-01-09",
    });
    const stored = await db.bills.get("b1");
    expect(stored).toMatchObject({ amount_paid: 1000, status: "paid" });
    const rows = await paymentsForParent("bill", "b1");
    expect(cashOnlineSplit(rows)).toEqual({ cash: 500, online: 500 });
    expect(rows.every((r) => r.received_at === "2026-01-09")).toBe(true);
    // ties go to the first entry
    expect(stored?.payment_mode).toBe("Cash");
  });

  it("a part payment leaves the bill partial and keeps the split", async () => {
    const row = billRow();
    await db.bills.add(row);
    await collectBillPayment({
      bill: row as unknown as Bill,
      entries: [{ amount: 300, mode: "UPI" }],
    });
    expect(await db.bills.get("b1")).toMatchObject({
      amount_paid: 300,
      status: "partial",
      payment_mode: "UPI",
    });
  });

  it("an old bill keeps its earlier payment as an implied row, then adds the new one", async () => {
    const row = billRow({
      amount_paid: 400,
      status: "partial",
      payment_mode: "Cash",
    });
    await db.bills.add(row);
    await collectBillPayment({
      bill: row as unknown as Bill,
      entries: [{ amount: 600, mode: "UPI" }],
      receivedAt: "2026-02-01",
    });
    const rows = await paymentsForParent("bill", "b1");
    expect(rows.map((r) => [r.amount, r.mode, r.received_at])).toEqual([
      [400, "Cash", "2026-01-05"],
      [600, "UPI", "2026-02-01"],
    ]);
    expect(await db.bills.get("b1")).toMatchObject({
      amount_paid: 1000,
      status: "paid",
    });
  });

  it("refuses more than is owed and writes nothing", async () => {
    const row = billRow();
    await db.bills.add(row);
    await expect(
      collectBillPayment({
        bill: row as unknown as Bill,
        entries: [{ amount: 1200, mode: "Cash" }],
      }),
    ).rejects.toThrow(/more than/);
    expect(await db.payments.count()).toBe(0);
    expect((await db.bills.get("b1"))?.amount_paid).toBe(0);
  });
});

describe("collectBookingPayment", () => {
  it("splits the balance of a booking that already had a cash advance", async () => {
    const row = bookingRow({ advance_paid: 500, payment_mode: "Cash" });
    await db.turf_bookings.add(row);
    await collectBookingPayment({
      booking: row as unknown as TurfBooking,
      entries: [
        { amount: 200, mode: "Cash" },
        { amount: 300, mode: "UPI" },
      ],
      receivedAt: "2026-01-10",
      markCompleted: true,
    });
    const stored = await db.turf_bookings.get("bk1");
    expect(stored).toMatchObject({ advance_paid: 1000, status: "Completed" });
    const rows = await paymentsForParent("turf_booking", "bk1");
    // Rows saved in the same millisecond have no defined order between them.
    const byDateThenAmount = [...rows].sort(
      (x, y) =>
        x.received_at.localeCompare(y.received_at) || x.amount - y.amount,
    );
    expect(
      byDateThenAmount.map((r) => [r.amount, r.mode, r.received_at]),
    ).toEqual([
      [500, "Cash", "2026-01-05"],
      [200, "Cash", "2026-01-10"],
      [300, "UPI", "2026-01-10"],
    ]);
    expect(cashOnlineSplit(rows)).toEqual({ cash: 700, online: 300 });
  });

  it("does not complete a booking on a part payment", async () => {
    const row = bookingRow();
    await db.turf_bookings.add(row);
    await collectBookingPayment({
      booking: row as unknown as TurfBooking,
      entries: [{ amount: 250, mode: "UPI" }],
      markCompleted: true,
    });
    expect(await db.turf_bookings.get("bk1")).toMatchObject({
      advance_paid: 250,
      status: "Confirmed",
    });
  });
});

describe("reversing payments", () => {
  async function paidBill() {
    const row = billRow();
    await db.bills.add(row);
    await collectBillPayment({
      bill: row as unknown as Bill,
      entries: [
        { amount: 600, mode: "Cash" },
        { amount: 400, mode: "UPI" },
      ],
    });
    expect(await db.payments.count()).toBe(2);
  }

  it("deleting a bill removes its payment rows", async () => {
    await paidBill();
    await unmergeBill("b1", { deleteBill: true });
    expect(await db.bills.get("b1")).toBeUndefined();
    expect(await db.payments.count()).toBe(0);
  });

  it("voiding a bill removes its payment rows but keeps the record", async () => {
    await paidBill();
    await unmergeBill("b1", { cancel: true });
    expect((await db.bills.get("b1"))?.status).toBe("cancelled");
    expect(await db.payments.count()).toBe(0);
  });

  it("a plain un-merge keeps the cash the bill really collected", async () => {
    await paidBill();
    await unmergeBill("b1");
    expect(await db.payments.count()).toBe(2);
  });
});

describe("backup round trip", () => {
  it("keeps every payment row through backup, wipe and restore", async () => {
    const row = billRow();
    await db.bills.add(row);
    await collectBillPayment({
      bill: row as unknown as Bill,
      entries: [
        { amount: 250, mode: "Cash" },
        { amount: 750, mode: "UPI" },
      ],
      receivedAt: "2026-01-09",
    });
    const backup = await buildBackup();
    expect(backup.tables["payments"]).toHaveLength(2);

    await db.payments.clear();
    await db.bills.clear();
    await restoreBackup(JSON.parse(JSON.stringify(backup)), "replace");

    const rows = await paymentsForParent("bill", "b1");
    expect(cashOnlineSplit(rows)).toEqual({ cash: 250, online: 750 });
    expect(await db.bills.get("b1")).toMatchObject({ amount_paid: 1000 });
  });
});

describe("settling a tab in several modes", () => {
  async function openTab(balance: number) {
    await db.customer_tabs.clear();
    await db.tab_entries.clear();
    await db.customer_tabs.add({
      id: "tab1",
      customer_key: "p:9876543210",
      customer_name: "Ravi",
      phone: "9876543210",
      status: "open",
      opened_at: "2026-01-01T00:00:00.000Z",
      closed_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    } as never);
    await db.tab_entries.add({
      id: "e1",
      tab_id: "tab1",
      customer_key: "p:9876543210",
      kind: "charge",
      business: "Turf",
      amount: balance,
      note: "Owed",
      ref_type: null,
      ref_id: null,
      payment_mode: null,
      entry_date: "2026-01-02",
      created_at: "2026-01-02T00:00:00.000Z",
    } as never);
  }

  it("writes one payment entry per mode and closes the tab", async () => {
    await openTab(1000);
    await settleAndCloseTab({
      tabId: "tab1",
      payments: [
        { amount: 300, mode: "Cash" },
        { amount: 700, mode: "UPI" },
      ],
    });
    const entries = await db.tab_entries
      .where("tab_id")
      .equals("tab1")
      .toArray();
    const paid = entries.filter((e) => e.kind === "payment");
    expect(paid.map((e) => [e.amount, e.payment_mode]).sort()).toEqual([
      [300, "Cash"],
      [700, "UPI"],
    ]);
    expect((await db.customer_tabs.get("tab1"))?.status).toBe("closed");
  });

  it("refuses a split that does not cover the whole balance", async () => {
    await openTab(1000);
    await expect(
      settleAndCloseTab({
        tabId: "tab1",
        payments: [{ amount: 300, mode: "Cash" }],
      }),
    ).rejects.toThrow(/full ₹1000/);
    expect((await db.customer_tabs.get("tab1"))?.status).toBe("open");
  });
});

describe("merging keeps the real payment split", () => {
  it("copies the sources' cash/online rows onto the merged bill, dates intact", async () => {
    await db.counters.clear();
    const row = bookingRow({ advance_paid: 600, payment_mode: "UPI" });
    await db.turf_bookings.add(row);
    await recordInitialPayments(
      "turf_booking",
      "bk1",
      [
        { amount: 200, mode: "Cash" },
        { amount: 400, mode: "UPI" },
      ],
      "2026-01-03",
    );

    const bill = await mergeIntoBill({
      name: "Ravi",
      phone: "9876543210",
      bookingIds: ["bk1"],
      saleIds: [],
      items: [],
      subtotal: 1000,
      discount: 0,
      total: 1000,
      putOnTab: false,
    });

    const rows = await paymentsForParent("bill", bill.id);
    expect(cashOnlineSplit(rows)).toEqual({ cash: 200, online: 400 });
    expect(rows.every((r) => r.received_at === "2026-01-03")).toBe(true);
    expect((await db.bills.get(bill.id))?.amount_paid).toBe(600);
    // the booking keeps its own rows for a later un-merge
    expect(await paymentsForParent("turf_booking", "bk1")).toHaveLength(2);
    // deleting the merged bill removes ITS rows only
    await unmergeBill(bill.id, { deleteBill: true });
    expect(await paymentsForParent("bill", bill.id)).toHaveLength(0);
    expect(await paymentsForParent("turf_booking", "bk1")).toHaveLength(2);
  });
});
