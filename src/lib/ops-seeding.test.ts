// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { db } from "./localdb";
import { ensureDefaultTurfRates, TURF_RATES_SEED_MARKER } from "./ops";

describe("turf-rate default seeding", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    window.localStorage.clear();
  });

  it("seeds defaults once on a fresh installation", async () => {
    const rows = await ensureDefaultTurfRates();
    expect(rows.map((r) => r.slot_name)).toEqual(["Weekdays", "Weekends"]);
    expect(window.localStorage.getItem(TURF_RATES_SEED_MARKER)).toBe("1");
  });

  it("does not reseed after the owner deletes all rates", async () => {
    await ensureDefaultTurfRates();
    await db.turf_rates.clear();

    const rows = await ensureDefaultTurfRates();
    expect(rows).toEqual([]);
    expect(await db.turf_rates.count()).toBe(0);
  });
});
