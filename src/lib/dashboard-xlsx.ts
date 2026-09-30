import type { DataBarRuleType, Workbook, Worksheet } from "exceljs";
import { registerChart, type ChartSpec } from "./xlsx-charts";
import {
  COLOR,
  addNegativeMoneyRules,
  formatInr,
  formatStamp,
  inrFormat,
  setPrintSetup,
  solidFill,
  styleTableHeader,
  styleTitleBand,
  thinBorder,
} from "./xlsx-style";

export type DashboardKpi = {
  label: string;
  value: number;
  previous: number;
  change: number | null;
  /** true when a rise in this metric is bad news (e.g. Expenses). */
  invert?: boolean;
  isCurrency?: boolean;
  /**
   * Replaces the "▲ x% vs last month" line. Used by the all-time Dashboard,
   * where there is no previous period to compare against.
   */
  caption?: string;
};

export type DashboardPnlRow = {
  month: string;
  Revenue: number;
  Expenses: number;
  Profit: number;
  /** Optional extras that unlock more charts when the caller has them. */
  Turf?: number;
  Snacks?: number;
  Bills?: number;
  Collected?: number;
  Dues?: number;
};

export type DashboardData = {
  shopName: string;
  periodLabel: string;
  currencySymbol: string;
  kpis: DashboardKpi[];
  collectionRatePct: number;
  topExpense: { name: string; value: number } | null;
  avgBookingValue: number;
  pnl: DashboardPnlRow[];
  /** All optional: each one present (and non-empty) adds a chart. */
  paymentSplit?: { name: string; value: number }[];
  expenseCategories?: { name: string; value: number }[];
  weekdayBookings?: { label: string; bookings: number }[];
  topItems?: { name: string; revenue: number }[];
  /** Biggest outstanding customer, shown in the insights strip. */
  topDebtor?: { name: string; value: number } | null;
  /** Heading above the P&L mini table; defaults to the last-6-months wording. */
  pnlHeading?: string;
};

/** "₹ 1,38,000" — same Indian grouping as the number formats in the cells. */
const fmtMoney = (symbol: string, v: number) =>
  `${symbol} ${formatInr(Math.round(v))}`;

const fmtDelta = (change: number | null, invert: boolean) => {
  if (change === null) return { text: "n/a", good: null as boolean | null };
  const good = invert ? change <= 0 : change >= 0;
  const sign = change > 0 ? "+" : "";
  const arrow = change > 0 ? "▲ " : change < 0 ? "▼ " : "";
  return { text: `${arrow}${sign}${change.toFixed(1)}% vs last month`, good };
};

/** Writes one KPI card into a 3-row x 3-col block starting at (row, col). */
function writeKpiCard(
  ws: Worksheet,
  row: number,
  col: number,
  kpi: DashboardKpi,
  currencySymbol: string,
) {
  const valueText =
    kpi.isCurrency === false
      ? `${kpi.value.toFixed(1)}%`
      : fmtMoney(currencySymbol, kpi.value);
  const delta =
    kpi.caption !== undefined
      ? { text: kpi.caption, good: null as boolean | null }
      : fmtDelta(kpi.change, kpi.invert ?? false);

  // Label row
  ws.mergeCells(row, col, row, col + 2);
  const labelCell = ws.getCell(row, col);
  labelCell.value = kpi.label.toUpperCase();
  labelCell.font = { size: 9, bold: true, color: { argb: COLOR.muted } };
  labelCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Value row
  ws.mergeCells(row + 1, col, row + 1, col + 2);
  const valueCell = ws.getCell(row + 1, col);
  valueCell.value = valueText;
  valueCell.font = { size: 16, bold: true, color: { argb: COLOR.text } };
  valueCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Delta row
  ws.mergeCells(row + 2, col, row + 2, col + 2);
  const deltaCell = ws.getCell(row + 2, col);
  deltaCell.value = delta.text;
  deltaCell.font = {
    size: 9,
    bold: true,
    color: {
      argb:
        delta.good === null
          ? COLOR.muted
          : delta.good
            ? COLOR.success
            : COLOR.destructive,
    },
  };
  deltaCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Card background + ONE outer frame around the whole 3x3 block, with a
  // left accent strip echoing the app's `HeroStat` tone-ring. Borders are set
  // per cell by position: only the outer edge of the block gets a line. (A full
  // thin border on every cell of a merged block draws stray inner vertical and
  // horizontal lines in Excel and phone viewers, and the merged-away cells
  // must carry the fill and edge themselves.)
  const edge = { style: "thin" as const, color: { argb: COLOR.border } };
  for (let r = row; r < row + 3; r++) {
    for (let c = col; c < col + 3; c++) {
      const cell = ws.getCell(r, c);
      // Assign a fresh style object per cell. ExcelJS makes merged cells in a
      // row share the master's style object, so setting `cell.border` /
      // `cell.fill` one property at a time would let the last cell overwrite
      // all the others.
      cell.style = {
        ...cell.style,
        fill: solidFill(COLOR.cardBg),
        border: {
          ...(r === row ? { top: edge } : {}),
          ...(r === row + 2 ? { bottom: edge } : {}),
          ...(c === col
            ? {
                left: {
                  style: "medium" as const,
                  color: { argb: COLOR.primary },
                },
              }
            : {}),
          ...(c === col + 2 ? { right: edge } : {}),
        },
      };
    }
  }
}

/**
 * Builds the full Dashboard sheet in place. Meant to be passed as a
 * `build` callback to `exportWorkbook`'s sheet spec.
 */
export function buildDashboardSheet(ws: Worksheet, data: DashboardData) {
  const CARD_W = 3; // columns per KPI card
  const GAP = 1; // gutter column between cards
  const CARDS_PER_ROW = 3;
  const totalCols = CARDS_PER_ROW * CARD_W + (CARDS_PER_ROW - 1) * GAP;

  ws.columns = Array.from({ length: totalCols }, () => ({ width: 12 }));
  ws.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.3,
      right: 0.3,
      top: 0.4,
      bottom: 0.4,
      header: 0,
      footer: 0,
    },
  };
  ws.views = [{ showGridLines: false }];

  // --- Title band (same helper, fonts and indent as every other sheet) ---
  styleTitleBand(
    ws,
    totalCols,
    data.shopName,
    ["Dashboard", data.periodLabel, `Generated ${formatStamp(new Date())}`]
      .filter(Boolean)
      .join("  ·  "),
  );

  // --- KPI grid (2 rows of 3 cards, each card 3 rows tall) ---
  let row = 4;
  for (let i = 0; i < data.kpis.length; i += CARDS_PER_ROW) {
    const rowKpis = data.kpis.slice(i, i + CARDS_PER_ROW);
    rowKpis.forEach((kpi, idx) => {
      const col = 1 + idx * (CARD_W + GAP);
      writeKpiCard(ws, row, col, kpi, data.currencySymbol);
    });
    row += 4; // 3 rows of card + 1 row gap
  }

  // --- Insights strip (text derived only from the data passed in) ---
  row += 1;
  ws.mergeCells(row, 1, row, totalCols);
  const insightsHeader = ws.getCell(row, 1);
  insightsHeader.value = "AT A GLANCE";
  insightsHeader.font = { size: 9, bold: true, color: { argb: COLOR.muted } };
  insightsHeader.alignment = { indent: 1 };
  row += 1;

  const insight = (label: string, value: string) => {
    ws.mergeCells(row, 1, row, CARD_W);
    ws.mergeCells(row, 1 + CARD_W, row, totalCols);
    const l = ws.getCell(row, 1);
    l.value = label;
    l.font = { bold: true, color: { argb: COLOR.text } };
    l.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    const v = ws.getCell(row, 1 + CARD_W);
    v.value = value;
    v.font = { color: { argb: COLOR.text } };
    v.alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 1; c <= totalCols; c++)
      ws.getCell(row, c).border = {
        bottom: { style: "hair", color: { argb: COLOR.border } },
      };
    row += 1;
  };
  insight("Collection rate", `${data.collectionRatePct.toFixed(1)}%`);
  insight(
    "Top expense category",
    data.topExpense
      ? `${data.topExpense.name} (${fmtMoney(data.currencySymbol, data.topExpense.value)})`
      : "—",
  );
  insight(
    "Avg. booking value",
    fmtMoney(data.currencySymbol, data.avgBookingValue),
  );
  const best = data.pnl.reduce<DashboardPnlRow | null>(
    (b, r) => (b === null || r.Profit > b.Profit ? r : b),
    null,
  );
  if (best && data.pnl.length > 1) {
    insight(
      "Best month (profit)",
      `${best.month} (${fmtMoney(data.currencySymbol, best.Profit)})`,
    );
  }
  if (data.topDebtor && data.topDebtor.value > 0) {
    insight(
      "Biggest outstanding",
      `${data.topDebtor.name} (${fmtMoney(data.currencySymbol, data.topDebtor.value)})`,
    );
  }
  row += 1;

  // --- Charts: 2-up grid, fed from the "Chart Data" sheet ---
  const charts = buildChartDefs(data);
  const CHART_ROWS = 16;
  if (charts.length > 0) {
    // Print: KPIs + insights on page 1; charts two rows (4 charts) per page,
    // so a chart is never sliced across a page boundary.
    ws.getRow(row - 1).addPageBreak();
    ws.mergeCells(row, 1, row, totalCols);
    const h = ws.getCell(row, 1);
    h.value = "CHARTS";
    h.font = { size: 9, bold: true, color: { argb: COLOR.muted } };
    h.alignment = { indent: 1 };
    row += 1;
    charts.forEach((def, i) => {
      const left = i % 2 === 0;
      const block = Math.floor(i / 2);
      const top = row - 1 + block * (CHART_ROWS + 1); // 0-based
      if (i % 4 === 0 && i > 0) ws.getRow(top).addPageBreak();
      registerChart(ws, {
        ...def.spec,
        anchor: {
          fromCol: left ? 0 : CARD_W * 2 + GAP,
          toCol: left ? CARD_W * 2 - 1 : totalCols,
          fromRow: top,
          toRow: top + CHART_ROWS,
        },
      });
    });
    row += Math.ceil(charts.length / 2) * (CHART_ROWS + 1) + 1;
  }
  pendingChartData.set(ws.workbook, charts);

  // --- 6-month P&L mini table with data bars ---
  if (charts.length > 0) ws.getRow(row - 1).addPageBreak();
  ws.mergeCells(row, 1, row, totalCols);
  const pnlHeader = ws.getCell(row, 1);
  pnlHeader.value = data.pnlHeading ?? "PROFIT & LOSS — LAST 6 MONTHS";
  pnlHeader.font = { size: 9, bold: true, color: { argb: COLOR.muted } };
  pnlHeader.alignment = { indent: 1 };
  row += 1;

  const sym = data.currencySymbol;
  [
    "Month",
    `Revenue incl. tax (${sym})`,
    `Expenses (${sym})`,
    `Profit (${sym})`,
  ].forEach((h, idx) => {
    ws.getCell(row, 1 + idx).value = h;
  });
  styleTableHeader(ws, row, 4, { rightCols: new Set([2, 3, 4]), height: 34 });
  row += 1;

  const dataStartRow = row;
  for (const r of data.pnl) {
    ws.getCell(row, 1).value = r.month;
    ws.getCell(row, 2).value = r.Revenue;
    ws.getCell(row, 3).value = r.Expenses;
    ws.getCell(row, 4).value = r.Profit;
    for (let c = 1; c <= 4; c++) {
      const cell = ws.getCell(row, c);
      cell.border = thinBorder;
      if ((row - dataStartRow) % 2 === 1) cell.fill = solidFill(COLOR.zebra);
      if (c > 1) {
        cell.numFmt = inrFormat();
        cell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };
      }
    }
    row += 1;
  }
  const dataEndRow = row - 1;

  if (dataEndRow >= dataStartRow) {
    addNegativeMoneyRules(ws, `B${dataStartRow}:D${dataEndRow}`);
    for (const [col, argb] of [
      ["B", COLOR.primary],
      ["D", COLOR.success],
    ] as const) {
      ws.addConditionalFormatting({
        ref: `${col}${dataStartRow}:${col}${dataEndRow}`,
        rules: [
          {
            type: "dataBar",
            priority: 1,
            gradient: false,
            border: false,
            cfvo: [{ type: "min" }, { type: "max" }],
            color: { argb },
          } as DataBarRuleType,
        ],
      });
    }
  }

  ws.getColumn(1).width = 16;
  for (let c = 2; c <= totalCols; c++) ws.getColumn(c).width = 14;
  setPrintSetup(ws, { landscape: true, footerText: data.shopName });
  ws.pageSetup.printArea = `A1:${String.fromCharCode(64 + totalCols)}${row}`;
}

// ---------------------------------------------------------------------------
// Chart data: one small block per chart on a "Chart Data" sheet. Charts read
// these ranges (so they stay live if the owner edits a value).
// ---------------------------------------------------------------------------

type ChartDef = {
  title: string;
  /** Values are counts, not rupees (no money format). */
  count?: boolean;
  header: string[];
  rows: (string | number)[][];
  spec: Omit<ChartSpec, "anchor">;
};

export const CHART_DATA_SHEET = "Chart Data";

const topN = <T extends { name: string; value: number }>(
  rows: T[],
  n: number,
) => {
  const sorted = rows
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const head = sorted
    .slice(0, n)
    .map((r) => ({ name: r.name, value: r.value }));
  const rest = sorted.slice(n).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...head, { name: "Other", value: rest }] : head;
};

/** Pure: decides which charts exist and lays their data out. Exported for tests. */
export function buildChartDefs(data: DashboardData): ChartDef[] {
  const out: ChartDef[] = [];
  let nextRow = 3; // 1 = sheet title, 2 blank; each block: title row, header row, data...
  const q = `'${CHART_DATA_SHEET}'!`;

  const add = (
    title: string,
    header: string[],
    rows: (string | number)[][],
    make: (r: {
      catRef: string;
      colRef: (i: number) => string;
      nameRef: (i: number) => string;
    }) => Omit<
      ChartSpec,
      "anchor" | "title" | "categoriesRef" | "categories" | "series"
    > & {
      series: (i: number) => Partial<ChartSpec["series"][number]>;
    },
    opts?: { count?: boolean },
  ) => {
    if (rows.length === 0) return;
    const headerRow = nextRow + 1;
    const first = headerRow + 1;
    const last = headerRow + rows.length;
    const col = (c: number) => String.fromCharCode(65 + c);
    const colRef = (i: number) => `${q}$${col(i)}$${first}:$${col(i)}$${last}`;
    const nameRef = (i: number) => `${q}$${col(i)}$${headerRow}`;
    const m = make({ catRef: colRef(0), colRef, nameRef });
    const { series, ...rest } = m;
    out.push({
      title,
      count: opts?.count ?? false,
      header,
      rows,
      spec: {
        ...rest,
        title,
        categoriesRef: colRef(0),
        categories: rows.map((r) => String(r[0])),
        series: header.slice(1).map((name, i) => ({
          name,
          nameRef: nameRef(i + 1),
          ref: colRef(i + 1),
          values: rows.map((r) => Number(r[i + 1]) || 0),
          ...series(i),
        })),
      },
    });
    nextRow = last + 2;
  };

  const pnl = data.pnl;
  if (pnl.length > 0) {
    add(
      "Revenue vs expenses vs profit",
      ["Month", "Revenue", "Expenses", "Profit"],
      pnl.map((r) => [r.month, r.Revenue, r.Expenses, r.Profit]),
      () => ({
        type: "combo",
        numFmt: inrFormat(),
        series: (i) =>
          i === 2 ? { kind: "line", color: "1E9E70" } : { kind: "bar" },
      }),
    );
  }
  const mix: [string, number][] = [
    ["Turf", pnl.reduce((s, r) => s + (r.Turf ?? 0), 0)],
    ["Snacks", pnl.reduce((s, r) => s + (r.Snacks ?? 0), 0)],
    ["Bills", pnl.reduce((s, r) => s + (r.Bills ?? 0), 0)],
  ];
  const mixRows = mix.filter(([, v]) => v > 0);
  add("Revenue mix", ["Source", "Revenue"], mixRows, () => ({
    type: "doughnut",
    series: () => ({}),
  }));
  const split = topN(data.paymentSplit ?? [], 6);
  add(
    "Payment modes",
    ["Mode", "Amount"],
    split.map((r) => [r.name, r.value]),
    () => ({ type: "pie", series: () => ({}) }),
  );
  const cats = topN(data.expenseCategories ?? [], 8);
  add(
    "Expenses by category",
    ["Category", "Amount"],
    cats.map((r) => [r.name, r.value]),
    () => ({
      type: "bar",
      legend: "none",
      dataLabels: true,
      series: () => ({ color: "D8483F" }),
    }),
  );
  const wk = (data.weekdayBookings ?? []).map(
    (r) => [r.label, r.bookings] as (string | number)[],
  );
  add(
    "Bookings by weekday",
    ["Weekday", "Bookings"],
    wk.some((r) => Number(r[1]) > 0) ? wk : [],
    () => ({
      type: "column",
      legend: "none",
      dataLabels: true,
      numFmt: "0",
      series: () => ({ color: "3B5FCC" }),
    }),
    { count: true },
  );
  const items = (data.topItems ?? [])
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((r) => [r.name, r.revenue] as (string | number)[]);
  add("Top snack items by revenue", ["Item", "Revenue"], items, () => ({
    type: "bar",
    legend: "none",
    dataLabels: true,
    series: () => ({ color: "F2A23A" }),
  }));
  if (pnl.some((r) => r.Collected !== undefined || r.Dues !== undefined)) {
    add(
      "Collected vs dues",
      ["Month", "Collected", "Dues"],
      pnl.map((r) => [r.month, r.Collected ?? 0, r.Dues ?? 0]),
      () => ({
        type: "line",
        series: (i) => ({ color: i === 0 ? "1E9E70" : "D8483F" }),
      }),
    );
  }
  return out;
}

const pendingChartData = new WeakMap<Workbook, ChartDef[]>();

/**
 * Called by fillWorkbook once every other sheet exists, so "Chart Data"
 * lands last (the Dashboard must stay the first tab).
 */
export function writeChartDataSheet(wb: Workbook) {
  const defs = pendingChartData.get(wb);
  if (!defs || defs.length === 0) return;
  pendingChartData.delete(wb);
  const ws = wb.addWorksheet(CHART_DATA_SHEET);
  ws.getCell(1, 1).value =
    "Chart data — the Dashboard charts read from these cells. Edit a value and its chart updates.";
  ws.getCell(1, 1).font = { bold: true, size: 12, color: { argb: COLOR.text } };
  let row = 3;
  for (const d of defs) {
    ws.getCell(row, 1).value = d.title.toUpperCase();
    ws.getCell(row, 1).font = {
      size: 9,
      bold: true,
      color: { argb: COLOR.muted },
    };
    row += 1;
    d.header.forEach((h, i) => (ws.getCell(row, 1 + i).value = h));
    styleTableHeader(ws, row, d.header.length);
    for (const r of d.rows) {
      row += 1;
      r.forEach((v, i) => {
        const cell = ws.getCell(row, 1 + i);
        cell.value = v;
        cell.border = thinBorder;
        if (typeof v === "number" && !d.count) cell.numFmt = inrFormat();
        if (typeof v === "number") cell.alignment = { horizontal: "right" };
      });
    }
    row += 2;
  }
  ws.getColumn(1).width = 28;
  for (let c = 2; c <= 5; c++) ws.getColumn(c).width = 16;
}
