// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "./localdb";
import { clearAllData } from "./devdata";

describe("clearAllData()", () => {
  beforeEach(async () => {
    await db.customers.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("clears transactional data, receipt hashes, and persisted app state", async () => {
    await db.customers.add({
      id: "c1",
      name: "Ravi",
      phone: "9876543210",
      created_at: "2026-09-01T10:00:00.000Z",
    });
    await db.receipts.add({
      path: "receipt-1.jpg",
      blob: new Blob(["photo"]),
      created_at: "2026-09-01T10:00:00.000Z",
    });
    await db.receipt_hashes.add({
      path: "receipt-1.jpg",
      sha256: "abc",
      created_at: "2026-09-01T10:00:00.000Z",
    });
    window.localStorage.setItem("ks:layout-active", "persisted");
    window.localStorage.setItem("ks:backup-passphrase", "secret");
    window.sessionStorage.setItem("ks:selected-year", "2026");

    await clearAllData();

    expect(await db.customers.count()).toBe(0);
    expect(await db.receipts.count()).toBe(0);
    expect(await db.receipt_hashes.count()).toBe(0);
    expect(window.localStorage.getItem("ks:layout-active")).toBeNull();
    expect(window.localStorage.getItem("ks:backup-passphrase")).toBeNull();
    expect(window.sessionStorage.getItem("ks:selected-year")).toBeNull();
  });
});
