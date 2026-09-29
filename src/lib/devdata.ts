import { db, DATA_TABLES, nowIso, resyncCounters, table } from "./localdb";
import { writeBackupPassphrase } from "./backup-passphrase";
import {
  DEFAULT_TELEGRAM_CONFIG,
  writeTelegramConfig,
} from "./telegram-backup";

/**
 * Dev/maintenance helper: wipes transactional data from the local database.
 * (The old 1,00,000-record load-test generator has been removed — it wrote
 * synthetic rows straight into live data.)
 */
export async function clearTestData() {
  await db.turf_bookings.clear();
  await db.snack_sales.clear();
  await db.expenses.clear();
  await db.payments.clear();
  await db.counters.clear();
  await db.counters.put({ key: "invoice", value: 0, updated_at: nowIso() });
  await resyncCounters();
}

/**
 * Settings "danger zone" reset: wipes every local table — customers, bills,
 * bookings, sales, expenses, tabs, rates/menu, branding/print settings,
 * saved receipts, everything — and reseeds the invoice/booking counters back
 * to zero. Irreversible; the confirming UI should warn the person to take a
 * backup first.
 */
export async function clearAllData() {
  await db.transaction(
    "rw",
    [
      ...DATA_TABLES.map((t) => table(t)),
      db.receipts,
      db.receipt_hashes,
      db.counters,
    ],
    async () => {
      for (const t of [...DATA_TABLES].reverse()) {
        await table(t).clear();
      }
      await db.receipts.clear();
      await db.receipt_hashes.clear();
      await db.counters.clear();
    },
  );

  // A full reset must also remove secrets and persisted UI/backup state that
  // lives outside IndexedDB. Secret writers target the OS credential stores
  // on desktop/Android and fall back to localStorage only when those stores
  // are unavailable.
  await Promise.all([
    writeBackupPassphrase(""),
    writeTelegramConfig(DEFAULT_TELEGRAM_CONFIG),
  ]);

  if (typeof window !== "undefined") {
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
        const key = window.localStorage.key(i);
        if (key?.startsWith("ks:")) window.localStorage.removeItem(key);
      }
      for (let i = window.sessionStorage.length - 1; i >= 0; i -= 1) {
        const key = window.sessionStorage.key(i);
        if (key?.startsWith("ks:")) window.sessionStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable — IndexedDB and OS secrets are still cleared */
    }
  }

  if (typeof caches !== "undefined") {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  }

  await resyncCounters();
}
