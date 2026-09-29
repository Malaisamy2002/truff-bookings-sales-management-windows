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
} from "./courts";

describe("multi-court money", () => {
  it("turfPrice = rate x courts, rounded once", () => {
    expect(turfPrice(500, 3)).toBe(1500); // rupees applied once, not 3x separately
    expect(turfPrice(500, 1)).toBe(500);
    expect(turfPrice(500, 0)).toBe(500); // max(1, courts) floor
    expect(turfPrice(333, 3)).toBe(999); // 999 exactly, one rounding
  });

  it("storedTurfAmount: stored value wins; else hours x rate x courts", () => {
    expect(
      storedTurfAmount({
        hours: 1,
        rate_per_hour: 500,
        courts: 3,
        turf_amount: 0,
      }),
    ).toBe(1500);
    expect(
      storedTurfAmount({
        hours: 1,
        rate_per_hour: 500,
        courts: 3,
        turf_amount: 1400,
      }),
    ).toBe(1400); // stored snapshot wins over recompute
    expect(storedTurfAmount({ hours: 2, rate_per_hour: 400, courts: 2 })).toBe(
      1600,
    );
    expect(storedTurfAmount({ hours: 1, rate_per_hour: 500 })).toBe(500); // no courts -> 1
  });

  it("bookingCourts: absent/0/negative -> 1 court (legacy single-court)", () => {
    expect(bookingCourts({})).toBe(1);
    expect(bookingCourts({ courts: 0 })).toBe(1);
    expect(bookingCourts({ courts: 3 })).toBe(3);
    expect(bookingCourts({ courts: 2.6 })).toBe(3); // rounded
  });

  it("courtHourSegments: 1 court x 1h = 1 court-hour segment; 3 courts = n:3", () => {
    const one = courtHourSegments({
      courts: 1,
      start_time: "18:00",
      end_time: "19:00",
      booking_date: "2026-09-01",
      hours: 1,
    } as never);
    expect(one).toEqual([{ dayOffset: 0, from: 1080, to: 1140, n: 1 }]);
    const three = courtHourSegments({
      courts: 3,
      start_time: "18:00",
      end_time: "19:00",
      booking_date: "2026-09-01",
      hours: 1,
    } as never);
    expect(three).toEqual([{ dayOffset: 0, from: 1080, to: 1140, n: 3 }]);
  });

  it("midnight-crossing splits court-hours across two days", () => {
    const segs = courtHourSegments({
      courts: 2,
      start_time: "23:00",
      end_time: "01:00",
      booking_date: "2026-09-01",
      hours: 2,
    } as never);
    expect(segs).toEqual([
      { dayOffset: 0, from: 1380, to: 1440, n: 2 }, // 23:00-24:00 = 1h x 2 courts
      { dayOffset: 1, from: 0, to: 60, n: 2 }, // 00:00-01:00 next day
    ]);
  });
});
