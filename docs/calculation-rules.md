# Money & Date Math — Spec / Prompt for Dashboard & Reports

Use this as the prompt/checklist whenever you (or an AI assistant) add or
touch anything that computes revenue, dues, profit, or per-customer totals
in this app. The goal is zero double-counting and zero drift between the
Dashboard, the Reports tab, and any Excel/PDF export. Every number below
must trace back to one of the two shared functions — `periodStats` /
`statsForMonth` (src/lib/analytics.ts) or `customerLifetimeStats`
(src/lib/data.ts) — never re-derived by hand in a component.

---

## 0. THE rounding rule — whole rupees, rounded once

Every payable or displayed amount in this app is a **whole rupee**. There
are no paise anywhere: not on a bill, not on a receipt, not in an Excel
export, not on a dashboard card.

All of it goes through `src/lib/money.ts` — the single rule:

```ts
rupees(n)        // whole rupee, half away from zero (0.5 -> 1, -0.5 -> -1)
money(n)         // "₹1,23,456" — whole rupees, Indian grouping
splitHalf(total) // two halves that add back to `total` exactly (NOT used for CGST/SGST — see rule 4)
sumRupees(list)  // Σ rupees(x) — each amount rounded once, then summed
```

Rules:

1. **Round once, at the point money becomes payable** — line total,
   discount, each tax line, the grand total. Never round the same rupee
   twice, and never round a subtotal and then round its parts again.
2. **Never write your own formatter.** No `toFixed(2)`,
   no `Math.round(x * 100) / 100`, no bare `toLocaleString("en-IN")` for
   money. Use `money()`; PDFs use their local `pmoney()`, which is
   `rupees()` plus a "Rs " prefix because helvetica has no ₹ glyph.
3. **Sum rounded parts, don't round the sum.** `taxBreakdown()` returns
   `taxAmount` as the sum of its own printed lines, so a receipt's
   CGST + SGST + custom taxes always equal its Grand Total on paper.
4. **CGST and SGST must be equal.** `taxBreakdown()` rounds each half
   independently (`rupees(taxable × rate / 200)`), so an intra-state sale
   never prints an uneven CGST/SGST pair (GST portals reject a mismatch).
   The combined GST can therefore differ by ₹1 from `rupees(taxable × rate)`
   (9% of ₹450 is 40.5, so CGST 41 + SGST 41 = 82, not 81). `splitHalf()`
   is for splitting a single already-rounded amount elsewhere, not for GST.
5. **Tab ledger entries are whole rupees too** (`buildTabEntry`,
   `tabBalanceOf`), so a running balance can never drift into paise.
6. **Excel money columns use `#,##0`** (no decimals) — an export must show
   the same figure as the screen it came from.

Where this is enforced: `money.ts` (rule), `biz.ts` (`rowTotal`,
`billGrossTotal`, `balanceOf`), `settings.ts` (`taxBreakdown`),
`dues.ts`, `tabs.ts`, `merge.ts`, `analytics.ts`, `receipt.ts`,
`report-pdf.ts`, `dashboard-xlsx.ts`, `xlsx.ts`.

---

## 0b. Discount before tax

Discounts are **always** applied before tax:

```
taxable = subtotal - discount        // this is what `bill.total` stores
tax     = Σ round(taxable × rate)    // one rounded line per active tax
gross   = taxable + tax              // what the customer pays
```

`bill.total` is therefore already post-discount everywhere it is written
(`TurfTab`: `gross - discount`; `MergeBillDialog`: `grossTotal - mergedDiscount`),
and every tax call site passes that stored total — never the subtotal.
Nothing may tax a pre-discount amount, and nothing may subtract a discount
after tax has been added.

---

## 1. The three business lines + expenses

| Line | Source table | Date field | Notes |
|---|---|---|---|
| Bills | `bills` | `bill_date` (full ISO timestamp) | Taxed live via `taxBreakdown`; bookings and snack sales carry their own tax snapshot (§4) |
| Turf bookings | `bookings` | `booking_date` (plain `YYYY-MM-DD`) | Excludes `Cancelled` and `No-show`; excludes merged (see §2) |
| Snack sales | `sales` | `sale_date` (plain `YYYY-MM-DD`) | |
| Expenses | `expenses` | `spent_at` | Never revenue — subtract only |

**Date parsing bug to avoid:** `bill_date` is a full UTC timestamp; the
other two are plain local dates. Slicing the first 7 chars of a UTC
timestamp to get a month key silently mis-buckets bills made in the last
~5.5 hours of the UTC day (IST). Always route dates through `monthKey()` /
`dayKey()` in analytics.ts — never re-slice or re-parse a date string
inline in a component or export.

**Call sites already audited and fixed against this rule:** Excel export
filenames, layout-preset export filenames, the print-test receipt date, and
recurring-expense auto-posting. Recurring expenses in particular now store
`spent_at` as a plain `YYYY-MM-DD` (matching every other expense row,
instead of a UTC `toISOString()` that plain-date-equality filters never
matched), post on the IST calendar day rather than the runtime's local day,
and clamp a rule for "the 31st" to the last day of a shorter month instead
of rolling into the next month. See `planRecurringPosts()` in
`src/lib/expenses.ts` and its tests in `expenses.test.ts`.

---

## 2. THE double-counting rule: merged bookings

A turf booking can be merged into a Bill (`merged_into_bill_id` set). Once
merged, **its revenue lives on the Bill, not on the booking.** Any
calculation that sums both `bills` and `bookings` for the same period
MUST exclude merged bookings from the booking side, or that money is
counted twice.

**This is centralized. Use it, don't re-derive it.** `src/lib/dues.ts`
defines it (re-exported from `src/lib/analytics.ts`):

```ts
export const isFinancialBooking = (b) =>
  b.status !== "Cancelled" && b.status !== "No-show" && !b.merged_into_bill_id;
```

This is the one place in the whole app that decides whether a booking is
still its own financial record. Every money-summing call site — Dashboard,
Reports, exports, the Turf tab, the Snacks tab, MergeBillDialog's picker,
per-customer rollups — filters through `isFinancialBooking(b)` instead of
re-writing the three-clause check inline. Before this was centralized, the
same condition was independently copy-pasted in 15+ places across the
codebase; that's how a bug like "this one screen forgot the merge check"
sneaks in silently. If you add a new money calculation, import
`isFinancialBooking` from `@/lib/analytics` — don't write
`status !== "Cancelled" && status !== "No-show" && !merged_into_bill_id` again by hand.

```ts
// Correct
const bookings = src.bookings.filter(
  (b) => matches(b.booking_date) && isFinancialBooking(b),
);
```

**Exception — counts that are about the booking as an event, not as
money** (e.g. "how many bookings did this customer make", "what's their
average booking value") legitimately include merged bookings, because the
booking still happened even though its cash is now tracked on a Bill.
Only *money* fields need the merge exclusion — see `bookingsCount` /
`avgBookingValue` in `customerLifetimeStats`, which deliberately do NOT
filter through `isFinancialBooking`.

Before adding any new sum that touches both `bills` and `bookings`, ask:
**"If I add these two totals together, could the same rupee show up in
both?"** If yes, filter merged bookings out via `isFinancialBooking`.

There are two narrow, intentional exceptions where `isFinancialBooking`
is NOT used even though the code touches `merged_into_bill_id`:
- `TurfUtilizationCard.tsx` — tracks court-hours occupied, not money; a
  merged booking still occupied the slot.
- The raw "Turf bookings" export sheets (Reports and Turf tab) — these
  intentionally list every booking, including merged and cancelled ones,
  for audit purposes, and zero the money columns per-row instead of
  dropping the row, so a reader can still see the full history.

---

## 2b. THE second double-counting rule: a balance moved to dues

"Put balance on tab" (Turf tab) and billing a snack sale "On tab" hand a
record's remaining balance to the customer's running tab. The booking write
sets `advance_paid` to the **full gross total** while posting the remainder
as a tab charge. So `advance_paid` is a settlement marker, not a cash figure:
reading it as money counts the balance once on the booking and again as a tab
payment when the customer settles on the Dues tab.

**Never read `advance_paid` as collected money.** Use
`bookingCashCollected(b, tabEntries)` from `src/lib/dues.ts`:

```ts
bookingCashCollected(b, entries) =
  max(0, rupees(b.advance_paid) - netTabAmountFor(entries, "turf_booking", b.id));
```

Call sites that must route through it: `periodStats().collected` and
`paymentSplit()` (analytics.ts), the Turf tab row, the Reports turf-dues
list and its Excel "Advance paid" column, and the customer popup.

**The one exception:** Reports' "Mark paid" writes `advance_paid = paid + due`
back to the booking, so it uses the STORED figure. Using cash-taken there
would erase the balance already parked on the tab.

Related helpers (same file): `bookingMovedToDues` / `saleMovedToDues` drive
the faded row and the "Moved to dues · D-…" tag; `isTabCashPayment` keeps
merge/un-merge reversals (payment rows that carry a `ref_type`) out of
collected cash.

Cover: `dues.test.ts`, `analytics.test.ts` ("no double counting when a
balance moves to dues"), `scripts/verify-math.ts` §12, and
`docs/formula-report.md` §9.

---

## 2c. Payments: how a rupee arrived (cash vs online)

Every receipt of money is one row in the `payments` table:
`(parent_type, parent_id, amount, mode, received_at)`, where `mode` is Cash,
UPI or Card and `received_at` is the day the money **actually arrived** (a due
collected today on last week's booking is received today).

- **`amount_paid` / `advance_paid` and `status` stay the source of truth for
  what is owed.** Dues, receipts and profit are computed exactly as before; the
  rows only say *how* the collected amount arrived. Every collection goes
  through `lib/collect.ts` → `recordPayment()`, which writes the rows **and**
  the record's new paid amount/status/mode in one database transaction.
- **Old data needs no migration.** A record with no rows is read as one payment
  of its collected amount, in its own `payment_mode`, on its own date — so past
  reports are unchanged. The first new payment on such a record saves that
  implied payment first.
- **Rows that don't add up are reconciled when read** (`effectivePaymentEntries`):
  a shortfall is counted on the record's own date in its own mode (the
  pre-payments behaviour); an excess is taken back from the newest rows. So a
  path that changes a paid amount without writing a row can never make the
  Cash/Online split or the cash drawer drift from the record's own figure.
- **The cash drawer and the payment split use `received_at`**, not the record's
  date. Cash in the drawer = cash rows received today − cash expenses today.
- **Expenses have their own (much simpler) cash/online split**: `payment_mode`
  (Cash/UPI/Card) plus an optional `cash_part` for a UPI/Card expense that was
  partly paid in cash — `expenseCashPart()` (`lib/money.ts`) reads it. There
  are no payment rows for expenses (they're money going out, not a
  `payments`-table parent); an expense from before this field existed has no
  `payment_mode` at all, which reads as Cash — the same assumption the
  drawer always made.
- **Money on a customer tab never gets a payment row.** A record's own due
  (`billDue` / `bookingDue`) excludes anything moved to the tab, and only that
  is collected here; tab payments keep their own `payment_mode` in `tab_entries`
  (a split tab settlement is written as one tab entry per mode).
- **Merging** copies the sources' rows onto the merged bill (same modes and
  received dates) while the sources stay excluded from reports, so nothing is
  counted twice; un-merging back to the sources leaves their own rows intact.
- **Deleting or voiding a bill, marking it unpaid, and deleting a booking or
  snack sale remove that record's rows.** A plain un-merge keeps the bill and
  the cash it really collected, so its rows stay.
- The record's own `payment_mode` field holds the mode that carried the most
  money in the latest collection (receipts and exports print the exact split,
  e.g. "Cash ₹700 + UPI ₹300", via `receiptModeLabel`).
- **Rows written in the same batch never tie on `created_at`.** A split's
  Cash and UPI rows (or any multi-row write — `recordInitialPayments`,
  `recordPayment`'s own entries, `replacePaymentsForParent`) get strictly
  increasing timestamps (`sequentialTimestamps`, `lib/localdb.ts`), 1ms
  apart, instead of one `nowIso()` shared across a synchronous loop — which
  routinely landed every row in a split on the exact same millisecond and
  left their relative order an accident of iteration rather than a real
  guarantee. `received_at` (the day that matters for reports) is untouched.
- **Editing writes a row too, not just a field patch.** Raising a booking's
  advance during an edit is new money, so it asks for its own cash/online
  split and records it via `recordPayment` (see
  `useApplyBookingEditWithPayment`) — the same as any other collection —
  instead of silently bumping `advance_paid` and leaving the extra rupees to
  the read-time reconciliation above (a decrease still relies on that
  reconciliation; cancellation refunds ARE modelled since the 2026-09 K4
  fix — see the cancellation bullet below — but an edit-time decrease is
  not a refund and keeps the read-time reconciliation). Correcting a
  snack sale's mode after the fact (it was rung up Cash but was really part
  UPI) replaces its real rows outright (`replacePaymentsForParent`) rather
  than only updating the display field, which used to leave the rows — and
  therefore every report reading them — silently disagreeing with the
  corrected mode.
- **Merged bills, "Settle all", and a customer's individual dues all support
  a cash/online split** the same way a plain bill or booking does — a
  merged bill is just a bill as far as `recordPayment` is concerned, and
  "Settle all" (`useSettleCustomer`) asks for ONE combined split across
  everything owed and allocates it across the individual bookings/bills/tab
  via `allocateAcrossDues` (drains the cash amount across the dues in a
  fixed order; where exactly it runs out is arbitrary, but every due's
  entries and every Cash entry still add up exactly).
- **A cancelled booking's advance either keeps its split or drops out of
  the split entirely, depending on the `is_refundable` toggle (see §3).**
  If the advance was originally collected as a Cash+UPI split (real rows in
  `payments`, same as any booking), and the booking is later cancelled and
  marked non-refundable (forfeited), `paymentSplit`/`periodStats` still
  read those same real rows via `effectivePaymentEntries` — the split by
  mode is preserved exactly as it was collected, it's just now attributed
  through `forfeitedBookingSources` instead of the plain booking-sources
  list `isFinancialBooking` would otherwise route it through. But if the
  same booking is marked **refundable** instead, the operator committed to
  paying the money back. The advance is still **received money** — since the
  2026-09 K4 fix it is included in `paymentSplit` and in `collected` on the
  day it arrived (`received_at` basis, via `refundableBookingSources`, same
  construction as `forfeitedBookingSources`), because it is physically
  sitting in the drawer. It remains a **liability**, not income: it stays
  out of `revenue`/`netRevenue`/`dues` and out of profit, and it is surfaced
  as the read-only `PeriodStats.refundableAdvance` KPI (§3), dated by
  `booking_date`, not by mode. When the refund is actually paid back to the
  customer (`refunded_at`/`refund_mode`, written by
  `useRefundBookingAdvance`), the liability drops to zero and the refund
  becomes a **drawer outflow on the refund day** (Cash refunds reduce the
  cash drawer via `cashRefundOutflowOn` feeding `expectedInDrawer`). A
  refund is never a P&L expense — the advance was never income.

## 3. Cancelled bookings

`status === "Cancelled"` bookings are excluded from `isFinancialBooking`
and therefore from `turfRevenue`, `bookingDue`, and the plain
`bookingCashCollected` sums — the booking's own contracted total is never
counted, and there is no due left to chase on a slot that isn't
happening. They are **not** excluded from `customerLifetimeStats` today —
check whether that's intentional before extending it; a cancelled booking
with no payment contributes 0 either way, but if you add a "no-show rate"
or similar metric, filter cancellations explicitly rather than assuming
downstream functions already did.

**The one exception: a forfeited or refundable advance.** If the customer
already paid an advance (`advance_paid > 0`) before the booking was
cancelled, that money doesn't just vanish from the books — the operator
decides, at the moment of cancellation, whether it's kept or paid back.
That choice is stored on the booking as `is_refundable` (`lib/ops.ts`'s
`TurfBooking` type) and read by two deliberately SEPARATE functions in
`lib/dues.ts`, never a single function with a branch:

- **`bookingForfeitedRevenue(b)`** — non-refundable path. Returns the advance when the booking is `Cancelled`
  (or `No-show`, F-9: a paid no-show keeps its advance exactly like a
  forfeited cancellation) and `is_refundable !== true`
  (this is the DEFAULT — an unset/legacy `is_refundable` is treated as
  non-refundable, which is how every cancelled booking's advance was
  always treated before this toggle existed). That rupee is real,
  already-collected income the plain `isFinancialBooking` exclusion above
  would otherwise silently drop, so it's added back in as its own line —
  `PeriodStats.forfeitedRevenue` — folded into `revenue`/`netRevenue`/
  `collected` in `periodStats`, and into the cash/online split in
  `paymentSplit` (see `forfeitedBookingSources` in `analytics.ts`) — if the
  advance was originally paid as a Cash+UPI split, that same split is
  preserved exactly (see §2c's cancellation bullet), not collapsed into one
  mode. It is
  dated by **when the money was actually received** (via
  `effectivePaymentEntries`), not by `booking_date` — a delivered booking's
  earning event is the day of the slot; a forfeited advance's earning
  event is the moment it stopped being refundable, which in practice is
  whenever it was collected.

- **`bookingRefundableAdvance(b)`** — refundable path, the mirror image.
  Returns `advance_paid` when `status === "Cancelled"` and
  `is_refundable === true` **and the refund has not been paid yet**
  (`refunded_at` unset). This is money the business still owes back — a
  **liability**, not revenue — so it stays out of `revenue`/`netRevenue`/
  `dues`. Since the 2026-09 K4 fix it IS counted in `collected` and in
  `paymentSplit` on its `received_at` date (the cash physically arrived);
  the liability itself is surfaced as `PeriodStats.refundableAdvance`
  (computed by `refundableAdvanceTotal`, kept as a separate code path from
  `forfeitedBookingSources` on purpose). Once the refund is paid
  (`useRefundBookingAdvance` sets `refunded_at`/`refund_mode`), the
  liability returns 0 and the refund shows up as a drawer outflow on the
  refund day (`bookingRefundOutflow`/`bookingRefundCashOut`/
  `cashRefundOutflowOn`), never in profit. Dated by `booking_date`, unlike
  the forfeited path, since the obligation exists from cancellation.

A given cancelled booking's advance is either forfeited revenue XOR a
refundable liability — never both, never split between the two. A
cancelled booking with `advance_paid === 0` returns `0` from both
functions: a cancellation with nothing paid is a pure void either way.

**Where the toggle is set.** The refundable/non-refundable choice is asked
once, at cancellation time, via a confirm dialog (only shown when
`advance_paid > 0` — there's nothing to ask about otherwise):
windows-app's Turf tab asks it from the booking's "Mark Cancelled" context
menu item; android-app's Turf tab has a dedicated "Cancel booking" action
(it previously had no way to cancel a booking from that screen at all).
Both write `is_refundable` on the same `update.mutate({ id, status:
"Cancelled", is_refundable })` call — there's no separate endpoint or
migration step; existing cancelled bookings simply have `is_refundable`
unset and keep behaving as forfeited (non-refundable), same as before.

---

## 4. Tax — bills, and wherever else GST is switched on

Only Bills go through `taxBreakdown(net, appSettings)` directly. Turf
bookings and snack sales carry their **own frozen tax snapshot**
(`tax_amount`/`tax_lines`, set by `freezeTax()` in `ops.ts` at creation —
see `biz.ts`'s `TaxSnapshot`) wherever GST is switched on: receipts, the
Turf tab, the Dues tab (`bookingDue()`/`bookingGrossTotal()`) and merges
all already treat that tax as real, collected money.

```
net    = bill.total                          // pre-tax, as stored
gross  = net + taxAmount
paid   = status === "paid" ? gross : amount_paid
dues  += max(0, gross - paid)
```

- `revenue` (headline, gross) = `netRevenue + tax`
- `tax` = `billsTax + bookingsTax + snacksTax` — each of the three is the
  sum of that line's own frozen/recomputed tax, never assumed to be zero
  for bookings/snacks.
- `netRevenue` (no tax) = `billsRevenue + turfRevenue + snacksRevenue`
- **Profit is always based on `netRevenue`, never `revenue`.** Tax is
  money passed through to the government, not earnings — including it in
  profit would overstate the business's actual take whenever tax is
  turned on.

**Regression this section exists to prevent (fixed — see `analytics.test.ts`
and `scripts/verify-math.ts` §11):** `periodStats()`'s bookings/sales loops
used to assume turf/snacks never carry tax and left `bookingsRevenue`'s
would-be tax out of `tax`/`revenue` entirely, even though the same
booking's receipt, Turf tab balance and Dues tab figure were already
tax-inclusive. That meant `collected` (tax-inclusive) could exceed
`revenue` (tax excluded) by exactly the invisible GST, and `taxReport()` —
the GST filing figures — only ever taxed `billsRevenue`, understating tax
actually collected. Fixed by summing each booking's/sale's own
`bookingGrossTotal(b) - rupees(b.total_amount)` /
`snackSaleGrossTotal(s) - rupees(s.total)` into `tax`, and by having
`taxReport()` use `netRevenue`/`s.tax` (all three lines) for
`taxableValue`/`totalTax` instead of `billsRevenue` alone.

**Fixed (this note used to say otherwise):** `taxReport()`'s per-rate
`lines` breakdown (the CGST/SGST/custom-tax rows on the GST report) now
sums each bill's/booking's/sale's own tax lines by label — a bill's live
`taxBreakdown(bill.total).lines`, or a booking's/sale's frozen
`tax_lines` (falling back to `[]`, never a live recompute, for a record
that has a frozen `tax_amount` but no line detail — the same
"can't reconstruct a rate breakdown from a total alone" rule
`taxLinesWithFallback()` in `biz.ts` already applies). `lines` therefore
already covers all three revenue lines, in step with `totalTax`/
`grossValue`: `sum(lines) === totalTax` for any period, verified over a
full random year by `scripts/verify-sections.ts`.

Never apply `taxBreakdown` directly to turf or snack totals — always go
through their own frozen-tax helpers (`bookingGrossTotal`,
`snackSaleGrossTotal`, or `bookingDue`/`dues.ts` for what's still owed).

---

## 5. Definitions, formula-exact

All of the below come from `periodStats(src, matches, appSettings)` in
src/lib/analytics.ts. Don't recompute any of these inline — import and
call this function (via `statsForMonth`/`statsForDay`) instead.

```
billsRevenue   = Σ bill.total                                  (pre-tax)
billsTax       = Σ taxBreakdown(bill.total).taxAmount
billsCollected = Σ (status === "paid" ? gross : amount_paid)
billsDues      = Σ max(0, gross - paid)

turfRevenue    = Σ booking.total_amount        (unmerged, non-cancelled only, pre-tax)
snacksRevenue  = Σ sale.total                  (pre-tax)
bookingsTax    = Σ max(0, bookingGrossTotal(booking) - booking.total_amount)  (unmerged, non-cancelled)
snacksTax      = Σ max(0, snackSaleGrossTotal(sale) - sale.total)

forfeitedRevenue = Σ bookingForfeitedRevenue(booking)  (Cancelled + is_refundable !== true —
                                                         see §3; dated by when collected, not booking_date)
refundableAdvance = Σ bookingRefundableAdvance(booking) (Cancelled + is_refundable === true — see §3;
                                                          a LIABILITY, deliberately excluded below)

netRevenue     = billsRevenue + turfRevenue + snacksRevenue + forfeitedRevenue
tax            = billsTax + bookingsTax + snacksTax
revenue        = netRevenue + tax
// refundableAdvance is NOT part of netRevenue/revenue/collected/dues — see §3.

collected      = billsCollected
               + Σ bookingCashCollected(booking, tabEntries)  (unmerged, non-cancelled)
               + Σ snackSaleCollected(sale, appSettings)
               + tabCollected
               + forfeitedRevenue
               + refundableCollected  // cash received for a refundable liability, not revenue

expenses       = Σ expense.amount
profit         = netRevenue - expenses          // NOT revenue - expenses

dues           = billsDues
               + Σ bookingDue(booking)          (unmerged, non-cancelled — tax-inclusive,
                                                  from dues.ts; never re-derive by hand)
               // snack sales have no "dues" concept — always fully paid

snackProfit    = Σ sale.profit
```

`avgBookingValue` (Reports/Dashboard KPI, month-scoped) =
`turfRevenue / (count of unmerged, non-cancelled bookings that month)`.

The "All time" Excel export's Dashboard uses the same formula over every
loaded month (Σ monthly `turfRevenue` / count of unmerged, non-cancelled
bookings). Its KPI cards are the sums of the same monthly `profitAndLoss()`
rows printed on the "Profit and loss" sheet (`Dues` therefore sums each
month's revenue − collected), and carry an "All time" caption instead of a
month-over-month delta.

## 5b. Multi-court bookings

A booking has both a court count (`courts`) and, on current rows, the named
courts it holds (`court_ids`). The count is the money/utilisation multiplier;
the ids are the occupancy/audit assignment. `resolveCourtIds()` is the
legacy fallback and `backfillCourtIds()` persists a deterministic assignment.

Pricing chain:

```text
pricePerCourt = priceForDuration(rateRow, hours × 60)
turf_amount   = turfPrice(pricePerCourt, courts)
taxable       = turf_amount + snacks_total − discount
total_amount  = max(0, taxable)
tax            = taxBreakdown(total_amount)
gross          = total_amount + tax
```

The courts multiplier is applied once and rounded once. `effectiveRatePerHour`
is `turf_amount / hours / courts`, rounded to two decimals because it is a
stored rate, not a payable total. Revenue counts one booking once because the
courts multiplier is already inside `turf_amount`/`total_amount`.

### Legacy zero-`turf_amount` rule

A row with `turf_amount === 0` is legacy and is rebuilt everywhere as:
`rupees(hours × rate_per_hour × max(1, courts))`. `merge.ts`, receipts, exports,
booking tax/dues and analytics must use the same `storedTurfAmount()` rule;
there is no second legacy formula.

### Merged-bill line items

A merged turf line must satisfy `qty × rate = total`. `qty` is court-hours
(`hours × courts`), `rate` is the per-court hourly rate represented by that
line, and the label includes the court count. Legacy rows use the same
reconstructed gross before the booking discount is removed once.

### Cancellation / no-show / refund

The advance is never multiplied by the court count. A cancelled, non-refundable
advance is forfeited revenue; a cancelled, refundable advance is a liability.
If payment rows exist, their Cash/UPI split and received date are preserved. A
refundable advance received is included in `collected` but not in revenue; the
liability is `refundableAdvance` until refunded. No-show advances follow the
forfeiture rule documented in §3.

### Customer metrics

`turfSpend` uses unmerged financial bookings only. `bookingsCount` and
`avgBookingValue` count merged bookings too because those are event metrics, not
financial ownership metrics. Outstanding turf dues use the tax-inclusive
`bookingDue()` result.

### Golden September 2026 multi-court rows

| Row | Setup | Turf | Discount | Total | Tax | Gross | Paid | Due |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| MC-1 | 2 courts, 1 h, ₹1,200/court, no advance | 2,400 | 0 | 2,400 | 552 | 2,952 | 0 | 2,952 |
| MC-2 | 3 courts, 2 h, ₹800/court, ₹300 discount, ₹2,000 advance | 4,800 | 300 | 4,500 | 1,035 | 5,535 | 2,000 | 3,535 |
| MC-3 | 3 courts, 1 h, ₹333/court, paid in full | 999 | 0 | 999 | 230 | 1,229 | 1,229 | 0 |
| MC-4 | 2 courts, cancelled, non-refundable, ₹1,000 advance (Cash 600 + UPI 400) | — | — | 0 | 0 | 0 | 1,000 | 0 |
| MC-5 | 2 courts, cancelled, refundable, ₹1,000 advance | — | — | 0 | 0 | 0 | 1,000 | 0 |
| MC-6 | 2 courts, 1 h, ₹700/court, merged into bill MC-BILL-6 | 1,400 | 0 | 1,400 | 322 (on bill) | 1,722 | 0 | 1,722 (on bill) |
| MC-7 | 2 courts, 1 h, ₹500/court, legacy `turf_amount: 0` (rebuilt 1×500×2) | 1,000 | 0 | 1,000 | 230 | 1,230 | 0 | 1,230 |
| MC-8 | 2 courts, 2 h, ₹600/court, 23:00–01:00, advance = pre-tax ₹1,200 | 1,200 | 0 | 1,200 | 276 | 1,476 | 1,200 | 276 |

MC-5 is a liability. Its ₹1,000 receipt is included in `collected` on the
received day under K4 but remains outside revenue, net revenue and dues.
MC-6 is merged: excluded from every turf figure — its ₹1,400 sits on
MC-BILL-6 (bills revenue ₹1,400, tax ₹322, dues ₹1,722). MC-7 exercises the
shared legacy rebuild with `courts: 2`. MC-8 splits across midnight for
court-hours (2 court-hours on each day) while its money buckets into
September by `booking_date`.

For MC-1 to MC-8 the September block is expected to show net revenue
₹12,499 (turf ₹10,099 + bill ₹1,400 + MC-4's ₹1,000 forfeited), tax ₹2,645,
revenue ₹15,144, dues ₹9,715 and collected ₹6,429 (including MC-5's
refundable receipt under K4). `refundableAdvance` stays ₹1,000.

## 8. Checklist before shipping a new calculation

Run through this explicitly, in comments or in your PR description if the
logic is non-trivial:

1. **Does this sum bills and bookings together?** → filter the booking
   side through `isFinancialBooking` (imported from `@/lib/analytics`) —
   never re-write the two-clause check by hand.
2. **Does this sum bookings at all?** → `isFinancialBooking` already
   excludes `Cancelled`; if you deliberately need cancelled rows for a
   specific metric (e.g. a cancellation-rate report), filter that in
   explicitly and say why in a comment.
3. **Is this a money total or an event count?** → money totals exclude
   merged bookings; event counts (bookings count, visit count, avg value)
   include them.
4. **Does this touch tax?** → Bills, and turf bookings/snack sales
   wherever GST is switched on, all carry tax (see §4) — never assume
   bookings/snacks are tax-free. Profit uses `netRevenue`, never `revenue`.
5. **Does this parse a date string directly?** → don't; route through
   `monthKey`/`dayKey` to avoid the UTC-slice bug on `bill_date`.
6. **Is there already a shared function for this?** (`periodStats`,
   `customerLifetimeStats`, `paymentSplit`, `expenseByCategory`,
   `profitAndLoss`, `taxReport`) → extend it in place rather than writing
   a parallel calculation in a component or export — two implementations
   of "this period's revenue" is how Dashboard and Reports drift apart.
7. **If you add a field to a shared stats function, update every caller**
   (search the whole repo for the function name) so a widened type
   doesn't leave one export silently reporting stale/zero values for the
   new column.
8. **Multi-court audit** → check `court_ids.length === courts`, no named court is
   held by two live bookings at the same minute, `turf_amount` equals the
   production pricing chain, and `Σ(hours × courts)` reconciles with the
   utilisation grid.
9. **Sanity-check with a known bad case**: a customer/period with (a) a
   merged booking, (b) a cancelled booking, (c) a partially-paid bill.
   Confirm the total doesn't include the cancelled booking, doesn't
   double-count the merged one, and dues reflect only what's actually
   outstanding.
