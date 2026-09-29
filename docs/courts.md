# Courts: one module, one set of rules

All court capacity, pricing and utilisation math lives in `src/lib/courts.ts`.
Nothing else should count courts, multiply by courts, or read `b.courts` for
math — import from there.

## Model
A venue has `total_courts` courts, ids `c1…cN` (Settings → Turf rates lets you
name them; blank names read "Court N"). A booking takes `courts` of them for
`[start, start + hours)` and stores the ids it holds in `court_ids`.

**Assignment is automatic.** The app gives a booking the lowest court id(s)
free for its WHOLE window (`assignCourts`). A booking holds the same court
start to finish, so a window can be refused even when a head-count says a
court is free at every minute (Court 1 busy early, Court 2 busy late). When
editing, the booking keeps its current court(s) if they are still free, so a
plain edit never shuffles the court.

**Legacy rows.** Bookings saved before named courts have no `court_ids`.
`resolveCourtIds` gives them a deterministic assignment (date, start,
created_at, id order, around already-assigned rows) and `backfillCourtIds`
(ops.ts, run from TurfTab) persists it, idempotently. It also re-homes a
booking whose court no longer exists after the venue's court count is lowered.

## What each helper is for
| Helper | Used by |
|---|---|
| `buildCourtOccupancy` | minute → set of court ids in use (past-midnight spill, `excludeId` for edits) |
| `assignCourts` / `freeCourtIdsFor` | automatic assignment; "N/M free" per slot = courts free for the whole slot |
| `resolveCourtIds` / `courtLabel` / `courtsLabel` | which court(s) a booking holds; display names |
| `buildOccupancy` | (count-only, kept for compatibility) minute → courts in use |
| `freeCourtsFor` / `windowFits` | slot grid "N/M free" and greyed-out slots |
| `selectionFits` | save-time guard — raising the court stepper after picking slots |
| `clampToVenue` | keeps the working court count ≤ `total_courts` |
| `turfPrice` / `effectiveRatePerHour` | price = one-court price × courts; stored rate is per court per hour |
| `storedTurfAmount` | ONE legacy rule (zero `turf_amount` ⇒ hours × rate × courts) for bill math, receipt and export |
| `courtHourSegments` / `utilisationPct` | Dashboard utilisation grid (court-hours and % of capacity) |

## Bugs this replaced
1. Raising the court stepper after picking slots could overbook the venue (no re-check on save).
2. Editing a booking whose `courts` exceeded a lowered `total_courts` priced N courts but saved fewer.
3. Excel export used `??` and printed Amount 0 for legacy rows that the receipt / bill math rebuilt — sheet and grand total disagreed.
4. Utilisation grid excluded merged bookings, contradicting `docs/calculation-rules.md` §2 (a merged booking still occupied the court). It now also shows % of capacity per cell.
5. Occupancy kept the court count in a shared mutable variable read by a closure — fragile; each booking now supplies its own.

## Not done
Court-wise revenue reports (the data is there: `court_ids` on every booking).
Manually picking or moving a booking to a specific court (assignment is
automatic by design). The utilisation grid still reports court-hours and % of
capacity across the venue, not per court.
