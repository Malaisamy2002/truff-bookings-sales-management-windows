/**
 * The ONE rounding + formatting rule for every rupee in the app.
 *
 * Policy (agreed before the live trial):
 * - Every payable / displayed amount is a WHOLE rupee. No paise anywhere.
 * - Rounding happens once, at the point an amount becomes payable
 *   (line total, discount, each tax line, grand total) — never twice on the
 *   same money, so a bill's parts always add up to its total on screen.
 * - Discounts are applied BEFORE tax: taxable = subtotal - discount.
 *
 * Anything that formats or totals money must use these helpers instead of
 * `toFixed`, `Math.round(x*100)/100`, or its own `toLocaleString` call.
 */

/** Whole-rupee value, rounded half away from zero (so -0.5 -> -1, 0.5 -> 1). */
export function rupees(n: unknown): number {
  const v = Number(n) || 0;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/**
 * For free-text money fields (`type="text" inputMode="decimal"`): keeps only
 * digits and a single decimal point. Used instead of `type="number"`, whose
 * spinner, arrow keys and mouse wheel can silently change an amount that is
 * merely focused.
 */
export function cleanAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "");
}

/** Display string: whole rupees, Indian digit grouping. */
export function money(n: unknown): string {
  const v = rupees(n);
  return (v < 0 ? "-₹" : "₹") + Math.abs(v).toLocaleString("en-IN");
}

/**
 * Short chart-axis tick in Indian units: 1500 → "₹1.5k", 360000 → "₹3.6L",
 * 25000000 → "₹2.5Cr". Raw "360000" ticks read as a different number system
 * than every ₹ figure on the page (and wide ticks clip on a phone).
 */
export function moneyAxis(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const f = (x: number) => String(Math.round(x * 10) / 10);
  if (a >= 1e7) return `${sign}₹${f(a / 1e7)}Cr`;
  if (a >= 1e5) return `${sign}₹${f(a / 1e5)}L`;
  if (a >= 1e3) return `${sign}₹${f(a / 1e3)}k`;
  return `${sign}₹${f(a)}`;
}

/**
 * Split a whole-rupee amount into two halves that add back to it exactly
 * (half of ₹101 is never ₹50.5 on a bill). NOT used for CGST / SGST:
 * taxBreakdown() rounds each GST half independently so the two are always equal.
 */
export function splitHalf(total: number): [number, number] {
  const t = rupees(total);
  const first = rupees(t / 2);
  return [first, t - first];
}

/**
 * How much of an expense's amount actually left the drawer as CASH — the
 * whole amount for a plain Cash expense, `cash_part` (clamped to the
 * total) for a UPI/Card expense with an optional cash part carved out of
 * it. The rest (`amount - expenseCashPart(e)`) went out online.
 *
 * An expense with no `payment_mode` at all (every one recorded before this
 * field existed) is read as Cash — the same assumption the cash-drawer
 * reconciliation already made for every expense before this, so old rows
 * keep counting exactly as they always did.
 */
export function expenseCashPart(e: {
  amount: number;
  payment_mode?: string | null;
  cash_part?: number | null;
}): number {
  const amount = Math.max(0, rupees(e.amount));
  if (e.payment_mode !== "UPI" && e.payment_mode !== "Card") return amount;
  return Math.min(amount, Math.max(0, rupees(e.cash_part ?? 0)));
}

/** Sum a list of amounts as whole rupees (each already rounded once). */
export const sumRupees = (values: number[]) =>
  values.reduce((s, v) => s + rupees(v), 0);

/**
 * Round several real-valued shares of one total into whole rupees that add
 * back to that total exactly — the many-bucket generalisation of
 * `splitHalf()`. Rounding N independent fractional buckets with plain
 * `rupees()` can drift a rupee or two from the true total purely from
 * rounding noise (e.g. a booking's revenue sliced across the hours of the
 * day it spans): each bucket looks right on its own, but 24 independent
 * roundings don't have to sum to the same whole rupee as rounding the
 * total once. The "largest remainder" method fixes that: floor every
 * share, then hand out the leftover rupees one at a time to the buckets
 * with the biggest fractional part, largest first — so every bucket stays
 * within one rupee of its raw share AND the buckets sum to exactly
 * `rupees(total)`.
 *
 * `total` is normally the sum of `shares` itself (pass it through
 * `rupees()` first, or omit it to have this derive it) — pass a different
 * total only when the shares deliberately don't cover the whole amount
 * (e.g. some records couldn't be bucketed at all), in which case the
 * buckets legitimately sum to less than the grand total, and that gap is
 * real, not rounding noise.
 */
export function allocateWhole(
  shares: number[],
  total: number = shares.reduce((s, v) => s + v, 0),
): number[] {
  if (shares.length === 0) return [];
  const floors = shares.map((s) => Math.floor(s));
  const base = floors.reduce((s, v) => s + v, 0);
  const remainder = rupees(total) - base;
  const order = shares
    .map((s, i) => ({ i, frac: s - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  if (remainder > 0) {
    for (let k = 0; k < remainder; k++) {
      const idx = order[k % order.length]!.i;
      out[idx] = (out[idx] ?? 0) + 1;
    }
  } else if (remainder < 0) {
    for (let k = 0; k < -remainder; k++) {
      const idx = order[order.length - 1 - (k % order.length)]!.i;
      out[idx] = (out[idx] ?? 0) - 1;
    }
  }
  return out;
}
