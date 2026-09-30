import type { Borders, Fill, Worksheet } from "exceljs";

/**
 * Shared look for every exported workbook. The palette is lifted from the
 * app's CSS custom properties (styles.css, light theme) so an export reads as
 * the same product. ARGB, no leading "#".
 */
export const COLOR = {
  primary: "FF3B5FCC",
  primaryDark: "FF23408F",
  onPrimary: "FFFFFFFF",
  success: "FF1E9E70",
  destructive: "FFD8483F",
  headerBg: "FFEFF3FC",
  cardBg: "FFF7F9FE",
  zebra: "FFF6F8FD",
  border: "FFD8E0F2",
  muted: "FF6B7690",
  text: "FF1B2436",
  totalBg: "FFE3EAF9",
} as const;

/** Series colours used by charts, in order (hex without alpha for chart XML). */
export const CHART_COLORS = [
  "3B5FCC",
  "1E9E70",
  "F2A23A",
  "D8483F",
  "8E5CD9",
  "2BB0C9",
  "E26FA8",
  "7A8599",
] as const;

export const thinBorder: Partial<Borders> = {
  top: { style: "thin", color: { argb: COLOR.border } },
  left: { style: "thin", color: { argb: COLOR.border } },
  bottom: { style: "thin", color: { argb: COLOR.border } },
  right: { style: "thin", color: { argb: COLOR.border } },
};

export const solidFill = (argb: string): Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb },
});

/**
 * Indian digit grouping (12,34,567), written into the number format itself so
 * it looks the same on every PC / phone regardless of regional settings.
 * Three sections: crore and above, lakh and above, everything else. Negatives
 * fall in the last section (fine up to -99,999); larger negatives and the red
 * colour come from `addNegativeMoneyRules` below.
 */
export const INR_CRORE = "##\\,##\\,##\\,##0";
export const INR_LAKH = "##\\,##\\,##0";
export const INR_SMALL = "##,##0";

/** Builds the 3-section Indian money format, optionally with a currency prefix. */
export function inrFormat(opts: { decimals?: boolean; symbol?: string } = {}) {
  const dp = opts.decimals ? ".00" : "";
  const pre = opts.symbol ? `"${opts.symbol.replace(/"/g, "")} "` : "";
  return `[>=10000000]${pre}${INR_CRORE}${dp};[>=100000]${pre}${INR_LAKH}${dp};${pre}${INR_SMALL}${dp}`;
}

export const MONEY_FMT = inrFormat();
export const MONEY_FMT_2DP = inrFormat({ decimals: true });

/** Same grouping as `inrFormat`, as plain text (for labels like "Rent (₹ 20,000)"). */
export function formatInr(n: number, decimals = false): string {
  if (!Number.isFinite(n)) return "0";
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals ? 2 : 0);
  const [int = "0", frac] = fixed.split(".");
  const head = int.length > 3 ? int.slice(0, -3) : "";
  const tail = int.slice(-3);
  const grouped = head
    ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}`
    : tail;
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/**
 * Red negatives + correct lakh/crore grouping for negatives beyond -99,999
 * (a conditional number format, since the base format only has two conditions).
 */
export function addNegativeMoneyRules(
  ws: Worksheet,
  ref: string,
  opts: { decimals?: boolean; symbol?: string } = {},
) {
  const dp = opts.decimals ? ".00" : "";
  const pre = opts.symbol ? `"${opts.symbol.replace(/"/g, "")} "` : "";
  const red = { bold: false, color: { argb: COLOR.destructive } };
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: "cellIs",
        operator: "lessThan",
        formulae: [-9999999.995],
        priority: 1,
        style: { font: red, numFmt: `${pre}${INR_CRORE}${dp}` },
      },
      {
        type: "cellIs",
        operator: "lessThan",
        formulae: [-99999.995],
        priority: 2,
        style: { font: red, numFmt: `${pre}${INR_LAKH}${dp}` },
      },
      {
        type: "cellIs",
        operator: "lessThan",
        formulae: [0],
        priority: 3,
        style: { font: red },
      },
    ],
  });
}

/** "30 Sep 2026, 2:31 pm" — same 3-letter month style as the rest of the report. */
export function formatStamp(d: Date): string {
  const MON = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${h12}:${mm} ${h < 12 ? "am" : "pm"}`;
}

/** dd/mm/yyyy text -> a real Excel date (UTC midnight), or null. */
export function parseDmy(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCDate() === d && dt.getUTCMonth() === mo - 1 ? dt : null;
}
export const DATE_FMT = "dd/mm/yyyy";

/** Headers that hold rupee amounts — formatted as money automatically. */
const MONEY_HEADER =
  /amount|total|paid|due|balance|revenue|expense|profit|price|cost|tax|collected|spend|value|advance|owed|discount|sales|turf|snacks|bills|rate\/hr|\btab\b/i;
/** Headers that must stay untouched even if the values happen to be numeric. */
const IDENTIFIER_HEADER =
  /\b(id|no\.?|number|phone|mobile|contact|gstin|pin)\b/i;

export function isMoneyHeader(header: string): boolean {
  if (header.includes("%")) return false;
  if (/^(qty|quantity|hours?|bookings?|count|stock)/i.test(header))
    return false;
  if (IDENTIFIER_HEADER.test(header)) return false;
  return MONEY_HEADER.test(header);
}

/** Excel sheet names: max 31 chars, none of []:*?/\ . Never empty. */
export function sanitizeSheetName(name: string, fallback = "Sheet"): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 31);
}

/** 1 -> A, 27 -> AA */
export function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * How many columns the title band must span so the shop name and subtitle are
 * never cut off, even on a 2-column sheet. Extra columns beyond the table get
 * a default width so the band looks the same on every sheet.
 */
export function bandSpan(
  ws: Worksheet,
  tableCols: number,
  title: string,
  subtitle: string,
): number {
  const need = Math.max(title.length * 1.9 + 4, subtitle.length * 1.1 + 4);
  let total = 0;
  let cols = 0;
  while ((total < need || cols < tableCols) && cols < 14) {
    cols += 1;
    const col = ws.getColumn(cols);
    if (cols > tableCols && !col.width) col.width = 12;
    total += col.width ?? 12;
  }
  return Math.max(cols, 2);
}

/** Full-width title band (shop name) plus a subtitle band beneath it. */
export function styleTitleBand(
  ws: Worksheet,
  totalCols: number,
  title: string,
  subtitle: string,
  startRow = 1,
) {
  const cols = Math.max(totalCols, 2);
  ws.mergeCells(startRow, 1, startRow, cols);
  const t = ws.getCell(startRow, 1);
  t.value = title;
  t.font = { size: 16, bold: true, color: { argb: COLOR.onPrimary } };
  t.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(startRow).height = 28;
  ws.mergeCells(startRow + 1, 1, startRow + 1, cols);
  const s = ws.getCell(startRow + 1, 1);
  s.value = subtitle;
  s.font = { size: 10, color: { argb: COLOR.onPrimary } };
  s.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(startRow + 1).height = 18;
  for (let c = 1; c <= cols; c++) {
    ws.getCell(startRow, c).fill = solidFill(COLOR.primaryDark);
    ws.getCell(startRow + 1, c).fill = solidFill(COLOR.primary);
  }
}

export function styleTableHeader(
  ws: Worksheet,
  row: number,
  cols: number,
  opts: { rightCols?: Set<number>; height?: number } = {},
) {
  const r = ws.getRow(row);
  r.height = opts.height ?? 24;
  for (let c = 1; c <= cols; c++) {
    const cell = r.getCell(c);
    cell.font = { bold: true, color: { argb: COLOR.onPrimary } };
    cell.fill = solidFill(COLOR.primaryDark);
    cell.alignment = {
      vertical: "middle",
      // Header sits over its data: right for amounts, left for text.
      horizontal: opts.rightCols?.has(c) ? "right" : "left",
      wrapText: true,
      indent: 1,
    };
    cell.border = thinBorder;
  }
}

export function styleBodyRow(
  ws: Worksheet,
  row: number,
  cols: number,
  zebra: boolean,
) {
  for (let c = 1; c <= cols; c++) {
    const cell = ws.getCell(row, c);
    cell.border = thinBorder;
    if (zebra) cell.fill = solidFill(COLOR.zebra);
    const numeric = typeof cell.value === "number";
    const isDate = cell.value instanceof Date;
    cell.alignment = {
      vertical: "top",
      horizontal: numeric ? "right" : "left",
      wrapText: !numeric && !isDate,
      indent: 1,
    };
  }
}

export function styleTotalsRow(ws: Worksheet, row: number, cols: number) {
  for (let c = 1; c <= cols; c++) {
    const cell = ws.getCell(row, c);
    cell.font = { bold: true, color: { argb: COLOR.text } };
    cell.fill = solidFill(COLOR.totalBg);
    cell.border = {
      ...thinBorder,
      top: { style: "medium", color: { argb: COLOR.primaryDark } },
    };
    if (typeof cell.value !== "string") {
      cell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };
    }
  }
}

/** A4, repeat header row on every printed page, "Page x of y" footer. */
export function setPrintSetup(
  ws: Worksheet,
  opts: {
    landscape: boolean;
    headerRow?: number;
    footerText?: string | undefined;
  },
) {
  ws.pageSetup = {
    paperSize: 9,
    orientation: opts.landscape ? "landscape" : "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.4,
      right: 0.4,
      top: 0.5,
      bottom: 0.6,
      header: 0.2,
      footer: 0.3,
    },
    ...(opts.headerRow
      ? { printTitlesRow: `${opts.headerRow}:${opts.headerRow}` }
      : {}),
  };
  ws.headerFooter = {
    oddFooter: `&L&8${(opts.footerText ?? "").replace(/&/g, "&&")}&R&8Page &P of &N`,
  };
}

/** Column width from header + content, clamped to a readable range. */
export function fitWidth(header: string, values: unknown[]): number {
  let max = header.length + 2;
  for (const v of values) {
    const len =
      typeof v === "number"
        ? formatInr(v, !Number.isInteger(v)).length + 2
        : String(v ?? "").length + 2;
    if (len > max) max = len;
  }
  return Math.min(40, Math.max(10, max));
}
