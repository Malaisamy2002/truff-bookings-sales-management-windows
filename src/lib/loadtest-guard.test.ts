// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { db } from "./localdb";
import {
  seedLoadTestData,
  countLiveBusinessRows,
  clearLoadTestData,
} from "./loadtest";
import { readAppSettings } from "./settings";

describe("F-14 (K3): load-test seed refuses live databases", () => {
  it("rejects seeding when real records exist and preserves tax settings", async () => {
    await db.customers.add({
      id: "cust-real",
      name: "Real Customer",
      phone: "9999999999",
      created_at: "2026-09-01T00:00:00.000Z",
    } as never);
    const before = readAppSettings();
    await expect(seedLoadTestData("light")).rejects.toThrow(
      /real business records/,
    );
    expect(readAppSettings().gstEnabled).toBe(before.gstEnabled);
    expect(await countLiveBusinessRows()).toBe(1);
  });

  it(
    "force succeeds on a live database WITHOUT flipping tax settings",
    { timeout: 30000 },
    async () => {
      const before = readAppSettings();
      await seedLoadTestData("light", undefined, { force: true, months: 12 });
      expect(readAppSettings().gstEnabled).toBe(before.gstEnabled);
      await clearLoadTestData();
      expect(await countLiveBusinessRows()).toBe(1); // the real customer stays
    },
  );

  it(
    "empty database seeds normally and applies the test tax setup",
    { timeout: 30000 },
    async () => {
      await db.customers.clear();
      await seedLoadTestData("light", undefined, { months: 12 });
      expect(readAppSettings().gstEnabled).toBe(true);
      await clearLoadTestData();
    },
  );
});
