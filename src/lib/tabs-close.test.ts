import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import { closeTab, settleAndCloseTab } from "./tabs";

const openTab = async () => {
  const now = new Date().toISOString();
  await db.customer_tabs.add({
    id: "tab-1",
    customer_key: "p:9876543210",
    customer_name: "Close Race",
    phone: "9876543210",
    status: "open",
    opened_at: now,
    closed_at: null,
    created_at: now,
  });
};

describe("tab closing transaction boundaries", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("closes only after reading the ledger inside the same transaction", async () => {
    await openTab();
    await db.tab_entries.add({
      id: "charge-1",
      tab_id: "tab-1",
      customer_key: "p:9876543210",
      kind: "charge",
      business: "Turf",
      amount: 500,
      note: null,
      ref_type: null,
      ref_id: null,
      source_ref_type: null,
      source_ref_id: null,
      payment_mode: null,
      entry_date: "2026-09-23",
      created_at: new Date().toISOString(),
    });

    await expect(closeTab("tab-1")).rejects.toThrow("Tab still has a balance");
    expect((await db.customer_tabs.get("tab-1"))?.status).toBe("open");

    await settleAndCloseTab({
      tabId: "tab-1",
      payments: [{ amount: 500, mode: "Cash" }],
    });
    expect((await db.customer_tabs.get("tab-1"))?.status).toBe("closed");
    expect(await db.tab_entries.where("tab_id").equals("tab-1").count()).toBe(
      2,
    );
  });

  it("never leaves a positive-balance tab closed", async () => {
    await openTab();
    await db.tab_entries.add({
      id: "charge-2",
      tab_id: "tab-1",
      customer_key: "p:9876543210",
      kind: "charge",
      business: "Snacks",
      amount: 300,
      note: null,
      ref_type: null,
      ref_id: null,
      source_ref_type: null,
      source_ref_id: null,
      payment_mode: null,
      entry_date: "2026-09-23",
      created_at: new Date().toISOString(),
    });

    // Exercise the same invariant through the public settlement boundary: a
    // short payment must abort the whole transaction, including the payment row.
    await expect(
      settleAndCloseTab({
        tabId: "tab-1",
        payments: [{ amount: 299, mode: "Cash" }],
      }),
    ).rejects.toThrow("full ₹300 is needed");
    expect((await db.customer_tabs.get("tab-1"))?.status).toBe("open");
    expect(await db.tab_entries.where("tab_id").equals("tab-1").count()).toBe(
      1,
    );
  });

  it("rejects a second close without changing the closed timestamp", async () => {
    await openTab();
    await closeTab("tab-1");
    const first = await db.customer_tabs.get("tab-1");
    await expect(closeTab("tab-1")).rejects.toThrow("already closed");
    expect((await db.customer_tabs.get("tab-1"))?.closed_at).toBe(
      first?.closed_at,
    );
  });
});
