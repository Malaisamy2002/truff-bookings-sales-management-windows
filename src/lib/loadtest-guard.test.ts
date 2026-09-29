// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { db } from "./localdb";
import {
  seedLoadTestData,
  countLiveBusinessRows,
  clearLoadTestData,
  LOAD_TEST_COURTS,
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

describe("F-1: load-test seed sets and restores the venue court count", () => {
  it(
    "seeds total_courts = LOAD_TEST_COURTS and restores the user's setting on clear",
    { timeout: 30000 },
    async () => {
      await db.customers.clear();
      const realSetting = {
        allow_15: true,
        allow_30: true,
        allow_45: false,
        allow_60: true,
        total_courts: 5,
        court_names: ["A", "B", "C", "D", "E"],
      };
      await db.app_settings.put({
        key: "slot_durations",
        value: realSetting,
        updated_at: "2026-09-01T00:00:00.000Z",
      });

      await seedLoadTestData("light", undefined, { months: 12 });
      const during = await db.app_settings.get("slot_durations");
      expect((during!.value as { total_courts?: number }).total_courts).toBe(
        LOAD_TEST_COURTS,
      );

      await clearLoadTestData();
      const after = await db.app_settings.get("slot_durations");
      expect(after?.value).toEqual(realSetting);
      expect(
        await db.app_settings.get("loadtest:slot_durations_backup"),
      ).toBeUndefined();
    },
  );

  it(
    "no prior setting: clear removes slot_durations entirely",
    { timeout: 30000 },
    async () => {
      await db.customers.clear();
      await db.app_settings.delete("slot_durations");
      await seedLoadTestData("light", undefined, { months: 12 });
      await clearLoadTestData();
      expect(await db.app_settings.get("slot_durations")).toBeUndefined();
      expect(
        await db.app_settings.get("loadtest:slot_durations_backup"),
      ).toBeUndefined();
    },
  );
});
