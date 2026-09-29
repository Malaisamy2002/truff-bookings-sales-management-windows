/** Deterministic booking/payment planning primitives for the load-test generator. */
import type { PaymentRow, TurfBookingRow } from "./localdb";
import { rupees } from "./money";

export type BookingScenario =
  | "B1"
  | "B2"
  | "B3"
  | "B4"
  | "B5"
  | "B6"
  | "B7"
  | "B8"
  | "B9"
  | "B10"
  | "B11"
  | "B12"
  | "B14";

export const BOOKING_SCENARIOS: { id: BookingScenario; weight: number }[] = [
  { id: "B14", weight: 0.03 },
  { id: "B9", weight: 0.025 },
  { id: "B10", weight: 0.01 },
  { id: "B11", weight: 0.015 },
  { id: "B12", weight: 0.02 },
  { id: "B8", weight: 0.07 },
  { id: "B7", weight: 0.12 },
  { id: "B6", weight: 0.04 },
  { id: "B5", weight: 0.04 },
  { id: "B4", weight: 0.08 },
  { id: "B3", weight: 0.1 },
  { id: "B2", weight: 0.16 },
  { id: "B1", weight: 0.29 },
];

export function pickBookingScenario(rand: () => number): BookingScenario {
  let x = rand();
  for (const s of BOOKING_SCENARIOS) {
    x -= s.weight;
    if (x < 0) return s.id;
  }
  return "B1";
}

export function primaryMode(
  entries: { amount: number; mode: string }[],
): string {
  if (!entries.length) return "Pending";
  let best = entries[0]!;
  for (const e of entries.slice(1)) if (e.amount > best.amount) best = e;
  return best.mode;
}

export function bookingPaymentRows(
  parentId: string,
  paymentSeq: number,
  receivedAt: string,
  entries: { amount: number; mode: "Cash" | "UPI" | "Card" }[],
): PaymentRow[] {
  return entries.map((e, i) => ({
    id: `lt-pay-${String(paymentSeq * 10 + i).padStart(7, "0")}`,
    parent_type: "turf_booking",
    parent_id: parentId,
    amount: rupees(e.amount),
    mode: e.mode,
    received_at: receivedAt,
    created_at: new Date(Date.parse(receivedAt) + i).toISOString(),
  }));
}

export function splitCollection(
  amount: number,
  rand: () => number,
  online: "UPI" | "Card" = rand() < 0.5 ? "UPI" : "Card",
): { amount: number; mode: "Cash" | "UPI" | "Card" }[] {
  const total = Math.max(0, rupees(amount));
  if (!total) return [];
  const cash = rupees(total * (0.25 + rand() * 0.35));
  const onlineAmount = total - cash;
  return cash > 0 && onlineAmount > 0
    ? [
        { amount: cash, mode: "Cash" },
        { amount: onlineAmount, mode: online },
      ]
    : [{ amount: total, mode: online }];
}

export function singleCollection(
  amount: number,
  rand: () => number,
): { amount: number; mode: "Cash" | "UPI" | "Card" }[] {
  if (amount <= 0) return [];
  const modes = ["Cash", "UPI", "Card"] as const;
  return [
    { amount: rupees(amount), mode: modes[Math.floor(rand() * modes.length)]! },
  ];
}

export function assertBookingPaymentConservation(
  booking: Pick<TurfBookingRow, "total_amount" | "tax_amount" | "advance_paid">,
  payments: Pick<PaymentRow, "amount">[],
  netTabCharge = 0,
) {
  const gross = rupees(booking.total_amount + (booking.tax_amount ?? 0));
  const rows = rupees(payments.reduce((n, p) => n + p.amount, 0));
  const allowed = rupees(gross - Math.max(0, netTabCharge));
  if (rows > allowed || booking.advance_paid > gross) {
    throw new Error(
      `loadtest booking payment conservation failed: rows=${rows} allowed=${allowed} advance=${booking.advance_paid} gross=${gross}`,
    );
  }
}
