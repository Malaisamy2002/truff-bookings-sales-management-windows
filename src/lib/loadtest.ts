/**
 * Settings → Load test: a realistic, deterministic ONE-YEAR dataset.
 *
 * What it seeds (all tagged so it can be removed exactly):
 *  - 100 customers (`lt-cust-###`), reused by every booking / sale / bill.
 *  - 50 snack items (`lt-item-##`) that start at 100 stock and are actually
 *    depleted by the sales below, with a `snack_stock_history` row per
 *    change. Items are picked with a Pareto-ish popularity weighting (same
 *    idea as customer selection below) instead of uniformly at random, so
 *    a handful of fast movers actually run down to the low-stock threshold
 *    over a month instead of every one of the 50 items coasting near 100.
 *  - Turf bookings spread across SEVEN real hourly slots (11:30 AM → 6:30 PM)
 *    and LOAD_TEST_COURTS courts — never more bookings than courts per slot.
 *    Most are a single court for one hour, but a small share are a 2-court
 *    group booking, a 2-hour (two consecutive slots) booking, or both, so
 *    the multi-court / multi-hour paths (`courts` > 1, `hours` > 1) aren't
 *    only exercised by hand-written fixtures.
 *  - Varied offers (`discount`) and advances, so dues are a real spread.
 *  - Snack sales, merged-style bills and expenses across the same year.
 *    A small share of sales have no linked customer (`"Walk-in"`, the same
 *    convention `verificationSeed.ts` uses) and a small share of sales and
 *    bills are soft-voided (`cancelled: true` / `status: "cancelled"`) —
 *    a voided sale restores its items to stock, same as `useVoidSnackSale`.
 *  - GST 18% + a 5% service charge are switched on before seeding (same
 *    setup `verificationSeed.ts` audits against), and every booking/sale/
 *    bill is written with its tax frozen via `freezeTax()` — the same call
 *    real creation makes — so this dataset exercises the frozen-tax path,
 *    not just `grossWithTax()`'s live-recompute fallback for legacy rows.
 *  - On the LAST generated day, a handful of bills/bookings pushed onto the
 *    customer's running tab (Dues), so "Moved to dues" has seeded examples.
 *  - Two of the regular customers also get hand-placed tab activity spread
 *    earlier in the year: one is charged and pays it off in full (closing
 *    the tab), the other is charged and only partly pays — so the
 *    `"payment"` entry kind and tab-closing are covered, not just the
 *    `"charge"` rows the final-day push writes.
 *
 * Tagging: every document number starts with `LT-` and every row id with
 * `lt-`, so `clearLoadTestData()` removes exactly what a fresh seed writes —
 * nothing else is touched. Ids are counter-based (not random UUIDs) so two
 * runs produce a byte-identical dataset.
 *
 * Decisions made by this module (see the spec's open questions):
 *  - Target file is this one (loadtest.ts); verificationSeed.ts stays a small
 *    hand-auditable 2-month dataset.
 *  - The venue is seeded with 3 courts (LOAD_TEST_COURTS).
 *  - 6 records are pushed onto tabs on the final day (LAST_DAY_TAB_RECORDS).
 *  - The benchmark is a SINGLE-run result over the one seeded year (no
 *    year-over-year table).
 */

import {
  db,
  nowIso,
  resyncCounters,
  type BillRow,
  type CustomerRow,
  type CustomerTabRow,
  type ExpenseRow,
  type PaymentRow,
  type SnackItemRow,
  type SnackSaleRow,
  type SnackStockHistoryRow,
  type TabEntryRow,
  type TurfBookingRow,
  type BudgetRow,
  type RecurringExpenseRow,
  type TurfRateRow,
  type DayCloseRow,
  type DayCloseHistoryRow,
} from "./localdb";
import type { Table } from "dexie";
import { rupees } from "./money";
import { makeReceiptRows } from "./seed-photo";
import { sha256Hex } from "./receipts-share";
import { periodStats, type Sources } from "./analytics";
import { TAB_REF_BILL, TAB_REF_TURF_BOOKING, tabKey } from "./tabs";
import {
  buildReportPdf,
  type ReportPdfDoc,
  type ReportTable,
} from "./report-pdf";
import { currentYear } from "./years";
import { bookingTaxable, freezeTax } from "./biz";
import { readAppSettings, writeAppSettings } from "./settings";
import { localDateStr } from "./utils";
import {
  bookingPaymentRows,
  pickBookingScenario,
  primaryMode,
  singleCollection,
  splitCollection,
} from "./loadtest-gen";

/* ------------------------------------------------------------------ */
/* Tags, constants                                                      */
/* ------------------------------------------------------------------ */

export const LT_PREFIX = "LT-";
export const LT_ID = "lt-";

/** Payment modes a single-tender load-test bill may carry (index picked by billRand). */
const SINGLE_BILL_MODES = ["Cash", "UPI", "Card"] as const;
/** Courts the seeded venue has: a slot can hold at most this many bookings. */
export const LOAD_TEST_COURTS = 3;
/** How many of the final day's records are pushed onto customer tabs. */
export const LAST_DAY_TAB_RECORDS = 6;
export const LOAD_TEST_CUSTOMERS = 100;
export const LOAD_TEST_SNACK_ITEMS = 50;
export const LOAD_TEST_STOCK_START = 100;
/** Exactly one calendar year of data. */
export const LOAD_TEST_YEARS = 1;

/** The seven bookable hourly slots, in the same "h:mm AM/PM" label format
 * `minuteLabel()` (TimeSlotPicker) writes onto real bookings. */
export const LOAD_TEST_SLOTS: { start: string; end: string }[] = [
  { start: "11:30 AM", end: "12:30 PM" },
  { start: "12:30 PM", end: "1:30 PM" },
  { start: "1:30 PM", end: "2:30 PM" },
  { start: "2:30 PM", end: "3:30 PM" },
  { start: "3:30 PM", end: "4:30 PM" },
  { start: "4:30 PM", end: "5:30 PM" },
  { start: "5:30 PM", end: "6:30 PM" },
];

export type LoadTestMix = "light" | "medium";

export const LOAD_TEST_MIXES: Record<
  LoadTestMix,
  {
    label: string;
    occupancy: number;
    sales: number;
    bills: number;
    expenses: number;
  }
> = {
  // occupancy = share of the 7 slots × 3 courts filled on an average day.
  light: { label: "Light", occupancy: 0.35, sales: 4, bills: 1, expenses: 0.3 },
  medium: {
    label: "Medium",
    occupancy: 0.62,
    sales: 9,
    bills: 2,
    expenses: 0.6,
  },
};

/** Rough row estimate for the Settings card copy. */
export function estimatedRows(mix: LoadTestMix, months = 12) {
  const m = LOAD_TEST_MIXES[mix];
  const days = Math.max(1, Math.round(months * 30.4375));
  const bookings = Math.round(
    days * LOAD_TEST_SLOTS.length * LOAD_TEST_COURTS * m.occupancy,
  );
  const sales = Math.round(days * m.sales);
  return {
    customers: LOAD_TEST_CUSTOMERS,
    snackItems: LOAD_TEST_SNACK_ITEMS,
    bookings,
    sales,
    bills: Math.round(days * m.bills),
    expenses: Math.round(days * m.expenses),
    total:
      LOAD_TEST_CUSTOMERS +
      LOAD_TEST_SNACK_ITEMS +
      bookings +
      sales +
      Math.round(days * m.bills) +
      Math.round(days * m.expenses),
  };
}

/** The single calendar year the generator covers. */
export const loadTestYear = () => currentYear();

/* ------------------------------------------------------------------ */
/* Deterministic PRNG + id helpers                                      */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width = 5) => String(n).padStart(width, "0");

/* ------------------------------------------------------------------ */
/* Name / item catalogues                                              */
/* ------------------------------------------------------------------ */

const FIRST_NAMES = [
  "Arjun",
  "Vikram",
  "Rahul",
  "Sneha",
  "Priya",
  "Karthik",
  "Divya",
  "Sanjay",
  "Meera",
  "Aditya",
  "Nikhil",
  "Pooja",
  "Ramesh",
  "Anita",
  "Suresh",
  "Deepak",
  "Kavya",
  "Manoj",
  "Lakshmi",
  "Harish",
  "Ganesh",
  "Ritu",
  "Naveen",
  "Swathi",
  "Vishal",
  "Anjali",
  "Prakash",
  "Neha",
  "Kiran",
  "Gopal",
];

const SURNAMES = [
  "Sharma",
  "Reddy",
  "Nair",
  "Iyer",
  "Patel",
  "Kumar",
  "Menon",
  "Rao",
  "Verma",
  "Pillai",
  "Chopra",
  "Joshi",
  "Desai",
  "Bose",
  "Gupta",
  "Shetty",
  "Naidu",
  "Mehta",
  "Kulkarni",
  "Banerjee",
];

const SNACK_CATALOGUE: {
  name: string;
  category: string;
  price: number;
  cost: number;
}[] = [
  { name: "Tea", category: "Beverages", price: 15, cost: 7 },
  { name: "Coffee", category: "Beverages", price: 25, cost: 12 },
  { name: "Cold Coffee", category: "Beverages", price: 60, cost: 28 },
  { name: "Lemon Soda", category: "Beverages", price: 40, cost: 16 },
  { name: "Buttermilk", category: "Beverages", price: 25, cost: 10 },
  { name: "Lassi", category: "Beverages", price: 50, cost: 22 },
  { name: "Mineral Water 1L", category: "Beverages", price: 20, cost: 12 },
  { name: "Energy Drink", category: "Beverages", price: 90, cost: 60 },
  { name: "Cola 500ml", category: "Beverages", price: 45, cost: 30 },
  { name: "Orange Juice", category: "Beverages", price: 60, cost: 30 },
  { name: "Sugarcane Juice", category: "Beverages", price: 40, cost: 15 },
  { name: "Iced Tea", category: "Beverages", price: 50, cost: 20 },
  { name: "Masala Milk", category: "Beverages", price: 45, cost: 20 },
  { name: "Protein Shake", category: "Beverages", price: 120, cost: 70 },
  { name: "Electrolyte Bottle", category: "Beverages", price: 35, cost: 20 },
  { name: "Samosa", category: "Snacks", price: 20, cost: 8 },
  { name: "Veg Puff", category: "Snacks", price: 25, cost: 11 },
  { name: "Egg Puff", category: "Snacks", price: 30, cost: 14 },
  { name: "Masala Vada", category: "Snacks", price: 20, cost: 8 },
  { name: "Onion Pakoda", category: "Snacks", price: 40, cost: 16 },
  { name: "French Fries", category: "Snacks", price: 70, cost: 30 },
  { name: "Peri Peri Fries", category: "Snacks", price: 85, cost: 36 },
  { name: "Chicken Nuggets", category: "Snacks", price: 110, cost: 60 },
  { name: "Paneer Popcorn", category: "Snacks", price: 120, cost: 62 },
  { name: "Veg Sandwich", category: "Snacks", price: 60, cost: 26 },
  { name: "Grilled Cheese Sandwich", category: "Snacks", price: 80, cost: 38 },
  { name: "Chicken Sandwich", category: "Snacks", price: 100, cost: 52 },
  { name: "Veg Roll", category: "Snacks", price: 70, cost: 30 },
  { name: "Chicken Roll", category: "Snacks", price: 95, cost: 48 },
  { name: "Maggi Masala", category: "Snacks", price: 50, cost: 20 },
  { name: "Cheese Maggi", category: "Snacks", price: 70, cost: 30 },
  { name: "Bread Omelette", category: "Snacks", price: 55, cost: 24 },
  { name: "Boiled Corn Cup", category: "Snacks", price: 45, cost: 18 },
  { name: "Peanut Chaat", category: "Snacks", price: 35, cost: 14 },
  { name: "Pav Bhaji", category: "Snacks", price: 90, cost: 40 },
  { name: "Chips Packet", category: "Packaged", price: 20, cost: 14 },
  { name: "Nachos Packet", category: "Packaged", price: 40, cost: 26 },
  { name: "Biscuit Pack", category: "Packaged", price: 10, cost: 6 },
  { name: "Chocolate Bar", category: "Packaged", price: 50, cost: 35 },
  { name: "Protein Bar", category: "Packaged", price: 90, cost: 60 },
  { name: "Dry Fruit Mix", category: "Packaged", price: 70, cost: 45 },
  { name: "Ice Cream Cup", category: "Desserts", price: 40, cost: 18 },
  { name: "Choco Brownie", category: "Desserts", price: 65, cost: 28 },
  { name: "Gulab Jamun (2 pc)", category: "Desserts", price: 45, cost: 18 },
  { name: "Fruit Bowl", category: "Desserts", price: 60, cost: 30 },
  {
    name: "Match Combo (Tea + Samosa)",
    category: "Combos",
    price: 30,
    cost: 14,
  },
  {
    name: "Team Combo (6 Water + Fries)",
    category: "Combos",
    price: 180,
    cost: 100,
  },
  {
    name: "Evening Combo (Coffee + Puff)",
    category: "Combos",
    price: 45,
    cost: 21,
  },
  {
    name: "Kids Combo (Juice + Chips)",
    category: "Combos",
    price: 70,
    cost: 40,
  },
  {
    name: "Post-Match Combo (Shake + Roll)",
    category: "Combos",
    price: 200,
    cost: 112,
  },
];

const PAY_MODES = ["Cash", "UPI", "Card"];

/* ------------------------------------------------------------------ */
/* Seeding                                                              */
/* ------------------------------------------------------------------ */

export type SeedProgress = {
  /** 1-based month being written. */
  month: number;
  months: number;
  rows: number;
};

export type SeedResult = {
  year: number;
  customers: number;
  snackItems: number;
  bookings: number;
  payments: number;
  receipts: number;
  receiptHashes: number;
  sales: number;
  bills: number;
  expenses: number;
  tabEntries: number;
  stockHistory: number;
  total: number;
};

type Cust = { id: string; name: string; phone: string; weight: number };

function buildCustomers(rand: () => number): {
  rows: CustomerRow[];
  pick: () => Cust;
} {
  const created = `${loadTestYear() - 1}-12-01T04:00:00.000Z`;
  const list: Cust[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < LOAD_TEST_CUSTOMERS; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const last =
      SURNAMES[(i * 7 + Math.floor(i / SURNAMES.length)) % SURNAMES.length]!;
    let name = `${first} ${last}`;
    while (seen.has(name)) name = `${first} ${last} ${seen.size}`;
    seen.add(name);
    const lead = [9, 8, 7][i % 3]!;
    const phone = `${lead}${pad(100000000 + i * 1237, 9)}`.slice(0, 10);
    // Pareto-ish skew: the first customers are the regulars, the tail is rare.
    const weight = 1 / Math.pow(i + 1, 0.85);
    list.push({ id: `${LT_ID}cust-${pad(i, 3)}`, name, phone, weight });
  }
  const totalWeight = list.reduce((s, c) => s + c.weight, 0);
  const pick = () => {
    let r = rand() * totalWeight;
    for (const c of list) {
      r -= c.weight;
      if (r <= 0) return c;
    }
    return list[0]!;
  };
  const rows: CustomerRow[] = list.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    created_at: created,
  }));
  return { rows, pick };
}

function buildSnackItems(): SnackItemRow[] {
  const created = `${loadTestYear() - 1}-12-01T04:00:00.000Z`;
  return SNACK_CATALOGUE.slice(0, LOAD_TEST_SNACK_ITEMS).map((s, i) => ({
    id: `${LT_ID}item-${pad(i, 3)}`,
    item_name: s.name,
    category: s.category,
    unit_price: s.price,
    cost_price: s.cost,
    is_active: true,
    stock_quantity: LOAD_TEST_STOCK_START,
    low_stock_threshold: 15,
    created_at: created,
    stock_updated_at: created,
  }));
}

// The app's own bucketing (analytics.ts's monthKey/dayKey) reads bill_date
// as a UTC instant and adds back a fixed +5:30 IST offset to recover the
// IST calendar day/month — deliberately independent of whatever timezone
// the reading device happens to be in. isoAt() must produce a bill_date
// that actually IS that IST wall-clock moment; building it via
// `new Date(\`${date}T${hour}:${minute}:00\`).toISOString()` instead parses
// the string in the HOST MACHINE's local timezone, so it only comes out
// right when the seeding script happens to run on an IST-clocked machine.
// On a UTC-clocked machine (a CI runner, most dev laptops, this sandbox)
// every bill_date silently lands ~5.5h later than intended — enough to
// push month-end bills into the next month, or a Dec-31 bill into the
// next year entirely, outside the seeded one-year window.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const isoAt = (date: string, hour: number, minute = 0) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(
    Date.UTC(y, m - 1, d, hour, minute, 0) - IST_OFFSET_MS,
  ).toISOString();
};

const dateStr = (y: number, m: number, d: number) =>
  `${y}-${pad(m, 2)}-${pad(d, 2)}`;

/** Seeds exactly one calendar year, month by month (one transaction per
 * month) so the UI stays responsive and can report progress. */
function monthChunksBetween(start: string, end: string) {
  const out: { year: number; month: number; days: number }[] = [];
  const d = new Date(Date.parse(start));
  d.setUTCDate(1);
  const stop = new Date(Date.parse(end));
  stop.setUTCDate(1);
  while (d <= stop) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    out.push({
      year: y,
      month: m,
      days: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Count rows that are NOT load-test rows — i.e. real business data. */
export async function countLiveBusinessRows(): Promise<number> {
  return (
    (await db.customers.filter((c) => !c.id.startsWith("lt-")).count()) +
    (await db.bills.filter((b) => !b.id.startsWith("lt-")).count()) +
    (await db.turf_bookings.filter((b) => !b.id.startsWith("lt-")).count())
  );
}

export async function seedLoadTestData(
  mix: LoadTestMix = "light",
  onProgress?: (p: SeedProgress) => void,
  opts: { anchor?: string; months?: 12 | 14; force?: boolean } = {},
): Promise<SeedResult> {
  const cfg = LOAD_TEST_MIXES[mix];
  const rand = mulberry32(20260905);
  const bookingRand = mulberry32(20260904);
  const salesRand = mulberry32(20260905);
  const billRand = mulberry32(20260906);
  const customerRand = mulberry32(20260910);
  const year = loadTestYear();

  // Match the tax setup `verificationSeed.ts`'s hand-computed expectations
  // use, so every generated row below can have its tax frozen via
  // freezeTax() (the frozen-tax path) instead of writing tax_amount: 0 and
  // only ever exercising grossWithTax()'s live-recompute fallback. Not
  // restored afterwards — same precedent as verificationSeed.ts, which also
  // leaves GST switched on once it seeds.
  const taxSettings = {
    ...readAppSettings(),
    gstEnabled: true,
    gstRate: 18,
    customTaxes: [
      { id: "svc", label: "Service Charge", rate: 5, enabled: true },
    ],
  };
  // F-14/K3: never seed into a live business database. Load-test rows are
  // all lt-prefixed, so any non-lt row in the core tables means real data.
  // The UI asks for explicit confirmation before passing { force: true }.
  // The tax flip below is likewise only applied to an empty (load-test)
  // database — on a live one it would silently change the owner's tax setup.
  const liveRows = await countLiveBusinessRows();
  if (liveRows > 0 && !opts.force) {
    throw new Error(
      "This database has real business records. Load-test seeding is only safe on an empty (or load-test-only) database.",
    );
  }
  if (liveRows === 0) writeAppSettings(taxSettings);

  const { rows: customerRows, pick: pickCustomer } =
    buildCustomers(customerRand);
  const items = buildSnackItems();
  const stock = new Map(items.map((i) => [i.id, LOAD_TEST_STOCK_START]));
  // Pareto-ish popularity, same idea as buildCustomers()'s weighting: a few
  // fast-moving items (the front of SNACK_CATALOGUE — Tea, Coffee, Samosa…)
  // sell far more than the tail, so stock genuinely runs down to the
  // low-stock threshold on some items instead of every item coasting near
  // its starting 100 units all month.
  const itemWeights = items.map((_, i) => 1 / Math.pow(i + 1, 0.55));
  const itemWeightTotal = itemWeights.reduce((a, b) => a + b, 0);
  const pickItem = () => {
    let r = rand() * itemWeightTotal;
    for (let i = 0; i < items.length; i++) {
      r -= itemWeights[i]!;
      if (r <= 0) return items[i]!;
    }
    return items[0]!;
  };

  await db.transaction("rw", db.customers, db.snack_items, async () => {
    await db.customers.bulkPut(customerRows);
    await db.snack_items.bulkPut(items);
  });

  let seq = 0;
  let rowCount = customerRows.length + items.length;
  const counts = {
    bookings: 0,
    payments: 0,
    sales: 0,
    bills: 0,
    expenses: 0,
    stockHistory: 0,
    tabEntries: 0,
    receipts: 0,
    receiptHashes: 0,
  };

  // Records written on the final day, candidates for the tab push in §7.
  const bookingDayCounters = new Map<string, number>();
  const saleDayCounters = new Map<string, number>();
  const billDayCounters = new Map<string, number>();
  const bookingTabCharges: { row: TurfBookingRow; cust: Cust; due: number }[] =
    [];
  const anchorDate = opts.anchor ?? localDateStr();
  const monthsRequested = opts.months ?? 12;
  const startWindowDate = new Date(
    Date.parse(anchorDate) - Math.round(monthsRequested * 30.4375 * 86400000),
  )
    .toISOString()
    .slice(0, 10);
  const endWindowDate = new Date(Date.parse(anchorDate) + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const monthChunks = monthChunksBetween(startWindowDate, endWindowDate);
  let lastDayBills: BillRow[] = [];
  let lastDayBookings: TurfBookingRow[] = [];
  let lastDayCustomers = new Map<string, Cust>();

  for (let chunkIndex = 0; chunkIndex < monthChunks.length; chunkIndex++) {
    const chunk = monthChunks[chunkIndex]!;
    const month = chunk.month;
    const chunkYear = chunk.year;
    const daysInMonth = chunk.days;
    const bookings: TurfBookingRow[] = [];
    const payments: PaymentRow[] = [];
    const sales: SnackSaleRow[] = [];
    const bills: BillRow[] = [];
    const expenses: ExpenseRow[] = [];
    const history: SnackStockHistoryRow[] = [];
    const monthBillOwner = new Map<string, Cust>();
    const monthBookingOwner = new Map<string, Cust>();

    for (let day = 1; day <= daysInMonth; day++) {
      const date = dateStr(chunkYear, month, day);
      if (date < startWindowDate || date > endWindowDate) continue;
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const weekend = dow === 0 || dow === 6;

      /* ---- turf bookings: scenario-driven, real payment rows ---- */
      const busy = (weekend ? 1.25 : 0.9) * (0.75 + bookingRand() * 0.6);
      const consumedCells = new Set<string>();
      for (let s = 0; s < LOAD_TEST_SLOTS.length; s++) {
        const slot = LOAD_TEST_SLOTS[s]!;
        const slotPull = 0.6 + (s / (LOAD_TEST_SLOTS.length - 1)) * 0.8;
        for (let court = 1; court <= LOAD_TEST_COURTS; court++) {
          const cellKey = `${s}:${court}`;
          if (consumedCells.has(cellKey)) continue;
          const chance =
            cfg.occupancy * busy * slotPull * (court === 1 ? 1 : 0.7);
          if (bookingRand() > chance) continue;
          const cust = pickCustomer();
          const rate = weekend ? 1400 : 1200;
          let courtsUsed = 1;
          while (
            courtsUsed < LOAD_TEST_COURTS - court + 1 &&
            !consumedCells.has(`${s}:${court + courtsUsed}`) &&
            bookingRand() < 0.12
          )
            courtsUsed++;
          let hours = 1;
          if (
            s + 1 < LOAD_TEST_SLOTS.length &&
            bookingRand() < (weekend ? 0.12 : 0.06)
          ) {
            let nextFree = true;
            for (let c = court; c < court + courtsUsed; c++)
              if (consumedCells.has(`${s + 1}:${c}`)) nextFree = false;
            if (nextFree) hours = 2;
          }
          for (let c = court; c < court + courtsUsed; c++) {
            consumedCells.add(`${s}:${c}`);
            if (hours === 2) consumedCells.add(`${s + 1}:${c}`);
          }

          const turfAmount = rupees(rate * hours * courtsUsed);
          const roll = bookingRand();
          const discount =
            roll < 0.6
              ? 0
              : roll < 0.85
                ? rupees(turfAmount * (0.05 + bookingRand() * 0.15))
                : 100;
          const total = Math.max(0, rupees(turfAmount - discount));
          const scenario = pickBookingScenario(bookingRand);
          const legacy = scenario === "B14";
          const gross =
            total + (legacy ? 0 : freezeTax(total, taxSettings).taxAmount);
          const advanceFraction = [0, 0.3, 0.5, 0.7, 1][
            Math.floor(bookingRand() * 5)
          ]!;
          const createdDays = Math.min(7, 1 + Math.floor(bookingRand() * 7));
          const createdDate = new Date(
            Date.parse(date) - createdDays * 86400000,
          )
            .toISOString()
            .slice(0, 10);
          const createdAt = isoAt(createdDate, 9, (s * 7 + court) % 60);
          let entries: { amount: number; mode: "Cash" | "UPI" | "Card" }[] = [];
          let collections: {
            receivedAt: string;
            entries: { amount: number; mode: "Cash" | "UPI" | "Card" }[];
          }[] = [];
          let tabDue = 0;
          let status: string;
          let isRefundable: boolean | undefined;
          let notes = "load-test";
          if (legacy) {
            const rawAdvance = rupees(total * advanceFraction);
            entries = [];
            status =
              rawAdvance >= total && total > 0
                ? "Completed"
                : rawAdvance > 0
                  ? "Confirmed"
                  : "Confirmed";
          } else if (scenario === "B9") {
            entries = singleCollection(
              rupees(
                gross *
                  (bookingRand() < 0.34 ? 0.3 : bookingRand() < 0.5 ? 0.5 : 1),
              ),
              bookingRand,
            );
            collections = entries.length
              ? [{ receivedAt: createdAt, entries }]
              : [];
            status = "Cancelled";
          } else if (scenario === "B10") {
            entries = singleCollection(
              rupees(gross * (bookingRand() < 0.5 ? 0.3 : 0.5)),
              bookingRand,
            );
            collections = entries.length
              ? [{ receivedAt: createdAt, entries }]
              : [];
            status = "Cancelled";
            isRefundable = true;
          } else if (scenario === "B11") {
            entries =
              bookingRand() < 0.5
                ? []
                : singleCollection(rupees(gross * 0.5), bookingRand);
            collections = entries.length
              ? [{ receivedAt: createdAt, entries }]
              : [];
            status = "No-show";
          } else if (scenario === "B8") {
            const adv = rupees(gross * advanceFraction);
            entries =
              adv > 0
                ? bookingRand() < 0.5
                  ? singleCollection(adv, bookingRand)
                  : splitCollection(adv, bookingRand)
                : [];
            collections = entries.length
              ? [{ receivedAt: createdAt, entries }]
              : [];
            tabDue = Math.max(0, gross - adv);
            status = "Completed";
            notes += ` · ₹${tabDue} moved to tab`;
          } else if (scenario === "B7") {
            const adv = rupees(gross * (bookingRand() < 0.5 ? 0.3 : 0.5));
            entries = adv > 0 ? singleCollection(adv, bookingRand) : [];
            // Copy: `entries` grows below with the later collection, and sharing the
            // array would write that later payment into the first collection too.
            collections = entries.length
              ? [{ receivedAt: createdAt, entries: [...entries] }]
              : [];
            if (bookingRand() < 0.55) {
              const later = new Date(
                Date.parse(date) +
                  Math.min(45, 7 + Math.floor(bookingRand() * 38)) * 86400000,
              )
                .toISOString()
                .slice(0, 10);
              if (later <= endWindowDate) {
                const laterEntries = singleCollection(
                  Math.min(gross - adv, rupees((gross - adv) * 0.5)),
                  bookingRand,
                );
                entries.push(...laterEntries);
                if (laterEntries.length)
                  collections.push({
                    receivedAt: isoAt(later, 12, 0),
                    entries: laterEntries,
                  });
              }
            }
            status = "Confirmed";
          } else if (scenario === "B6") {
            entries = splitCollection(gross, bookingRand);
            collections = entries.length
              ? [{ receivedAt: createdAt, entries }]
              : [];
            status = "Completed";
          } else if (scenario === "B5") {
            const adv = rupees(gross * 0.5);
            const a = splitCollection(adv, bookingRand);
            const b = splitCollection(gross - adv, bookingRand);
            entries = [...a, ...b];
            collections = [];
            if (a.length)
              collections.push({ receivedAt: createdAt, entries: a });
            if (b.length)
              collections.push({ receivedAt: isoAt(date, 18, 0), entries: b });
            status = "Completed";
          } else if (scenario === "B4") {
            const adv = rupees(gross * 0.5);
            const a = singleCollection(adv, bookingRand);
            const b = splitCollection(gross - adv, bookingRand);
            entries = [...a, ...b];
            collections = [];
            if (a.length)
              collections.push({ receivedAt: createdAt, entries: a });
            if (b.length)
              collections.push({ receivedAt: isoAt(date, 18, 0), entries: b });
            status = "Completed";
          } else if (scenario === "B3") {
            const adv = rupees(gross * 0.5);
            const a = splitCollection(adv, bookingRand);
            const b = singleCollection(gross - adv, bookingRand);
            entries = [...a, ...b];
            collections = [];
            if (a.length)
              collections.push({ receivedAt: createdAt, entries: a });
            if (b.length)
              collections.push({ receivedAt: isoAt(date, 18, 0), entries: b });
            status = "Completed";
          } else if (scenario === "B2") {
            const adv = rupees(gross * 0.5);
            const a = singleCollection(adv, bookingRand);
            const b = singleCollection(gross - adv, bookingRand);
            entries = [...a, ...b];
            collections = [];
            if (a.length)
              collections.push({ receivedAt: createdAt, entries: a });
            if (b.length)
              collections.push({ receivedAt: isoAt(date, 18, 0), entries: b });
            status = "Completed";
          } else {
            entries = singleCollection(gross, bookingRand);
            collections = entries.length
              ? [{ receivedAt: isoAt(date, 18, 0), entries }]
              : [];
            status = "Completed";
          }

          // B13 overlay: for 5% of B2–B5, move the advance into the previous
          // calendar month when possible; otherwise move the balance collection
          // into the next calendar month while remaining inside the window.
          if (
            collections.length > 1 &&
            ["B2", "B3", "B4", "B5"].includes(scenario) &&
            bookingRand() < 0.05
          ) {
            const previous = createdDate;
            const next = new Date(Date.parse(date) + 20 * 86400000)
              .toISOString()
              .slice(0, 10);
            if (
              previous.slice(0, 7) !== date.slice(0, 7) &&
              previous >= startWindowDate &&
              previous <= anchorDate
            ) {
              collections[0]!.receivedAt = isoAt(previous, 12, 0);
            } else if (
              next.slice(0, 7) !== date.slice(0, 7) &&
              next <= anchorDate &&
              next <= endWindowDate
            ) {
              collections[collections.length - 1]!.receivedAt = isoAt(
                next,
                18,
                0,
              );
            }
          }

          if (date > anchorDate) {
            entries = [];
            collections = [];
            tabDue = 0;
            status = "Confirmed";
          }
          if (scenario === "B9" || scenario === "B10" || scenario === "B11")
            tabDue = 0;
          const collected = entries.reduce((n, e) => n + e.amount, 0);
          const advancePaid =
            scenario === "B8"
              ? gross
              : legacy
                ? rupees(total * advanceFraction)
                : collected;
          if (
            status !== "Cancelled" &&
            status !== "No-show" &&
            scenario !== "B8" &&
            !legacy
          )
            status = collected >= gross ? "Completed" : "Confirmed";
          const tax = legacy ? null : freezeTax(total, taxSettings);
          seq++;
          const id = `${LT_ID}bk-${pad(seq)}`;
          const dayCounter = (bookingDayCounters.get(date) ?? 0) + 1;
          bookingDayCounters.set(date, dayCounter);
          const row: TurfBookingRow = {
            id,
            booking_no: `${LT_PREFIX}INV-${date}-${pad(dayCounter, 4)}`,
            booking_date: date,
            customer_name: cust.name,
            phone: cust.phone,
            slot_name: weekend ? "Weekends" : "Weekdays",
            hours,
            rate_per_hour: rate,
            total_amount: total,
            ...(tax
              ? { tax_amount: tax.taxAmount, tax_lines: tax.taxLines }
              : {}),
            advance_paid: advancePaid,
            payment_mode: legacy
              ? bookingRand() < 0.25
                ? "Pending"
                : (["Cash", "UPI", "Card"] as const)[
                    Math.floor(bookingRand() * 3)
                  ]!
              : collections.length
                ? primaryMode(collections[collections.length - 1]!.entries)
                : "Pending",
            status,
            ...(isRefundable !== undefined
              ? { is_refundable: isRefundable }
              : {}),
            discount,
            notes,
            start_time: slot.start,
            end_time: hours === 2 ? LOAD_TEST_SLOTS[s + 1]!.end : slot.end,
            courts: courtsUsed,
            snacks: [],
            snacks_total: 0,
            turf_amount: turfAmount,
            created_at: createdAt,
            merged_into_bill_id: null,
          };
          bookings.push(row);
          monthBookingOwner.set(id, cust);
          if (collections.length && !legacy) {
            for (let ci = 0; ci < collections.length; ci++) {
              const c = collections[ci]!;
              payments.push(
                ...bookingPaymentRows(
                  id,
                  seq * 100 + ci,
                  c.receivedAt,
                  c.entries,
                ),
              );
            }
          }
          if (tabDue > 0) bookingTabCharges.push({ row, cust, due: tabDue });
        }
      }
      /* ---- snack sales: deterministic scenario + real payment rows ---- */
      const saleCount = Math.max(
        0,
        Math.round(cfg.sales * (weekend ? 1.4 : 1) * (0.6 + salesRand())),
      );
      for (let n = 0; n < saleCount; n++) {
        const isWalkIn = salesRand() < 0.1;
        const cust = isWalkIn ? null : pickCustomer();
        const lineCount = 1 + Math.floor(salesRand() * 3);
        const lines: {
          item_name: string;
          qty: number;
          unit_price: number;
          cost_price: number;
          amount: number;
        }[] = [];
        let total = 0,
          profit = 0;
        for (let l = 0; l < lineCount; l++) {
          const item = pickItem();
          const have = stock.get(item.id) ?? 0;
          if (have <= 0) continue;
          const qty = Math.min(have, 1 + Math.floor(salesRand() * 3));
          const amount = rupees(item.unit_price * qty);
          lines.push({
            item_name: item.item_name,
            qty,
            unit_price: item.unit_price,
            cost_price: item.cost_price,
            amount,
          });
          total += amount;
          profit += rupees((item.unit_price - item.cost_price) * qty);
          const next = have - qty;
          stock.set(item.id, next);
          history.push({
            id: `${LT_ID}sh-${pad(++seq)}`,
            item_id: item.id,
            item_name: item.item_name,
            delta: -qty,
            previous_quantity: have,
            new_quantity: next,
            created_at: isoAt(date, 13, (n * 3 + l) % 60),
            reason: "sale",
          });
        }
        if (!lines.length) continue;
        const scenarioRoll = salesRand();
        const scenario =
          scenarioRoll < 0.5
            ? "cash"
            : scenarioRoll < 0.75
              ? "upi"
              : scenarioRoll < 0.87
                ? "split"
                : scenarioRoll < 0.94
                  ? "tab"
                  : scenarioRoll < 0.97
                    ? "void"
                    : scenarioRoll < 0.98
                      ? "corrected"
                      : "merged";
        const isCancelled = scenario === "void";
        if (isCancelled) {
          for (const line of lines) {
            const item = items.find((i) => i.item_name === line.item_name)!;
            const have = stock.get(item.id) ?? 0;
            const next = have + line.qty;
            stock.set(item.id, next);
            history.push({
              id: `${LT_ID}sh-${pad(++seq)}`,
              item_id: item.id,
              item_name: item.item_name,
              delta: line.qty,
              previous_quantity: have,
              new_quantity: next,
              created_at: isoAt(date, 14, (n * 3) % 60),
              reason: "sale_reversal",
            } as SnackStockHistoryRow);
          }
        }
        const tax = freezeTax(total, taxSettings);
        seq++;
        const id = `${LT_ID}sale-${pad(seq)}`;
        const dayNo = (saleDayCounters.get(date) ?? 0) + 1;
        saleDayCounters.set(date, dayNo);
        let mode: string = "Cash";
        let paymentEntries: {
          amount: number;
          mode: "Cash" | "UPI" | "Card";
        }[] = [];
        if (scenario === "cash") {
          mode = "Cash";
          paymentEntries = [
            { amount: rupees(total + tax.taxAmount), mode: "Cash" },
          ];
        } else if (scenario === "upi") {
          mode = "UPI";
          paymentEntries = [
            { amount: rupees(total + tax.taxAmount), mode: "UPI" },
          ];
        } else if (scenario === "split" || scenario === "corrected") {
          mode = "UPI";
          const gross = rupees(total + tax.taxAmount);
          const cash = rupees(gross * (0.25 + salesRand() * 0.25));
          paymentEntries = [
            { amount: cash, mode: "Cash" },
            { amount: gross - cash, mode: "UPI" },
          ];
        }
        // A walk-in has no tab to charge, so an "On tab" sale would be neither collected nor owed anywhere; walk-ins pay cash instead.
        else if (scenario === "tab" && cust) {
          mode = "On tab";
        } else if (scenario === "void") {
          mode = "Cash";
        } else {
          mode = "Cash";
          paymentEntries = [
            { amount: rupees(total + tax.taxAmount), mode: "Cash" },
          ];
        }
        const row: SnackSaleRow = {
          id,
          bill_no: `${LT_PREFIX}SB-${date}-${pad(dayNo, 4)}`,
          sale_date: date,
          customer_name: cust ? cust.name : "Walk-in",
          items: lines,
          total: rupees(total),
          tax_amount: tax.taxAmount,
          tax_lines: tax.taxLines,
          profit: rupees(profit),
          payment_mode: mode,
          notes: "load-test",
          booking_id: null,
          booking_no: null,
          created_at: isoAt(date, 13, n % 60),
          merged_into_bill_id: null,
          ...(isCancelled ? { cancelled: true } : {}),
        };
        sales.push(row);
        if (paymentEntries.length && !isCancelled && mode !== "On tab") {
          payments.push(
            ...paymentEntries.map((e, i) => ({
              id: `${LT_ID}pay-${pad(++seq, 7)}`,
              parent_type: "snack_sale" as const,
              parent_id: id,
              amount: e.amount,
              mode: e.mode,
              received_at: date,
              created_at: isoAt(date, 13, (n + i) % 60),
            })),
          );
        }
        if (scenario === "tab" && cust) {
          // Deferred until tab phase below; charge is created there from this sale.
        }
      }

      /* ---- bills: scenario-driven, with real payment rows ---- */
      const billCount = Math.round(cfg.bills * (billRand() < 0.5 ? 1 : 2));
      for (let n = 0; n < billCount; n++) {
        const cust = pickCustomer();
        const base = 400 + Math.floor(billRand() * 18) * 100;
        const discount =
          billRand() < 0.7 ? 0 : rupees(base * (0.05 + billRand() * 0.15));
        const total = Math.max(0, rupees(base - discount));
        const gross = rupees(total + freezeTax(total, taxSettings).taxAmount);
        const r = billRand();
        const scenario =
          r < 0.26
            ? "single"
            : r < 0.38
              ? "split"
              : r < 0.52
                ? "later"
                : r < 0.66
                  ? "partial"
                  : r < 0.88
                    ? "unpaid"
                    : r < 0.91
                      ? "cancelled"
                      : r < 0.95
                        ? "merged"
                        : "legacy";
        const tax =
          scenario === "legacy" ? undefined : freezeTax(total, taxSettings);
        const id = `${LT_ID}bill-${++seq}`;
        const dayNo = (billDayCounters.get(date) ?? 0) + 1;
        billDayCounters.set(date, dayNo);
        let entries: { amount: number; mode: "Cash" | "UPI" | "Card" }[] = [];
        if (scenario === "single")
          entries = [
            {
              amount: gross,
              mode: SINGLE_BILL_MODES[Math.floor(billRand() * 3)] ?? "Cash",
            },
          ];
        else if (scenario === "split") {
          const cash = rupees(gross * (0.25 + billRand() * 0.3));
          entries = [
            { amount: cash, mode: "Cash" },
            { amount: gross - cash, mode: billRand() < 0.5 ? "UPI" : "Card" },
          ];
        } else if (scenario === "later") {
          const first = rupees(gross * (0.3 + billRand() * 0.3));
          entries = [{ amount: first, mode: "Cash" }];
        } else if (scenario === "partial") {
          entries = [
            { amount: rupees(gross * (0.25 + billRand() * 0.25)), mode: "UPI" },
          ];
        } else if (scenario === "legacy") entries = [];
        else entries = [];
        const paid = entries.reduce((a, e) => a + e.amount, 0);
        const status =
          scenario === "cancelled"
            ? "cancelled"
            : scenario === "legacy"
              ? "paid"
              : paid >= gross
                ? "paid"
                : paid > 0
                  ? "partial"
                  : "unpaid";
        const row: BillRow = {
          id,
          invoice_no: `${LT_PREFIX}INV-${date}-${pad(dayNo, 4)}`,
          customer_name: cust.name,
          customer_phone: cust.phone,
          items: [
            {
              item: "Turf + snacks",
              rate: base,
              qty: 1,
              total: base,
              unit: "hr",
            },
          ],
          subtotal: base,
          discount,
          total,
          ...(tax
            ? { tax_amount: tax.taxAmount, tax_lines: tax.taxLines }
            : {}),
          amount_paid: paid,
          status,
          payment_mode: paid ? primaryMode(entries) : null,
          bill_date: isoAt(date, 19, n % 60),
          created_at: isoAt(date, 19, n % 60),
        };
        bills.push(row);
        monthBillOwner.set(id, cust);
        if (entries.length) {
          payments.push(
            ...entries.map((e, i) => ({
              id: `${LT_ID}pay-${pad(++seq, 7)}`,
              parent_type: "bill" as const,
              parent_id: id,
              amount: e.amount,
              mode: e.mode,
              received_at: isoAt(date, 19, i),
              created_at: isoAt(date, 19, i),
            })),
          );
          if (scenario === "later")
            payments.push({
              id: `${LT_ID}pay-${pad(++seq, 7)}`,
              parent_type: "bill",
              parent_id: id,
              amount: gross - paid,
              mode: "UPI",
              received_at: isoAt(
                dateStr(chunkYear, month, Math.min(daysInMonth, day + 1)),
                20,
                0,
              ),
              created_at: isoAt(
                dateStr(chunkYear, month, Math.min(daysInMonth, day + 1)),
                20,
                0,
              ),
            });
        }
      }

      /* ---- expenses ---- */
      if (rand() < cfg.expenses) {
        // Real categories the app renders icons for (see CATEGORY_ICONS in
        // expenses.ts) — previously "maintenance"/"ingredients" didn't
        // match any of these (wrong case, and "ingredients" isn't a real
        // category at all), so every load-test expense fell back to the
        // generic "Other" icon regardless of its actual category text.
        const turfCategories = [
          "Maintenance",
          "Electricity",
          "Rent",
          "Staff Wages",
          "Equipment",
          "Transport",
          "Other",
        ];
        const snackCategories = [
          "Raw Material",
          "Staff Wages",
          "Electricity",
          "Transport",
          "Other",
        ];
        const business = rand() < 0.5 ? "Turf" : "Snacks";
        const categories =
          business === "Turf" ? turfCategories : snackCategories;
        seq++;
        const expenseAmount = rupees(200 + rand() * 3000);
        const expenseMode =
          rand() < 0.55 ? "Cash" : rand() < 0.7 ? "UPI" : "Card";
        const expenseCash =
          expenseMode === "Cash"
            ? null
            : rand() < 0.25
              ? rupees(expenseAmount * (0.1 + rand() * 0.4))
              : 0;
        expenses.push({
          id: `${LT_ID}exp-${pad(seq)}`,
          expense_no: `${LT_PREFIX}TX-${pad(seq)}`,
          business,
          category: categories[Math.floor(rand() * categories.length)]!,
          description: "Load test expense",
          note: null,
          amount: expenseAmount,
          spent_at: date,
          receipt_path: null,
          created_at: isoAt(date, 11, 0),
          payment_mode: expenseMode,
          cash_part: expenseCash,
        });
      }
    }

    /* ---- monthly restock of anything that ran low ---- */
    const restockDate = dateStr(chunkYear, month, daysInMonth);
    if (restockDate >= startWindowDate && restockDate <= endWindowDate)
      for (const item of items) {
        const have = stock.get(item.id) ?? 0;
        if (have > item.low_stock_threshold) continue;
        const next = LOAD_TEST_STOCK_START;
        stock.set(item.id, next);
        history.push({
          id: `${LT_ID}sh-${pad(++seq)}`,
          item_id: item.id,
          item_name: item.item_name,
          delta: next - have,
          previous_quantity: have,
          new_quantity: next,
          created_at: isoAt(restockDate, 20, 0),
          reason: "purchase",
        });
      }

    /* ---- quarterly stock-takes: one shared batch per quarter ---- */
    const quarterMonths = [1, 4, 7, 10];
    const batchNoBase = Math.floor(
      monthChunks.findIndex((m) => m.year === year && m.month === month) / 3,
    );
    if (quarterMonths.includes(month)) {
      const takeDate = dateStr(chunkYear, month, Math.min(15, daysInMonth));
      if (takeDate >= startWindowDate && takeDate <= endWindowDate) {
        const batchId = `${LT_ID}batch-${String(batchNoBase + 1).padStart(3, "0")}`;
        for (const item of items) {
          const have = stock.get(item.id) ?? 0;
          const jitter =
            ((item.id.charCodeAt(item.id.length - 1) + month + chunkYear) % 7) -
            3;
          const target = Math.max(0, have + jitter);
          const next = target;
          stock.set(item.id, next);
          history.push({
            id: `${LT_ID}sh-${pad(++seq)}`,
            item_id: item.id,
            item_name: item.item_name,
            delta: next - have,
            previous_quantity: have,
            new_quantity: next,
            created_at: isoAt(takeDate, 18, 0),
            reason: "stock_take",
            batch_id: batchId,
          });
        }
      }
    }

    await db.transaction(
      "rw",
      [
        db.turf_bookings,
        db.snack_sales,
        db.bills,
        db.payments,
        db.expenses,
        db.snack_stock_history,
      ],
      async () => {
        if (bookings.length) await db.turf_bookings.bulkPut(bookings);
        if (sales.length) await db.snack_sales.bulkPut(sales);
        if (bills.length) await db.bills.bulkPut(bills);
        if (payments.length) await db.payments.bulkPut(payments);
        if (expenses.length) await db.expenses.bulkPut(expenses);
        if (history.length) await db.snack_stock_history.bulkPut(history);
      },
    );

    counts.bookings += bookings.length;
    counts.payments += payments.length;
    counts.sales += sales.length;
    counts.bills += bills.length;
    counts.expenses += expenses.length;
    counts.stockHistory += history.length;
    rowCount +=
      bookings.length +
      payments.length +
      sales.length +
      bills.length +
      expenses.length +
      history.length;

    if (chunkIndex === monthChunks.length - 1) {
      // Keep the whole final month; §7 prefers the last day and falls back to
      // earlier December records when the day itself has too few candidates.
      lastDayBills = bills;
      lastDayBookings = bookings;
      lastDayCustomers = new Map([...monthBillOwner, ...monthBookingOwner]);
    }

    onProgress?.({
      month: chunkIndex + 1,
      months: monthChunks.length,
      rows: rowCount,
    });
    // Yield to the UI between month chunks.
    await new Promise((r) => setTimeout(r, 0));
  }

  /* ---- Step 5: recurring expenses, budgets, turf rates, receipt photos ---- */
  {
    const monthKeys = monthChunks.map((m) => `${m.year}-${pad(m.month, 2)}`);
    const recurring: RecurringExpenseRow[] = [
      {
        id: `${LT_ID}rec-rent`,
        title: "Rent",
        business: "Turf",
        category: "Rent",
        amount: 5000,
        day_of_month: 1,
        is_active: true,
        last_posted_month: null,
        created_at: isoAt(startWindowDate, 6, 0),
      },
      {
        id: `${LT_ID}rec-electricity`,
        title: "Electricity",
        business: "Turf",
        category: "Electricity",
        amount: 1800,
        day_of_month: 5,
        is_active: true,
        last_posted_month: null,
        created_at: isoAt(startWindowDate, 6, 1),
      },
      {
        id: `${LT_ID}rec-wages`,
        title: "Staff Wages",
        business: "Turf",
        category: "Staff Wages",
        amount: 7000,
        day_of_month: 28,
        is_active: true,
        last_posted_month: null,
        created_at: isoAt(startWindowDate, 6, 2),
      },
    ];
    const budgets: BudgetRow[] = monthKeys.map((month, i) => ({
      id: `${LT_ID}budget-${month}`,
      month,
      amount: rupees(18000 + (i % 4) * 1000),
      created_at: isoAt(`${month}-01`, 6, 10),
    }));
    const recExpenses: ExpenseRow[] = [];
    for (const month of monthKeys) {
      const [yy, mm] = month.split("-").map(Number) as [number, number];
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      for (let i = 0; i < recurring.length; i++) {
        const r = recurring[i]!;
        const day = Math.min(r.day_of_month, lastDay);
        const date = dateStr(yy, mm, day);
        if (date < startWindowDate || date > anchorDate) continue;
        recExpenses.push({
          id: `${LT_ID}exp-rec-${month}-${i + 1}`,
          expense_no: `${LT_PREFIX}TX-${date}-${String(900 + i + 1).padStart(4, "0")}`,
          business: r.business,
          category: r.category,
          description: r.title,
          note: "Auto-added recurring expense",
          amount: r.amount,
          spent_at: date,
          receipt_path: null,
          created_at: isoAt(date, 7, i),
          payment_mode: "Cash",
          cash_part: null,
        });
        r.last_posted_month = month;
      }
    }
    // `expenses` (above) is scoped to each month chunk, so read back every
    // expense already written for this dataset, then add the recurring ones.
    const expenses: ExpenseRow[] = await db.expenses
      .where("id")
      .startsWith(LT_ID)
      .toArray();
    expenses.push(...recExpenses);
    // Ensure every seeded expense gets a deterministic receipt in Dexie.
    const receipts = [] as { path: string; blob: Blob; created_at: string }[];
    const hashes = [] as { path: string; sha256: string; created_at: string }[];
    for (const e of expenses) {
      const rr = await makeReceiptRows(e);
      e.receipt_path = rr.path;
      receipts.push({ path: rr.path, blob: rr.blob, created_at: e.created_at });
      hashes.push(rr.hash);
    }
    const rates: TurfRateRow[] = [
      {
        id: `${LT_ID}rate-weekdays`,
        slot_name: "Weekdays",
        rate_per_hour: 1200,
        rate_15: null,
        rate_30: null,
        rate_45: null,
        rate_60: 1200,
        allow_15: false,
        allow_30: false,
        allow_45: false,
        allow_60: true,
        is_active: true,
        created_at: isoAt(startWindowDate, 6, 20),
      },
      {
        id: `${LT_ID}rate-weekends`,
        slot_name: "Weekends",
        rate_per_hour: 1400,
        rate_15: null,
        rate_30: null,
        rate_45: null,
        rate_60: 1400,
        allow_15: false,
        allow_30: false,
        allow_45: false,
        allow_60: true,
        is_active: true,
        created_at: isoAt(startWindowDate, 6, 21),
      },
    ];
    await db.transaction(
      "rw",
      [
        db.expenses,
        db.receipts,
        db.receipt_hashes,
        db.recurring_expenses,
        db.expense_budgets,
        db.turf_rates,
      ],
      async () => {
        await db.expenses.bulkPut(expenses);
        await db.receipts.bulkPut(receipts);
        await db.receipt_hashes.bulkPut(hashes);
        await db.recurring_expenses.bulkPut(recurring);
        await db.expense_budgets.bulkPut(budgets);
        await db.turf_rates.bulkPut(rates);
      },
    );
    counts.expenses += recExpenses.length;
    counts.receipts += receipts.length;
    counts.receiptHashes += hashes.length;
    rowCount +=
      recExpenses.length +
      receipts.length +
      hashes.length +
      recurring.length +
      budgets.length +
      rates.length;
  }

  /* ---- Step 4: deterministic merged booking + snack-sale bills ----
   * Merge a small deterministic 2% cohort after both source domains exist.
   * Sources remain in their tables, but are excluded from their own revenue
   * after `merged_into_bill_id` is set. Their payment rows are COPIED to the
   * bill with new ids, matching merge.ts rather than moved/deleted. */
  {
    const allBookings = await db.turf_bookings
      .where("id")
      .startsWith(LT_ID)
      .toArray();
    const allSales = await db.snack_sales
      .where("id")
      .startsWith(LT_ID)
      .toArray();
    const eligibleBookings = allBookings.filter(
      (b) =>
        !b.merged_into_bill_id &&
        b.status !== "Cancelled" &&
        b.status !== "No-show",
    );
    const eligibleSales = allSales.filter(
      (s) => !s.merged_into_bill_id && !s.cancelled,
    );
    const usedB = new Set<string>();
    const usedS = new Set<string>();
    const billRows: BillRow[] = [];
    const copiedPayments: PaymentRow[] = [];
    const pairs = Math.max(1, Math.floor(eligibleSales.length * 0.02));
    for (let i = 0; i < eligibleSales.length && billRows.length < pairs; i++) {
      const sale = eligibleSales[i]!;
      const booking = eligibleBookings.find(
        (b) =>
          !usedB.has(b.id) &&
          b.customer_name === sale.customer_name &&
          b.booking_date === sale.sale_date,
      );
      if (!booking || usedS.has(sale.id)) continue;
      usedB.add(booking.id);
      usedS.add(sale.id);
      const taxable = rupees(booking.total_amount + sale.total);
      const tax = freezeTax(taxable, taxSettings);
      const gross = rupees(taxable + tax.taxAmount);
      const sourcePayments = await db.payments
        .filter(
          (p) =>
            (p.parent_type === "turf_booking" && p.parent_id === booking.id) ||
            (p.parent_type === "snack_sale" && p.parent_id === sale.id),
        )
        .toArray();
      const collected = sourcePayments.reduce((a, p) => a + p.amount, 0);
      const id = `${LT_ID}bill-merge-${String(billRows.length + 1).padStart(5, "0")}`;
      const date = sale.sale_date;
      const dayNo = (billDayCounters.get(date) ?? 0) + 1;
      billDayCounters.set(date, dayNo);
      const bill: BillRow = {
        id,
        invoice_no: `${LT_PREFIX}INV-${date}-${pad(dayNo, 4)}`,
        customer_name: sale.customer_name ?? booking.customer_name,
        customer_phone: booking.phone ?? null,
        items: [
          {
            item: "Merged turf + snacks",
            booking_id: booking.id,
            sale_id: sale.id,
          },
        ],
        subtotal: taxable,
        discount: 0,
        total: taxable,
        tax_amount: tax.taxAmount,
        tax_lines: tax.taxLines,
        amount_paid: Math.min(collected, gross),
        status:
          collected >= gross ? "paid" : collected > 0 ? "partial" : "unpaid",
        payment_mode: null,
        bill_date: isoAt(date, 19, 0),
        created_at: isoAt(date, 19, 0),
      };
      billRows.push(bill);
      let copiedTotal = 0;
      for (let j = 0; j < sourcePayments.length && copiedTotal < gross; j++) {
        const p = sourcePayments[j]!;
        const amount = Math.min(p.amount, gross - copiedTotal);
        if (amount <= 0) continue;
        copiedTotal += amount;
        copiedPayments.push({
          ...p,
          id: `${LT_ID}pay-merge-${String(copiedPayments.length + 1).padStart(7, "0")}`,
          parent_type: "bill",
          parent_id: id,
          amount,
          created_at: new Date(Date.parse(p.created_at) + 1).toISOString(),
        });
      }
      booking.merged_into_bill_id = id;
      sale.merged_into_bill_id = id;
    }
    if (billRows.length) {
      await db.transaction(
        "rw",
        db.turf_bookings,
        db.snack_sales,
        db.bills,
        db.payments,
        async () => {
          await db.turf_bookings.bulkPut(
            eligibleBookings.filter((b) => usedB.has(b.id)),
          );
          await db.snack_sales.bulkPut(
            eligibleSales.filter((s) => usedS.has(s.id)),
          );
          await db.bills.bulkPut(billRows);
          if (copiedPayments.length) await db.payments.bulkPut(copiedPayments);
        },
      );
      counts.bills += billRows.length;
      counts.payments += copiedPayments.length;
      rowCount += billRows.length + copiedPayments.length;
    }
  }

  // Link 8% of non-walk-in sales to an existing same-day booking for the same customer.
  {
    const bs = await db.turf_bookings.where("id").startsWith(LT_ID).toArray();
    const ss = await db.snack_sales.where("id").startsWith(LT_ID).toArray();
    const used = new Set<string>();
    const links: SnackSaleRow[] = [];
    for (const sale of ss.filter(
      (x) => x.customer_name && !x.cancelled && !x.merged_into_bill_id,
    )) {
      const target = bs.find(
        (b) =>
          !used.has(b.id) &&
          !b.merged_into_bill_id &&
          b.customer_name === sale.customer_name &&
          b.booking_date === sale.sale_date,
      );
      if (target && (parseInt(sale.id.replace(/\D/g, ""), 10) || 0) % 12 < 1) {
        sale.booking_id = target.id;
        sale.booking_no = target.booking_no;
        used.add(target.id);
        links.push(sale);
      }
    }
    if (links.length) await db.snack_sales.bulkPut(links);
  }

  /* ---- Step 6: deterministic day closes for the 60 days before anchor ---- */
  {
    const [anchorYear, anchorMonth, anchorDay] = anchorDate
      .split("-")
      .map(Number) as [number, number, number];
    const taggedPayments = await db.payments
      .where("id")
      .startsWith(LT_ID)
      .toArray();
    const taggedExpenses = await db.expenses
      .where("id")
      .startsWith(LT_ID)
      .toArray();
    const closes: DayCloseRow[] = [];
    const histories: DayCloseHistoryRow[] = [];
    for (let offset = 60; offset >= 1; offset--) {
      const d = new Date(
        Date.UTC(anchorYear, anchorMonth - 1, anchorDay - offset),
      );
      const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
      const cashIn = taggedPayments
        .filter(
          (p) =>
            String(p.received_at).slice(0, 10) === day && p.mode === "Cash",
        )
        .reduce((a, p) => a + p.amount, 0);
      const cashOut = taggedExpenses
        .filter((e) => e.spent_at === day)
        .reduce(
          (a, e) =>
            a + (e.payment_mode === "Cash" ? e.amount : (e.cash_part ?? 0)),
          0,
        );
      const expected = rupees(cashIn - cashOut);
      const variance = offset % 5 === 0 ? ((offset * 17) % 101) - 50 : 0;
      const counted = expected + variance;
      const id = `${LT_ID}day-close-${day}`;
      closes.push({
        id,
        day,
        expected_in_drawer: expected,
        counted_cash: counted,
        variance,
        note: variance ? "Load test count amendment" : null,
        closed_at: isoAt(day, 21, 0),
        created_at: isoAt(day, 21, 0),
      });
      if (offset % 12 === 0) {
        histories.push({
          id: `${LT_ID}day-close-history-${day}`,
          day,
          previous_expected_in_drawer: expected,
          previous_counted_cash: expected,
          previous_variance: 0,
          previous_note: null,
          previous_closed_at: isoAt(day, 21, 0),
          amended_at: isoAt(day, 21, 5),
        });
      }
    }
    await db.transaction(
      "rw",
      db.day_closes,
      db.day_close_history,
      async () => {
        if (closes.length) await db.day_closes.bulkPut(closes);
        if (histories.length) await db.day_close_history.bulkPut(histories);
      },
    );
  }

  /* ---- persist final stock levels ---- */
  await db.transaction("rw", db.snack_items, async () => {
    for (const item of items) {
      await db.snack_items.update(item.id, {
        stock_quantity: stock.get(item.id) ?? 0,
        stock_updated_at: isoAt(endWindowDate, 20, 0),
      });
    }
  });

  /* ---- §7: push a handful of the final day's records onto tabs ---- */
  const lastDate = endWindowDate;
  const tabs = new Map<string, CustomerTabRow>();
  const entries: TabEntryRow[] = [];
  let tabSeq = 0;

  const chargeFor = (
    cust: { name: string; phone: string | null },
    amount: number,
    business: string,
    refType: string,
    refId: string,
  ) => {
    const value = rupees(amount);
    if (value <= 0) return;
    const key = tabKey(cust.name, cust.phone);
    let tab = tabs.get(key);
    if (!tab) {
      tab = {
        id: `${LT_ID}tab-${pad(tabs.size, 3)}`,
        customer_key: key,
        customer_name: cust.name,
        phone: cust.phone,
        status: "open",
        opened_at: isoAt(lastDate, 21, 0),
        closed_at: null,
        created_at: isoAt(lastDate, 21, 0),
      };
      tabs.set(key, tab);
    }
    entries.push({
      id: `${LT_ID}tabentry-${pad(++tabSeq, 3)}`,
      tab_id: tab.id,
      customer_key: key,
      kind: "charge",
      business,
      amount: value,
      note: "Load test — moved to dues",
      ref_type: refType,
      ref_id: refId,
      source_ref_type: null,
      source_ref_id: null,
      payment_mode: null,
      entry_date: lastDate,
      created_at: isoAt(lastDate, 21, 0),
    });
  };

  // Snack sales marked On tab become real tab charges; they never create payment rows.
  const taggedSalesForTabs = await db.snack_sales
    .where("id")
    .startsWith(LT_ID)
    .toArray();
  for (const sale of taggedSalesForTabs.filter(
    (s) =>
      s.payment_mode === "On tab" && !s.cancelled && !s.merged_into_bill_id,
  )) {
    const cust = customerRows.find((c) => c.name === sale.customer_name);
    if (cust)
      chargeFor(
        cust,
        sale.total + (sale.tax_amount ?? 0),
        "Snacks",
        "snack_sale",
        sale.id,
      );
  }

  // B8 scenario charges: the booking itself is marked fully collected while
  // the outstanding amount is represented by a real customer-tab charge.
  for (const c of bookingTabCharges) {
    chargeFor(c.cust, c.due, "Turf", TAB_REF_TURF_BOOKING, c.row.id);
  }

  // Settle roughly half of generated B8 charges using the real tab-entry
  // shape. A split settlement is represented by one payment entry per mode
  // on the same date; the other half deliberately remains open.
  for (let i = 0; i < bookingTabCharges.length; i += 2) {
    const c = bookingTabCharges[i]!;
    const key = tabKey(c.cust.name, c.cust.phone);
    const tab = tabs.get(key);
    if (!tab) continue;
    const settleDate = new Date(Date.parse(c.row.booking_date) + 14 * 86400000)
      .toISOString()
      .slice(0, 10);
    if (settleDate > anchorDate) continue;
    const cash = rupees(c.due * 0.4);
    const online = c.due - cash;
    const parts = [
      ...(cash > 0 ? [{ amount: cash, mode: "Cash" as const }] : []),
      ...(online > 0 ? [{ amount: online, mode: "UPI" as const }] : []),
    ];
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]!;
      entries.push({
        id: `${LT_ID}tabentry-${pad(++tabSeq, 3)}`,
        tab_id: tab.id,
        customer_key: key,
        kind: "payment",
        business: "Shared",
        amount: part.amount,
        note: pi === parts.length - 1 ? "Final settlement" : null,
        ref_type: null,
        ref_id: null,
        source_ref_type: null,
        source_ref_id: null,
        payment_mode: part.mode,
        entry_date: settleDate,
        created_at: new Date(
          Date.parse(isoAt(settleDate, 12, 0)) + pi,
        ).toISOString(),
      });
    }
  }

  // Last-day records first, topped up from the rest of December when needed.
  const dayFirst = <T>(rows: T[], onDay: (r: T) => boolean) => [
    ...rows.filter(onDay),
    ...rows.filter((r) => !onDay(r)),
  ];
  const billCandidates = dayFirst(
    lastDayBills,
    (b) => b.created_at.slice(0, 10) === lastDate,
  ).filter(
    (b) =>
      b.status !== "paid" &&
      b.status !== "cancelled" &&
      b.total - b.amount_paid > 0,
  );
  const bookingCandidates = dayFirst(
    lastDayBookings,
    (b) => b.booking_date === lastDate,
  ).filter(
    (b) => b.status !== "Cancelled" && b.total_amount - b.advance_paid > 0,
  );
  const billsToTab = billCandidates.slice(
    0,
    Math.ceil(LAST_DAY_TAB_RECORDS / 2),
  );
  const bookingsToTab = bookingCandidates.slice(
    0,
    LAST_DAY_TAB_RECORDS - billsToTab.length,
  );

  for (const b of billsToTab) {
    const cust = lastDayCustomers.get(b.id);
    if (cust)
      chargeFor(cust, b.total - b.amount_paid, "Snacks", TAB_REF_BILL, b.id);
  }
  for (const b of bookingsToTab) {
    const cust = lastDayCustomers.get(b.id);
    if (cust)
      chargeFor(
        cust,
        b.total_amount - b.advance_paid,
        "Turf",
        TAB_REF_TURF_BOOKING,
        b.id,
      );
  }

  /* ---- §7b: hand-placed tab activity earlier in the year ----
   * §7 above only ever writes "charge" rows, all dated the final day — the
   * "payment" entry kind and tab-closing are never exercised by the
   * generated dataset. Two of the regular customers (customerRows[0]/[1],
   * the most-weighted — so also the customers most likely to show up
   * elsewhere in their own booking/sale history) get a small hand-placed
   * ledger instead: */
  const manualEntry = (
    cust: Pick<CustomerRow, "id" | "name" | "phone">,
    kind: "charge" | "payment",
    amount: number,
    business: string,
    date: string,
    note: string,
  ) => {
    const value = rupees(amount);
    if (value <= 0) return;
    const key = tabKey(cust.name, cust.phone);
    let tab = tabs.get(key);
    if (!tab) {
      tab = {
        id: `${LT_ID}tab-${pad(tabs.size, 3)}`,
        customer_key: key,
        customer_name: cust.name,
        phone: cust.phone,
        status: "open",
        opened_at: isoAt(date, 12, 0),
        closed_at: null,
        created_at: isoAt(date, 12, 0),
      };
      tabs.set(key, tab);
    }
    entries.push({
      id: `${LT_ID}tabentry-${pad(++tabSeq, 3)}`,
      tab_id: tab.id,
      customer_key: key,
      kind,
      business,
      amount: value,
      note,
      ref_type: null,
      ref_id: null,
      source_ref_type: null,
      source_ref_id: null,
      payment_mode: kind === "payment" ? "Cash" : null,
      entry_date: date,
      created_at: isoAt(date, 12, 0),
    });
  };

  const regular1 = customerRows[0]!;
  const regular2 = customerRows[1]!;

  // Regular #1: a manual due charged mid-year, paid off in full a week
  // later, tab explicitly closed — the ordinary "settle and close" flow.
  manualEntry(
    regular1,
    "charge",
    800,
    "Turf",
    dateStr(year, 6, 10),
    "Load test — manual due",
  );
  manualEntry(
    regular1,
    "payment",
    800,
    "Shared",
    dateStr(year, 6, 17),
    "Load test — settled",
  );
  const closedTab = tabs.get(tabKey(regular1.name, regular1.phone));
  if (closedTab) {
    closedTab.status = "closed";
    closedTab.closed_at = isoAt(dateStr(year, 6, 17), 12, 0);
  }

  // Regular #2: charged, then only PARTLY paid a couple of weeks later —
  // stays open with a real balance, separate from (and earlier than) the
  // Dec-31 "moved to dues" push, exercising the ordinary partial-payment
  // flow on its own.
  manualEntry(
    regular2,
    "charge",
    1200,
    "Snacks",
    dateStr(year, 3, 5),
    "Load test — manual due",
  );
  manualEntry(
    regular2,
    "payment",
    500,
    "Shared",
    dateStr(year, 3, 20),
    "Load test — part payment",
  );

  if (entries.length) {
    await db.transaction("rw", db.customer_tabs, db.tab_entries, async () => {
      await db.customer_tabs.bulkPut([...tabs.values()]);
      await db.tab_entries.bulkPut(entries);
    });
  }
  counts.tabEntries = entries.length;
  rowCount += entries.length + tabs.size;

  // Step 6 built the day closes before any tab entry existed, but the app's
  // cash drawer (paymentSplit's Cash on that day) also counts cash collected
  // against a tab. Fold those payments into each affected close, keeping its
  // deliberate count variance and its amendment-history snapshot consistent.
  {
    const tabCash = new Map<string, number>();
    for (const e of entries) {
      if (
        e.kind === "payment" &&
        !e.ref_type &&
        (e.payment_mode ?? "Cash") === "Cash"
      )
        tabCash.set(
          e.entry_date,
          (tabCash.get(e.entry_date) ?? 0) + rupees(e.amount),
        );
    }
    const closesNow = (
      await db.day_closes.where("id").startsWith(LT_ID).toArray()
    ).filter((c) => tabCash.has(c.day));
    const historyNow = (
      await db.day_close_history.where("id").startsWith(LT_ID).toArray()
    ).filter((h) => tabCash.has(h.day));
    for (const c of closesNow) {
      c.expected_in_drawer += tabCash.get(c.day)!;
      c.counted_cash = c.expected_in_drawer + c.variance;
    }
    for (const h of historyNow) {
      h.previous_expected_in_drawer += tabCash.get(h.day)!;
      h.previous_counted_cash += tabCash.get(h.day)!;
    }
    if (closesNow.length) await db.day_closes.bulkPut(closesNow);
    if (historyNow.length) await db.day_close_history.bulkPut(historyNow);
  }

  await resyncCounters();

  return {
    year: Number(anchorDate.slice(0, 4)),
    customers: customerRows.length,
    snackItems: items.length,
    ...counts,
    total: rowCount,
  };
}

/* ------------------------------------------------------------------ */
/* Counting + cleanup                                                   */
/* ------------------------------------------------------------------ */

const ltIds = <T extends { id: string }>(rows: T[]) =>
  rows.filter((r) => r.id.startsWith(LT_ID)).map((r) => r.id);

export type LoadTestCounts = {
  customers: number;
  snackItems: number;
  bookings: number;
  payments: number;
  receipts: number;
  receiptHashes: number;
  sales: number;
  bills: number;
  expenses: number;
  stockHistory: number;
  tabEntries: number;
  tabs: number;
  dayCloses: number;
  dayCloseHistory: number;
  total: number;
};

export async function countLoadTestRows(): Promise<LoadTestCounts> {
  const [
    customers,
    items,
    bookings,
    payments,
    sales,
    bills,
    expenses,
    history,
    entries,
    tabs,
    receipts,
    hashes,
    rates,
    budgets,
    recurring,
    dayCloses,
    dayCloseHistory,
  ] = await Promise.all([
    db.customers.toArray(),
    db.snack_items.toArray(),
    db.turf_bookings.toArray(),
    db.payments.toArray(),
    db.snack_sales.toArray(),
    db.bills.toArray(),
    db.expenses.toArray(),
    db.snack_stock_history.toArray(),
    db.tab_entries.toArray(),
    db.customer_tabs.toArray(),
    db.receipts.toArray(),
    db.receipt_hashes.toArray(),
    db.turf_rates.toArray(),
    db.expense_budgets.toArray(),
    db.recurring_expenses.toArray(),
    db.day_closes.toArray(),
    db.day_close_history.toArray(),
  ]);
  const out: LoadTestCounts = {
    customers: ltIds(customers).length,
    snackItems: ltIds(items).length,
    bookings: ltIds(bookings).length,
    payments: ltIds(payments).length,
    receipts: receipts.filter((r) => r.path.includes("/lt-")).length,
    receiptHashes: hashes.filter((r) => r.path.includes("/lt-")).length,
    sales: ltIds(sales).length,
    bills: ltIds(bills).length,
    expenses: ltIds(expenses).length,
    stockHistory: ltIds(history).length,
    tabEntries: ltIds(entries).length,
    tabs: ltIds(tabs).length,
    dayCloses: ltIds(dayCloses).length,
    dayCloseHistory: ltIds(dayCloseHistory).length,
    total: 0,
  };
  out.total =
    out.customers +
    out.snackItems +
    out.bookings +
    out.payments +
    out.receipts +
    out.receiptHashes +
    out.sales +
    out.bills +
    out.expenses +
    out.stockHistory +
    out.tabEntries +
    out.tabs +
    out.dayCloses +
    out.dayCloseHistory;
  return out;
}

/** Removes every row this module wrote — including the seeded customers,
 * snack items, stock history, tab entries and tabs — and nothing else.
 *
 * Every affected table's primary key is `id`, and every lt-seeded id starts
 * with the fixed `LT_ID` prefix, so the ids to remove always form one
 * contiguous range in primary-key order. `.where("id").startsWith(LT_ID).delete()`
 * lets Dexie/IndexedDB delete that whole range in a single request instead of
 * one delete-by-key request per row (the previous read-all -> filter ->
 * bulkDelete(ids) shape). On real IndexedDB this is a minor win; on the
 * fake-indexeddb harness the scripts/tests run under it's the difference
 * between one linear index scan total and one per deleted row, which is what
 * made clearing a full seeded year (tens of thousands of rows) take minutes
 * instead of milliseconds. */
export async function clearLoadTestData(): Promise<LoadTestCounts> {
  const before = await countLoadTestRows();

  const wipe = <T extends { id: string }>(table: Table<T, string>) =>
    table.where("id").startsWith(LT_ID).delete();

  await wipe(db.turf_bookings);
  await wipe(db.payments);
  await wipe(db.snack_sales);
  await wipe(db.bills);
  await wipe(db.expenses);
  await wipe(db.snack_stock_history);
  await wipe(db.snack_items);
  await wipe(db.customers);
  await wipe(db.tab_entries);
  await wipe(db.customer_tabs);
  await wipe(db.turf_rates);
  await wipe(db.expense_budgets);
  await wipe(db.recurring_expenses);
  // receipts/receipt_hashes are keyed by `path` (Receipts/<date>/lt-<id>.png),
  // not `id`, and the lt- tag sits mid-string rather than as a key prefix, so
  // they don't form a single range — kept as read -> filter -> bulkDelete.
  const receiptPaths = (await db.receipts.toArray())
    .filter((r) => r.path.includes("/lt-"))
    .map((r) => r.path);
  if (receiptPaths.length) await db.receipts.bulkDelete(receiptPaths);
  const hashPaths = (await db.receipt_hashes.toArray())
    .filter((r) => r.path.includes("/lt-"))
    .map((r) => r.path);
  if (hashPaths.length) await db.receipt_hashes.bulkDelete(hashPaths);
  await wipe(db.day_closes);
  await wipe(db.day_close_history);

  await resyncCounters();
  return before;
}

/* ------------------------------------------------------------------ */
/* Benchmark — a SINGLE run over the one seeded year                    */
/* ------------------------------------------------------------------ */

export type LoadTestBenchmark = {
  ranAt: string;
  year: number;
  anchor: string;
  months: 12 | 14;
  rows: number;
  payments: number;
  receipts: number;
  receiptHashes: number;
  receiptBytes: number;
  readMs: number;
  analyticsMs: number;
  pdfMs: number;
  totalMs: number;
  datasetHash: string;
};

const ms = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Times the three things that get slow on a big dataset: reading the year
 * out of IndexedDB, running the dashboard/report analytics over it, and
 * building a report PDF from the result. One year in, one row of results out.
 */
export async function runLoadTestBenchmark(
  opts: { anchor?: string; months?: 12 | 14 } = {},
): Promise<LoadTestBenchmark> {
  const anchor = opts.anchor ?? localDateStr();
  const months = opts.months ?? 12;
  const year = Number(anchor.slice(0, 4));
  const started = ms();
  const t0 = ms();
  const [
    bills,
    bookings,
    sales,
    expenses,
    tabEntries,
    payments,
    receipts,
    receiptHashes,
  ] = await Promise.all([
    db.bills.toArray(),
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.expenses.toArray(),
    db.tab_entries.toArray(),
    db.payments.toArray(),
    db.receipts.toArray(),
    db.receipt_hashes.toArray(),
  ]);
  const readMs = ms() - t0;
  const startDate = new Date(Date.parse(`${anchor}T00:00:00Z`));
  startDate.setUTCMonth(startDate.getUTCMonth() - months);
  const start = localDateStr(startDate);
  const inWindow = (value: string) => {
    const d = String(value).slice(0, 10);
    return d >= start && d <= anchor;
  };
  const src = {
    bills: bills.filter((r) => inWindow(r.bill_date)),
    bookings: bookings.filter((r) => inWindow(r.booking_date)),
    sales: sales.filter((r) => inWindow(r.sale_date)),
    expenses: expenses.filter((r) => inWindow(r.spent_at)),
    tabEntries: tabEntries.filter((r) => inWindow(r.entry_date)),
  } as unknown as Sources;
  const t1 = ms();
  const stats = periodStats(src, inWindow);
  const analyticsMs = ms() - t1;
  const ltPayments = payments.filter((r) => String(r.id).startsWith(LT_ID));
  const ltReceipts = receipts.filter((r) => r.path.includes("/lt-"));
  const ltHashes = receiptHashes.filter((r) => r.path.includes("/lt-"));
  const canonical = JSON.stringify({
    bills: src.bills,
    bookings: src.bookings,
    sales: src.sales,
    expenses: src.expenses,
    tabEntries: src.tabEntries,
    payments: ltPayments,
    receipts: ltReceipts.map((r) => ({
      path: r.path,
      size: r.blob.size,
      type: r.blob.type,
    })),
    receiptHashes: ltHashes,
  });
  const datasetHash = await sha256Hex(new TextEncoder().encode(canonical));
  const receiptBytes = ltReceipts.reduce((sum, r) => sum + r.blob.size, 0);
  const t2 = ms();
  buildReportPdf(benchmarkDoc(year, stats, 0, 0, 0));
  const pdfMs = ms() - t2;
  return {
    ranAt: nowIso(),
    year,
    anchor,
    months,
    rows:
      src.bills.length +
      src.bookings.length +
      src.sales.length +
      src.expenses.length +
      (src.tabEntries?.length ?? 0) +
      ltPayments.length,
    payments: ltPayments.length,
    receipts: ltReceipts.length,
    receiptHashes: ltHashes.length,
    receiptBytes,
    readMs: Math.round(readMs),
    analyticsMs: Math.round(analyticsMs),
    pdfMs: Math.round(pdfMs),
    totalMs: Math.round(ms() - started),
    datasetHash,
  };
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

function benchmarkDoc(
  year: number,
  stats: ReturnType<typeof periodStats>,
  readMs: number,
  analyticsMs: number,
  pdfMs: number,
): ReportPdfDoc {
  const timings: ReportTable = {
    title: "Timings",
    columns: ["Step", "Time"],
    align: ["left", "right"],
    rows: [
      { cells: ["Read year from database", `${Math.round(readMs)} ms`] },
      { cells: ["Analytics over the year", `${Math.round(analyticsMs)} ms`] },
      { cells: ["Build report PDF", `${Math.round(pdfMs)} ms`] },
    ],
  };
  const totals: ReportTable = {
    title: `${year} totals`,
    columns: ["Figure", "Amount"],
    align: ["left", "right"],
    rows: [
      { cells: ["Revenue (gross)", rs(stats.revenue)] },
      { cells: ["Collected", rs(stats.collected)] },
      { cells: ["Expenses", rs(stats.expenses)] },
      { cells: ["Profit", rs(stats.profit)] },
      { cells: ["Outstanding dues", rs(stats.dues)], strong: true },
    ],
  };
  return {
    title: `Load test results — ${year}`,
    subtitle: `One year of generated data`,
    tables: [timings, totals],
    fileName: `load-test-${year}`,
  };
}

/** Printable results for the Settings card's "Results PDF" button. */
export function benchmarkPdfDoc(result: LoadTestBenchmark): ReportPdfDoc {
  const timings: ReportTable = {
    title: `Window: ${result.months} months ending ${result.anchor}`,
    columns: ["Step", "Value"],
    align: ["left", "right"],
    rows: [
      { cells: ["Read database", `${result.readMs} ms`] },
      { cells: ["Analytics", `${result.analyticsMs} ms`] },
      { cells: ["Build PDF", `${result.pdfMs} ms`] },
      { cells: ["Total", `${result.totalMs} ms`], strong: true },
    ],
  };
  const dataset: ReportTable = {
    title: "Dataset",
    columns: ["Metric", "Value"],
    align: ["left", "right"],
    rows: [
      { cells: ["Tagged records", result.rows.toLocaleString("en-IN")] },
      { cells: ["Payment rows", result.payments.toLocaleString("en-IN")] },
      { cells: ["Receipt photos", result.receipts.toLocaleString("en-IN")] },
      { cells: ["Receipt bytes", result.receiptBytes.toLocaleString("en-IN")] },
      { cells: ["SHA-256", result.datasetHash] },
    ],
  };
  return {
    title: "Load test results",
    subtitle: `${result.months} months ending ${result.anchor} • run ${new Date(result.ranAt).toLocaleString("en-IN")}`,
    tables: [timings, dataset],
    fileName: `load-test-${result.months}m-${result.anchor}`,
  };
}
