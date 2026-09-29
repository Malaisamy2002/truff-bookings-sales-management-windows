import type { DataTable, Row } from "./localdb";
import { DATA_TABLES } from "./localdb";

/**
 * Per-row shape checks for a backup being restored, run before anything
 * reaches `bulkPut`/`bulkAdd` (`backup.ts`'s `restoreBackup`) or the
 * receipt-hash `bulkPut` in `telegram-backup.ts`'s `restoreFullBackup`.
 *
 * Until now, `parseBackup`/`parseFullBackupManifest` only checked the
 * envelope (`format`/`tables` presence) — a hand-edited or corrupted
 * `.db`/manifest file could carry a row missing its primary key, or with
 * the wrong type for a field the rest of the app assumes is present (e.g.
 * `amount` as a string, `items` as an object instead of an array). That
 * either throws a raw Dexie error mid-`restoreBackup` transaction — which
 * in `mode: "replace"` has already cleared the target tables, so the
 * failure leaves the ledger emptier than before the restore — or inserts a
 * row that crashes some unrelated read of the table much later, far from
 * the actual cause.
 *
 * This only checks the handful of fields serious enough to break something
 * structurally (the primary key, plus fields other code indexes into,
 * iterates as an array, or does arithmetic on). It is deliberately NOT a
 * full schema validator for every optional field — a backup from a
 * slightly older app version, missing a newer optional column, should
 * still restore cleanly. All checks run up front, before any table is
 * cleared or written to, so a bad backup fails closed with nothing touched
 * rather than partially applied.
 */

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isMoney = (v: unknown): v is number => isNum(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

/** Receipt paths are relative app-private paths. Reject traversal, absolute
 * paths, and alternate separators before any path reaches native filesystem
 * APIs during restore. */
export const isSafeReceiptPath = (v: unknown): v is string => {
  if (!isStr(v) || !v.startsWith("Receipts/")) return false;
  if (v.includes("\\") || v.startsWith("/") || v.includes("..")) return false;
  const parts = v.split("/");
  return parts.every((part) => part.length > 0 && part !== ".");
};

const isObj = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type FieldCheck = readonly [
  field: string,
  check: (v: unknown) => boolean,
  mode?: "optional",
];

export type RowProblem = { index: number; reason: string };

/**
 * Runs `checks` against every row in `rows`. Only reports the FIRST failing
 * field per row (enough to say "this row is broken", not every field wrong
 * with it) so one badly-shaped row doesn't produce a wall of near-duplicate
 * messages.
 */
function checkRows(
  rows: unknown[],
  checks: readonly FieldCheck[],
): RowProblem[] {
  const problems: RowProblem[] = [];
  rows.forEach((row, index) => {
    if (!isObj(row)) {
      problems.push({ index, reason: "row is not an object" });
      return;
    }
    for (const [field, check, mode] of checks) {
      const value = row[field];
      if (mode === "optional" && value === undefined) continue;
      if (!check(value)) {
        problems.push({
          index,
          reason: `"${field}" is missing or the wrong type`,
        });
        return;
      }
    }
  });
  return problems;
}

/**
 * Field checks per `DATA_TABLES` table. Not exhaustive — see the module
 * doc comment above for what's deliberately left unchecked.
 */
const TABLE_CHECKS: Record<DataTable, readonly FieldCheck[]> = {
  customers: [
    ["id", isStr],
    ["name", isStr],
  ],
  bills: [
    ["id", isStr],
    ["invoice_no", isStr],
    ["items", isArr],
    ["subtotal", isMoney],
    ["total", isMoney],
    ["amount_paid", isMoney],
  ],
  expenses: [
    ["id", isStr],
    ["business", isStr],
    ["category", isStr],
    ["amount", isMoney],
    ["spent_at", isStr],
  ],
  history_entries: [
    ["id", isStr],
    ["rows", isArr],
    ["total", isMoney],
  ],
  turf_rates: [
    ["id", isStr],
    ["slot_name", isStr],
    ["rate_per_hour", isMoney],
    ["is_active", isBool],
  ],
  snack_items: [
    ["id", isStr],
    ["item_name", isStr],
    ["unit_price", isMoney],
    ["cost_price", isMoney],
    ["is_active", isBool],
    ["stock_quantity", isNum],
  ],
  snack_stock_history: [
    ["id", isStr],
    ["item_id", isStr],
    ["delta", isNum],
  ],
  turf_bookings: [
    ["id", isStr],
    ["booking_no", isStr],
    ["booking_date", isStr],
    ["hours", isNum],
    ["rate_per_hour", isMoney],
    ["total_amount", isMoney],
    ["snacks", isArr],
  ],
  snack_sales: [
    ["id", isStr],
    ["bill_no", isStr],
    ["items", isArr],
    ["total", isMoney],
  ],
  snack_combos: [
    ["id", isStr],
    ["name", isStr],
    ["items", isArr],
    ["price", isMoney],
  ],
  expense_budgets: [
    ["id", isStr],
    ["month", isStr],
    ["amount", isMoney],
  ],
  recurring_expenses: [
    ["id", isStr],
    ["title", isStr],
    ["amount", isMoney],
    ["day_of_month", isNum],
    ["is_active", isBool],
  ],
  customer_tabs: [
    ["id", isStr],
    ["customer_key", isStr],
    ["status", isStr],
  ],
  tab_entries: [
    ["id", isStr],
    ["tab_id", isStr],
    ["customer_key", isStr],
    ["kind", isStr],
    ["amount", isMoney],
  ],
  app_settings: [["key", isStr]],
  day_closes: [
    ["id", isStr],
    ["day", isStr],
    ["expected_in_drawer", isNum],
    ["counted_cash", isNum],
    ["variance", isNum],
  ],
  day_close_history: [
    ["id", isStr],
    ["day", isStr],
    ["previous_expected_in_drawer", isNum],
    ["previous_counted_cash", isNum],
    ["previous_variance", isNum],
  ],
  payments: [
    ["id", isStr],
    ["parent_type", isStr],
    ["parent_id", isStr],
    ["amount", isMoney],
    ["mode", isStr],
    ["received_at", isStr],
  ],
};

const FULL_BACKUP_EXTRA_TABLES = new Set(["receipts", "receipt_hashes"]);

/** Validate the backup envelope before any row-level validation or restore. */
export function validateBackupTablesEnvelope(
  tables: unknown,
  options: {
    requireAllDataTables?: boolean;
    allowFullBackupExtras?: boolean;
  } = {},
): asserts tables is Record<string, unknown[]> {
  if (!isObj(tables)) throw new Error("Backup tables must be an object");

  const allowed = new Set<string>(DATA_TABLES);
  if (options.allowFullBackupExtras)
    for (const extra of FULL_BACKUP_EXTRA_TABLES) allowed.add(extra);
  for (const key of Object.keys(tables)) {
    if (!allowed.has(key))
      throw new Error(`Backup contains an unknown table "${key}"`);
    if (!isArr(tables[key]))
      throw new Error(`Backup table "${key}" is not an array`);
  }

  if (options.requireAllDataTables) {
    const missing = DATA_TABLES.filter((t) => !(t in tables));
    if (missing.length > 0)
      throw new Error(
        `Full backup is missing required table${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    for (const extra of FULL_BACKUP_EXTRA_TABLES) {
      if (!(extra in tables))
        throw new Error(`Full backup is missing required table "${extra}"`);
    }
  }
}

export type InvalidRow = { table: DataTable; index: number; reason: string };

/**
 * Validates every row of every `DATA_TABLES` table in a backup snapshot.
 * Returns the list of problems found (empty = the backup looks
 * restorable). `tables` takes the same loose shape `BackupFile["tables"]`
 * and `FullBackup["tables"]` already share, so it works for both.
 */
export function findInvalidRows(
  tables: Record<string, unknown[] | undefined>,
): InvalidRow[] {
  const problems: InvalidRow[] = [];
  for (const t of DATA_TABLES) {
    const rows = tables[t] ?? [];
    for (const p of checkRows(rows, TABLE_CHECKS[t]))
      problems.push({ table: t, ...p });

    // Dexie's bulkPut is last-write-wins for duplicate primary keys. A
    // duplicated id inside a backup therefore silently destroys one row
    // during restore instead of restoring the snapshot faithfully. Reject
    // duplicates before any table is cleared or written.
    // Dexie primary keys are not uniformly named `id`: app_settings is keyed
    // by `key`. Validate the actual primary-key field so duplicate settings
    // cannot silently overwrite each other during bulkPut.
    const primaryKey = t === "app_settings" ? "key" : "id";
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (!isObj(row) || !isStr(row[primaryKey])) return;
      const value = row[primaryKey];
      if (seen.has(value))
        problems.push({
          table: t,
          index,
          reason: `duplicate primary key "${value}"`,
        });
      else seen.add(value);
    });
  }
  return problems;
}

/** One line summarizing every problem found, for an error toast. */
export function describeInvalidRows(problems: InvalidRow[]): string {
  const byTable = new Map<DataTable, number>();
  for (const p of problems)
    byTable.set(p.table, (byTable.get(p.table) ?? 0) + 1);
  const parts = [...byTable.entries()]
    .map(([t, n]) => `${n} in ${t}`)
    .join(", ");
  return `This backup has ${problems.length} row${
    problems.length === 1 ? "" : "s"
  } that don't look right (${parts}) — nothing was restored.`;
}

const RECEIPT_HASH_CHECKS: readonly FieldCheck[] = [
  ["path", isStr],
  ["sha256", isStr],
];

/** Same shape check as `findInvalidRows`, for the `receipt_hashes` rows a
 *  full Telegram backup restores separately (they aren't in `DATA_TABLES`). */
export function findInvalidReceiptHashRows(rows: unknown[]): RowProblem[] {
  const problems = checkRows(rows, RECEIPT_HASH_CHECKS);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isObj(row) || !isStr(row["path"])) return;
    if (seen.has(row["path"]))
      problems.push({
        index,
        reason: `duplicate primary key "${row["path"]}"`,
      });
    else seen.add(row["path"]);
  });
  return problems;
}

const PHOTO_CHECKS: readonly FieldCheck[] = [
  ["path", isSafeReceiptPath],
  ["data", isStr],
  ["created_at", isStr],
];

/** Same shape check, for the inline base64 `photos[]` a version-2 local
 *  `.db` backup carries (`BackupPhoto` in backup.ts). */
export function findInvalidPhotoRows(rows: unknown[]): RowProblem[] {
  const problems = checkRows(rows, PHOTO_CHECKS);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isObj(row) || !isStr(row["path"])) return;
    if (seen.has(row["path"]))
      problems.push({
        index,
        reason: `duplicate primary key "${row["path"]}"`,
      });
    else seen.add(row["path"]);
  });
  return problems;
}
