# UI fixes (Windows)

- Tabs stay mounted (hidden) once visited, so an in-progress sale, booking or expense survives a tab switch (routes/index.tsx).
- Ctrl+Enter, "/" and the command palette now ignore hidden tabs (lib/visible-query.ts).
- Command palette: "Collect payment" / "Find customer" focus the search box after the dialog closes, so Radix no longer steals focus back; palette has an accessible title.
- Turf booking detail pane scrolls instead of running off the viewport.
- Print preview labels are tied to their controls.
- Shared with Android: Sell cart rows wrap on phones and use full-size controls; dialog close X and court steppers get a larger hit area; time-slot swipe needs a clearly horizontal gesture; status strip no longer overflows; money fields are text/decimal inputs instead of type=number; small red text meets contrast in dark mode; `dataset["cartBar"]` typing fixed; lint clean.

## Round 2

- Global `button { font-size: 16px }` removed (inputs keep it); buttons now inherit their size, so the status-strip backup label and inline text-links match the text around them.
- `monthLabel` uses a 4-digit year ("Sept 2026") so it no longer reads like a day; the Expenses budget label uses it too.
- Accordion `Header` is `flex-1`, so Settings chevrons sit at the right edge; section titles are spans (no headings/paragraphs/divs inside the trigger button).
- Each tab remembers its own scroll position and restores it when shown; a tab never visited opens at the top (routes/index.tsx).
- Hidden tabs are wrapped in `<Activity>`: state is kept, effects (listeners, resize observers, live queries) pause. Removes the Recharts "width(0)" warning.
- Status strip and `chrome-solid` are opaque, so scrolled content no longer shows through.
- Keyboard-shortcuts hint is hidden on touch (coarse pointer) devices.
- Main column reserves room for the floating scroll button on windows narrower than 1320px so it no longer covers page controls.
- Year picker no longer shows a dangling "·"; duplicate "Recurring expenses"/"Recent expenses" disclosure labels renamed; command-palette input clears the close button.

## Round 3

- Keyboard-shortcuts hint button moved from bottom-left (where it covered "Settings" at 960×600) to the bottom-right gutter, stacked directly above the scroll button (cart-bar offsets kept).
- Windows Bookings list rows: the second line (date · time · slot · Due ₹…) wraps instead of truncating, and "Due ₹…" never splits mid-amount.
- Booking detail card: status / payment / merged chips sit in a left-aligned wrapping row, and the action buttons are left-aligned; the text block now takes the row first, so the chips only drop below it when the pane is narrow.
- Stat labels (`MiniStat`, "Top expense category") wrap instead of truncating ("OUTSTANDING TUR…"); values are bottom-aligned so figures line up across a row.
- Reports month field: `<input type="month">` replaced with `MonthPicker` (Popover with year stepper + month grid) so it reads "Sept 2026" on every WebView, not "2026-09".
- Duplicate headings: the Outstanding list disclosure was named "Outstanding" under a page title "Outstanding" and a section "Outstanding balances" → now "Balance list". The desktop two-pane list captions match their mobile disclosure names ("Booking list (n)", "Balance list (n)") instead of repeating the section heading.
- Recharts "width and height are both fixed numbers": `PopularSnacksCard` nested a `ResponsiveContainer` inside `ChartContainer` (which already provides one); the outer one handed the inner one numeric sizes. Inner container removed.
- Sidebar no longer slides up ~32px at the bottom of a page: the shell's `md:pb-8` shortened the sticky nav's containing block; `main` already pads its own bottom on md+, so the shell padding is now `md:pb-0`.
- Already in the previous snapshot (verified, not changed): consistent DD-MM-YYYY on the Turf calendar's selected-day header; moved bookings/bills/sales use a dashed border instead of 60% opacity; "Pending dues" section vs "Due bookings" disclosure; "Bill list" / "Sales list" / "Booking list" disclosure names.
- Android gets the shared parts: stat-label wrapping, `MonthPicker`, the `PopularSnacksCard` fix, and the "Balance list" rename.

## Round 3

- Keyboard-shortcuts hint button moved from bottom-left (where it covered "Settings" at 960×600) to the bottom-right gutter, stacked directly above the scroll button (cart-bar offsets kept).
- Windows Bookings list rows: the second line (date · time · slot · Due ₹…) wraps instead of truncating, and "Due ₹…" never splits mid-amount.
- Booking detail card: status / payment / merged chips sit in a left-aligned wrapping row, and the action buttons are left-aligned; the text block takes the row first, so the chips only drop below it when the pane is narrow.
- Stat labels (`MiniStat`, "Top expense category") wrap instead of truncating ("OUTSTANDING TUR…"); values are bottom-aligned so figures line up across a row.
- Reports month field: `<input type="month">` replaced with `MonthPicker` (Popover with year stepper + month grid) so it reads "Sept 2026" on every WebView, not "2026-09".
- Duplicate headings: the Outstanding list disclosure was "Outstanding" under a page title "Outstanding" and a section "Outstanding balances" → now "Balance list". The desktop two-pane list captions match their mobile disclosure names ("Booking list (n)", "Balance list (n)") instead of repeating the section heading.
- Recharts "width and height are both fixed numbers": `PopularSnacksCard` nested a `ResponsiveContainer` inside `ChartContainer` (which already provides one); the outer one handed the inner one numeric sizes. Inner container removed.
- Sidebar no longer slides up ~32px at the bottom of a page: the shell's `md:pb-8` shortened the sticky nav's containing block; `main` already pads its own bottom on md+, so the shell padding is now `md:pb-0`.
- Already in the previous snapshot (verified, not changed): DD-MM-YYYY on the Turf calendar's selected-day header; moved bookings/bills/sales use a dashed border instead of 60% opacity; "Pending dues" section vs "Due bookings" disclosure; "Bill list" / "Sales list" / "Booking list" disclosure names.
- Android gets the shared parts: stat-label wrapping, `MonthPicker`, the `PopularSnacksCard` fix, and the "Balance list" rename.

## Round 3b — self-audit

- Same truncation as the Bookings list, found in other rows: second lines now wrap (`break-words`) in Bills rows (the "Balance ₹…" amount stays whole and is red like "Due"), Outstanding rows (phone · items · oldest), Expenses rows (description · date), Dashboard collect-now rows, Dues focus, Operational alerts, Top customers, Item performance and the first-run checklist descriptions.
- Customer rows: tag / "On tab ₹…" badges wrap under the name instead of squeezing the name to "…" in the narrow list pane.
- Icon-only buttons with no accessible name (missed because they live on tabs not opened): customer-row delete, Settings delete, and the Save buttons for turf rates, snack items and combos.

## Round 3c — second self-audit

- Form labels: most forms are `<Label>Date</Label><Input/>` with no `htmlFor`/`id`, so fields had no accessible name and clicking a label did nothing. `lib/auto-label.ts` (`useAutoLabelAssociation`, mounted once in the shell) now links each unassociated label to the control after it (or the switch/checkbox before it), skipping labels that already have `for`, wrap their control, or whose control is already labelled. Unit tests in `lib/auto-label.test.ts`.
- Alert dialogs had no max-height, so tall ones (restore preview, archive) ran off a 600px-high window with the buttons unreachable; they now scroll inside the viewport like normal dialogs.
- Telegram QR dialogs gained a description (Radix "Missing Description" console warning).
- Windows toasts moved from bottom-right to bottom-centre so they no longer cover the scroll button, shortcuts hint and the docked Sell cart bar's "Generate bill".
- Bills card header: text block can shrink (`min-w-0`) and the badge column no longer squeezes long customer names in the narrow detail pane.
- Note: the earlier "syntax-checked" claims for rounds 3/3b used `tsc` with a tsconfig present, which silently skips the files; everything was re-checked with `--ignoreConfig` and is clean.

## Round 3d — third self-audit

- Detail pane no longer blanks when you page the list (Bookings, Bills): the selected record is resolved against the whole filtered list, not just the visible page (so a reschedule that re-sorts the row onto another page keeps its pane too).
- Sell: item tiles show up to two lines of the name (was one truncated line, so "Cold Coffee Lar…" / "Cold Coffee Sma…" looked identical) with the full name as a tooltip; out-of-stock tiles dim only the name/price, so the red "Out of stock" badge keeps full contrast instead of being halved by `opacity-50`. Cart lines and the item picker wrap instead of truncating the price/stock.
- Home and Reports month-comparison tiles switch to six columns at `xl` (1280) instead of `lg` (1024), where 6 columns made ₹ amounts overflow the tile; values can wrap.
- One global, zero-specificity `:focus-visible` ring for raw `<button>`/`<a>` rows (list rows, sidebar, status strip) that had no ring classes; components with their own ring utilities are unaffected.

## Round 4

**Windows only**
- `SectionHeading` wraps its action row below the title instead of squeezing the title. At 960×600 the "Stock counts" heading was crushed to ~20px next to its three controls ("St / co").
- Bills and Bookings list rows in the narrow two-pane list wrap the title (`LT-INV-… · Customer`) instead of cutting the customer name to ~80px.

**Shared with Android**
- **Close day button** (Home → Cash in drawer): the text block took the whole row and squeezed the button to ~51px, so "Close day" spilled out of the blue pill and read "Close d…". The text block is now `min-w-0 flex-1` and the button `shrink-0` (also the "Edit closing" variant).
- **Slot utilisation heatmap**: the fifth column (Night) sat behind an invisible sideways scroll on phones. The grid now fits 360px with short column names below `sm` (Late / Morn / Aft / Eve / Night). Cell text no longer switches to white on a 50–80 % blue tint (2.1–3.4 : 1); it keeps the normal text colour.
- **Selected calendar day**: the "n slots" caption was 80 % white on blue (3.5 : 1); it is full white when the day is selected.
- **Header**: the business name wraps to two lines instead of "Chennai Soccer & Sports S…", and the generic tagline is hidden below 640px.
- **Booking wizard**: on phones every step was an equal-width pill showing only a number, so the step name was never visible. The active step now takes the free width and shows its name; other steps shrink to their number.
- **Chart axes** show `₹3.6L` / `₹2.5k` (`moneyAxis` in `lib/money.ts`, unit-tested) instead of raw `360000`, on the two Home charts and the two money charts in Reports.
- **Truncation → wrapping** where the cut-off text was the important part: Operational-alert titles ("433 past bookings still marked Confirmed"), Expenses rows (category · business), customer-dialog history rows (the trailing "Due ₹…"), customer tab-ledger rows, the "statement is ready" banner, Dashboard collect-now rows.
- **Collect now rows** on 360px phones: the invoice number and date broke mid-token over three lines because the text was squeezed to ~90px. It now has a minimum width so the badge, amount and buttons wrap onto the next line instead.
- **Invalid HTML**: a status `Badge` (a `<div>`) sat inside a `<p>` in the Turf booking list and the Sell sales list, which React logs as a hydration error. Both wrappers are `<div>` now.
- **Phone field** (`CustomerFields`): the suggestion list stayed open, and covered the wizard's Next button, after a complete 10-digit number; it now closes at 10 digits, and its empty text no longer says "keep typing" for a full number.
- **Tap targets**: the backup-status button, setup-checklist toggles, Invoices bill checkbox and customer-name links get an invisible larger hit area (`::after`). The status button is limited by the header above it (~36px in total).
- Prettier formatting fixed in files flagged by the lint from earlier rounds (`PopularSnacksCard`, etc.).
