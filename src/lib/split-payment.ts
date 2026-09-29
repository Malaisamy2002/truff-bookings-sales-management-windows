import { money, rupees } from "./money";
import type { PaymentEntry, ReceivedPaymentMode } from "./payments";

/**
 * Pure rules for the split-payment control (components/app/
 * SplitPaymentFields.tsx): one collection made of a Cash part and an Online
 * part. Kept free of React and the database so the rules — "whole rupees",
 * "never more than is owed", "an empty part writes no row" — are unit-tested
 * on their own.
 */

/** The non-cash modes a collection can be received in. */
export type OnlineMode = Exclude<ReceivedPaymentMode, "Cash">;
export const ONLINE_MODES_FOR_SPLIT: readonly OnlineMode[] = ["UPI", "Card"];

/** What the two amount boxes hold while the person is typing (free text). */
export type SplitDraft = {
  cash: string;
  online: string;
  onlineMode: OnlineMode;
};

export type SplitPlan =
  | { ok: true; entries: PaymentEntry[]; total: number; remaining: number }
  | { ok: false; error: string; total: number; remaining: number };

/** The amounts typed so far, as whole rupees (blank / junk is 0). */
export function draftAmounts(draft: SplitDraft): {
  cash: number;
  online: number;
} {
  return {
    cash: Math.max(0, rupees(Number(draft.cash) || 0)),
    online: Math.max(0, rupees(Number(draft.online) || 0)),
  };
}

/**
 * Turns the draft into the entries to record, or says what is wrong. `due`
 * is what this record still owes ON ITS OWN (after anything moved to a tab):
 * the total may equal it (settles the record) or be less (a part payment),
 * never more.
 */
export function planSplit(due: number, draft: SplitDraft): SplitPlan {
  const owed = Math.max(0, rupees(due));
  const { cash, online } = draftAmounts(draft);
  const total = cash + online;
  const remaining = Math.max(0, owed - total);
  if (total <= 0) {
    return { ok: false, error: "Enter an amount", total, remaining };
  }
  if (total > owed) {
    return {
      ok: false,
      error: `${money(total - owed)} more than the ${money(owed)} owed`,
      total,
      remaining,
    };
  }
  const entries: PaymentEntry[] = [];
  if (cash > 0) entries.push({ amount: cash, mode: "Cash" });
  if (online > 0) entries.push({ amount: online, mode: draft.onlineMode });
  return { ok: true, entries, total, remaining };
}

/** A draft that puts the whole amount in one mode (the one-tap default). */
export function singleModeDraft(
  amount: number,
  mode: ReceivedPaymentMode,
  onlineMode: OnlineMode = "UPI",
): SplitDraft {
  const a = String(Math.max(0, rupees(amount)));
  return mode === "Cash"
    ? { cash: a, online: "", onlineMode }
    : { cash: "", online: a, onlineMode: mode };
}

/** What is left of `due` once `typed` (the other box) is taken out — used to
 * auto-fill the second box so the two always add up to what is owed. */
export function restOf(due: number, typed: string): string {
  const left = Math.max(
    0,
    rupees(due) - Math.max(0, rupees(Number(typed) || 0)),
  );
  return left > 0 ? String(left) : "";
}

/**
 * Splits one combined cash + online collection across several dues at once
 * — e.g. "Settle all ₹700" as "₹500 Cash + ₹200 UPI" across a customer's two
 * open bookings and a bill. Each due still needs to know which of ITS OWN
 * money came in cash vs online (so the cash drawer and the Cash/Online split
 * stay accurate down to the record), but the person only chooses one overall
 * split, not one per due.
 *
 * `cash` is drained across `dues` in order: the first due takes as much cash
 * as it needs (up to its own amount), the next due starts from whatever cash
 * is left, and so on — the rest of every due is `onlineMode`. Where exactly
 * the cash "runs out" is therefore arbitrary (it depends only on `dues`'
 * order), but the totals always add up: summing every returned entry's
 * amount reproduces `dues` exactly, and summing every Cash entry reproduces
 * `cash` (assuming, as the caller should via `planSplit`, that `cash` plus
 * the online amount together equal the sum of `dues`).
 *
 * A due of 0 (or less) contributes no entries at all.
 */
export function allocateAcrossDues(
  dues: number[],
  cash: number,
  onlineMode: OnlineMode,
): PaymentEntry[][] {
  let cashLeft = Math.max(0, rupees(cash));
  return dues.map((raw) => {
    const due = Math.max(0, rupees(raw));
    if (due <= 0) return [];
    const cashPart = Math.min(cashLeft, due);
    cashLeft -= cashPart;
    const onlinePart = due - cashPart;
    const entries: PaymentEntry[] = [];
    if (cashPart > 0) entries.push({ amount: cashPart, mode: "Cash" });
    if (onlinePart > 0) entries.push({ amount: onlinePart, mode: onlineMode });
    return entries;
  });
}

/**
 * The payment entries for an advance taken at booking time. `mode` is the
 * booking form's payment mode; `cashPart` (optional) is how much of the
 * advance was handed over in cash when the rest came in online. "Pending" (or
 * nothing paid) writes no rows.
 */
export function advanceEntries(
  advance: number,
  mode: string,
  cashPart?: string,
): PaymentEntry[] {
  const total = Math.max(0, rupees(advance));
  if (total <= 0 || mode === "Pending") return [];
  if (mode !== "UPI" && mode !== "Card") {
    return [{ amount: total, mode: "Cash" }];
  }
  const cash = Math.min(total, Math.max(0, rupees(Number(cashPart) || 0)));
  const entries: PaymentEntry[] = [];
  if (cash > 0) entries.push({ amount: cash, mode: "Cash" });
  if (total - cash > 0) entries.push({ amount: total - cash, mode });
  return entries;
}
