import {
  db,
  nowIso,
  resyncCounters,
  type BillRow,
  type CustomerRow,
  type ExpenseRow,
  type SnackSaleRow,
  type TurfBookingRow,
  type PaymentRow,
} from "./localdb";
import {
  readAppSettings,
  writeAppSettings,
  type AppSettings,
} from "./settings";
import { statsForMonth, type PeriodStats, type Sources } from "./analytics";
import type { ReportPdfDoc, ReportTable } from "./report-pdf";

/**
 * Hand-built, deterministic dataset spanning three real months (July,
 * August & September 2026) — the SAME data scripts/verify-math.ts audits
 * the calculators against. September is the multi-court golden block
 * (MC-1…MC-8, see EXPECTED_SEP below). It exercises every rule in
 * docs/calculation-rules.md at once:
 * merged bookings, cancelled bookings, paid/partial/unpaid bills, the
 * UTC-slice month-boundary trap (bill VER-INV-0002 is 31 Jul 20:00 UTC =
 * 1 Aug 01:30 IST and must bucket into August), and customer identity
 * matching by phone vs. name. Every row is tagged with a "VER-"
 * document-number prefix (and customer ids prefixed "ver-cust-") so
 * `clearVerificationData()` can remove exactly these rows without touching
 * real data.
 *
 * Seeding also turns on GST 18% + a 5% service charge, because the
 * hand-computed expectations in verify-math.ts are computed under that tax
 * setup. GST being ON applies to more than the bills here: none of this
 * dataset's turf bookings/snack sales carry a frozen tax_amount (that's only
 * set by ops.ts's freezeTax() at real creation time), so biz.ts's
 * grossWithTax() taxes them live too, same as a legacy pre-snapshot bill
 * would (calculation-rules.md §4).
 *
 * Expected headline figures (from scripts/verify-math.ts):
 *   July    — revenue 4920, collected 3045, expenses 400, profit 3600,
 *             dues 1875, tax 920
 *   August  — revenue 7935, collected 4400, expenses 400, profit 6050,
 *             dues 3535, tax 1485
 *   Combined revenue 12855, collected 7445, dues 5410, tax 2405.
 *
 * Per-customer (lifetime over ALL seeded rows, tax-inclusive — same GST
 * setup as above; includes the September multi-court block):
 *   Ravi  — turf dues 6764, bill dues 1960, total owed 8724
 *           (turf: TB-1 1076 + TB-5 1230 + MC-1 2952 + MC-7 1230 + MC-8 276)
 *   Priya — turf dues 4064, bill dues 2337, total owed 6401
 *           (turf: TB-2 184 + TB-6 345 + MC-2 3535; bills: INV-3 615 +
 *           MC-BILL-6 1722 — MC-6's merged money sits on the bill)
 *   (8724 + 6401 = 15125 = 1875 July + 3535 Aug + 9715 Sep period dues.)
 *
 * NOTE on "fully paid" bookings: TB-2 and TB-6 have advance_paid equal to the
 * PRE-tax total_amount. Real bookings store the tax-inclusive gross in
 * advance_paid, but these rows carry no frozen tax_amount, so the live GST
 * fallback applies and ₹184 (TB-2) and ₹345 (TB-6) of tax is still owed.
 * That is intentional — it exercises the live-tax fallback — and is already
 * baked into the dues figures above.
 */

const VER_PREFIX = "VER-";

export async function seedVerificationData() {
  // Match the tax setup the expectations were computed under.
  const s = readAppSettings();
  writeAppSettings({
    ...s,
    gstEnabled: true,
    gstRate: 18,
    customTaxes: [
      { id: "svc", label: "Service Charge", rate: 5, enabled: true },
    ],
  });

  const customers: CustomerRow[] = [
    {
      id: "ver-cust-ravi",
      name: "Ravi",
      phone: "9876543210",
      created_at: nowIso(),
    },
    {
      id: "ver-cust-priya",
      name: "Priya",
      phone: "9000000001",
      created_at: nowIso(),
    },
  ];

  const bill1Id = "ver-bill-0001";
  const billMc6Id = "ver-bill-mc-0006";

  const bills: BillRow[] = [
    // INV-1 — Ravi, July, paid in full (amount_paid 0 by design: "paid"
    // status means the gross was collected).
    {
      id: bill1Id,
      invoice_no: `${VER_PREFIX}INV-0001`,
      customer_name: "Ravi",
      customer_phone: "9876543210",
      items: [
        { item: "Turf + snacks", rate: 1000, qty: 1, total: 1000, unit: "hr" },
      ],
      subtotal: 1000,
      discount: 0,
      total: 1000,
      amount_paid: 0,
      status: "paid",
      payment_mode: "Cash",
      bill_date: "2026-07-05T06:30:00.000Z",
      created_at: "2026-07-05T06:30:00.000Z",
    },
    // INV-2 — Ravi, partially paid. THE month-boundary trap: 31 Jul 20:00 UTC
    // is 1 Aug 01:30 IST — must bucket into AUGUST, not July.
    {
      id: "ver-bill-0002",
      invoice_no: `${VER_PREFIX}INV-0002`,
      customer_name: "Ravi",
      customer_phone: "9876543210",
      items: [
        { item: "Turf + snacks", rate: 2000, qty: 1, total: 2000, unit: "hr" },
      ],
      subtotal: 2000,
      discount: 0,
      total: 2000,
      amount_paid: 500,
      status: "partial",
      payment_mode: "UPI",
      bill_date: "2026-07-31T20:00:00.000Z",
      created_at: "2026-07-31T20:00:00.000Z",
    },
    // INV-3 — Priya, July, fully unpaid: exercises billsDues.
    {
      id: "ver-bill-0003",
      invoice_no: `${VER_PREFIX}INV-0003`,
      customer_name: "Priya",
      customer_phone: "9000000001",
      items: [
        { item: "Turf + snacks", rate: 500, qty: 1, total: 500, unit: "hr" },
      ],
      subtotal: 500,
      discount: 0,
      total: 500,
      amount_paid: 0,
      status: "unpaid",
      payment_mode: null,
      bill_date: "2026-07-10T05:00:00.000Z",
      created_at: "2026-07-10T05:00:00.000Z",
    },
    // INV-4 — Priya, August, fully paid.
    {
      id: "ver-bill-0004",
      invoice_no: `${VER_PREFIX}INV-0004`,
      customer_name: "Priya",
      customer_phone: "9000000001",
      items: [
        { item: "Turf + snacks", rate: 1500, qty: 1, total: 1500, unit: "hr" },
      ],
      subtotal: 1500,
      discount: 0,
      total: 1500,
      amount_paid: 0,
      status: "paid",
      payment_mode: "Cash",
      bill_date: "2026-08-12T05:00:00.000Z",
      created_at: "2026-08-12T05:00:00.000Z",
    },
    // MC-BILL-6 — Priya, September: the bill MC-6 (merged 2-court booking)
    // points at. Its turf money lives on THIS bill, not in turfRevenue.
    {
      id: billMc6Id,
      invoice_no: `${VER_PREFIX}MC-BILL-6`,
      customer_name: "Priya",
      customer_phone: "9000000001",
      items: [
        { item: "Turf · Weekdays (VER-MC-6) · 2 courts", rate: 700, qty: 2, total: 1400, unit: "hr" },
      ],
      subtotal: 1400,
      discount: 0,
      total: 1400,
      amount_paid: 0,
      status: "unpaid",
      payment_mode: null,
      bill_date: "2026-09-22T05:00:00.000Z",
      created_at: "2026-09-22T05:00:00.000Z",
    },
  ];

  const bookings: TurfBookingRow[] = [
    // TB-1 — Ravi, July, standalone, partially paid: pre-tax balance 800, booking
    // due 1076 once the live 23% tax is included.
    {
      id: "ver-book-0001",
      booking_no: `${VER_PREFIX}INV-0001`,
      booking_date: "2026-07-04",
      customer_name: "Ravi",
      phone: "9876543210",
      slot_name: "Weekdays",
      hours: 1,
      rate_per_hour: 1200,
      total_amount: 1200,
      advance_paid: 400,
      payment_mode: "Cash",
      status: "Confirmed",
      discount: 0,
      notes: "verification-seed",
      start_time: "06:00 AM",
      end_time: "07:00 AM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 1200,
      created_at: "2026-07-04T06:00:00.000Z",
      merged_into_bill_id: null,
    },
    // TB-2 — Priya, July, standalone, advance = pre-tax total (the ₹184 live
    // tax is still owed — see the note in the header comment).
    {
      id: "ver-book-0002",
      booking_no: `${VER_PREFIX}INV-0002`,
      booking_date: "2026-07-18",
      customer_name: "Priya",
      phone: "9000000001",
      slot_name: "Weekends",
      hours: 1,
      rate_per_hour: 800,
      total_amount: 800,
      advance_paid: 800,
      payment_mode: "Cash",
      status: "Completed",
      discount: 0,
      notes: "verification-seed",
      start_time: "09:00 AM",
      end_time: "10:00 AM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 800,
      created_at: "2026-07-18T09:00:00.000Z",
      merged_into_bill_id: null,
    },
    // TB-3 — Priya, July, Cancelled: zero money everywhere.
    {
      id: "ver-book-0003",
      booking_no: `${VER_PREFIX}INV-0003`,
      booking_date: "2026-07-20",
      customer_name: "Priya",
      phone: "9000000001",
      slot_name: "Weekdays",
      hours: 1,
      rate_per_hour: 600,
      total_amount: 600,
      advance_paid: 0,
      payment_mode: "Pending",
      status: "Cancelled",
      discount: 0,
      notes: "verification-seed",
      start_time: "05:00 PM",
      end_time: "06:00 PM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 600,
      created_at: "2026-07-20T17:00:00.000Z",
      merged_into_bill_id: null,
    },
    // TB-4 — Ravi, July, merged into INV-1: must vanish from turfRevenue/dues.
    {
      id: "ver-book-0004",
      booking_no: `${VER_PREFIX}INV-0004`,
      booking_date: "2026-07-25",
      customer_name: "Ravi",
      phone: "9876543210",
      slot_name: "Weekdays",
      hours: 1,
      rate_per_hour: 900,
      total_amount: 900,
      advance_paid: 300,
      payment_mode: "Cash",
      status: "Confirmed",
      discount: 0,
      notes: "verification-seed",
      start_time: "07:00 PM",
      end_time: "08:00 PM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 900,
      created_at: "2026-07-25T19:00:00.000Z",
      merged_into_bill_id: bill1Id,
    },
    // TB-5 — Ravi, August, standalone, unpaid: pre-tax 1000, booking due 1230
    // with the live 23% tax.
    {
      id: "ver-book-0005",
      booking_no: `${VER_PREFIX}INV-0005`,
      booking_date: "2026-08-03",
      customer_name: "Ravi",
      phone: "9876543210",
      slot_name: "Weekends",
      hours: 1,
      rate_per_hour: 1000,
      total_amount: 1000,
      advance_paid: 0,
      payment_mode: "Cash",
      status: "Confirmed",
      discount: 0,
      notes: "verification-seed",
      start_time: "08:00 AM",
      end_time: "09:00 AM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 1000,
      created_at: "2026-08-03T08:00:00.000Z",
      merged_into_bill_id: null,
    },
    // TB-6 — Priya, August, standalone, advance = pre-tax total (the ₹345
    // live tax is still owed — see the note in the header comment).
    {
      id: "ver-book-0006",
      booking_no: `${VER_PREFIX}INV-0006`,
      booking_date: "2026-08-22",
      customer_name: "Priya",
      phone: "9000000001",
      slot_name: "Weekends",
      hours: 1,
      rate_per_hour: 1500,
      total_amount: 1500,
      advance_paid: 1500,
      payment_mode: "UPI",
      status: "Completed",
      discount: 0,
      notes: "verification-seed",
      start_time: "02:00 PM",
      end_time: "03:00 PM",
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 1500,
      created_at: "2026-08-22T14:00:00.000Z",
      merged_into_bill_id: null,
    },
    // MC-1 — September: 2 courts × 1 h, no advance.
    {
      id: "ver-book-mc-0001", booking_no: `${VER_PREFIX}MC-1`, booking_date: "2026-09-03",
      customer_name: "Ravi", phone: "9876543210", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 1200, total_amount: 2400, advance_paid: 0, payment_mode: "Pending",
      status: "Confirmed", discount: 0, notes: "verification-seed MC", start_time: "06:00 PM",
      end_time: "07:00 PM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 2400, created_at: "2026-09-03T12:30:00.000Z", merged_into_bill_id: null,
    },
    // MC-2 — 3 courts × 2 h, ₹300 discount, ₹2,000 advance.
    {
      id: "ver-book-mc-0002", booking_no: `${VER_PREFIX}MC-2`, booking_date: "2026-09-07",
      customer_name: "Priya", phone: "9000000001", slot_name: "Weekdays", hours: 2,
      rate_per_hour: 800, total_amount: 4500, advance_paid: 2000, payment_mode: "Cash",
      status: "Confirmed", discount: 300, notes: "verification-seed MC", start_time: "04:00 PM",
      end_time: "06:00 PM", courts: 3, court_ids: ["c1", "c2", "c3"], snacks: [], snacks_total: 0,
      turf_amount: 4800, created_at: "2026-09-07T10:30:00.000Z", merged_into_bill_id: null,
    },
    // MC-3 — 3 courts × 1 h, paid in full, the ₹333 regression.
    {
      id: "ver-book-mc-0003", booking_no: `${VER_PREFIX}MC-3`, booking_date: "2026-09-11",
      customer_name: "Ravi", phone: "9876543210", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 333, total_amount: 999, advance_paid: 1229, payment_mode: "UPI",
      status: "Completed", discount: 0, notes: "verification-seed MC", start_time: "07:00 PM",
      end_time: "08:00 PM", courts: 3, court_ids: ["c1", "c2", "c3"], snacks: [], snacks_total: 0,
      turf_amount: 999, created_at: "2026-09-11T13:30:00.000Z", merged_into_bill_id: null,
    },
    // MC-4 — non-refundable cancelled advance becomes forfeited revenue.
    {
      id: "ver-book-mc-0004", booking_no: `${VER_PREFIX}MC-4`, booking_date: "2026-09-15",
      customer_name: "Priya", phone: "9000000001", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 1000, total_amount: 2000, advance_paid: 1000, payment_mode: "Cash",
      status: "Cancelled", discount: 0, notes: "verification-seed MC", start_time: "05:00 PM",
      end_time: "06:00 PM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 2000, created_at: "2026-09-15T11:30:00.000Z", merged_into_bill_id: null,
      is_refundable: false,
    },
    // MC-5 — refundable cancelled advance remains a liability and is collected
    // on its received day via the payment ledger, but never enters revenue.
    {
      id: "ver-book-mc-0005", booking_no: `${VER_PREFIX}MC-5`, booking_date: "2026-09-18",
      customer_name: "Ravi", phone: "9876543210", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 1000, total_amount: 2000, advance_paid: 1000, payment_mode: "UPI",
      status: "Cancelled", discount: 0, notes: "verification-seed MC", start_time: "05:00 PM",
      end_time: "06:00 PM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 2000, created_at: "2026-09-18T11:30:00.000Z", merged_into_bill_id: null,
      is_refundable: true,
    },
    // MC-6 — 2 courts × 1 h merged into MC-BILL-6: must vanish from
    // turfRevenue/turf dues; its gross sits on the bill instead.
    {
      id: "ver-book-mc-0006", booking_no: `${VER_PREFIX}MC-6`, booking_date: "2026-09-22",
      customer_name: "Priya", phone: "9000000001", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 700, total_amount: 1400, advance_paid: 0, payment_mode: "Pending",
      status: "Confirmed", discount: 0, notes: "verification-seed MC", start_time: "06:00 PM",
      end_time: "07:00 PM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 1400, created_at: "2026-09-22T12:30:00.000Z", merged_into_bill_id: billMc6Id,
    },
    // MC-7 — legacy row: turf_amount 0, courts 2. storedTurfAmount rebuilds
    // it as 1 h × 500 × 2 = 1,000; tax and dues must follow the rebuild.
    {
      id: "ver-book-mc-0007", booking_no: `${VER_PREFIX}MC-7`, booking_date: "2026-09-24",
      customer_name: "Ravi", phone: "9876543210", slot_name: "Weekdays", hours: 1,
      rate_per_hour: 500, total_amount: 1000, advance_paid: 0, payment_mode: "Pending",
      status: "Confirmed", discount: 0, notes: "verification-seed MC", start_time: "06:00 PM",
      end_time: "07:00 PM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 0, created_at: "2026-09-24T12:30:00.000Z", merged_into_bill_id: null,
    },
    // MC-8 — 2 courts, 23:00–01:00 (past midnight), advance = pre-tax total
    // (the ₹276 live tax is still owed, same convention as TB-2/TB-6).
    {
      id: "ver-book-mc-0008", booking_no: `${VER_PREFIX}MC-8`, booking_date: "2026-09-26",
      customer_name: "Ravi", phone: "9876543210", slot_name: "Weekdays", hours: 2,
      rate_per_hour: 600, total_amount: 1200, advance_paid: 1200, payment_mode: "UPI",
      status: "Completed", discount: 0, notes: "verification-seed MC", start_time: "11:00 PM",
      end_time: "01:00 AM", courts: 2, court_ids: ["c1", "c2"], snacks: [], snacks_total: 0,
      turf_amount: 1200, created_at: "2026-09-26T12:30:00.000Z", merged_into_bill_id: null,
    },
  ];

  const sales: SnackSaleRow[] = [
    {
      id: "ver-sale-0001",
      bill_no: `${VER_PREFIX}SB-0001`,
      sale_date: "2026-07-06",
      customer_name: "Ravi",
      items: [
        {
          item_name: "Snacks",
          qty: 1,
          unit_price: 300,
          cost_price: 200,
          amount: 300,
        },
      ],
      total: 300,
      profit: 100,
      payment_mode: "Cash",
      notes: "verification-seed",
      booking_id: null,
      booking_no: null,
      created_at: "2026-07-06T10:00:00.000Z",
    },
    {
      id: "ver-sale-0002",
      bill_no: `${VER_PREFIX}SB-0002`,
      sale_date: "2026-07-19",
      customer_name: "Walk-in",
      items: [
        {
          item_name: "Snacks",
          qty: 1,
          unit_price: 200,
          cost_price: 120,
          amount: 200,
        },
      ],
      total: 200,
      profit: 80,
      payment_mode: "UPI",
      notes: "verification-seed",
      booking_id: null,
      booking_no: null,
      created_at: "2026-07-19T10:00:00.000Z",
    },
    {
      id: "ver-sale-0003",
      bill_no: `${VER_PREFIX}SB-0003`,
      sale_date: "2026-08-09",
      customer_name: "Priya",
      items: [
        {
          item_name: "Snacks",
          qty: 1,
          unit_price: 450,
          cost_price: 300,
          amount: 450,
        },
      ],
      total: 450,
      profit: 150,
      payment_mode: "Cash",
      notes: "verification-seed",
      booking_id: null,
      booking_no: null,
      created_at: "2026-08-09T10:00:00.000Z",
    },
  ];

  const payments: PaymentRow[] = [
    { id: "ver-pay-mc-0004-a", parent_type: "turf_booking", parent_id: "ver-book-mc-0004", amount: 600, mode: "Cash", received_at: "2026-09-15T11:30:00.000Z", created_at: "2026-09-15T11:30:00.000Z" },
    { id: "ver-pay-mc-0004-b", parent_type: "turf_booking", parent_id: "ver-book-mc-0004", amount: 400, mode: "UPI", received_at: "2026-09-15T11:31:00.000Z", created_at: "2026-09-15T11:31:00.000Z" },
    { id: "ver-pay-mc-0005", parent_type: "turf_booking", parent_id: "ver-book-mc-0005", amount: 1000, mode: "UPI", received_at: "2026-09-18T11:30:00.000Z", created_at: "2026-09-18T11:30:00.000Z" },
  ];

  const expenses: ExpenseRow[] = [
    {
      id: "ver-exp-0001",
      expense_no: `${VER_PREFIX}TX-0001`,
      business: "Snacks",
      category: "ingredients",
      description: "Verification seed",
      note: null,
      amount: 250,
      spent_at: "2026-07-07",
      receipt_path: null,
      created_at: "2026-07-07T11:00:00.000Z",
    },
    {
      id: "ver-exp-0002",
      expense_no: `${VER_PREFIX}TX-0002`,
      business: "Turf",
      category: "labour",
      description: "Verification seed",
      note: null,
      amount: 150,
      spent_at: "2026-07-28",
      receipt_path: null,
      created_at: "2026-07-28T11:00:00.000Z",
    },
    {
      id: "ver-exp-0003",
      expense_no: `${VER_PREFIX}TX-0003`,
      business: "Turf",
      category: "transport",
      description: "Verification seed",
      note: null,
      amount: 400,
      spent_at: "2026-08-14",
      receipt_path: null,
      created_at: "2026-08-14T11:00:00.000Z",
    },
  ];

  await db.customers.bulkAdd(customers);
  await db.bills.bulkAdd(bills);
  await db.turf_bookings.bulkAdd(bookings);
  await db.payments.bulkAdd(payments);
  await db.snack_sales.bulkAdd(sales);
  await db.expenses.bulkAdd(expenses);
  await resyncCounters();

  return {
    customers: customers.length,
    bills: bills.length,
    bookings: bookings.length,
    sales: sales.length,
    payments: payments.length,
    expenses: expenses.length,
  };
}

/** Removes only the rows this module added (matched by the "VER-" tag on
 * every document number, and the "ver-cust-" id prefix on customers) —
 * safe to run without touching real data or unrelated load-test data. */
export async function clearVerificationData() {
  const custIds = (await db.customers.toArray())
    .filter((c) => c.id.startsWith("ver-cust-"))
    .map((c) => c.id);
  await db.customers.bulkDelete(custIds);

  const billIds = (await db.bills.toArray())
    .filter((b) => b.invoice_no.startsWith(VER_PREFIX))
    .map((b) => b.id);
  await db.bills.bulkDelete(billIds);

  const bookingIds = (await db.turf_bookings.toArray())
    .filter((b) => b.booking_no.startsWith(VER_PREFIX))
    .map((b) => b.id);
  await db.turf_bookings.bulkDelete(bookingIds);

  const paymentIds = (await db.payments.toArray())
    .filter((p) => p.id.startsWith("ver-pay-"))
    .map((p) => p.id);
  await db.payments.bulkDelete(paymentIds);

  const saleIds = (await db.snack_sales.toArray())
    .filter((s) => s.bill_no.startsWith(VER_PREFIX))
    .map((s) => s.id);
  await db.snack_sales.bulkDelete(saleIds);

  const expenseIds = (await db.expenses.toArray())
    .filter((e) => (e.expense_no ?? "").startsWith(VER_PREFIX))
    .map((e) => e.id);
  await db.expenses.bulkDelete(expenseIds);

  await resyncCounters();

  return {
    customers: custIds.length,
    bills: billIds.length,
    bookings: bookingIds.length,
    sales: saleIds.length,
    payments: paymentIds.length,
    expenses: expenseIds.length,
  };
}

/* ------------------------------------------------------------------ */
/* Hand-computed verification check + PDF                              */
/* ------------------------------------------------------------------ */

/**
 * Literal arithmetic for July & August 2026, transcribed line-for-line from
 * `scripts/verify-math.ts`'s `expectedJul`/`expectedAug` — NOT re-derived
 * here, so this file can never silently drift from the audited numbers.
 * GST 18% + Service Charge 5% = 23% tax on every bill's pre-tax total.
 */
const TAX = 0.23;
const grossOf = (net: number) => net + net * TAX;

// TB-1/TB-2/TB-5/TB-6 and SB-0001/0002/0003 carry no frozen tax_amount —
// with GST on, biz.ts's grossWithTax() taxes them live too, same rule as a
// legacy pre-snapshot bill (calculation-rules.md §4). TB-3 is cancelled and
// TB-4 is merged, so neither is financial and neither is taxed.
const EXPECTED_JUL = {
  billsRevenue: 1000 + 500,
  // Bills' tax, plus TB-1+TB-2's and SB-0001+SB-0002's own live tax fallback.
  tax: (1000 + 500) * TAX + (1200 + 800) * TAX + (300 + 200) * TAX,
  turfRevenue: 1200 + 800, // TB-3 cancelled, TB-4 merged -> both excluded
  snacksRevenue: 300 + 200,
  netRevenue: 1500 + 2000 + 500,
  revenue:
    1500 +
    2000 +
    500 +
    ((1000 + 500) * TAX + (1200 + 800) * TAX + (300 + 200) * TAX),
  collected:
    grossOf(1000) /* INV-1 */ +
    0 /* INV-3 */ +
    (400 +
      800) /* advances: bookingCashCollected reads advance_paid raw, never tax-inclusive */ +
    (grossOf(300) +
      grossOf(200)) /* snacks: snackSaleCollected IS tax-inclusive */,
  expenses: 400,
  profit: 4000 - 400,
  dues:
    grossOf(500) - 0 /* INV-3 */ + (grossOf(1200) - 400) + (grossOf(800) - 800),
  snackProfit: 180,
};

const EXPECTED_AUG = {
  billsRevenue: 2000 + 1500,
  // Bills' tax, plus TB-5+TB-6's live tax fallback. SB-0003's own tax is NOT
  // 450 * TAX (103.5): taxBreakdown() rounds each tax LINE to a whole rupee
  // before summing. The audited verification fixture expects the three tax
  // components to round to 41 + 41 + 23 = 105, matching scripts/verify-math.ts.
  tax: (2000 + 1500) * TAX + (1000 + 1500) * TAX + 105,
  turfRevenue: 1000 + 1500,
  snacksRevenue: 450,
  netRevenue: 3500 + 2500 + 450,
  revenue:
    3500 + 2500 + 450 + ((2000 + 1500) * TAX + (1000 + 1500) * TAX + 105),
  collected:
    500 /* INV-2 partial */ +
    grossOf(1500) /* INV-4 */ +
    1500 /* advance (raw, not tax-inclusive) */ +
    (450 +
      105) /* SB-0003: snackSaleCollected IS tax-inclusive, 450 + its 105 tax */,
  expenses: 400,
  profit: 6450 - 400,
  dues:
    grossOf(2000) -
    500 /* INV-2 */ +
    (grossOf(1000) - 0) +
    (grossOf(1500) - 1500),
  snackProfit: 150,
};

// September 2026 multi-court block (MC-1…MC-8), hand-derived row by row:
//   MC-1  turf 2400, tax 216+216+120 = 552,            due 2952
//   MC-2  total 4500 (4800 − 300), tax 405+405+225 = 1035, advance 2000, due 3535
//   MC-3  999, tax 90+90+50 = 230, paid 1229,          due 0
//   MC-4  cancelled non-refundable: forfeited 1000,    collected 1000 (payments)
//   MC-5  cancelled refundable: liability 1000,        collected 1000 (payments)
//   MC-6  merged 2-court booking: excluded from turf;  its bill carries 1400
//   MC-BILL-6  bill 1400, tax 126+126+70 = 322, unpaid, due 1722
//   MC-7  legacy rebuild 1×500×2 = 1000, tax 90+90+50 = 230, no advance, due 1230
//   MC-8  2 courts × 2 h = 1200, tax 108+108+60 = 276, advance 1200 (raw),
//         due 276 (23:00–01:00; month bucketing follows booking_date)
const EXPECTED_SEP = {
  billsRevenue: 1400,
  tax: 552 + 1035 + 230 + 322 + 230 + 276,
  turfRevenue: 2400 + 4500 + 999 + 1000 + 1200, // MC-4/5 cancelled, MC-6 merged
  snacksRevenue: 0,
  netRevenue: 2400 + 4500 + 999 + 1000 + 1000 + 1400 + 1200,
  revenue:
    2400 + 4500 + 999 + 1000 + 1000 + 1400 + 1200 +
    (552 + 1035 + 230 + 322 + 230 + 276),
  collected: 2000 + 1229 + 1000 + 1000 + 1200,
  expenses: 0,
  profit: 12499, // netRevenue (2400+4500+999+1000 turf + 1400 bill + 1000 forfeited)
  dues: 2952 + 3535 + 1230 + 276 + 1722,
  snackProfit: 0,
};

const FIELD_LABELS: Record<keyof typeof EXPECTED_JUL, string> = {
  billsRevenue: "Bills revenue (net of tax)",
  tax: "Tax collected (GST 18% + Service 5%)",
  turfRevenue: "Turf revenue (merged & cancelled excluded)",
  snacksRevenue: "Snacks revenue",
  netRevenue: "Net revenue (bills + turf + snacks)",
  revenue: "Revenue, gross (incl. tax)",
  collected: "Cash actually collected",
  expenses: "Expenses",
  profit: "Profit (net revenue − expenses)",
  dues: "Outstanding dues",
  snackProfit: "Snack profit",
};

export type VerificationCheckRow = {
  label: string;
  expected: number;
  actual: number;
  pass: boolean;
};

export type VerificationCheckResult = {
  ranAt: string;
  recordsFound: number;
  rows: VerificationCheckRow[];
  allPassed: boolean;
};

/**
 * Reads whatever "VER-" rows currently sit in the database (i.e. exactly
 * what `seedVerificationData()` wrote), runs them through the SAME live
 * `statsForMonth()` the Dashboard/Reports screens use, and compares every
 * figure against the hand-computed literals above. This is the actual app
 * code being checked against arithmetic done by hand — not two copies of
 * the same formula agreeing with each other.
 */
export async function runVerificationCheck(): Promise<VerificationCheckResult> {
  const [billRows, bookingRows, saleRows, expenseRows, paymentRows] = await Promise.all([
    db.bills.toArray(),
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.expenses.toArray(),
    db.payments.toArray(),
  ]);
  const bills = billRows.filter((b) => b.invoice_no.startsWith(VER_PREFIX));
  const bookings = bookingRows.filter((b) =>
    b.booking_no.startsWith(VER_PREFIX),
  );
  const sales = saleRows.filter((s) => s.bill_no.startsWith(VER_PREFIX));
  const expenses = expenseRows.filter((e) =>
    (e.expense_no ?? "").startsWith(VER_PREFIX),
  );
  const payments = paymentRows.filter((p) => p.id.startsWith("ver-pay-"));

  // Match the tax setup the expected literals above were computed under,
  // regardless of what Settings currently has (seedVerificationData turns
  // this on when it seeds, but a user may have since changed it).
  const settings: AppSettings = {
    ...readAppSettings(),
    gstEnabled: true,
    gstRate: 18,
    customTaxes: [
      { id: "svc", label: "Service Charge", rate: 5, enabled: true },
    ],
  };

  const src = {
    bills,
    bookings,
    sales,
    expenses,
    payments,
    tabEntries: [],
  } as unknown as Sources;

  const jul = statsForMonth(src, "2026-07", settings);
  const aug = statsForMonth(src, "2026-08", settings);

  const rows: VerificationCheckRow[] = [];
  const addRows = (
    monthLabel: string,
    actual: PeriodStats,
    expected: typeof EXPECTED_JUL,
  ) => {
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const a = Math.round(actual[key] * 100) / 100;
      const e = Math.round(expected[key] * 100) / 100;
      rows.push({
        label: `${monthLabel} — ${FIELD_LABELS[key]}`,
        expected: e,
        actual: a,
        pass: Math.abs(a - e) < 0.5,
      });
    }
  };
  const sep = statsForMonth(src, "2026-09", settings);
  addRows("July 2026", jul, EXPECTED_JUL);
  addRows("August 2026", aug, EXPECTED_AUG);
  addRows("September 2026", sep, EXPECTED_SEP);
  rows.push({
    label: "September 2026 — refundable advance liability",
    expected: 1000,
    actual: sep.refundableAdvance,
    pass: Math.abs(sep.refundableAdvance - 1000) < 0.5,
  });

  return {
    ranAt: nowIso(),
    recordsFound:
      bills.length + bookings.length + sales.length + expenses.length + payments.length,
    rows,
    allPassed: rows.every((r) => r.pass),
  };
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

/** Turns a finished check into a printable/downloadable PDF: every hand-
 * computed figure next to what the app actually returned, with a per-row
 * PASS/FAIL so a mismatch is easy to spot without re-doing any arithmetic. */
export function verificationPdfDoc(
  result: VerificationCheckResult,
): ReportPdfDoc {
  const table: ReportTable = {
    title: "Hand-computed expected vs. actual app result",
    columns: ["Check", "Expected (by hand)", "Actual (app)", "Result"],
    align: ["left", "right", "right", "left"],
    rows: result.rows.map((r) => ({
      cells: [r.label, rs(r.expected), rs(r.actual), r.pass ? "PASS" : "FAIL"],
      negative: !r.pass,
      strong: !r.pass,
    })),
  };
  const passed = result.rows.filter((r) => r.pass).length;
  return {
    title: "Verification results — hand-computed audit",
    subtitle: `${result.recordsFound} VER- records loaded • ${passed}/${result.rows.length} checks passed • run ${new Date(result.ranAt).toLocaleString("en-IN")}`,
    tables: [table],
    fileName: "verification-results",
  };
}
