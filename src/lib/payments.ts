import { money, rupees } from "./money";
import { isOnlinePaymentMode } from "./ops";
import {
  db,
  newId,
  nowIso,
  sequentialTimestamps,
  type BillRow,
  type PaymentParentType,
  type PaymentRow,
  type SnackSaleRow,
  type TurfBookingRow,
} from "./localdb";

/**
 * Payments: one row per actual receipt of money against a bill, turf
 * booking, or snack sale.
 *
 * This is the ONE place that writes to the `payments` table. Every screen
 * that collects money (bills quick-pay, dashboard dues, turf collect,
 * booking advance, snack sale, tab settle) should end up calling
 * `recordPayment()` rather than writing rows itself, so the parent's
 * `amount_paid`/`advance_paid` field and its payment rows can never drift
 * apart — see "payment rows always add up to the parent's amount_paid" in
 * payments.test.ts, which checks exactly that invariant.
 *
 * Customer-tab payments are NOT recorded here — a tab entry already carries
 * its own mode per line (see lib/tabs.ts), so duplicating that into this
 * table would double-count the same money.
 */

/** Modes a payment can actually be received in (distinct from `PAYMENT_MODES`
 * in ops.ts, which also lists "Pending" — a not-yet-received state that can
 * never itself be a *payment*). */
export const RECEIVED_PAYMENT_MODES = ["Cash", "UPI", "Card"] as const;
export type ReceivedPaymentMode = (typeof RECEIVED_PAYMENT_MODES)[number];

/** A parent row may still carry an operational mode such as "Pending" or
 * "On tab". Those are not payment methods; when legacy data needs to be
 * represented as a real/implied payment, the app's unknown-mode convention is
 * to treat it as Cash. */
export function normalizeReceivedPaymentMode(
  mode: string | null | undefined,
): ReceivedPaymentMode {
  return mode === "UPI" || mode === "Card" ? mode : "Cash";
}

/** One part of a (possibly split) collection — e.g. ₹500 Cash + ₹500 UPI. */
export type PaymentEntry = {
  amount: number;
  mode: ReceivedPaymentMode;
};

type ParentConfig = {
  table: "bills" | "turf_bookings" | "snack_sales";
  /** Field on the parent row that mirrors "total collected so far".
   * `null` for parent types that don't track partial payment yet (snack
   * sales, until phase 5 adds a part-paid remainder) — recordPayment still
   * writes the payment rows for those, it just has nothing to sync back. */
  amountField: "amount_paid" | "advance_paid" | null;
  modeField: "payment_mode";
  dateField: string;
};

const PARENT_CONFIG: Record<PaymentParentType, ParentConfig> = {
  bill: {
    table: "bills",
    amountField: "amount_paid",
    modeField: "payment_mode",
    dateField: "bill_date",
  },
  turf_booking: {
    table: "turf_bookings",
    amountField: "advance_paid",
    modeField: "payment_mode",
    dateField: "booking_date",
  },
  snack_sale: {
    table: "snack_sales",
    amountField: null,
    modeField: "payment_mode",
    dateField: "sale_date",
  },
};

type ParentRow = BillRow | TurfBookingRow | SnackSaleRow;

/** Reads the parent row's already-collected amount/mode/date, for building
 * the implied payment of a record that predates this table. Returns null
 * for a parent type with no amount field (nothing collected to imply) or a
 * missing row. */
function impliedFromParent(
  parentType: PaymentParentType,
  row: ParentRow | undefined,
): { amount: number; mode: ReceivedPaymentMode; date: string } | null {
  const cfg = PARENT_CONFIG[parentType];
  if (!row || !cfg.amountField) return null;
  const amount = Number((row as Record<string, unknown>)[cfg.amountField]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const mode = normalizeReceivedPaymentMode(
    (row as Record<string, unknown>)[cfg.modeField] as
      string | null | undefined,
  );
  const date = String((row as Record<string, unknown>)[cfg.dateField] ?? "");
  return { amount, mode, date };
}

/**
 * Every real payment row on file for one parent record, oldest first. Does
 * NOT synthesize the implied payment for old data — use `paymentsForParent`
 * for that; this is the low-level "what's actually stored" view, used by
 * `recordPayment` to decide whether a backfill is needed.
 */
async function storedPayments(
  parentType: PaymentParentType,
  parentId: string,
): Promise<PaymentRow[]> {
  const rows = await db.payments.where("parent_id").equals(parentId).toArray();
  return rows
    .filter((r) => r.parent_type === parentType)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Every payment against one parent record, read-side. If the record
 * predates this table (no rows in `payments` yet) but already shows an
 * amount collected on its own `amount_paid`/`advance_paid` field, that is
 * returned as one synthetic implied payment — never persisted by this
 * function, so calling it repeatedly is always safe. A record with nothing
 * collected (due amount only) returns an empty list either way.
 */
export async function paymentsForParent(
  parentType: PaymentParentType,
  parentId: string,
): Promise<PaymentRow[]> {
  const real = await storedPayments(parentType, parentId);
  if (real.length > 0) return real;

  const cfg = PARENT_CONFIG[parentType];
  const row = (await (
    db[cfg.table] as never as {
      get: (id: string) => Promise<ParentRow | undefined>;
    }
  ).get(parentId)) as ParentRow | undefined;
  const implied = impliedFromParent(parentType, row);
  if (!implied) return [];

  return [
    {
      id: `implied:${parentType}:${parentId}`,
      parent_type: parentType,
      parent_id: parentId,
      amount: implied.amount,
      mode: implied.mode,
      received_at: implied.date,
      created_at: implied.date,
    },
  ];
}

/** Cash vs online totals for a list of payments — the one place that
 * decides which of THESE rows count as online, reusing the same
 * Cash-vs-Online rule (`isOnlinePaymentMode`) already used for expenses and
 * the drawer, so a payment split never disagrees with the rest of the app
 * about what "online" means. */
export function cashOnlineSplit(payments: { amount: number; mode: string }[]): {
  cash: number;
  online: number;
} {
  let cash = 0;
  let online = 0;
  for (const p of payments) {
    if (isOnlinePaymentMode(p.mode)) online += p.amount;
    else cash += p.amount;
  }
  return { cash, online };
}

export type RecordPaymentInput = {
  parentType: PaymentParentType;
  parentId: string;
  /** One or more parts of this collection — a single entry for a plain
   * Cash/UPI/Card payment, two entries for a split payment. */
  entries: PaymentEntry[];
  /** When the money actually arrived. Defaults to now — pass an explicit
   * value when recording a payment for an earlier day. */
  receivedAt?: string;
  /** Extra fields written to the parent in the SAME transaction as the
   * payment rows (e.g. a bill's `status` and `payment_mode`), so a screen
   * never has to update the parent in a second step that could fail and
   * leave rows and status disagreeing. A function receives the new total
   * collected. */
  parentPatch?:
    Record<string, unknown> | ((total: number) => Record<string, unknown>);
  /** What the parent had REALLY collected before this call, when that isn't
   * the raw `amount_paid`/`advance_paid` (a booking whose balance was put on
   * a tab has `advance_paid` inflated to its gross). Used only for the
   * one-time implied backfill of a record with no rows yet. */
  impliedAmount?: number;
};

export type RecordPaymentResult = {
  /** The rows just written — the implied backfill row (if any) followed by
   * this call's own entries. */
  added: PaymentRow[];
  /** Every payment on file for the parent after this call, oldest first. */
  all: PaymentRow[];
  /** Sum of `all` — also what the parent's amount field (when it has one)
   * was just set to. */
  total: number;
};

/**
 * Records one collection (one or more entries) against a bill, turf
 * booking, or snack sale, in a single database transaction:
 *
 * 1. If this parent has no payment rows yet but already shows something
 *    collected on its own record, that implied payment is saved first —
 *    so the record's history reads correctly from here on, without a
 *    separate migration step.
 * 2. This call's entries are inserted.
 * 3. The parent's `amount_paid`/`advance_paid` field (when it has one) is
 *    set to the new sum of all its payment rows, so every existing
 *    dues/receipt/profit calculation — which reads that field, not this
 *    table — keeps seeing the right number.
 *
 * Throws if any entry's amount isn't a positive number; does not clamp
 * against the parent's total/due, since that check has to know the
 * parent's total, discount, and tax, which differ by parent type. Callers
 * that need "don't let the collected amount exceed the due" enforce it
 * before calling this (e.g. the shared split-payment control's own check).
 */
export async function recordPayment(
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  const { parentType, parentId, entries } = input;
  const receivedAt = input.receivedAt ?? nowIso();
  const cfg = PARENT_CONFIG[parentType];

  if (entries.length === 0) {
    throw new Error("recordPayment: at least one entry is required.");
  }
  for (const e of entries) {
    if (!Number.isFinite(e.amount) || e.amount <= 0) {
      throw new Error(
        `recordPayment: entry amounts must be positive (got ${e.amount}).`,
      );
    }
  }

  return db.transaction("rw", [db.payments, db[cfg.table]], async () => {
    const existing = await storedPayments(parentType, parentId);
    const added: PaymentRow[] = [];

    if (existing.length === 0) {
      const row = (await (
        db[cfg.table] as never as {
          get: (id: string) => Promise<ParentRow | undefined>;
        }
      ).get(parentId)) as ParentRow | undefined;
      const rawImplied = impliedFromParent(parentType, row);
      const implied =
        rawImplied && input.impliedAmount !== undefined
          ? { ...rawImplied, amount: input.impliedAmount }
          : rawImplied;
      if (implied && implied.amount > 0) {
        const impliedRow: PaymentRow = {
          id: newId(),
          parent_type: parentType,
          parent_id: parentId,
          amount: implied.amount,
          mode: implied.mode,
          received_at: implied.date || receivedAt,
          created_at: implied.date || receivedAt,
        };
        await db.payments.add(impliedRow);
        added.push(impliedRow);
      }
    }

    const entryTimestamps = sequentialTimestamps(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const row: PaymentRow = {
        id: newId(),
        parent_type: parentType,
        parent_id: parentId,
        amount: entry.amount,
        mode: entry.mode,
        received_at: receivedAt,
        // Sequential, not one shared `nowIso()` — a split's Cash and UPI
        // rows both being written here in the same call must not tie (see
        // `sequentialTimestamps`'s doc comment).
        created_at: entryTimestamps[i]!,
      };
      await db.payments.add(row);
      added.push(row);
    }

    const all = [...existing, ...added].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const total = all.reduce((s, p) => s + p.amount, 0);

    const patch =
      typeof input.parentPatch === "function"
        ? input.parentPatch(total)
        : (input.parentPatch ?? {});
    if (cfg.amountField || Object.keys(patch).length > 0) {
      await (
        db[cfg.table] as never as {
          update: (id: string, changes: Record<string, unknown>) => unknown;
        }
      ).update(parentId, {
        ...(cfg.amountField ? { [cfg.amountField]: total } : {}),
        // Last, so a caller can override the amount field (see
        // collectBookingPayment, whose `advance_paid` can be tab-inflated).
        ...patch,
      });
    }

    return { added, all, total };
  });
}

/** One parent record's already-collected amount, as analytics.ts computes it
 * (via billCollected/bookingCashCollected/snackSaleCollected, which already
 * apply the tax/on-tab-exclusion rules) — the minimal shape
 * `effectivePaymentEntries` needs to build that parent's implied payment
 * when it has no real rows yet. */
export type PaymentSourceRecord = {
  id: string;
  /** Money actually collected against this record — NOT the raw
   * amount_paid/advance_paid field; callers pass the already-computed
   * billCollected()/bookingCashCollected()/snackSaleCollected() figure. */
  collected: number;
  mode: string | null;
  /** The record's own date (bill_date/booking_date/sale_date) — used as
   * the implied payment's received_at only when there are no real rows. */
  date: string;
};

/** One entry in the flattened, per-payment view `effectivePaymentEntries`
 * returns: a real payment row's fields, or a synthetic implied payment's. */
export type EffectivePaymentEntry = {
  parent_type: PaymentParentType;
  parent_id: string;
  amount: number;
  mode: string;
  received_at: string;
};

/**
 * Bulk, DB-free counterpart to `paymentsForParent`: expands every bill/
 * turf-booking/snack-sale in `sources` into one entry per real payment row
 * on file for it, or — for a parent with no real rows yet — one synthetic
 * entry built from its own collected amount/mode/date, exactly like
 * `paymentsForParent`'s implied fallback. `paymentsForParent` does one
 * DB round trip per parent, which is fine for a single record but not for
 * the thousands analytics.ts (paymentSplit, the cash drawer, reports) has
 * to fold over at once — this takes the already-loaded arrays instead.
 *
 * A record with nothing collected (`collected <= 0`) contributes no
 * entries, same as `paymentsForParent` returning `[]` for it.
 */
export function effectivePaymentEntries(
  sources: Partial<Record<PaymentParentType, PaymentSourceRecord[]>>,
  payments: PaymentRow[],
): EffectivePaymentEntry[] {
  const byParent = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    const key = `${p.parent_type}:${p.parent_id}`;
    const list = byParent.get(key);
    if (list) list.push(p);
    else byParent.set(key, [p]);
  }

  const entries: EffectivePaymentEntry[] = [];
  for (const parentType of Object.keys(sources) as PaymentParentType[]) {
    for (const rec of sources[parentType] ?? []) {
      if (!(rec.collected > 0)) continue;
      const real = byParent.get(`${parentType}:${rec.id}`);
      if (real && real.length > 0) {
        // The rows should add up to what the record says was collected. When
        // they don't — a path that changes the paid amount without writing a
        // row (a status toggle, an edited advance) — reconcile here so the
        // split and the drawer never drift from the record's own figure:
        //  - short: the difference is counted as received on the record's
        //    own date, in its own mode (exactly the pre-payments behaviour);
        //  - over: the newest rows give back the excess.
        const rowsTotal = real.reduce((s, r) => s + r.amount, 0);
        const diff = rupees(rec.collected - rowsTotal);
        const kept: { row: PaymentRow; amount: number }[] = real.map((row) => ({
          row,
          amount: row.amount,
        }));
        if (diff < 0) {
          let excess = -diff;
          const newestFirst = [...kept].sort((a, b) =>
            b.row.received_at.localeCompare(a.row.received_at),
          );
          for (const k of newestFirst) {
            if (excess <= 0) break;
            const cut = Math.min(k.amount, excess);
            k.amount -= cut;
            excess -= cut;
          }
        }
        for (const { row, amount } of kept) {
          if (amount <= 0) continue;
          entries.push({
            parent_type: parentType,
            parent_id: rec.id,
            amount,
            mode: normalizeReceivedPaymentMode(row.mode),
            received_at: row.received_at,
          });
        }
        if (diff > 0) {
          entries.push({
            parent_type: parentType,
            parent_id: rec.id,
            amount: diff,
            mode: normalizeReceivedPaymentMode(rec.mode),
            received_at: rec.date,
          });
        }
      } else {
        entries.push({
          parent_type: parentType,
          parent_id: rec.id,
          amount: rec.collected,
          mode: normalizeReceivedPaymentMode(rec.mode),
          received_at: rec.date,
        });
      }
    }
  }
  return entries;
}

/**
 * Removes every payment row on file for a parent record (real rows only —
 * an implied payment is never persisted, so there is nothing to remove
 * when the parent predates this table) and, when the parent tracks an
 * amount field, resets it to 0. For cancel/delete/un-merge flows, so a
 * reversed record doesn't leave stale payment rows behind.
 */
export async function reversePaymentsForParent(
  parentType: PaymentParentType,
  parentId: string,
): Promise<number> {
  const cfg = PARENT_CONFIG[parentType];
  return db.transaction("rw", [db.payments, db[cfg.table]], async () => {
    const rows = await storedPayments(parentType, parentId);
    for (const r of rows) await db.payments.delete(r.id);
    if (cfg.amountField) {
      await (
        db[cfg.table] as never as {
          update: (id: string, changes: Record<string, unknown>) => unknown;
        }
      ).update(parentId, { [cfg.amountField]: 0 });
    }
    return rows.length;
  });
}

/** The mode a parent record's own single `payment_mode` field should show
 * after a collection: the mode that carried the most money (first one wins a
 * tie). Receipts and the legacy readers that only know one mode keep working;
 * the exact split lives in the payment rows. */
export function primaryMode(entries: PaymentEntry[]): ReceivedPaymentMode {
  let best = entries[0];
  for (const e of entries) if (best && e.amount > best.amount) best = e;
  return best?.mode ?? "Cash";
}

/** Deletes every payment row for the given parents WITHOUT touching the
 * parents themselves — for flows that delete or void the parent row. Call it
 * inside the transaction that already includes `db.payments`. */
export async function removePaymentsForParents(
  parentType: PaymentParentType,
  parentIds: string[],
): Promise<number> {
  if (parentIds.length === 0) return 0;
  const ids = new Set(parentIds);
  const rows = await db.payments
    .filter((r) => r.parent_type === parentType && ids.has(r.parent_id))
    .toArray();
  if (rows.length > 0) await db.payments.bulkDelete(rows.map((r) => r.id));
  return rows.length;
}

/**
 * Writes the payment rows for money taken WHEN a record is created (a booking
 * advance, a snack sale paid on the spot). The parent already carries the
 * paid amount, so unlike `recordPayment` this touches only the rows; it does
 * nothing if the record already has some. `receivedAt` defaults to now, i.e.
 * the day the money really arrived — not the booking's play date.
 */
export async function recordInitialPayments(
  parentType: PaymentParentType,
  parentId: string,
  entries: PaymentEntry[],
  receivedAt: string = nowIso(),
): Promise<PaymentRow[]> {
  const positive = entries.filter(
    (e) => Number.isFinite(e.amount) && e.amount > 0,
  );
  if (positive.length === 0) return [];
  return db.transaction("rw", db.payments, async () => {
    if ((await storedPayments(parentType, parentId)).length > 0) return [];
    const timestamps = sequentialTimestamps(positive.length);
    const rows: PaymentRow[] = positive.map((e, i) => ({
      id: newId(),
      parent_type: parentType,
      parent_id: parentId,
      amount: e.amount,
      mode: e.mode,
      received_at: receivedAt,
      created_at: timestamps[i]!,
    }));
    await db.payments.bulkAdd(rows);
    return rows;
  });
}

/**
 * Wholesale-replaces the payment rows for one parent — for correcting the
 * MODE of money already collected (not new money: the parent's own amount
 * field doesn't change), e.g. fixing a snack sale rung up as Cash that was
 * actually paid half in UPI. Deletes every existing row for that parent and
 * inserts `entries` fresh, keeping `receivedAt` (normally the sale's own
 * date, not today, since this corrects the ORIGINAL event rather than
 * recording a new one) so day-based reports don't shift the money to a
 * different day than it actually happened. Unlike `recordPayment`, never
 * touches the parent row itself — a caller that also needs a mode-summary
 * field updated does that with its own separate write.
 */
export async function replacePaymentsForParent(
  parentType: PaymentParentType,
  parentId: string,
  entries: PaymentEntry[],
  receivedAt: string,
): Promise<PaymentRow[]> {
  const positive = entries.filter(
    (e) => Number.isFinite(e.amount) && e.amount > 0,
  );
  return db.transaction("rw", db.payments, async () => {
    await removePaymentsForParents(parentType, [parentId]);
    if (positive.length === 0) return [];
    const timestamps = sequentialTimestamps(positive.length);
    const rows: PaymentRow[] = positive.map((e, i) => ({
      id: newId(),
      parent_type: parentType,
      parent_id: parentId,
      amount: e.amount,
      mode: e.mode,
      received_at: receivedAt,
      created_at: timestamps[i]!,
    }));
    await db.payments.bulkAdd(rows);
    return rows;
  });
}

/**
 * "Cash ₹700 + UPI ₹300" for a record paid in more than one mode, or null when
 * it was paid in one mode (or not at all) so the caller keeps showing the plain
 * mode. Used on receipts.
 */
export function describePaymentSplit(
  rows: { amount: number; mode: string }[],
): string | null {
  const byMode = new Map<string, number>();
  for (const r of rows) {
    if (!(r.amount > 0)) continue;
    const mode = r.mode || "Cash";
    byMode.set(mode, (byMode.get(mode) ?? 0) + r.amount);
  }
  if (byMode.size < 2) return null;
  return [...byMode]
    .map(([mode, amount]) => `${mode} ${money(amount)}`)
    .join(" + ");
}

// Receipts are built synchronously at the moment of a tap, from a record
// alone, so the payment rows are looked up in this small in-memory index that
// the app keeps in step with the database (see lib/receipt-payments.ts).
let receiptIndex = new Map<string, PaymentRow[]>();

export function setReceiptPayments(rows: PaymentRow[]) {
  const next = new Map<string, PaymentRow[]>();
  for (const r of rows) {
    const key = `${r.parent_type}:${r.parent_id}`;
    const list = next.get(key);
    if (list) list.push(r);
    else next.set(key, [r]);
  }
  receiptIndex = next;
}

/** The "Mode" a receipt should print: the split when the record was paid in
 * several modes, otherwise the record's own mode. */
export function receiptModeLabel(
  parentType: PaymentParentType,
  parentId: string,
  fallback: string,
): string {
  const rows = receiptIndex.get(`${parentType}:${parentId}`);
  return (rows && describePaymentSplit(rows)) || fallback;
}
