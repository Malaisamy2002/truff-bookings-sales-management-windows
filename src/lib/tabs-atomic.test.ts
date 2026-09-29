import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addTabEntry, type AddTabEntryInput } from "./tabs";
import { db } from "./localdb";

const input: AddTabEntryInput = {
  name: "Atomic Tab Test",
  phone: "9876543210",
  kind: "charge",
  business: "Snacks",
  amount: 500,
};

describe("addTabEntry atomicity", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("rolls back a newly-created tab when the ledger insert fails", async () => {
    const add = vi
      .spyOn(db.tab_entries, "add")
      .mockRejectedValueOnce(new Error("injected ledger failure"));
    await expect(addTabEntry(input)).rejects.toThrow("injected ledger failure");
    expect(await db.customer_tabs.toArray()).toHaveLength(0);
    expect(await db.tab_entries.toArray()).toHaveLength(0);
    add.mockRestore();
  });

  it("creates the tab and entry together on success", async () => {
    const entry = await addTabEntry(input);
    expect(entry.amount).toBe(500);
    expect(await db.customer_tabs.count()).toBe(1);
    expect(await db.tab_entries.count()).toBe(1);
  });
});
