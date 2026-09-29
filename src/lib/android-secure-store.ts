/**
 * Thin wrapper around the `android-save` plugin's `secureSet`/`secureGet`/
 * `secureDelete` commands (see `src-tauri/plugins/android-save`), which
 * store values in an `EncryptedSharedPreferences` file backed by a
 * Keystore-derived AES256-GCM master key.
 *
 * This exists because desktop's `keyring_*` commands (OS credential store —
 * Windows Credential Manager / macOS Keychain / libsecret) are
 * `#[cfg(not(target_os = "android"))]`-gated: there is no equivalent OS
 * credential store on Android reachable the same way, so telegram-backup.ts
 * previously fell back to plaintext `localStorage` for every Android build
 * (audit item 1.3). Callers should only reach for this module when
 * `isAndroid()` is true — on any other target these commands simply don't
 * exist and every call rejects.
 *
 * `key` is validated against a fixed allowlist on the Kotlin side (see
 * `AndroidSavePlugin.secureSet/secureGet/secureDelete`) rather than trusted
 * as an arbitrary caller-supplied name — the same principle desktop's
 * `keyring_*` commands apply to `account` (see `src-tauri/src/lib.rs`).
 */

// Two concurrent Android secret writes (writeTelegramConfig() writes the
// primary token and the extra tokens together via Promise.all) can both
// hit this as their *first* dynamic import of the specifier in the same
// tick. Under Vitest's module mocking that race can resolve inconsistently
// — one caller gets the mock, the other the real (unmocked) module, which
// then reaches for `window.__TAURI_INTERNALS__` and throws. A fresh
// `await import(...)` per call is safe in the real bundled app (dynamic
// import of the same specifier always resolves to one cached module
// instance there) — see telegram-backup.ts's own `tauriCore()` helper,
// which documents and fixes the identical race for its keyring calls.
// Caching the import here the same way means only one dynamic import ever
// actually executes, sidestepping the race in both places.
let tauriCorePromise: Promise<typeof import("@tauri-apps/api/core")> | null =
  null;
function tauriCore() {
  if (!tauriCorePromise) tauriCorePromise = import("@tauri-apps/api/core");
  return tauriCorePromise;
}

async function secureInvoke<T>(
  command: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await tauriCore();
  return invoke<T>(`plugin:android-save|${command}`, { payload });
}

/** Reads a stored secret, or `null` if nothing is stored (or the read failed). */
export async function secureGet(key: string): Promise<string | null> {
  try {
    const result = await secureInvoke<{ value: string | null }>("secure_get", {
      key,
    });
    return result?.value ?? null;
  } catch {
    return null;
  }
}

/** Stores a secret, replacing any existing value under the same key. */
export async function secureSet(key: string, value: string): Promise<void> {
  await secureInvoke<void>("secure_set", { key, value });
}

/** Deletes a stored secret. Never throws on "nothing was there to delete". */
export async function secureDelete(key: string): Promise<void> {
  try {
    await secureInvoke<void>("secure_delete", { key });
  } catch {
    /* fine if there was nothing to delete, or the store is unavailable */
  }
}
