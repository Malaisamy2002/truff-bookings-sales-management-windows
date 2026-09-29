import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "./localdb";
import { backfillCourtIds } from "./ops";

// Minimal booking rows — only the fields the court logic reads.
const row = (id: string, start: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    booking_no: id,
    booking_date: "2026-03-10",
    start_time: start,
    end_time: null,
    hours: 1,
    courts: 1,
    status: "Confirmed",
    created_at: `2026-03-01T00:00:0${id.length}Z`,
    ...extra,
  }) as never;

describe("backfillCourtIds", () => {
  beforeEach(async () => {
    await db.turf_bookings.clear();
  });

  it("writes court ids onto legacy rows around already-assigned ones", async () => {
    await db.turf_bookings.bulkAdd([
      row("a", "6 PM", { court_ids: ["c1"] }),
      row("b", "6 PM"), // legacy, same slot -> must land on c2
      row("c", "8 PM"), // legacy, free slot -> c1
    ]);
    expect(await backfillCourtIds(2)).toBe(2);
    expect((await db.turf_bookings.get("a"))?.court_ids).toEqual(["c1"]);
    expect((await db.turf_bookings.get("b"))?.court_ids).toEqual(["c2"]);
    expect((await db.turf_bookings.get("c"))?.court_ids).toEqual(["c1"]);
  });

  it("leaves seeded named-court assignments untouched", async () => {
    await db.turf_bookings.bulkAdd([
      row("seeded", "6 PM", { courts: 2, court_ids: ["c2", "c3"] }),
      row("legacy", "6 PM", { courts: 1 }),
    ]);
    expect(await backfillCourtIds(3)).toBe(1);
    expect((await db.turf_bookings.get("seeded"))?.court_ids).toEqual(["c2", "c3"]);
    expect((await db.turf_bookings.get("legacy"))?.court_ids).toEqual(["c1"]);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    await db.turf_bookings.bulkAdd([row("a", "6 PM"), row("b", "6 PM")]);
    expect(await backfillCourtIds(2)).toBe(2);
    expect(await backfillCourtIds(2)).toBe(0);
  });

  it("re-homes a booking whose court was removed, and skips cancelled ones", async () => {
    await db.turf_bookings.bulkAdd([
      row("a", "6 PM", { court_ids: ["c3"] }), // venue shrank to 2 courts
      row("x", "6 PM", { status: "Cancelled" }),
    ]);
    expect(await backfillCourtIds(2)).toBe(1);
    expect((await db.turf_bookings.get("a"))?.court_ids).toEqual(["c1"]);
    expect((await db.turf_bookings.get("x"))?.court_ids).toBeUndefined();
  });
});
