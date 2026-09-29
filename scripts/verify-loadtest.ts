/**
 * Independent load-test audit.
 *
 * This script deliberately does not use the application's aggregate helpers to
 * construct its expected numbers. loadtest-ledger.ts re-derives the monthly,
 * payment, tab, expense and drawer figures from raw rows. The application
 * periodStats/paymentSplit results are only the comparison side.
 */
import "fake-indexeddb/auto";
const store = new Map<string, string>();
(globalThis as Record<string, unknown>)["window"] = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  atob: (globalThis as Record<string, unknown>)["atob"],
  btoa: (globalThis as Record<string, unknown>)["btoa"],
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { seedLoadTestData, clearLoadTestData, LT_ID } =
  await import("../src/lib/loadtest");
const { db } = await import("../src/lib/localdb");
const { periodStats, paymentSplit } = await import("../src/lib/analytics");
const { buildExpectedLedger } = await import("../src/lib/loadtest-ledger");
const { rupees } = await import("../src/lib/money");
const { sha256Hex } = await import("../src/lib/receipts-share");
const { priceForDuration } = await import("../src/lib/ops");
const { turfPrice, buildCourtOccupancy, courtHourSegments } = await import("../src/lib/courts");
const { taxBreakdown, readAppSettings } = await import("../src/lib/settings");

const mix = (process.argv[2] as "light" | "medium") ?? "light";
const months = (process.argv.includes("--14") ? 14 : 12) as 12 | 14;
const anchorArg = process.argv.find((x) => x.startsWith("--anchor="))?.slice(9);
const anchor = anchorArg;
const slotBeforeSeed = await (await import("../src/lib/localdb")).db.app_settings.get("slot_durations");
let failures = 0;
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
};
const eq = (label: string, a: number, b: number) =>
  check(label, near(a, b), `got ${a} expected ${b}`);

await clearLoadTestData();
const seed = await seedLoadTestData(mix, undefined, {
  months,
  ...(anchor ? { anchor } : {}),
});
console.log(
  `Seeded ${seed.total} rows; mix=${mix}; months=${months}; anchor=${anchor ?? "default"}`,
);

const [
  bills,
  bookings,
  sales,
  expenses,
  payments,
  tabEntries,
  dayCloses,
  dayHist,
  receipts,
  hashes,
  stockHist,
] = await Promise.all([
  db.bills.where("id").startsWith(LT_ID).toArray(),
  db.turf_bookings.where("id").startsWith(LT_ID).toArray(),
  db.snack_sales.where("id").startsWith(LT_ID).toArray(),
  db.expenses.where("id").startsWith(LT_ID).toArray(),
  db.payments.where("id").startsWith(LT_ID).toArray(),
  db.tab_entries.where("id").startsWith(LT_ID).toArray(),
  db.day_closes.where("id").startsWith(LT_ID).toArray(),
  db.day_close_history.where("id").startsWith(LT_ID).toArray(),
  db.receipts.toArray().then((x) => x.filter((r) => r.path.includes("/lt-"))),
  db.receipt_hashes
    .toArray()
    .then((x) => x.filter((r) => r.path.includes("/lt-"))),
  db.snack_stock_history.where("id").startsWith(LT_ID).toArray(),
]);

/* C — named courts, coverage and production pricing */
check("venue seeded with 3 courts", (await db.app_settings.get("slot_durations"))?.value && ((await db.app_settings.get("slot_durations"))!.value as any).total_courts === 3);
for (const b of bookings) {
  check(`court id count ${b.id}`, (b.court_ids?.length ?? 0) === b.courts);
  check(`court ids valid ${b.id}`, (b.court_ids ?? []).every((id) => /^c[123]$/.test(id)));
  const rateRow = { id: `verify-${b.id}`, slot_name: b.slot_name ?? "verify", is_active: true, rate_per_hour: b.rate_per_hour, rate_15: null, rate_30: null, rate_45: null, rate_60: b.rate_per_hour };
  const expectedTurf = turfPrice(priceForDuration(rateRow, b.hours * 60), b.courts);
  if (b.turf_amount > 0) eq(`pricing chain ${b.id}`, b.turf_amount, expectedTurf);
}
const coverage = new Map<string, number>();
for (const b of bookings) {
  if (b.courts === 2 || b.courts === 3) {
    const k = `${b.courts}x${b.hours}`;
    coverage.set(k, (coverage.get(k) ?? 0) + 1);
  }
}
for (const k of ["2x1", "3x1", "2x2", "3x2"])
  check(`coverage ${k} >= 2`, (coverage.get(k) ?? 0) >= 2, `got ${coverage.get(k) ?? 0}`);
const allVenueIds = new Set(["c1", "c2", "c3"]);
for (const date of [...new Set(bookings.map((b) => b.booking_date))]) {
  const occupied = buildCourtOccupancy(bookings, date, 3);
  for (const [minute, ids] of occupied)
    check(`capacity ${date} minute ${minute}`, ids.size <= 3 && [...ids].every((id) => allVenueIds.has(id)));
}
const courtHours = bookings.filter((b) => b.status !== "Cancelled").reduce((n, b) => n + b.hours * b.courts, 0);
const segmentedHours = bookings.filter((b) => b.status !== "Cancelled").reduce(
  (n, b) => n + courtHourSegments(b).reduce((m, seg) => m + ((seg.to - seg.from) / 60) * seg.n, 0),
  0,
);
eq("court-hour conservation", courtHours, segmentedHours);

/* P — payment conservation and shape */
const parentGross = new Map<string, number>();
for (const b of bills)
  parentGross.set(`bill:${b.id}`, rupees(b.total + (b.tax_amount ?? 0)));
for (const b of bookings)
  parentGross.set(
    `turf_booking:${b.id}`,
    rupees(b.total_amount + (b.tax_amount ?? 0)),
  );
for (const s of sales)
  parentGross.set(`snack_sale:${s.id}`, rupees(s.total + (s.tax_amount ?? 0)));
const sums = new Map<string, number>();
for (const p of payments) {
  check(
    `payment ${p.id} positive integer`,
    p.amount > 0 && Number.isInteger(p.amount),
  );
  check(`payment ${p.id} mode`, ["Cash", "UPI", "Card"].includes(p.mode));
  check(
    `payment ${p.id} parent`,
    parentGross.has(`${p.parent_type}:${p.parent_id}`),
  );
  const k = `${p.parent_type}:${p.parent_id}`;
  sums.set(k, (sums.get(k) ?? 0) + p.amount);
}
for (const [k, v] of sums)
  eq(`payment sum <= gross ${k}`, v, Math.min(v, parentGross.get(k) ?? v));
check("payments > 0", payments.length > 0);
for (const s of sales)
  if (!s.cancelled)
    check(
      `snack ${s.id} never Card`,
      s.payment_mode !== "Card" &&
        !payments.some(
          (p) =>
            p.parent_type === "snack_sale" &&
            p.parent_id === s.id &&
            p.mode === "Card",
        ),
    );
for (const [k, v] of sums)
  check(
    `payment conservation ${k}`,
    v <= (parentGross.get(k) ?? Infinity) + 0.001,
  );

/* E — expenses/photos */
for (const e of expenses) {
  check(`expense date ${e.id}`, /^\d{4}-\d{2}-\d{2}$/.test(e.spent_at));
  check(`expense photo ${e.id}`, !!e.receipt_path);
  const r = receipts.find((x) => x.path === e.receipt_path);
  const h = hashes.find((x) => x.path === e.receipt_path);
  check(`receipt/hash pair ${e.id}`, !!r && !!h);
  if (r && h) {
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    check(
      `PNG signature ${e.id}`,
      bytes
        .slice(0, 8)
        .every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]),
    );
    // Fixed layout: 8 (signature) + 25 (IHDR) + 12 + (2 zlib header + 5 stored-block header + 240*46 raw + 4 adler) (IDAT) + 12 (IEND) = 11108.
    eq(
      `receipt bytes ${e.id}`,
      bytes.length,
      8 + 25 + 12 + (2 + 5 + 240 * 46 + 4) + 12,
    );
    const digest = await sha256Hex(bytes);
    check(`receipt hash ${e.id}`, digest === h.sha256);
  }
}
check(
  "receipt count equals expense count",
  receipts.length === expenses.length,
);
check("hash count equals expense count", hashes.length === expenses.length);

/* K/DC */
for (const h of stockHist)
  check(
    `stock chain ${h.id}`,
    h.previous_quantity + h.delta === h.new_quantity && h.new_quantity >= 0,
  );
for (const d of dayCloses)
  eq(
    `day close variance ${d.id}`,
    d.variance,
    d.counted_cash - d.expected_in_drawer,
  );
check("day closes exist", dayCloses.length > 0);
check("day close history exists", dayHist.length > 0);

/* Independent aggregate oracle */
// A row with no frozen tax_amount ("legacy" seed rows) falls back, in the
// real app, to whatever the LIVE global tax settings are at read time (see
// biz.ts grossWithTax) — genuinely not an independently-derivable fact,
// since loadtest.ts deliberately never mutates those real settings (audit
// item F65). `periodStats` below is likewise called with no explicit
// settings, so it too defaults to the live readAppSettings(); passing the
// same live settings here keeps both sides of the comparison looking at
// the same tax rate rather than the oracle silently assuming a fixed
// 18%+5% that may no longer match this account's actual configuration.
const liveSettings = readAppSettings();
const ledger = buildExpectedLedger({
  bills,
  bookings,
  sales,
  expenses,
  payments,
  tabEntries,
  dayCloses,
  liveTaxOf: (net) => taxBreakdown(net, liveSettings).taxAmount,
});
const ledgerCourtHours = ledger.courtHours;
check("ledger court-hours matches raw rows", near(ledgerCourtHours, courtHours));
for (const [month, hours] of Object.entries(ledger.courtHoursByMonth)) {
  const raw = bookings.filter((b) => b.status !== "Cancelled" && b.booking_date.startsWith(month)).reduce((n, b) => n + b.hours * b.courts, 0);
  eq(`ledger court-hours ${month}`, hours, raw);
}

const src = {
  bills,
  bookings,
  sales,
  expenses,
  tabEntries,
  payments,
} as unknown as Parameters<typeof periodStats>[0];
const monthKeys = Object.keys(ledger.months).sort();
for (const key of monthKeys) {
  const s = periodStats(src, (iso: string) => iso.startsWith(key));
  const e = ledger.months[key]!;
  eq(`${key} net`, s.netRevenue, e.net);
  eq(`${key} tax`, s.tax, e.tax);
  eq(`${key} revenue`, s.revenue, e.revenue);
  eq(`${key} collected`, s.collected, e.collected);
  eq(`${key} tabCollected`, s.tabCollected, e.tabCollected);
  eq(`${key} expenses`, s.expenses, e.expenses);
  eq(`${key} profit`, s.profit, e.profit);
  eq(`${key} dues`, s.dues, e.dues);
  eq(`${key} snackProfit`, s.snackProfit, e.snackProfit);
  eq(`${key} billsCollected`, s.billsCollected, e.billsCollected);
  eq(`${key} billsDues`, s.billsDues, e.billsDues);
  eq(`${key} turfRevenue`, s.turfRevenue, e.turfRevenue);
  eq(`${key} snacksRevenue`, s.snacksRevenue, e.snacksRevenue);
  // paymentSplit() returns [{ name, value }] rows (not a Map).
  const split = paymentSplit(src, (iso: string) => iso.startsWith(key));
  const splitOf = (mode: string) =>
    split.find((r) => r.name === mode)?.value ?? 0;
  eq(`${key} Cash split`, splitOf("Cash"), e.split.Cash);
  eq(`${key} UPI split`, splitOf("UPI"), e.split.UPI);
  eq(`${key} Card split`, splitOf("Card"), e.split.Card);
}

/* DC — app cash drawer source: cash payments minus cash expense. */
for (const [day, e] of Object.entries(ledger.days)) {
  const d = dayCloses.find((x) => x.day === day);
  if (d) eq(`drawer ${day}`, d.expected_in_drawer, e.cashIn - e.cashOut);
}

/* O — deterministic tagging and no future non-confirmed activity */
for (const rows of [
  bills,
  bookings,
  sales,
  expenses,
  payments,
  tabEntries,
  dayCloses,
  dayHist,
  stockHist,
])
  for (const r of rows) check(`tag ${r.id}`, String(r.id).startsWith(LT_ID));

console.log(
  `\n${failures === 0 ? "ALL AUDIT CHECKS PASSED" : `${failures} AUDIT CHECK(S) FAILED`}`,
);
await clearLoadTestData();
const slotAfterClear = await db.app_settings.get("slot_durations");
check("slot_durations restored after clear", JSON.stringify(slotAfterClear?.value ?? null) === JSON.stringify(slotBeforeSeed?.value ?? null));
process.exit(failures ? 1 : 0);
