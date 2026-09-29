import { describe, expect, it } from "vitest";
import {
  assignCourts,
  bookingCourts,
  buildCourtOccupancy,
  courtIdsFor,
  courtLabel,
  courtNamesFor,
  courtsLabel,
  freeCourtIdsFor,
  resolveCourtIds,
  buildOccupancy,
  clampToVenue,
  courtHourSegments,
  effectiveRatePerHour,
  freeCourtsFor,
  selectionFits,
  storedTurfAmount,
  turfPrice,
  utilisationPct,
  windowFits,
  type CourtBooking,
} from "./courts";

const bk = (o: Partial<CourtBooking> & { start: string; hours: number }) =>
  ({
    id: o.id ?? Math.random().toString(36).slice(2),
    booking_date: o.booking_date ?? "2026-03-10",
    start_time: o.start,
    end_time: null,
    hours: o.hours,
    courts: o.courts ?? 1,
    status: o.status ?? "Confirmed",
  }) as CourtBooking;

const H = (h: number) => h * 60;

describe("bookingCourts / clampToVenue", () => {
  it("treats missing or junk as 1 and rounds", () => {
    expect(bookingCourts({})).toBe(1);
    expect(bookingCourts({ courts: 0 })).toBe(1);
    expect(bookingCourts({ courts: 2.6 })).toBe(3);
    expect(bookingCourts({ courts: null })).toBe(1);
  });
  it("never exceeds the venue and never drops below 1", () => {
    expect(clampToVenue(5, 2)).toBe(2);
    expect(clampToVenue(0, 3)).toBe(1);
    expect(clampToVenue(2, 0)).toBe(1);
  });
});

describe("buildOccupancy", () => {
  it("adds up courts per minute and ignores cancelled bookings", () => {
    const occ = buildOccupancy(
      [
        bk({ start: "6 PM", hours: 1, courts: 2 }),
        bk({ start: "6:30 PM", hours: 1, courts: 1 }),
        bk({ start: "6 PM", hours: 1, courts: 3, status: "Cancelled" }),
      ],
      "2026-03-10",
    );
    expect(occ.get(H(18))).toBe(2);
    expect(occ.get(H(18) + 30)).toBe(3); // both live bookings overlap
    expect(occ.get(H(19) + 10)).toBe(1); // only the second, still running
    expect(occ.get(H(19) + 30)).toBeUndefined();
  });

  it("gives every booking its OWN court count (no bleed between bookings)", () => {
    // Regression: the old inline version kept the count in a shared variable.
    const occ = buildOccupancy(
      [
        bk({ start: "6 PM", hours: 1, courts: 3 }),
        bk({ start: "9 PM", hours: 1, courts: 1 }),
      ],
      "2026-03-10",
    );
    expect(occ.get(H(18))).toBe(3);
    expect(occ.get(H(21))).toBe(1);
  });

  it("spills a past-midnight booking into the next day, and excludes itself when editing", () => {
    const late = bk({
      id: "late",
      start: "11 PM",
      hours: 2,
      courts: 2,
      booking_date: "2026-03-09",
    });
    const next = buildOccupancy([late], "2026-03-10");
    expect(next.get(0)).toBe(2);
    expect(next.get(59)).toBe(2);
    expect(next.get(60)).toBeUndefined();
    expect(buildOccupancy([late], "2026-03-10", "late").size).toBe(0);
  });
});

describe("free courts / fit", () => {
  const occ = buildOccupancy(
    [bk({ start: "6 PM", hours: 1, courts: 1 })],
    "2026-03-10",
  );
  it("counts free courts as the minimum over the whole window", () => {
    expect(freeCourtsFor(occ, 2, H(18), 60)).toBe(1);
    // window straddles the booking's last minute -> still limited to 1 free
    expect(freeCourtsFor(occ, 2, H(18) + 50, 30)).toBe(1);
    expect(freeCourtsFor(occ, 2, H(19), 60)).toBe(2);
  });
  it("never reports negative free courts if the venue was shrunk", () => {
    const big = buildOccupancy(
      [bk({ start: "6 PM", hours: 1, courts: 3 })],
      "2026-03-10",
    );
    expect(freeCourtsFor(big, 2, H(18), 60)).toBe(0);
  });
  it("windowFits respects the requested court count", () => {
    expect(windowFits(occ, 2, H(18), 60, 1)).toBe(true);
    expect(windowFits(occ, 2, H(18), 60, 2)).toBe(false);
  });
  it("selectionFits catches slots invalidated by raising the court count", () => {
    const slots = [H(18), H(19)];
    expect(selectionFits(occ, 2, slots, 60, 1)).toBe(true);
    expect(selectionFits(occ, 2, slots, 60, 2)).toBe(false);
  });
});

describe("pricing", () => {
  it("multiplies one-court price by courts in whole rupees", () => {
    expect(turfPrice(600, 1)).toBe(600);
    expect(turfPrice(600, 3)).toBe(1800);
    expect(turfPrice(450, 0)).toBe(450);
  });
  it("uses stored turf_amount, else rebuilds legacy zero from hours×rate×courts", () => {
    expect(
      storedTurfAmount({
        turf_amount: 900,
        hours: 1,
        rate_per_hour: 1,
        courts: 1,
      }),
    ).toBe(900);
    expect(
      storedTurfAmount({
        turf_amount: 0,
        hours: 1.5,
        rate_per_hour: 600,
        courts: 2,
      }),
    ).toBe(1800);
    expect(
      storedTurfAmount({ turf_amount: 0, hours: 1, rate_per_hour: 600 }),
    ).toBe(600);
  });
  it("effective rate is per court per hour", () => {
    expect(effectiveRatePerHour(1800, 1.5, 2)).toBe(600);
    expect(effectiveRatePerHour(0, 0, 2)).toBe(0);
  });
});

describe("court-hours & utilisation", () => {
  it("splits a past-midnight booking across two days, weighted by courts", () => {
    const segs = courtHourSegments({
      ...bk({ start: "11 PM", hours: 2, courts: 2 }),
      end_time: "1 AM",
    });
    expect(segs).toEqual([
      { dayOffset: 0, from: H(23), to: 1440, n: 2 },
      { dayOffset: 1, from: 0, to: 60, n: 2 },
    ]);
  });
  it("normalises by venue size and caps at 100%", () => {
    expect(utilisationPct(2, 4, 2)).toBe(25);
    expect(utilisationPct(99, 4, 2)).toBe(100);
    expect(utilisationPct(1, 0, 2)).toBe(0);
  });
});

describe("named courts", () => {
  type NB = CourtBooking & { court_ids?: string[] | null; created_at?: string };
  const nb = (
    o: Partial<NB> & { start: string; hours: number; id: string },
  ): NB => ({ ...bk(o), id: o.id, court_ids: o.court_ids ?? null }) as NB;

  it("builds ids and names, padding blanks with 'Court N'", () => {
    expect(courtIdsFor(3)).toEqual(["c1", "c2", "c3"]);
    expect(courtNamesFor(3, ["Main", " ", null])).toEqual([
      "Main",
      "Court 2",
      "Court 3",
    ]);
    expect(courtLabel("c2", ["A", "B"])).toBe("B");
    expect(courtLabel("c3", ["A", "B"])).toBe("Court 3");
    expect(courtsLabel(["c1", "c2"], ["A", "B"])).toBe("A, B");
    expect(courtsLabel(null)).toBe("");
  });

  it("keeps stored court_ids and assigns legacy rows around them", () => {
    const rows = [
      nb({ id: "a", start: "10 AM", hours: 1, court_ids: ["c1"] }),
      nb({ id: "b", start: "10 AM", hours: 1 }), // legacy
    ];
    const held = resolveCourtIds(rows, 2);
    expect(held.get("a")).toEqual(["c1"]);
    expect(held.get("b")).toEqual(["c2"]);
  });

  it("ignores ids for a court that no longer exists and skips cancelled", () => {
    const rows = [
      nb({ id: "a", start: "10 AM", hours: 1, court_ids: ["c5"] }),
      nb({ id: "x", start: "10 AM", hours: 1, status: "Cancelled" }),
    ];
    const held = resolveCourtIds(rows, 2);
    expect(held.get("a")).toEqual(["c1"]);
    expect(held.has("x")).toBe(false);
  });

  it("never throws on an already-overbooked legacy day", () => {
    const rows = [
      nb({ id: "a", start: "10 AM", hours: 1 }),
      nb({ id: "b", start: "10 AM", hours: 1 }),
    ];
    const held = resolveCourtIds(rows, 1);
    expect(held.get("a")).toEqual(["c1"]);
    expect(held.get("b")).toEqual(["c1"]);
  });

  it("assigns the lowest free court for the whole window", () => {
    const rows = [nb({ id: "a", start: "10 AM", hours: 1, court_ids: ["c1"] })];
    const occ = buildCourtOccupancy(rows, "2026-03-10", 3);
    expect(assignCourts(occ, 3, H(10), 60, 1)).toEqual(["c2"]);
    expect(assignCourts(occ, 3, H(10), 60, 2)).toEqual(["c2", "c3"]);
    expect(assignCourts(occ, 3, H(10), 60, 3)).toBeNull();
    expect(assignCourts(occ, 3, H(11), 60, 3)).toEqual(["c1", "c2", "c3"]);
  });

  it("refuses a window no single court is free for, though the head-count would fit", () => {
    // 2 courts: c1 busy 10-11, c2 busy 11-12. A 1-court booking 10-12 has one
    // court free at every minute (count model says yes) but never the SAME one.
    const rows = [
      nb({ id: "a", start: "10 AM", hours: 1, court_ids: ["c1"] }),
      nb({ id: "b", start: "11 AM", hours: 1, court_ids: ["c2"] }),
    ];
    const occ = buildCourtOccupancy(rows, "2026-03-10", 2);
    expect(assignCourts(occ, 2, H(10), 120, 1)).toBeNull();
    expect(freeCourtIdsFor(occ, 2, H(10), 60)).toEqual(["c2"]);
    expect(freeCourtIdsFor(occ, 2, H(11), 60)).toEqual(["c1"]);
  });

  it("excludeId frees the booking being edited", () => {
    const rows = [nb({ id: "a", start: "10 AM", hours: 1, court_ids: ["c1"] })];
    const occ = buildCourtOccupancy(rows, "2026-03-10", 1, "a");
    expect(assignCourts(occ, 1, H(10), 60, 1)).toEqual(["c1"]);
  });

  it("carries a past-midnight booking into the next day on the same court", () => {
    const rows = [
      nb({
        id: "a",
        booking_date: "2026-03-10",
        start: "11:30 PM",
        hours: 1,
        court_ids: ["c2"],
      }),
    ];
    const next = buildCourtOccupancy(rows, "2026-03-11", 2);
    expect(assignCourts(next, 2, 0, 30, 1)).toEqual(["c1"]);
    expect(assignCourts(next, 2, 30, 30, 2)).toEqual(["c1", "c2"]);
    const same = buildCourtOccupancy(rows, "2026-03-10", 2);
    expect(assignCourts(same, 2, H(23) + 30, 30, 1)).toEqual(["c1"]);
  });
});
