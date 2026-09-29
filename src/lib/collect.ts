import { useMutation, useQueryClient } from "@tanstack/react-query";

import { billGrossTotal, bookingGrossTotal, type Bill } from "./biz";
import { db } from "./localdb";
import { billDue, bookingCashCollected, bookingDue } from "./dues";
import { rupees } from "./money";
import type { TurfBooking } from "./ops";
import {
  primaryMode,
  recordInitialPayments,
  recordPayment,
  replacePaymentsForParent,
  type PaymentEntry,
  type ReceivedPaymentMode,
} from "./payments";
import type { TabEntry } from "./tabs";

/**
 * The collection paths every screen uses. Each one:
 *  - checks the entries against what the record still owes,
 *  - writes the payment rows AND the parent's new paid amount / status /
 *    mode in ONE database transaction (`recordPayment`), so rows and record
 *    can never disagree,
 *  - stamps the payment with the day the money actually arrived.
 *
 * What is owed is always the record's OWN due (`billDue` / `bookingDue`):
 * anything already moved onto the customer's running tab belongs to the tab
 * ledger and is never collected here, so no rupee is counted twice.
 */

const sum = (entries: PaymentEntry[]) =>
  entries.reduce((s, e) => s + rupees(e.amount), 0);

function assertCollectable(entries: PaymentEntry[], due: number) {
  const total = sum(entries);
  if (total <= 0) throw new Error("Enter an amount to collect");
  if (total > rupees(due)) {
    throw new Error(`That is more than the ₹${rupees(due)} owed`);
  }
  return total;
}

/** Collects `entries` against a bill. Settles it (status "paid") when the
 * whole of its own due is covered, otherwise marks it "partial". */
export async function collectBillPayment(input: {
  bill: Bill;
  tabEntries?: TabEntry[];
  entries: PaymentEntry[];
  receivedAt?: string;
}) {
  const { bill, entries } = input;
  const due = billDue(bill, input.tabEntries ?? []);
  const total = assertCollectable(entries, due);
  const settled = total >= rupees(due);
  return recordPayment({
    parentType: "bill",
    parentId: bill.id,
    entries,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
    parentPatch: {
      status: settled ? "paid" : "partial",
      payment_mode: primaryMode(entries),
    },
  });
}

/** Collects `entries` against a turf booking. `markCompleted` also flips a
 * fully paid booking to "Completed" (what the Turf tab's Collect / Mark paid
 * always did). */
export async function collectBookingPayment(input: {
  booking: TurfBooking;
  tabEntries?: TabEntry[];
  entries: PaymentEntry[];
  receivedAt?: string;
  markCompleted?: boolean;
}) {
  const { booking, entries } = input;
  const tabEntries = input.tabEntries ?? [];
  const due = bookingDue(booking, tabEntries);
  const total = assertCollectable(entries, due);
  const settled = total >= rupees(due);
  // `advance_paid` moves by exactly what was collected. It can be inflated
  // above the real cash by "Put balance on tab", so it is NOT recomputed from
  // the payment rows; the implied backfill uses the REAL cash instead.
  const newAdvance = Number(booking.advance_paid || 0) + total;
  return recordPayment({
    parentType: "turf_booking",
    parentId: booking.id,
    entries,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
    impliedAmount: bookingCashCollected(booking, tabEntries),
    parentPatch: {
      advance_paid: newAdvance,
      payment_mode: primaryMode(entries),
      ...(input.markCompleted &&
      (settled || newAdvance >= bookingGrossTotal(booking))
        ? { status: "Completed" }
        : {}),
    },
  });
}

/** The mode a one-tap "mark paid" should record: the record's own mode when
 * it is UPI/Card, otherwise Cash. */
export function settleMode(
  mode: string | null | undefined,
): ReceivedPaymentMode {
  return mode === "UPI" || mode === "Card" ? mode : "Cash";
}

/** One-tap "mark paid" for a bill: collects whatever it still owes as ONE
 * receipt (so it is recorded like any other payment, dated today) in `mode`
 * (default: the bill's own mode, else Cash). A bill with nothing left owing on
 * itself just has its status set. */
export async function settleBill(input: {
  bill: Bill;
  tabEntries?: TabEntry[];
  mode?: ReceivedPaymentMode;
}) {
  const { bill } = input;
  const due = billDue(bill, input.tabEntries ?? []);
  if (due <= 0) {
    await db.bills.update(bill.id, {
      status: "paid",
      amount_paid: billGrossTotal(bill),
    });
    return null;
  }
  return collectBillPayment({
    bill,
    ...(input.tabEntries ? { tabEntries: input.tabEntries } : {}),
    entries: [
      { amount: due, mode: input.mode ?? settleMode(bill.payment_mode) },
    ],
  });
}

/** One-tap "mark paid" for a turf booking (same idea as `settleBill`). */
export async function settleBooking(input: {
  booking: TurfBooking;
  tabEntries?: TabEntry[];
  mode?: ReceivedPaymentMode;
}) {
  const { booking } = input;
  const due = bookingDue(booking, input.tabEntries ?? []);
  if (due <= 0) {
    await db.turf_bookings.update(booking.id, { status: "Completed" });
    return null;
  }
  return collectBookingPayment({
    booking,
    ...(input.tabEntries ? { tabEntries: input.tabEntries } : {}),
    entries: [
      { amount: due, mode: input.mode ?? settleMode(booking.payment_mode) },
    ],
    markCompleted: true,
  });
}

export function useCollectBillPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: collectBillPayment,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useCollectBookingPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: collectBookingPayment,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useSettleBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settleBill,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useSettleBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settleBooking,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/** Records the rows for money taken at creation (see recordInitialPayments)
 * and refreshes the payment queries. */
export function useRecordInitialPayments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      parentType: "bill" | "turf_booking" | "snack_sale";
      parentId: string;
      entries: PaymentEntry[];
      receivedAt?: string;
    }) =>
      recordInitialPayments(v.parentType, v.parentId, v.entries, v.receivedAt),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payments"] }),
  });
}

/**
 * Corrects how an ALREADY-RUNG-UP snack sale was actually paid — e.g. it
 * was entered as Cash but was really half UPI. This is a correction of the
 * mode, not new money, so unlike every other hook here it does not touch
 * `snack_sales.total`; it replaces the sale's payment rows outright (see
 * `replacePaymentsForParent`) dated the sale's own day. The sale's own
 * `payment_mode` field is left to the caller's own field patch (the same
 * dropdown value the sale was CREATED with, kept as-is regardless of any
 * cash part carved out of it — the split lives in the rows, not this
 * field, exactly the convention sale creation already uses). */
export function useCorrectSnackSaleMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      saleDate: string;
      entries: PaymentEntry[];
    }) => replacePaymentsForParent("snack_sale", v.id, v.entries, v.saleDate),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payments"] }),
  });
}

/**
 * Applies a booking edit that ALSO raises the advance already on file — the
 * extra rupees are new money, so unlike a plain field patch they need their
 * own payment row (in the cash/online split the person just chose) rather
 * than a silent bump to `advance_paid`. Runs both through `recordPayment` in
 * one write: `parentPatch` carries every other field the edit is changing,
 * and `advance_paid` itself comes out of the payment rows' own total (this
 * new entry plus whatever was already recorded), the same source of truth
 * `bookingDue`/`effectivePaymentEntries` read everywhere else. */
export function useApplyBookingEditWithPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      parentId: string;
      entries: PaymentEntry[];
      parentPatch: Record<string, unknown>;
    }) =>
      recordPayment({
        parentType: "turf_booking",
        parentId: v.parentId,
        entries: v.entries,
        parentPatch: v.parentPatch,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}
