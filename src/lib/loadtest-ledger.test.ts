import { describe, expect, it } from "vitest";
import { buildExpectedLedger } from "./loadtest-ledger";

describe("loadtest expected ledger", () => {
  it("reconciles raw split payments and tab collections without app aggregators", () => {
    const ledger = buildExpectedLedger({
      bills: [
        {
          id: "lt-b",
          invoice_no: "LT-INV-1",
          customer_name: "A",
          customer_phone: null,
          items: [],
          subtotal: 100,
          discount: 0,
          total: 100,
          tax_amount: 18,
          amount_paid: 118,
          status: "paid",
          payment_mode: "UPI",
          bill_date: "2026-07-10T12:00:00.000Z",
          created_at: "2026-07-10T12:00:00.000Z",
        },
      ],
      bookings: [],
      sales: [],
      expenses: [],
      payments: [
        {
          id: "lt-p1",
          parent_type: "bill",
          parent_id: "lt-b",
          amount: 60,
          mode: "Cash",
          received_at: "2026-07-10T12:00:00.000Z",
          created_at: "2026-07-10T12:00:00.000Z",
        },
        {
          id: "lt-p2",
          parent_type: "bill",
          parent_id: "lt-b",
          amount: 58,
          mode: "UPI",
          received_at: "2026-07-10T12:00:01.000Z",
          created_at: "2026-07-10T12:00:01.000Z",
        },
      ],
      tabEntries: [],
      dayCloses: [],
    });
    expect(ledger.months["2026-07"]?.revenue).toBe(118);
    expect(ledger.months["2026-07"]?.collected).toBe(118);
    expect(ledger.months["2026-07"]?.split).toEqual({
      Cash: 60,
      UPI: 58,
      Card: 0,
    });
  });

  it("keeps cancelled refundable advances out of revenue", () => {
    const ledger = buildExpectedLedger({
      bills: [],
      sales: [],
      expenses: [],
      bookings: [
        {
          id: "lt-c",
          booking_no: "LT-INV-1",
          booking_date: "2026-08-02",
          customer_name: "A",
          phone: null,
          slot_name: "11:30 AM",
          hours: 1,
          rate_per_hour: 1000,
          total_amount: 1000,
          tax_amount: 180,
          advance_paid: 400,
          payment_mode: "Cash",
          status: "Cancelled",
          is_refundable: true,
          discount: 0,
          notes: null,
          start_time: null,
          end_time: null,
          courts: 1,
          snacks: [],
          snacks_total: 0,
          turf_amount: 1000,
          created_at: "2026-08-02T05:00:00.000Z",
        },
      ],
      payments: [
        {
          id: "lt-p",
          parent_type: "turf_booking",
          parent_id: "lt-c",
          amount: 400,
          mode: "Cash",
          received_at: "2026-08-02T05:00:00.000Z",
          created_at: "2026-08-02T05:00:00.000Z",
        },
      ],
      tabEntries: [],
      dayCloses: [],
    });
    expect(ledger.months["2026-08"]?.revenue).toBe(0);
    expect(ledger.months["2026-08"]?.refundable).toBe(400);
    expect(ledger.months["2026-08"]?.forfeited).toBe(0);
  });

  it("splits received money by mode: rows by received_at, implied entry when a parent has no rows, no merged bookings", () => {
    const booking = (id: string, extra: Record<string, unknown>) => ({
      id,
      booking_no: id,
      booking_date: "2026-08-02",
      customer_name: "A",
      phone: null,
      slot_name: "11:30 AM",
      hours: 1,
      rate_per_hour: 1000,
      total_amount: 1000,
      tax_amount: 0,
      advance_paid: 500,
      payment_mode: "UPI",
      status: "Confirmed",
      discount: 0,
      notes: null,
      start_time: null,
      end_time: null,
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 1000,
      created_at: "2026-08-02T05:00:00.000Z",
      ...extra,
    });
    const ledger = buildExpectedLedger({
      bills: [],
      sales: [],
      expenses: [],
      tabEntries: [],
      dayCloses: [],
      bookings: [
        booking("lt-a", {}), // no rows -> implied UPI 500 on Aug 2
        booking("lt-b", { advance_paid: 300 }), // rows: Cash 300 received in September
        booking("lt-m", { merged_into_bill_id: "x" }), // merged -> contributes nothing
      ] as never,
      payments: [
        {
          id: "p1",
          parent_type: "turf_booking",
          parent_id: "lt-b",
          amount: 300,
          mode: "Cash",
          received_at: "2026-09-01T05:00:00.000Z",
          created_at: "x",
        },
        {
          id: "p2",
          parent_type: "turf_booking",
          parent_id: "lt-m",
          amount: 500,
          mode: "Card",
          received_at: "2026-08-02T05:00:00.000Z",
          created_at: "x",
        },
      ] as never,
    });
    expect(ledger.months["2026-08"]?.split).toEqual({
      Cash: 0,
      UPI: 500,
      Card: 0,
    });
    expect(ledger.months["2026-09"]?.split).toEqual({
      Cash: 300,
      UPI: 0,
      Card: 0,
    });
  });
});
