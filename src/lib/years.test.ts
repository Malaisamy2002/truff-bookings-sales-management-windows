import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db, type BillRow, type TurfBookingRow } from "./localdb";
import {
  countForYear,
  deleteYear,
  distinctYears,
  rowsForYear,
  YEAR_TABLES,
  yearOf,
  type YearTable,
} from "./years";
import { archiveYear, buildYearArchive, yearRowCount } from "./archive";
import { closeDay } from "./day-close";

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
    amount_paid: 1000,
    status: "paid",
    payment_mode: "Cash",
    bill_date: "2025-06-01",
    created_at: "2025-06-01T10:00:00.000Z",
    ...over,
  };
}

function bookingRow(over: Partial<TurfBookingRow> = {}): TurfBookingRow {
  return {
    id: "bk1",
    booking_no: "BK-1",
    booking_date: "2025-06-01",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Court 1",
    start_time: "10:00",
    end_time: "11:00",
    total_amount: 500,
    advance_paid: 500,
    status: "Confirmed",
    created_at: "2025-06-01T10:00:00.000Z",
    ...over,
  } as TurfBookingRow;
}

beforeEach(async () => {
  for (const name of Object.keys(YEAR_TABLES) as YearTable[])
    await db[name].clear();
  await db.customer_tabs.clear();
  await db.receipts.clear();
  await db.receipt_hashes.clear();
});

describe("yearOf", () => {
  it("reads a 4-digit year off the front of a date/timestamp string", () => {
    expect(yearOf("2025-06-01")).toBe(2025);
    expect(yearOf("2025-06-01T10:00:00.000Z")).toBe(2025);
  });
  it("returns 0 for anything that isn't a plausible year", () => {
    expect(yearOf(null)).toBe(0);
    expect(yearOf("")).toBe(0);
    expect(yearOf("abcd")).toBe(0);
  });
});

describe("deleteYear", () => {
  it("removes only the target year's rows, across every dated table, and leaves other years untouched", async () => {
    await db.bills.add(billRow({ id: "b-2025", bill_date: "2025-06-01" }));
    await db.bills.add(billRow({ id: "b-2026", bill_date: "2026-01-05" }));
    await db.turf_bookings.add(
      bookingRow({ id: "bk-2025", booking_date: "2025-12-31" }),
    );
    await db.turf_bookings.add(
      bookingRow({ id: "bk-2026", booking_date: "2026-01-01" }),
    );

    const removed = await deleteYear(2025);

    expect(removed).toBe(2);
    expect(await db.bills.get("b-2025")).toBeUndefined();
    expect(await db.bills.get("b-2026")).toBeDefined();
    expect(await db.turf_bookings.get("bk-2025")).toBeUndefined();
    expect(await db.turf_bookings.get("bk-2026")).toBeDefined();
  });

  it("is a no-op (0 removed) for a year with no data in any table", async () => {
    expect(await deleteYear(1999)).toBe(0);
  });
});

describe("distinctYears / countForYear / rowsForYear", () => {
  it("agree on which years exist and how many rows each holds", async () => {
    await db.bills.add(billRow({ id: "b-2025", bill_date: "2025-06-01" }));
    await db.bills.add(billRow({ id: "b-2025-2", bill_date: "2025-11-01" }));
    await db.bills.add(billRow({ id: "b-2026", bill_date: "2026-01-05" }));

    expect(await distinctYears()).toEqual([2025, 2026]);
    expect(await countForYear("bills", 2025)).toBe(2);
    expect(await countForYear("bills", 2026)).toBe(1);
    expect((await rowsForYear("bills", 2025)).length).toBe(2);
  });
});

describe("archiveYear — current-year rejection", () => {
  it("refuses to archive the current year, before touching Telegram/files/DB", async () => {
    const thisYear = new Date().getFullYear();
    await db.bills.add(
      billRow({ id: "b-current", bill_date: `${thisYear}-06-01` }),
    );

    await expect(archiveYear(thisYear)).rejects.toThrow(/current year/i);

    // Nothing was touched: the row is still there.
    expect(await db.bills.get("b-current")).toBeDefined();
  });
});

describe("schema migrations", () => {
  const storesByVersion: Record<number, Record<string, string>> = {
    1: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
    },
    4: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, created_at",
    },
    7: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, ref_id, created_at",
      app_settings: "key",
      receipt_hashes: "path",
    },
    9: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, ref_id, created_at",
      app_settings: "key",
      receipt_hashes: "path",
      day_closes: "id, day, created_at",
      day_close_history: "id, day, amended_at",
    },
  };

  for (const startVersion of [1, 4, 7, 9]) {
    it(`upgrades a v${startVersion} database without losing rows`, async () => {
      db.close();
      await Dexie.delete("turf-ledger");
      const old = new Dexie("turf-ledger");
      old.version(startVersion).stores(storesByVersion[startVersion]!);
      await old.open();
      await old.table("customers").add({
        id: "legacy-c",
        name: "Legacy",
        phone: null,
        created_at: "2025-01-01",
      });
      await old.table("snack_sales").add({
        id: "legacy-s",
        bill_no: "SB-1",
        sale_date: "2025-01-02",
        customer_name: "Legacy",
        items: [],
        total: 100,
        profit: 20,
        payment_mode: "Cash",
        notes: null,
        booking_id: null,
        booking_no: null,
        created_at: "2025-01-02",
      });
      if (startVersion >= 4)
        await old
          .table("counters")
          .put({ key: "invoice:2025", value: 7, updated_at: "2025-01-02" });
      await old.close();
      await db.open();

      expect(await db.customers.get("legacy-c")).toBeDefined();
      const sale = await db.snack_sales.get("legacy-s");
      expect(sale).toBeDefined();
      expect(sale?.merged_into_bill_id).toBeNull();
      if (startVersion >= 4)
        expect(await db.counters.get("invoice:2025")).toMatchObject({
          value: 7,
        });
      else expect(await db.counters.count()).toBe(0);
      expect(await db.payments.count()).toBe(0);
      expect(await db.day_closes.count()).toBe(0);
      expect(await db.day_close_history.count()).toBe(0);
      expect(await db.receipt_hashes.count()).toBe(0);
    });
  }
});

describe("year archive coverage", () => {
  it("has an IndexedDB entry_date index for tab-year filtering", async () => {
    await db.tab_entries.add({
      id: "index-check",
      tab_id: "tab",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Turf",
      amount: 1,
      note: null,
      ref_type: null,
      ref_id: null,
      entry_date: "2025-01-02",
      created_at: "2025-01-02T00:00:00.000Z",
    });
    expect(await rowsForYear("tab_entries", 2025)).toHaveLength(1);
  });

  it("archives every year-owned ledger table plus receipt blobs/hashes", async () => {
    const year = 2025;
    await db.snack_stock_history.add({
      id: "sh-1",
      item_id: "snack-1",
      item_name: "Water",
      delta: -1,
      previous_quantity: 5,
      new_quantity: 4,
      created_at: "2025-05-02T10:00:00.000Z",
    });
    await db.tab_entries.add({
      id: "te-1",
      tab_id: "tab-1",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Snacks",
      amount: 100,
      note: null,
      ref_type: "snack_sale",
      ref_id: "s1",
      entry_date: "2025-05-03",
      created_at: "2025-05-03T10:00:00.000Z",
    });
    await db.customer_tabs.add({
      id: "tab-1",
      customer_key: "n:ravi",
      customer_name: "Ravi",
      phone: null,
      status: "closed",
      opened_at: "2025-05-01T10:00:00.000Z",
      closed_at: "2025-05-04T10:00:00.000Z",
      created_at: "2025-05-01T10:00:00.000Z",
    });
    await db.day_closes.add({
      id: "dc-1",
      day: "2025-05-05",
      expected_in_drawer: 500,
      counted_cash: 500,
      variance: 0,
      note: null,
      closed_at: "2025-05-05T18:00:00.000Z",
      created_at: "2025-05-05T18:00:00.000Z",
    });
    await db.day_close_history.add({
      id: "dch-1",
      day: "2025-05-05",
      previous_expected_in_drawer: 400,
      previous_counted_cash: 390,
      previous_variance: -10,
      previous_note: "old",
      previous_closed_at: "2025-05-05T17:00:00.000Z",
      amended_at: "2025-05-05T18:00:00.000Z",
    });
    await db.bills.add(billRow({ id: "b-1", bill_date: "2025-05-01" }));
    await db.payments.add({
      id: "pay-1",
      parent_type: "bill",
      parent_id: "b-1",
      amount: 100,
      mode: "Cash",
      received_at: "2025-05-06",
      created_at: "2025-05-06T10:00:00.000Z",
    });
    await db.payments.add({
      id: "pay-late",
      parent_type: "bill",
      parent_id: "b-1",
      amount: 50,
      mode: "UPI",
      received_at: "2026-01-03",
      created_at: "2026-01-03T10:00:00.000Z",
    });
    const blob = new Blob(["receipt"], { type: "image/jpeg" });
    await db.receipts.put({
      path: "Receipts/2025/r.jpg",
      blob,
      created_at: "2025-05-07T10:00:00.000Z",
    });
    await db.receipt_hashes.put({
      path: "Receipts/2025/r.jpg",
      sha256: "abc",
      created_at: "2025-05-07T10:00:00.000Z",
    });
    await db.expenses.add({
      id: "e-1",
      expense_no: "TX-1",
      business: "Turf",
      category: "Other",
      description: null,
      note: null,
      amount: 50,
      spent_at: "2025-05-07T10:00:00.000Z",
      receipt_path: "Receipts/2025/r.jpg",
      created_at: "2025-05-07T10:00:00.000Z",
    });

    const archive = await buildYearArchive(year);
    expect(archive.version).toBe(2);
    expect(archive.tables["snack_stock_history"]).toHaveLength(1);
    expect(archive.tables["tab_entries"]).toHaveLength(1);
    expect(archive.tables["day_closes"]).toHaveLength(1);
    expect(archive.tables["day_close_history"]).toHaveLength(1);
    expect(archive.tables["payments"]).toHaveLength(2);
    expect(archive.photos).toHaveLength(1);
    expect(archive.receipt_hashes).toHaveLength(1);
    expect(await yearRowCount(year)).toBe(10);

    const removed = await deleteYear(year);
    expect(removed).toBe(10);
    expect(await db.snack_stock_history.get("sh-1")).toBeUndefined();
    expect(await db.tab_entries.get("te-1")).toBeUndefined();
    expect(await db.day_closes.get("dc-1")).toBeUndefined();
    expect(await db.day_close_history.get("dch-1")).toBeUndefined();
    expect(await db.payments.get("pay-1")).toBeUndefined();
    expect(await db.payments.get("pay-late")).toBeUndefined();
    expect(await db.receipts.get("Receipts/2025/r.jpg")).toBeUndefined();
    expect(await db.receipt_hashes.get("Receipts/2025/r.jpg")).toBeUndefined();
  });

  it("refuses to delete year entries belonging to an open tab", async () => {
    await db.customer_tabs.add({
      id: "tab-open",
      customer_key: "n:ravi",
      customer_name: "Ravi",
      phone: null,
      status: "open",
      opened_at: "2025-01-01T00:00:00.000Z",
      closed_at: null,
      created_at: "2025-01-01T00:00:00.000Z",
    });
    await db.tab_entries.add({
      id: "te-open",
      tab_id: "tab-open",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Turf",
      amount: 100,
      note: null,
      ref_type: "bill",
      ref_id: "b",
      entry_date: "2025-06-01",
      created_at: "2025-06-01T00:00:00.000Z",
    });
    await expect(deleteYear(2025)).rejects.toThrow(/still open/i);
    expect(await db.tab_entries.get("te-open")).toBeDefined();
  });
});

describe("closeDay atomic amendment", () => {
  it("rolls back the day close when history cannot be written", async () => {
    await db.day_closes.add({
      id: "dc-existing",
      day: "2025-05-10",
      expected_in_drawer: 500,
      counted_cash: 500,
      variance: 0,
      note: "original",
      closed_at: "2025-05-10T18:00:00.000Z",
      created_at: "2025-05-10T18:00:00.000Z",
    });
    const put = vi
      .spyOn(db.day_close_history, "put")
      .mockRejectedValueOnce(new Error("history failed"));
    await expect(
      closeDay({ day: "2025-05-10", expectedInDrawer: 600, countedCash: 590 }),
    ).rejects.toThrow("history failed");
    put.mockRestore();
    expect(await db.day_closes.get("dc-existing")).toMatchObject({
      counted_cash: 500,
      note: "original",
    });
    expect(
      await db.day_close_history.where("day").equals("2025-05-10").count(),
    ).toBe(0);
  });
});
