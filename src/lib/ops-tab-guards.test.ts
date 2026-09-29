import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { db } from "./localdb";
import { assertSnackSaleNotOnTab } from "./ops";

describe("snack-sale destructive mutation guards", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  const seed = async () => {
    const id = "sale-1";
    await db.snack_sales.add({
      id,
      bill_no: "SB-1",
      sale_date: "2026-09-23",
      customer_name: "A",
      items: [
        {
          item_name: "Water",
          qty: 1,
          unit_price: 50,
          cost_price: 20,
          amount: 50,
        },
      ],
      total: 50,
      profit: 30,
      payment_mode: "On tab",
      notes: null,
      booking_id: null,
      booking_no: null,
      created_at: new Date().toISOString(),
    });
    await db.tab_entries.add({
      id: "entry-1",
      tab_id: "tab-1",
      customer_key: "n:a",
      kind: "charge",
      business: "Snacks",
      amount: 50,
      note: "Snack sale",
      ref_type: "snack_sale",
      ref_id: id,
      payment_mode: null,
      entry_date: "2026-09-23",
      created_at: new Date().toISOString(),
    });
    return id;
  };

  it("refuses delete while a sale charge remains on a tab", async () => {
    const id = await seed();
    await expect(assertSnackSaleNotOnTab(id)).rejects.toThrow(
      /on a customer tab/,
    );
    expect(await db.snack_sales.get(id)).toBeTruthy();
  });

  it("refuses void while a sale charge remains on a tab", async () => {
    const id = await seed();
    await expect(assertSnackSaleNotOnTab(id)).rejects.toThrow(
      /on a customer tab/,
    );
    expect((await db.snack_sales.get(id))?.cancelled).not.toBe(true);
  });
});
