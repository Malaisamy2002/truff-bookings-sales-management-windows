/**
 * Court math — the ONE place that knows how many courts a booking uses, how
 * many are free at a given minute, what a multi-court booking costs, and how
 * many court-hours a booking occupies.
 *
 * Before this module the same rules were re-implemented in TurfTab
 * (occupancy, free counts, price × courts), biz.ts (legacy turf amount),
 * receipt.ts (legacy turf amount), the Excel export and TurfUtilizationCard,
 * and the copies had drifted apart. Everything here is pure (no React, no
 * storage) so it can be unit-tested directly.
 *
 * MODEL: a venue has `totalCourts` NAMED courts (c1…cN, see "NAMED COURTS"
 * below). A booking takes `courts` of them — recorded as `court_ids` — for
 * [start, start + hours). A slot is full once the courts in use reach
 * `totalCourts`; the count (`courts`) drives money and utilisation, the ids
 * drive occupancy and audit.
 */
import { parseMinutes } from "@/lib/time-slot-utils";
import { rupees } from "@/lib/money";

/** Minimal booking shape the court helpers read (avoids importing TurfBooking). */
export type CourtBooking = {
  id?: string;
  booking_date: string;
  start_time: string | null;
  end_time?: string | null;
  hours: number;
  courts?: number | null;
  status?: string | null;
};

/** Whole number of courts a booking uses; missing / junk counts as 1. */
export const bookingCourts = (b: { courts?: number | null }): number =>
  Math.max(1, Math.round(Number(b.courts ?? 1)) || 1);

/** Clamp a requested court count to what the venue actually has. */
export const clampToVenue = (courts: number, totalCourts: number): number =>
  Math.max(
    1,
    Math.min(
      Math.max(1, Math.round(Number(totalCourts)) || 1),
      Math.round(Number(courts)) || 1,
    ),
  );

/** Date string one calendar day earlier (local time — never via toISOString). */
const prevDayKey = (date: string): string | null => {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

/** Minutes a booking runs, from its stored hours (never below 1). */
export const bookingSpanMinutes = (b: { hours: number }): number =>
  Math.max(1, Math.round((Number(b.hours) || 1) * 60));

/**
 * minute-of-day -> courts in use, for every non-cancelled booking that touches
 * `date`. A late-night booking that runs past midnight spills into the next
 * calendar day, so the PREVIOUS day's bookings are read too.
 * `excludeId` keeps a booking that is being edited from blocking itself.
 */
export function buildOccupancy(
  bookings: readonly CourtBooking[],
  date: string,
  excludeId?: string | null,
): Map<number, number> {
  const occupied = new Map<number, number>();
  const yesterday = prevDayKey(date);
  for (const b of bookings) {
    if (b.status === "Cancelled") continue;
    if (excludeId && b.id === excludeId) continue;
    const sameDay = b.booking_date === date;
    const dayBefore = yesterday !== null && b.booking_date === yesterday;
    if (!sameDay && !dayBefore) continue;
    const start = parseMinutes(b.start_time);
    if (start === null) continue;
    const span = bookingSpanMinutes(b);
    const n = bookingCourts(b); // read per booking — no shared mutable state
    for (let m = start; m < start + span; m++) {
      if (sameDay && m < 1440) occupied.set(m, (occupied.get(m) ?? 0) + n);
      if (dayBefore && m >= 1440)
        occupied.set(m - 1440, (occupied.get(m - 1440) ?? 0) + n);
    }
  }
  return occupied;
}

/** Courts still free for the WHOLE window [start, start + minutes). */
export function freeCourtsFor(
  occupied: ReadonlyMap<number, number>,
  totalCourts: number,
  start: number,
  minutes: number,
): number {
  let free = totalCourts;
  for (let k = 0; k < minutes; k++) {
    free = Math.min(free, totalCourts - (occupied.get(start + k) ?? 0));
  }
  return Math.max(0, free);
}

/** Does a booking of `courts` courts fit in [start, start + minutes)? */
export const windowFits = (
  occupied: ReadonlyMap<number, number>,
  totalCourts: number,
  start: number,
  minutes: number,
  courts: number,
): boolean => freeCourtsFor(occupied, totalCourts, start, minutes) >= courts;

/**
 * Validate a whole selection (sorted slot start-minutes on one `interval`
 * grid) before saving. The UI greys out taken slots, but a slot picked with
 * 1 court can become invalid when the court stepper is raised afterwards —
 * this is the save-time guard that catches it.
 */
export function selectionFits(
  occupied: ReadonlyMap<number, number>,
  totalCourts: number,
  slotStarts: readonly number[],
  interval: number,
  courts: number,
): boolean {
  return slotStarts.every((s) =>
    windowFits(occupied, totalCourts, s, interval, courts),
  );
}

/**
 * Turf price for `courts` courts, given the price of ONE court for the chosen
 * duration (priceForDuration from ops.ts). Takes the number, not the rate row,
 * so this module never imports ops.ts — ops -> biz -> courts must not cycle.
 */
export const turfPrice = (pricePerCourt: number, courts: number): number =>
  rupees(pricePerCourt * Math.max(1, courts));

/**
 * The turf gross of a stored booking. `turf_amount` wins when present; a
 * zero is the legacy "field was absent" sentinel, so it is rebuilt from
 * hours × rate × courts. Used by the bill maths, the receipt AND the export
 * so all three always agree (the export used `??` and disagreed for legacy
 * rows).
 */
export function storedTurfAmount(b: {
  turf_amount?: number | null;
  hours?: number | null;
  rate_per_hour?: number | null;
  courts?: number | null;
}): number {
  const stored = Number(b.turf_amount) || 0;
  if (stored > 0) return stored;
  return rupees((b.hours ?? 0) * (b.rate_per_hour ?? 0) * bookingCourts(b));
}

/** Effective per-court hourly rate to store on a booking (0 when no hours). */
export const effectiveRatePerHour = (
  turfAmount: number,
  hours: number,
  courts: number,
): number =>
  hours > 0
    ? Math.round((turfAmount / hours / Math.max(1, courts)) * 100) / 100
    : 0;

/**
 * Court-hours a booking occupies inside each [from, to) window, splitting a
 * past-midnight booking across the two calendar days. Returns
 * `{ dayOffset, from, to, courtHours }` segments the utilisation grid buckets.
 */
export function courtHourSegments(b: CourtBooking) {
  const start = parseMinutes(b.start_time);
  let end = parseMinutes(b.end_time ?? null);
  if (start === null || end === null) return [];
  if (end <= start) end += 1440;
  const n = bookingCourts(b);
  const segs = [{ dayOffset: 0, from: start, to: Math.min(end, 1440), n }];
  if (end > 1440) segs.push({ dayOffset: 1, from: 0, to: end - 1440, n });
  return segs;
}

/** Percent of a window's capacity that was used (0–100, 1 dp). */
export const utilisationPct = (
  courtHours: number,
  windowHours: number,
  totalCourts: number,
): number => {
  const cap = windowHours * Math.max(1, totalCourts);
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((courtHours / cap) * 1000) / 10);
};

/* ------------------------------------------------------------------------ *
 * NAMED COURTS
 *
 * A venue's courts are c1…cN (stable ids by position); Settings only edits
 * their display names. A booking stores the ids it holds in `court_ids`, and
 * the app PICKS them (lowest free ids first) — the person never chooses.
 * Rows saved before named courts have no `court_ids`; `resolveCourtIds`
 * gives them a deterministic assignment so every read agrees.
 * ------------------------------------------------------------------------ */

/** Court ids for a venue with `total` courts: ["c1", "c2", …]. */
export const courtIdsFor = (total: number): string[] =>
  Array.from(
    { length: Math.max(1, Math.round(Number(total)) || 1) },
    (_, i) => `c${i + 1}`,
  );

/** Display names padded/trimmed to `total` entries ("Court 1" when unnamed). */
export const courtNamesFor = (
  total: number,
  names?: readonly (string | null | undefined)[] | null,
): string[] =>
  courtIdsFor(total).map((_, i) => {
    const n = (names?.[i] ?? "").toString().trim();
    return n || `Court ${i + 1}`;
  });

/** Display name for one court id ("c2" -> "Court 2" / the renamed value). */
export const courtLabel = (
  id: string,
  names?: readonly (string | null | undefined)[] | null,
): string => {
  const idx = Number(id.slice(1)) - 1;
  const n = Number.isInteger(idx) && idx >= 0 ? names?.[idx] : null;
  return (n ?? "").toString().trim() || `Court ${idx + 1}`;
};

/** "Court 1, Court 2" for a booking (empty string when it has no courts yet). */
export const courtsLabel = (
  ids: readonly string[] | null | undefined,
  names?: readonly (string | null | undefined)[] | null,
): string => (ids ?? []).map((id) => courtLabel(id, names)).join(", ");

const dayNumber = (date: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return Math.round(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000);
};

/** [startAbs, endAbs) in minutes since the epoch day 0, or null when unusable. */
const absInterval = (b: CourtBooking): [number, number] | null => {
  const day = dayNumber(b.booking_date);
  const start = parseMinutes(b.start_time);
  if (day === null || start === null) return null;
  const s = day * 1440 + start;
  return [s, s + bookingSpanMinutes(b)];
};

type WithCourtIds = CourtBooking & {
  court_ids?: readonly string[] | null;
  created_at?: string | null;
};

/** Stored ids that are usable: distinct, inside the venue, enough of them. */
const validStored = (b: WithCourtIds, valid: Set<string>): string[] | null => {
  const ids = [...new Set(b.court_ids ?? [])].filter((id) => valid.has(id));
  return ids.length >= bookingCourts(b) ? ids.slice(0, bookingCourts(b)) : null;
};

/**
 * booking id -> the court ids it holds. Stored `court_ids` win; bookings with
 * none (legacy rows, or ids for a court that no longer exists) are assigned
 * greedily in (date, start, created_at, id) order around what is already
 * held. Deterministic, so every screen and export agrees. Cancelled bookings
 * hold nothing and are omitted. If a legacy row cannot fit anywhere (the data
 * was already overbooked) it falls back to the lowest ids rather than throwing.
 */
export function resolveCourtIds(
  bookings: readonly WithCourtIds[],
  totalCourts: number,
): Map<string, string[]> {
  const all = courtIdsFor(totalCourts);
  const valid = new Set(all);
  const out = new Map<string, string[]>();
  const busy = new Map<string, [number, number][]>(all.map((c) => [c, []]));
  const clash = (c: string, iv: [number, number]) =>
    busy.get(c)!.some(([s, e]) => iv[0] < e && s < iv[1]);

  const live = bookings.filter((b) => b.status !== "Cancelled" && b.id);
  const pending: WithCourtIds[] = [];
  for (const b of live) {
    const ids = validStored(b, valid);
    const iv = absInterval(b);
    if (ids) {
      out.set(b.id!, ids);
      if (iv) for (const c of ids) busy.get(c)!.push(iv);
    } else pending.push(b);
  }
  pending.sort(
    (a, b) =>
      (absInterval(a)?.[0] ?? 0) - (absInterval(b)?.[0] ?? 0) ||
      (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
  for (const b of pending) {
    const n = Math.min(bookingCourts(b), all.length);
    const iv = absInterval(b);
    const free = iv ? all.filter((c) => !clash(c, iv)) : all;
    const picked = (free.length >= n ? free : all).slice(0, n);
    out.set(b.id!, picked);
    if (iv) for (const c of picked) busy.get(c)!.push(iv);
  }
  return out;
}

/** minute-of-day -> court ids in use on `date` (handles past-midnight spill). */
export function buildCourtOccupancy(
  bookings: readonly WithCourtIds[],
  date: string,
  totalCourts: number,
  excludeId?: string | null,
): Map<number, Set<string>> {
  const held = resolveCourtIds(bookings, totalCourts);
  const day = dayNumber(date);
  const occupied = new Map<number, Set<string>>();
  if (day === null) return occupied;
  const dayStart = day * 1440;
  for (const b of bookings) {
    if (!b.id || (excludeId && b.id === excludeId)) continue;
    const ids = held.get(b.id);
    const iv = absInterval(b);
    if (!ids || !iv) continue;
    const from = Math.max(iv[0], dayStart);
    const to = Math.min(iv[1], dayStart + 1440);
    for (let m = from; m < to; m++) {
      const key = m - dayStart;
      let set = occupied.get(key);
      if (!set) occupied.set(key, (set = new Set()));
      for (const c of ids) set.add(c);
    }
  }
  return occupied;
}

/** Courts free for the WHOLE window [start, start + minutes), lowest id first. */
export function freeCourtIdsFor(
  occupied: ReadonlyMap<number, ReadonlySet<string>>,
  totalCourts: number,
  start: number,
  minutes: number,
): string[] {
  const free = new Set(courtIdsFor(totalCourts));
  for (let k = 0; k < minutes && free.size > 0; k++) {
    const busy = occupied.get(start + k);
    if (busy) for (const c of busy) free.delete(c);
  }
  return courtIdsFor(totalCourts).filter((c) => free.has(c));
}

/**
 * Automatic assignment: the lowest `courts` court ids free for the whole
 * window, or null when the window can't take that many. Because a booking
 * holds the SAME court(s) start to finish, this can refuse a window that the
 * old head-count would have accepted (Court 1 busy early, Court 2 busy late).
 */
export function assignCourts(
  occupied: ReadonlyMap<number, ReadonlySet<string>>,
  totalCourts: number,
  start: number,
  minutes: number,
  courts: number,
): string[] | null {
  const free = freeCourtIdsFor(occupied, totalCourts, start, minutes);
  const need = Math.max(1, Math.round(courts) || 1);
  return free.length >= need ? free.slice(0, need) : null;
}
