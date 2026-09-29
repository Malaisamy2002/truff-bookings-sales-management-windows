/**
 * Multi-court money invariants — the courts multiplier is the ONE place
 * turf price scales by court count, rounded once; revenue counts each
 * booking once (courts already inside total_amount); utilization is
 * court-HOURS. Pairs with courts.test.ts (occupancy) and wp1-*.test.ts
 * (single-court money).
 */
import { describe, expect, it } from "vitest";
import {
  bookingCourts,
  storedTurfAmount,
  turfPrice,
  courtHourSegments,
  effectiveRatePerHour,
} from "./courts";
import { priceForDuration } from "./ops";
import { taxBreakdown, DEFAULT_APP_SETTINGS } from "./settings";

describe("multi-court money", () => {
  it("turfPrice = rate x courts, rounded once", () => {
    expect(turfPrice(500, 3)).toBe(1500); // rupees applied once, not 3x separately
    expect(turfPrice(500, 1)).toBe(500);
    expect(turfPrice(500, 0)).toBe(500); // max(1, courts) floor
    expect(turfPrice(333, 3)).toBe(999); // 999 exactly, one rounding
  });

  it("storedTurfAmount: stored value wins; else hours x rate x courts", () => {
    expect(
      storedTurfAmount({ hours: 1, rate_per_hour: 500, courts: 3, turf_amount: 0 }),
    ).toBe(1500);
    expect(
      storedTurfAmount({ hours: 1, rate_per_hour: 500, courts: 3, turf_amount: 1400 }),
    ).toBe(1400); // stored snapshot wins over recompute
    expect(storedTurfAmount({ hours: 2, rate_per_hour: 400, courts: 2 })).toBe(1600);
    expect(storedTurfAmount({ hours: 1, rate_per_hour: 500 })).toBe(500); // no courts -> 1
  });

  it("bookingCourts: absent/0/negative -> 1 court (legacy single-court)", () => {
    expect(bookingCourts({})).toBe(1);
    expect(bookingCourts({ courts: 0 })).toBe(1);
    expect(bookingCourts({ courts: 3 })).toBe(3);
    expect(bookingCourts({ courts: 2.6 })).toBe(3); // rounded
  });

  it("courtHourSegments: 1 court x 1h = 1 court-hour segment; 3 courts = n:3", () => {
    const one = courtHourSegments({ courts: 1, start_time: "18:00", end_time: "19:00" });
    expect(one).toEqual([{ dayOffset: 0, from: 1080, to: 1140, n: 1 }]);
    const three = courtHourSegments({ courts: 3, start_time: "18:00", end_time: "19:00" });
    expect(three).toEqual([{ dayOffset: 0, from: 1080, to: 1140, n: 3 }]);
  });

  it("effectiveRatePerHour stores per-court hourly rate", () => {
    expect(effectiveRatePerHour(1000, 3, 3)).toBe(111.11);
    expect(effectiveRatePerHour(2400, 2, 3)).toBe(400);
  });

  it("2 hours × 3 courts uses the production duration pricing path", () => {
    const row = { rate_per_hour: 800, rate_15: null, rate_30: null, rate_45: null, rate_60: 800 };
    expect(turfPrice(priceForDuration(row, 120), 3)).toBe(4800);
  });

  it("15/30/45-minute remainder prices are multiplied by courts once", () => {
    const row = { rate_per_hour: 1200, rate_15: 300, rate_30: 550, rate_45: 800, rate_60: 1200 };
    expect(turfPrice(priceForDuration(row, 75), 2)).toBe(3000);
    expect(turfPrice(priceForDuration(row, 90), 2)).toBe(3500);
    expect(turfPrice(priceForDuration(row, 105), 2)).toBe(4000);
  });

  it("tax is calculated on the combined multi-court total", () => {
    const tax = taxBreakdown(999, {
      ...DEFAULT_APP_SETTINGS,
      gstEnabled: true,
      gstRate: 18,
      customTaxes: [{ id: "svc", label: "Service Charge", rate: 5, enabled: true }],
    });
    expect(tax.taxAmount).toBe(230);
    expect(tax.lines.map((x) => x.value)).toEqual([90, 90, 50]);
  });

  it("midnight-crossing splits court-hours across two days", () => {
    const segs = courtHourSegments({ courts: 2, start_time: "23:00", end_time: "01:00" });
    expect(segs).toEqual([
      { dayOffset: 0, from: 1380, to: 1440, n: 2 }, // 23:00-24:00 = 1h x 2 courts
      { dayOffset: 1, from: 0, to: 60, n: 2 },      // 00:00-01:00 next day
    ]);
  });
});
