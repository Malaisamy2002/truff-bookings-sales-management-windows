import { describe, expect, it } from "vitest";
import {
  BOOKING_SCENARIOS,
  bookingPaymentRows,
  pickBookingScenario,
  primaryMode,
  singleCollection,
  splitCollection,
} from "./loadtest-gen";

describe("loadtest booking generator", () => {
  it("uses the audited booking scenario weights", () => {
    expect(BOOKING_SCENARIOS.reduce((n, s) => n + s.weight, 0)).toBe(1);
    expect(new Set(BOOKING_SCENARIOS.map((s) => s.id))).toEqual(
      new Set([
        "B1",
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "B8",
        "B9",
        "B10",
        "B11",
        "B12",
        "B14",
      ]),
    );
  });

  it("writes split rows in Cash-first order and chooses the last collection mode", () => {
    const split = splitCollection(1000, () => 0.5, "UPI");
    expect(split.map((x) => x.mode)).toEqual(["Cash", "UPI"]);
    expect(split.reduce((n, x) => n + x.amount, 0)).toBe(1000);
    expect(
      primaryMode([
        { amount: 300, mode: "Cash" },
        { amount: 700, mode: "UPI" },
      ]),
    ).toBe("UPI");
  });

  it("creates deterministic payment rows with increasing timestamps", () => {
    const entries = singleCollection(1000, () => 0);
    const rows = bookingPaymentRows(
      "lt-bk-00001",
      1,
      "2026-09-01T03:30:00.000Z",
      entries,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "lt-pay-0000010",
      parent_type: "turf_booking",
      parent_id: "lt-bk-00001",
      amount: 1000,
      mode: "Cash",
      received_at: "2026-09-01T03:30:00.000Z",
    });
  });

  it("never produces a payment row for a zero collection", () => {
    expect(
      bookingPaymentRows("lt-bk-00001", 1, "2026-09-01T03:30:00.000Z", []),
    ).toEqual([]);
  });

  it("is deterministic for a deterministic PRNG", () => {
    const sequence = [0.001, 0.1, 0.4, 0.8, 0.99];
    let i = 0;
    const rand = () => sequence[i++ % sequence.length]!;
    const a = Array.from({ length: 20 }, () => pickBookingScenario(rand));
    i = 0;
    const b = Array.from({ length: 20 }, () => pickBookingScenario(rand));
    expect(a).toEqual(b);
  });
});
