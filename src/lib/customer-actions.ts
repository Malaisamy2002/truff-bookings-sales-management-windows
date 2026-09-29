import { toast } from "sonner";
import type { Bill } from "./biz";
import { useCollectBillPayment, useCollectBookingPayment } from "./collect";
import type { TurfBooking } from "./ops";
import { billDue, bookingDue } from "./dues";
import { INVOICE_SECTIONS } from "./desktop";
import { money } from "./money";
import { describePaymentSplit, type PaymentEntry } from "./payments";
import { paymentReceipt, printReceipt } from "./receipt";
import { allocateAcrossDues, ONLINE_MODES_FOR_SPLIT } from "./split-payment";
import {
  tabKey,
  useSettleAndCloseTab,
  useTabSummaries,
  type TabEntry,
} from "./tabs";

/**
 * Settle-all for one customer — collects every open booking and bill (plus
 * the running tab) for what it still owes, in ONE combined cash/online split
 * the person chooses once (see `entries`, built by `CollectPaymentDialog`
 * with `requireFull`). Pulled out here so a second caller (`OutstandingTab`'s
 * row-level context menu) can trigger the same action without re-deriving or
 * duplicating the math. `CustomerDetailContent` itself calls this too, so
 * there is exactly one place this logic lives.
 *
 * Callers must pass bookings/bills already filtered to this one customer
 * (e.g. via `matchesCustomer`) — this hook does no identity matching of its
 * own, same division of responsibility `collectLine` already had.
 */
export function useSettleCustomer() {
  const collectBookingMut = useCollectBookingPayment();
  const collectBillMut = useCollectBillPayment();
  const settleTab = useSettleAndCloseTab();
  const tabSummaries = useTabSummaries();

  const settleAll = async (params: {
    name: string;
    phone: string | null;
    myBookings: TurfBooking[];
    myBills: Bill[];
    myEntries: TabEntry[];
    tabBalance: number;
    /** How the WHOLE balance was received — one or two entries (Cash and/or
     * an online mode), summing to exactly the total due (enforced by the
     * caller's `CollectPaymentDialog` via `requireFull`). Defaults to a
     * plain Cash receipt for callers that haven't been updated to ask. */
    entries?: PaymentEntry[];
  }) => {
    const {
      name,
      phone,
      myBookings,
      myBills,
      myEntries,
      tabBalance,
      entries = [],
    } = params;

    const bookingDues = myBookings.map((b) =>
      Math.max(0, bookingDue(b, myEntries)),
    );
    const billDues = myBills.map((b) => Math.max(0, billDue(b, myEntries)));
    const tabDue = Math.max(0, tabBalance);
    const total =
      bookingDues.reduce((s, d) => s + d, 0) +
      billDues.reduce((s, d) => s + d, 0) +
      tabDue;

    // The chosen cash amount is drained across every due in a fixed order —
    // bookings, then bills, then the tab — so each one gets told exactly
    // which part of ITS OWN money was cash vs online (see
    // `allocateAcrossDues`'s doc comment for why the split point itself is
    // arbitrary but the totals always add up). A caller with no entries
    // (not yet updated to ask) keeps the old all-Cash behaviour.
    const cashEntry = entries.find((e) => e.mode === "Cash");
    const onlineEntry = entries.find(
      (e): e is PaymentEntry & { mode: "UPI" | "Card" } =>
        e.mode === "UPI" || e.mode === "Card",
    );
    const cash = entries.length > 0 ? (cashEntry?.amount ?? 0) : total;
    const onlineMode: (typeof ONLINE_MODES_FOR_SPLIT)[number] =
      onlineEntry?.mode ?? "UPI";
    const allocations = allocateAcrossDues(
      [...bookingDues, ...billDues, tabDue],
      cash,
      onlineMode,
    );
    const bookingAllocations = allocations.slice(0, bookingDues.length);
    const billAllocations = allocations.slice(
      bookingDues.length,
      bookingDues.length + billDues.length,
    );
    const tabAllocation =
      allocations[bookingDues.length + billDues.length] ?? [];

    // Each open booking/bill is collected as a real receipt for what it
    // still owes (dated today), not just flipped to "paid", so the cash
    // drawer and the Cash/Online split count this money on the day it came
    // in, split exactly the way it was received.
    //
    // Every step below is independent (its own mutateAsync/mutate call), so
    // one failing partway through must not make the rest of this function
    // claim the FULL balance was settled — that would print a "Full
    // balance ₹X, balance after ₹0" receipt while the customer still
    // genuinely owes money on whichever item failed. `settledTotal` tracks
    // only what actually committed; the closing toast/receipt below report
    // that, not the original `total`.
    let settledTotal = 0;
    let anyFailed = false;
    for (let i = 0; i < myBookings.length; i++) {
      const b = myBookings[i]!;
      const due = bookingDues[i]!;
      const parts = bookingAllocations[i] ?? [];
      if (due <= 0 || parts.length === 0) continue;
      try {
        await collectBookingMut.mutateAsync({
          booking: b,
          tabEntries: myEntries,
          entries: parts,
          markCompleted: true,
        });
        settledTotal += due;
        toast.success("Booking marked paid");
      } catch (e) {
        anyFailed = true;
        toast.error(
          e instanceof Error ? e.message : "Could not settle booking",
        );
      }
    }

    for (let i = 0; i < myBills.length; i++) {
      const bill = myBills[i]!;
      const due = billDues[i]!;
      const parts = billAllocations[i] ?? [];
      if (due <= 0 || parts.length === 0) continue;
      try {
        await collectBillMut.mutateAsync({
          bill,
          tabEntries: myEntries,
          entries: parts,
        });
        settledTotal += due;
        toast.success("Bill marked paid");
      } catch (e) {
        anyFailed = true;
        toast.error(e instanceof Error ? e.message : "Could not settle bill");
      }
    }

    const tab = tabSummaries.get(tabKey(name, phone))?.tab;
    if (tab && tabDue > 0 && tabAllocation.length > 0) {
      try {
        await settleTab.mutateAsync({ tabId: tab.id, payments: tabAllocation });
        settledTotal += tabDue;
      } catch (e) {
        anyFailed = true;
        toast.error(e instanceof Error ? e.message : "Could not settle tab");
      }
    }

    // The receipt shows the same split just recorded, not a hardcoded mode
    // — "Cash ₹500 + UPI ₹200" when it was mixed, otherwise the one mode
    // actually used.
    const modeLabel =
      describePaymentSplit(
        entries.length > 0 ? entries : [{ amount: total, mode: "Cash" }],
      ) ??
      entries[0]?.mode ??
      "Cash";

    if (anyFailed) {
      // Partial success: say exactly what landed, and only offer a receipt
      // for that (real, committed) amount — never for the original `total`,
      // which would overstate what the customer actually paid off.
      toast.warning(
        settledTotal > 0
          ? `Settled ${money(settledTotal)} of ${money(total)} — see the errors above for what's still outstanding`
          : "Nothing was settled — see the errors above",
        {
          action:
            settledTotal > 0
              ? {
                  label: "Print receipt",
                  onClick: () =>
                    printReceipt(
                      paymentReceipt({
                        customer: name,
                        phone,
                        against: "Partial balance",
                        amount: settledTotal,
                        mode: modeLabel,
                        balanceAfter: Math.max(0, total - settledTotal),
                      }),
                      undefined,
                      INVOICE_SECTIONS.dues,
                    ),
                }
              : undefined,
        },
      );
      return;
    }

    toast.success("Settling full balance…", {
      action:
        total > 0
          ? {
              label: "Print receipt",
              onClick: () =>
                printReceipt(
                  paymentReceipt({
                    customer: name,
                    phone,
                    against: "Full balance",
                    amount: total,
                    mode: modeLabel,
                    balanceAfter: 0,
                  }),
                  undefined,
                  INVOICE_SECTIONS.dues,
                ),
            }
          : undefined,
    });
  };

  return {
    settleAll,
    isPending:
      collectBookingMut.isPending ||
      collectBillMut.isPending ||
      settleTab.isPending,
  };
}
