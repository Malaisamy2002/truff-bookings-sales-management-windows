import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import {
  customerLifetimeStats,
  mergeCustomersAtomic,
  type CustomerRec,
} from "./data";
import { db } from "./localdb";
import { tabKey } from "./tabs";
import { bookingDue } from "./dues";

// Minimal booking shape customerLifetimeStats accepts — see the widened
// inline type on its `data.bookings` param in data.ts.
const taxedBooking = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  customer_name: "Ravi",
  phone: "9876543210",
  booking_date: "2026-09-01",
  total_amount: 1000,
  advance_paid: 0,
  status: "Booked",
  merged_into_bill_id: null,
  turf_amount: 1000,
  hours: 1,
  rate_per_hour: 1000,
  courts: 1,
  tax_amount: 180, // frozen 18% GST, exactly as ops.ts freezes it at creation
  ...over,
});

const customer: CustomerRec = {
  id: "c1",
  name: "Ravi",
  phone: "9876543210",
} as CustomerRec;

describe("customerLifetimeStats() outstandingTurfDues", () => {
  it("is tax-inclusive and matches dues.ts's bookingDue() for the same booking", () => {
    const booking = taxedBooking();
    const [row] = customerLifetimeStats([customer], {
      bills: [],
      bookings: [booking as never],
      sales: [],
    });
    if (!row) throw new Error("expected a customerLifetimeStats row");

    // Before the fix this summed (total_amount - advance_paid) = 1000, silently
    // dropping the ₹180 GST the booking's own receipt actually charged and
    // that dues.ts's bookingDue() already accounts for.
    expect(row.outstandingTurfDues).toBe(bookingDue(booking as never));
    expect(row.outstandingTurfDues).toBe(1180);
  });

  it("still excludes a booking merged into a bill, same as isFinancialBooking elsewhere", () => {
    const booking = taxedBooking({ merged_into_bill_id: "bill-1" });
    const [row] = customerLifetimeStats([customer], {
      bills: [],
      bookings: [booking as never],
      sales: [],
    });
    if (!row) throw new Error("expected a customerLifetimeStats row");

    expect(row.outstandingTurfDues).toBe(0);
    // But it's still a real visit, so turfSpend excludes it while bookingsCount doesn't.
    expect(row.bookingsCount).toBe(1);
    expect(row.turfSpend).toBe(0);
  });
});

describe("customerLifetimeStats() financial spend filters", () => {
  it("excludes cancelled bills from lifetime spend", () => {
    const [row] = customerLifetimeStats([customer], {
      bills: [
        {
          customer_name: "Ravi",
          customer_phone: "9876543210",
          total: 500,
          bill_date: "2026-09-02",
          status: "cancelled",
        } as never,
      ],
      bookings: [],
      sales: [],
    });
    expect(row?.billsSpend).toBe(0);
    expect(row?.totalSpend).toBe(0);
  });

  it("excludes merged and cancelled snack sales from lifetime spend", () => {
    const [row] = customerLifetimeStats([customer], {
      bills: [],
      bookings: [],
      sales: [
        {
          customer_name: "Ravi",
          phone: "9876543210",
          total: 300,
          sale_date: "2026-09-03",
          merged_into_bill_id: "bill-1",
        },
        {
          customer_name: "Ravi",
          phone: "9876543210",
          total: 200,
          sale_date: "2026-09-04",
          cancelled: true,
        },
        {
          customer_name: "Ravi",
          phone: "9876543210",
          total: 100,
          sale_date: "2026-09-05",
        },
      ],
    });
    expect(row?.snacksSpend).toBe(100);
    expect(row?.totalSpend).toBe(100);
  });
});

describe("mergeCustomersAtomic()", () => {
  beforeEach(async () => {
    await Promise.all([
      db.customers.clear(),
      db.bills.clear(),
      db.turf_bookings.clear(),
      db.snack_sales.clear(),
      db.customer_tabs.clear(),
      db.tab_entries.clear(),
    ]);
  });

  const keep: CustomerRec = {
    id: "keep",
    name: "Ravi",
    phone: "9876543210",
  } as CustomerRec;
  const absorb: CustomerRec = {
    id: "absorb",
    name: "Ravi Kumar",
    phone: "9123456789",
  } as CustomerRec;

  it("moves tab identity and ledger entries along with the customer merge", async () => {
    await db.customers.bulkAdd([keep, absorb] as never);
    await db.customer_tabs.add({
      id: "tab-old",
      customer_key: tabKey(absorb.name, absorb.phone),
      customer_name: absorb.name,
      phone: absorb.phone,
      status: "open",
      opened_at: "2026-09-01T10:00:00.000Z",
      closed_at: null,
      created_at: "2026-09-01T10:00:00.000Z",
    });
    await db.tab_entries.add({
      id: "entry-old",
      tab_id: "tab-old",
      customer_key: tabKey(absorb.name, absorb.phone),
      kind: "charge",
      business: "Snacks",
      amount: 250,
      note: null,
      ref_type: "snack_sale",
      ref_id: "sale-old",
      source_ref_type: null,
      source_ref_id: null,
      payment_mode: null,
      entry_date: "2026-09-01",
      created_at: "2026-09-01T10:00:00.000Z",
    });

    await mergeCustomersAtomic({
      keep,
      absorb: [absorb],
      finalName: "Ravi",
      finalPhone: "9876543210",
    });

    const finalKey = tabKey("Ravi", "9876543210");
    expect(await db.customer_tabs.get("tab-old")).toMatchObject({
      customer_key: finalKey,
      customer_name: "Ravi",
      phone: "9876543210",
    });
    expect(await db.tab_entries.get("entry-old")).toMatchObject({
      customer_key: finalKey,
      amount: 250,
    });
    expect(await db.customers.get("absorb")).toBeUndefined();
  });

  it("rolls back every store when a mid-merge write fails", async () => {
    await db.customers.bulkAdd([keep, absorb] as never);
    await db.bills.add({
      id: "bill-old",
      invoice_no: "INV-OLD",
      customer_name: absorb.name,
      customer_phone: absorb.phone,
      items: [],
      subtotal: 500,
      discount: 0,
      total: 500,
      amount_paid: 0,
      status: "unpaid",
      payment_mode: null,
      bill_date: "2026-09-01",
      created_at: "2026-09-01T10:00:00.000Z",
    } as never);
    // Seed a matching booking so the injected turf_bookings.update failure
    // actually fires mid-merge (the bills write above must then roll back).
    await db.turf_bookings.add({
      id: "bk-old",
      booking_no: "BK-OLD",
      customer_name: absorb.name,
      phone: absorb.phone,
      booking_date: "2026-09-01",
      status: "Confirmed",
      total_amount: 300,
      advance_paid: 0,
      payment_mode: null,
      created_at: "2026-09-01T10:00:00.000Z",
    } as never);

    const updateSpy = vi
      .spyOn(db.turf_bookings, "update")
      .mockRejectedValueOnce(new Error("injected merge failure"));

    await expect(
      mergeCustomersAtomic({
        keep,
        absorb: [absorb],
        finalName: "Ravi",
        finalPhone: "9876543210",
      }),
    ).rejects.toThrow("injected merge failure");
    updateSpy.mockRestore();

    expect(await db.bills.get("bill-old")).toMatchObject({
      customer_name: absorb.name,
      customer_phone: absorb.phone,
    });
    expect(await db.customers.get("absorb")).toBeDefined();
    expect(await db.customers.get("keep")).toMatchObject(keep);
  });
});
