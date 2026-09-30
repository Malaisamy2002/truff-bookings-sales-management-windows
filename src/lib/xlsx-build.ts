import type { Workbook, Worksheet } from "exceljs";
import { writeChartDataSheet } from "./dashboard-xlsx";
import {
  COLOR,
  DATE_FMT,
  addNegativeMoneyRules,
  bandSpan,
  fitWidth,
  formatStamp,
  inrFormat,
  parseDmy,
  isMoneyHeader,
  colLetter,
  sanitizeSheetName,
  setPrintSetup,
  styleBodyRow,
  styleTableHeader,
  styleTitleBand,
  styleTotalsRow,
} from "./xlsx-style";

export type SheetRow = Record<string, string | number>;

/**
 * A sheet spec is either the flat-table shape (`rows`) or a `build` callback
 * for sheets that need bespoke layout (the Dashboard). Flat sheets are now
 * rendered as a professional table: title band, dark header, zebra rows,
 * money formats, SUBTOTAL totals row, filters, frozen header, print setup.
 *
 * All the extra options are optional; existing callers keep compiling.
 */
export type SheetSpec =
  | {
      name: string;
      rows: SheetRow[];
      /** Filter dropdowns on the header row (default: on when there is data). */
      autofilter?: boolean;
      /** Columns forced to money format even if the header doesn't look like money. */
      moneyColumns?: string[];
      /** Heading shown in the title band (defaults to the sheet name). */
      title?: string;
      /** Skip the SUBTOTAL totals row. */
      noTotals?: boolean;
    }
  | { name: string; build: (ws: Worksheet) => void };

export type ExportMeta = {
  shopName?: string;
  /** Currency symbol shown in money column headers. Defaults to ₹. */
  currencySymbol?: string;
  /** e.g. "May 2026" — shown next to the report title. */
  periodLabel?: string;
};

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Headers that must never be summed even though they are money-like. */
const NOT_SUMMABLE =
  /avg|average|rate|per |share|%|change|price|balance after/i;

const DUE_HEADER = /due|balance|outstanding|owed|unpaid/i;

function styleFlatSheet(
  ws: Worksheet,
  rows: SheetRow[],
  hasData: boolean,
  spec: Extract<SheetSpec, { rows: SheetRow[] }>,
  meta: ExportMeta,
) {
  const keys = Object.keys(rows[0] ?? {});
  const withTitle = !!meta.shopName;
  const headerRow = withTitle ? 4 : 1;
  const symbol = meta.currencySymbol?.trim() || "₹";

  // Which columns are money? explicit list, or a money-looking header whose
  // values are all numbers. Anything else keeps its raw value untouched.
  const moneyIdx = new Set<number>();
  // Date columns: every value is a dd/mm/yyyy string -> real Excel dates, so
  // sorting and the date filter work instead of treating them as text.
  const dateIdx = new Set<number>();
  keys.forEach((k, i) => {
    if (!hasData) return;
    if (rows.every((r) => isNum(r[k]))) {
      if (spec.moneyColumns?.includes(k) || isMoneyHeader(k)) moneyIdx.add(i);
    } else if (rows.every((r) => parseDmy(r[k]) !== null)) {
      dateIdx.add(i);
    }
  });

  // Header text: amounts are labelled with the currency so a table reads the
  // same as the Dashboard (which shows the rupee symbol).
  keys.forEach((k, i) => {
    ws.getCell(headerRow, i + 1).value = moneyIdx.has(i)
      ? `${k} (${symbol})`
      : k;
  });
  styleTableHeader(ws, headerRow, keys.length, {
    rightCols: new Set([...moneyIdx].map((i) => i + 1)),
  });

  rows.forEach((r, ri) => {
    const rowNo = headerRow + 1 + ri;
    keys.forEach((k, ci) => {
      const cell = ws.getCell(rowNo, ci + 1);
      const v = r[k] ?? "";
      // Strings are written as shared-string (text) cells, never formulas, so a
      // customer name like "=SUM(1)" stays inert text in .xlsx.
      const d = dateIdx.has(ci) ? parseDmy(v) : null;
      cell.value = d ?? v;
      if (d) cell.numFmt = DATE_FMT;
    });
    styleBodyRow(ws, rowNo, keys.length, ri % 2 === 1);
    if (!hasData)
      ws.getCell(rowNo, 1).font = {
        italic: true,
        color: { argb: COLOR.muted },
      };
  });

  keys.forEach((k, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(
      fitWidth(
        k,
        rows.map((r) => r[k]),
      ),
      moneyIdx.has(i) ? `${k} (${symbol})`.length + 3 : 0,
    );
    if (moneyIdx.has(i)) {
      const decimals = rows.some(
        (r) => isNum(r[k]) && !Number.isInteger(r[k] as number),
      );
      col.eachCell({ includeEmpty: false }, (cell, rn) => {
        if (rn > headerRow) cell.numFmt = inrFormat({ decimals });
      });
    }
  });

  // Title band last, so it can be sized from the real column widths. Same
  // look on every sheet, however few columns the table has.
  if (withTitle) {
    const subtitle = [
      spec.title ?? spec.name,
      meta.periodLabel,
      `Generated ${formatStamp(new Date())}`,
    ]
      .filter(Boolean)
      .join("  ·  ");
    const span = bandSpan(ws, keys.length, meta.shopName!, subtitle);
    styleTitleBand(ws, span, meta.shopName!, subtitle);
    ws.getCell(3, 1).value = hasData
      ? `${rows.length} record${rows.length === 1 ? "" : "s"}`
      : "No records for this period";
    ws.getCell(3, 1).font = {
      italic: true,
      size: 9,
      color: { argb: COLOR.muted },
    };
  }

  if (!hasData) {
    setPrintSetup(ws, { landscape: false, footerText: meta.shopName });
    return;
  }

  const lastData = headerRow + rows.length;
  // Totals row (SUBTOTAL 109 ignores rows hidden by a filter). Cached result
  // is supplied so viewers that don't recalculate still show the number.
  const summable = [...moneyIdx].filter((i) => !NOT_SUMMABLE.test(keys[i]!));
  if (!spec.noTotals && rows.length > 1 && summable.length > 0) {
    const totalRow = lastData + 1;
    ws.getCell(totalRow, 1).value = "TOTAL";
    for (const i of summable) {
      const k = keys[i]!;
      const L = colLetter(i + 1);
      const result = rows.reduce((s, r) => s + (r[k] as number), 0);
      const cell = ws.getCell(totalRow, i + 1);
      cell.value = {
        formula: `SUBTOTAL(109,${L}${headerRow + 1}:${L}${lastData})`,
        result,
      };
      const decimals = rows.some((r) => !Number.isInteger(r[k] as number));
      cell.numFmt = inrFormat({ decimals });
    }
    styleTotalsRow(ws, totalRow, keys.length);
    // "TOTAL" label must stay left-aligned text.
    ws.getCell(totalRow, 1).alignment = {
      horizontal: "left",
      vertical: "middle",
      indent: 1,
    };
  }

  // Filters + frozen header. The filter range excludes the totals row.
  if (spec.autofilter !== false && rows.length > 1) {
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: lastData, column: keys.length },
    };
  }
  ws.views = [{ state: "frozen", ySplit: headerRow, showGridLines: false }];

  // Conditional formatting: dues in red, status words coloured.
  keys.forEach((k, i) => {
    const L = colLetter(i + 1);
    const ref = `${L}${headerRow + 1}:${L}${lastData}`;
    if (moneyIdx.has(i)) {
      const decimals = rows.some(
        (r) => isNum(r[k]) && !Number.isInteger(r[k] as number),
      );
      // Includes the totals row (if any) so a negative total is red too.
      const last = lastData + (spec.noTotals || rows.length < 2 ? 0 : 1);
      addNegativeMoneyRules(ws, `${L}${headerRow + 1}:${L}${last}`, {
        decimals,
      });
    }
    if (moneyIdx.has(i) && DUE_HEADER.test(k)) {
      ws.addConditionalFormatting({
        ref,
        rules: [
          {
            type: "cellIs",
            operator: "greaterThan",
            formulae: [0],
            priority: 1,
            style: { font: { bold: true, color: { argb: COLOR.destructive } } },
          },
        ],
      });
    }
    if (/status/i.test(k)) {
      const rule = (text: string, argb: string, strike = false, p = 1) => ({
        type: "containsText" as const,
        operator: "containsText" as const,
        text,
        priority: p,
        formulae: [`NOT(ISERROR(SEARCH("${text}",${L}${headerRow + 1})))`],
        style: { font: { bold: true, strike, color: { argb } } },
      });
      ws.addConditionalFormatting({
        ref,
        rules: [
          rule("Cancel", "FF8A93A6", true, 1),
          rule("Paid", COLOR.success, false, 2),
          rule("Due", COLOR.destructive, false, 3),
          rule("Unpaid", COLOR.destructive, false, 4),
          rule("Partial", "FFC77700", false, 5),
        ],
      });
    }
  });

  setPrintSetup(ws, {
    landscape: keys.length > 6,
    headerRow,
    footerText: meta.shopName,
  });
}

/** Fills `wb` from the sheet specs. Pure w.r.t. saving — used by tests too. */
export function fillWorkbook(
  wb: Workbook,
  sheets: SheetSpec[],
  meta: ExportMeta = {},
) {
  const used = new Set<string>();
  for (const s of sheets) {
    let name = sanitizeSheetName(s.name);
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      name = `${sanitizeSheetName(s.name).slice(0, 28)} ${n}`;
    }
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    if ("build" in s) {
      s.build(ws);
      continue;
    }
    const hasData = s.rows.length > 0;
    const rows = hasData ? s.rows : [{ Info: "No records" }];
    styleFlatSheet(ws, rows, hasData, s, meta);
  }
  // Chart Data (if a Dashboard registered one) goes last; the first tab stays active.
  writeChartDataSheet(wb);
  wb.views = [
    {
      x: 0,
      y: 0,
      width: 10000,
      height: 20000,
      firstSheet: 0,
      activeTab: 0,
      visibility: "visible",
    },
  ];
}
