# Turf Bookings & Sales Ledger

A local-first business app for a turf (sports ground) + snacks business in
India. All data lives on the device (Dexie/IndexedDB); money is whole rupees.
Windows (Tauri v2) and Android (Tauri mobile) share one React 19 + TanStack
codebase.

## Features

- Turf bookings (multi-court slots, day-part rates, repeat bookings, advances,
  split payments, cancellations with forfeited/refundable advances)
- Snack sales with live stock, combos and tax-frozen bills
- Customer ledger: dues, on-tab sales, settle-and-close
- GST invoicing (CGST/SGST, custom taxes), receipts (PDF/print/share), UPI QR
- Reports: revenue/collected/dues/profit, payment split, GST, P&L, exports
- Encrypted local backup + optional Telegram cloud backup with restore
- Day-close cash drawer with variance and re-close history

The money rules are documented in [`docs/calculation-rules.md`](docs/calculation-rules.md) — read it
before changing anything in `src/lib`.

## Development

Prerequisites: **Node 22**.

```bash
npm ci --ignore-scripts
npm run dev          # Vite dev server
npx tsc --noEmit     # type check (must be clean)
npx eslint .         # lint (must be clean)
npx vitest run       # unit tests
npm run verify:math      # seeded financial fixtures (4,920 / 7,935 / 12,855)
npm run verify:sections  # section-id registry checks
npm run verify:loadtest:light   # independent ledger audit
npm run verify:loadtest:medium
```

## Building

```bash
npm run build        # SPA bundle in .output/public (Tauri serves index.html)
```

Windows installer / Android APK: via Tauri (`npm run tauri build`). The
Android CI/workflow has not been proven from this repo snapshot — see
`ANDROID_BUILD.md` (Android repo) for the current assumptions.

## Backups

Settings → Backup: encrypted file backups (set a passphrase) and optional
Telegram backups (bot token + private chat id). Restore replaces or merges;
document numbers are rebuilt from restored rows on every restore.

## Repo layout

- `src/lib/` — all business logic (money rules live here; components must not
  re-derive figures)
- `src/components/app/` — tab UI
- `docs/` — calculation rules, formula report, verification notes
- `src-tauri/` — desktop shell (Windows printing, keyring, capabilities)
