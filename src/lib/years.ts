import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { db } from "./localdb";

/**
 * Year handling for the ledger.
 *
 * Every dated table is already indexed by its date column, so a year is fetched
 * with an indexed range query instead of loading the whole table — this is what
 * keeps the app responsive at 100k+ rows.
 */

/** Dated tables and the date column each one is filtered/indexed by. */
export const YEAR_TABLES = {
  bills: "bill_date",
  expenses: "spent_at",
  turf_bookings: "booking_date",
  snack_sales: "sale_date",
  history_entries: "created_at",
  snack_stock_history: "created_at",
  tab_entries: "entry_date",
  day_closes: "day",
  day_close_history: "amended_at",
  // Keyed by received_at (not a parent record's own date) so a payment
  // archives with the year the money actually arrived in. A payment can
  // never be received before its parent exists, so this is always the
  // same year as the parent or later — the parent can't already have been
  // archived out while a live payment against it remains (see
  // lib/archive.ts's oldest-year-first order).
  payments: "received_at",
} as const;

export type YearTable = keyof typeof YEAR_TABLES;

/** How many years of data stay inside the app. Older years get archived out. */
export const RETAINED_YEARS = 3;

export const currentYear = () => new Date().getFullYear();

export const yearOf = (value: unknown) => {
  const s = String(value ?? "");
  const n = Number(s.slice(0, 4));
  return Number.isFinite(n) && n > 1900 ? n : 0;
};

export const yearStart = (year: number) => `${year}-01-01`;
export const yearEndExclusive = (year: number) => `${year + 1}-01-01`;

/** All rows of one dated table for one year, via the date index. */
export async function rowsForYear<T = Record<string, unknown>>(
  name: YearTable,
  year: number,
): Promise<T[]> {
  const field = YEAR_TABLES[name];
  const tbl = db[name] as unknown as {
    where: (f: string) => {
      between: (
        a: string,
        b: string,
        ia: boolean,
        ib: boolean,
      ) => { toArray: () => Promise<T[]> };
    };
  };
  return tbl
    .where(field)
    .between(yearStart(year), yearEndExclusive(year), true, false)
    .toArray();
}

/** Rows that belong in a year archive. Payments follow both sides of their
 * lifecycle: money received in the target year, or money received later for a
 * parent record dated in the target year. The latter prevents an old bill from
 * being archived while its later collection is left behind as an orphan. */
export async function rowsForArchiveYear<T = Record<string, unknown>>(
  name: YearTable,
  year: number,
): Promise<T[]> {
  if (name !== "payments") return rowsForYear<T>(name, year);

  const payments = await db.payments.toArray();
  const parentDates = new Map<string, number>();
  for (const b of await db.bills.toArray())
    parentDates.set(`bill:${b.id}`, yearOf(b.bill_date));
  for (const b of await db.turf_bookings.toArray())
    parentDates.set(`turf_booking:${b.id}`, yearOf(b.booking_date));
  for (const s of await db.snack_sales.toArray())
    parentDates.set(`snack_sale:${s.id}`, yearOf(s.sale_date));
  return payments.filter(
    (p) =>
      yearOf(p.received_at) === year ||
      parentDates.get(`${p.parent_type}:${p.parent_id}`) === year,
  ) as T[];
}

/** Rows for a set of years (used by the screens, which show the selected year). */
export async function rowsForYears<T = Record<string, unknown>>(
  name: YearTable,
  years: number[] | "all",
): Promise<T[]> {
  if (years === "all")
    return await (
      db[name] as never as { toArray: () => Promise<T[]> }
    ).toArray();
  const out: T[] = [];
  for (const y of years) out.push(...(await rowsForYear<T>(name, y)));
  return out;
}

export async function countForYear(name: YearTable, year: number) {
  const field = YEAR_TABLES[name];
  const tbl = db[name] as unknown as {
    where: (f: string) => {
      between: (
        a: string,
        b: string,
        ia: boolean,
        ib: boolean,
      ) => { count: () => Promise<number> };
    };
  };
  return tbl
    .where(field)
    .between(yearStart(year), yearEndExclusive(year), true, false)
    .count();
}

/** Distinct years present across every dated table, ascending. */
export async function distinctYears(): Promise<number[]> {
  const found = new Set<number>();
  for (const [name, field] of Object.entries(YEAR_TABLES) as [
    YearTable,
    string,
  ][]) {
    const tbl = db[name] as unknown as {
      orderBy: (f: string) => {
        eachUniqueKey?: (cb: (k: unknown) => void) => Promise<void>;
        keys: () => Promise<unknown[]>;
      };
    };
    try {
      const keys = await tbl.orderBy(field).keys();
      for (const k of keys) {
        const y = yearOf(k);
        if (y) found.add(y);
      }
    } catch {
      /* table missing/empty — skip */
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Deletes every row of one year from the dated tables. Returns rows removed. */
export async function deleteYear(year: number) {
  let removed = 0;

  // Tab entries are part of the year archive, but an open tab may still use
  // those historical entries to derive its live balance. Archiving them would
  // silently change money owed, so require the tab to be closed first.
  const targetEntries = await rowsForYear<{
    id: string;
    tab_id: string;
    entry_date: string;
  }>("tab_entries", year);
  if (targetEntries.length) {
    const tabIds = new Set(targetEntries.map((e) => e.tab_id));
    for (const tabId of tabIds) {
      const tab = await db.customer_tabs.get(tabId);
      if (tab?.status === "open") {
        throw new Error(
          `Can't archive ${year}: customer tab ${tab.customer_name || tab.customer_key} is still open and has entries from that year. Settle/close the tab first.`,
        );
      }
    }
  }

  // Receipt photos are not independently dated. They are archived with the
  // expense rows that reference them. A path must not be shared by an expense
  // outside the target year; otherwise deleting it would damage live data.
  const expenses = await rowsForYear<{
    id: string;
    receipt_path: string | null;
  }>("expenses", year);
  const receiptPaths = new Set(
    expenses.map((e) => e.receipt_path).filter((p): p is string => !!p),
  );
  if (receiptPaths.size) {
    const allExpenses = await db.expenses.toArray();
    for (const path of receiptPaths) {
      const shared = allExpenses.some(
        (e) => e.receipt_path === path && yearOf(e.spent_at) !== year,
      );
      if (shared)
        throw new Error(
          `Can't archive ${year}: receipt ${path} is referenced by another year's expense.`,
        );
    }
  }

  // Resolve year payments BEFORE the deletion transaction deletes their
  // parents: a payment received after the year but owed to a parent record
  // dated in the year can only be found while the parent row still exists.
  // The archive collects the same set — archive and delete must agree (WP3).
  const yearPayments = await rowsForArchiveYear<{ id: string }>(
    "payments",
    year,
  );

  const tables = (Object.keys(YEAR_TABLES) as YearTable[]).map((t) => db[t]);
  await db.transaction(
    "rw",
    [...tables, db.receipts, db.receipt_hashes],
    async () => {
      for (const [name, field] of Object.entries(YEAR_TABLES) as [
        YearTable,
        string,
      ][]) {
        if (name === "payments") {
          if (yearPayments.length) {
            await db.payments.bulkDelete(yearPayments.map((p) => p.id));
            removed += yearPayments.length;
          }
          continue;
        }
        const tbl = db[name] as unknown as {
          where: (f: string) => {
            between: (
              a: string,
              b: string,
              ia: boolean,
              ib: boolean,
            ) => { delete: () => Promise<number> };
          };
        };
        removed += await tbl
          .where(field)
          .between(yearStart(year), yearEndExclusive(year), true, false)
          .delete();
      }
      for (const path of receiptPaths) {
        removed += await db.receipts
          .delete(path)
          .then(() => 1)
          .catch(() => 0);
        removed += await db.receipt_hashes
          .delete(path)
          .then(() => 1)
          .catch(() => 0);
      }
    },
  );
  return removed;
}

/* ------------------------------------------------------------------ */
/* Selected year (shared across screens)                               */
/* ------------------------------------------------------------------ */

const KEY = "ks:selected-year";
const EVENT = "ks:selected-year-changed";

export function readSelectedYear(): number {
  if (typeof window === "undefined") return currentYear();
  const raw = window.localStorage.getItem(KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 1900 ? n : currentYear();
}

export function writeSelectedYear(year: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, String(year));
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * The year the screens are showing. It follows the calendar automatically: when
 * a new year begins the app simply switches to it, no action needed. Stored
 * selections from older years are kept until the user changes them.
 */
export function useSelectedYear() {
  const [year, setYear] = useState<number>(() => readSelectedYear());
  const autoCorrected = useRef(false);

  useEffect(() => {
    const sync = () => setYear(readSelectedYear());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // The starting year (from localStorage, or this calendar year by default)
  // can point at a year the ledger has nothing in — e.g. after restoring a
  // backup dated in an earlier year, or opening a profile whose data was
  // seeded for a different year — which silently renders every screen empty
  // with no clue why. Once, on load, if that year has no data but another
  // year does, jump to the most recent year that actually has data. This only
  // runs on mount: a deliberate later selection of an empty year (planning
  // ahead for next year, say) is left alone.
  useEffect(() => {
    if (autoCorrected.current) return;
    let alive = true;
    distinctYears().then((years) => {
      if (!alive || autoCorrected.current) return;
      autoCorrected.current = true;
      if (years.length === 0 || years.includes(year)) return;
      const latest = years[years.length - 1];
      if (latest === undefined) return;
      writeSelectedYear(latest);
      toast.info(`Showing ${latest} — no data for ${year}`);
    });
    return () => {
      alive = false;
    };
    // Deliberately mount-only: re-running on every `year` change would also
    // fire after the user picks an empty year on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [year, writeSelectedYear] as const;
}

/** Years that should appear in the picker: everything in the db plus this year. */
export function useAvailableYears() {
  const [years, setYears] = useState<number[]>([currentYear()]);
  useEffect(() => {
    let alive = true;
    distinctYears().then((list) => {
      if (!alive) return;
      const all = new Set([...list, currentYear()]);
      setYears([...all].sort((a, b) => b - a));
    });
    return () => {
      alive = false;
    };
  }, []);
  return years;
}

/**
 * Years the screens load for a selection. During January the previous year is
 * included too, so "yesterday"/last-month comparisons still work right after a
 * year rollover.
 */
export function yearsWindow(selected: number) {
  const now = new Date();
  return selected === now.getFullYear() && now.getMonth() === 0
    ? [selected - 1, selected]
    : [selected];
}

/** React helper: the year window currently being displayed. */
export function useYearWindow() {
  const [year] = useSelectedYear();
  return { year, years: yearsWindow(year) };
}
