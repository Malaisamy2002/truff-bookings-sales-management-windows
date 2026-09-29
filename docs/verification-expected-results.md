# Verification dataset — expected results

**Dataset:** `src/lib/verificationSeed.ts` · **Regenerated:** 2026-09-25 audit, from the
actual seeded rows (the previous version of this file described an older,
smaller June/July dataset and stale fixtures — do not hand-check screens
against it).

**How to verify (no hand math needed):**

```bash
npm ci --ignore-scripts
npx vitest run                     # 684/684 pass (Windows repo)
npm run verify:math                # ALL CHECKS PASSED
npm run verify:sections            # ALL SECTION CHECKS PASSED
npm run verify:loadtest:light      # ALL AUDIT CHECKS PASSED
```

`verify:math` recomputes every figure below from the raw seeded rows with an
independent implementation (`scripts/verify-math.ts`) and fails on any drift.

## Headline fixtures (July + August 2026, GST enabled)

| Metric | July 2026 | August 2026 | Combined |
|---|---|---|---|
| Revenue (net) | ₹4,920 | ₹7,935 | ₹12,855 |
| — via `verify:math` ("revenue" check) | ✅ | ✅ | ✅ |

August snack-sale tax is **₹105**, split exactly as
**CGST ₹41 + SGST ₹41 + service charge ₹23** — CGST and SGST are always equal
(`rupees(taxable × rate / 200)` each), and the printed lines sum to the
frozen `tax_amount`.

## The month-boundary bill

The dataset's boundary bill is stored as `2026-07-31T20:00:00.000Z` — a UTC
timestamp. Sliced naively (first 7 chars) that reads `"2026-07"`, i.e. July.
But 20:00 UTC on 31 July is **01:30 IST on 1 August** — the correct calendar
month. `monthKey()` / `dayKey()` bucket it into **August** by construction
(fixed +5:30 IST offset on the UTC instant, never the runtime clock), so the
August column includes this bill on every screen, export and report. If a
manual check shows it in July, the bucketing regression is back — the
TZ-sensitive tests and `verify:math` (run them under `TZ=UTC`,
`TZ=America/Los_Angeles` and `TZ=Asia/Kolkata`; results are identical) guard
this.

## What the seed contains (trace any number)

- Bookings across both months: confirmed/completed with advances (Cash/UPI
  mixes), a **cancelled non-refundable** booking (advance = forfeited revenue,
  dated by when the money was received), a **cancelled refundable** booking
  (surfaced only as `refundableAdvance` — see `docs/calculation-rules.md` §3
  and the K4 model), a no-advance pending booking, and merged bookings folded
  into a bill.
- Bills: paid, partially paid, unpaid, one straddling the July→August IST
  boundary; snack sales incl. on-tab and void cases; expenses incl. a Card
  purchase with a `cash_part`; tab charges and payments; day-close rows.
- Row-level source data is in `verificationSeed.ts` — every figure in
  `verify:math` can be traced to those rows by id.

## Rules the fixtures encode

These come straight from `docs/calculation-rules.md` — the fixtures fail if
any of them regresses:

1. Discount before tax; taxes frozen at document time (`freezeTax`).
2. `revenue = netRevenue + tax`; `profit = netRevenue − expenses`.
3. Forfeited advances are income dated by **received** date; refundable
   advances are liabilities dated by `booking_date` and enter
   `collected`/split on arrival; refunds leave the drawer on refund day.
4. Merged/cancelled/no-show slots never produce play revenue; a paid no-show
   keeps its advance as forfeited income.
5. Payment split reconciles through `effectivePaymentEntries`
   (rows win; shortfall on the record's date in its mode; excess trims the
   newest rows).
