import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { fillWorkbook } from "./xlsx-build";
import { injectCharts, buildChartXml, chartsFor } from "./xlsx-charts";
import {
  buildChartDefs,
  buildDashboardSheet,
  type DashboardData,
} from "./dashboard-xlsx";
import {
  sanitizeSheetName,
  isMoneyHeader,
  formatInr,
  inrFormat,
  parseDmy,
  formatStamp,
} from "./xlsx-style";

/** Minimal well-formedness check (balanced tags) — no DOM in the node test env. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    const [, close, name, selfClose] = m;
    if (selfClose) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0 && !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml);
}

const meta = { shopName: "Test Shop", periodLabel: "May 2026" };

const dash: DashboardData = {
  shopName: "Test Shop",
  periodLabel: "May 2026",
  currencySymbol: "₹",
  kpis: [
    { label: "Revenue", value: 1000, previous: 800, change: 25 },
    { label: "Expenses", value: 300, previous: 400, change: -25, invert: true },
    {
      label: "Collection rate",
      value: 91.2,
      previous: 80,
      change: 14,
      isCurrency: false,
    },
  ],
  collectionRatePct: 91.2,
  topExpense: { name: "Rent", value: 200 },
  avgBookingValue: 650,
  pnl: [
    {
      month: "Mar",
      Revenue: 900,
      Expenses: 300,
      Profit: 600,
      Turf: 600,
      Snacks: 200,
      Bills: 100,
      Collected: 800,
      Dues: 100,
    },
    {
      month: "Apr",
      Revenue: 800,
      Expenses: 400,
      Profit: 400,
      Turf: 500,
      Snacks: 200,
      Bills: 100,
      Collected: 700,
      Dues: 100,
    },
  ],
  paymentSplit: [
    { name: "Cash", value: 700 },
    { name: "UPI", value: 300 },
  ],
  expenseCategories: [
    { name: "Rent", value: 200 },
    { name: "Power", value: 100 },
  ],
  weekdayBookings: [
    { label: "Mon", bookings: 3 },
    { label: "Tue", bookings: 5 },
  ],
  topItems: [{ name: "Tea", revenue: 400 }],
  topDebtor: { name: "Ravi", value: 250 },
};

async function build(sheets: Parameters<typeof fillWorkbook>[1]) {
  const wb = new ExcelJS.Workbook();
  fillWorkbook(wb, sheets, meta);
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return { wb, buf };
}

describe("style helpers", () => {
  it("sanitizes sheet names", () => {
    expect(sanitizeSheetName("A/B:C*D?[E]\\F")).toBe("A B C D E F");
    expect(sanitizeSheetName("x".repeat(50))).toHaveLength(31);
    expect(sanitizeSheetName("  ")).toBe("Sheet");
  });
  it("money header detection", () => {
    expect(isMoneyHeader("Balance due")).toBe(true);
    expect(isMoneyHeader("Phone")).toBe(false);
    expect(isMoneyHeader("Bill No")).toBe(false);
    expect(isMoneyHeader("Share %")).toBe(false);
  });
});

describe("flat sheets", () => {
  it("renders title, styled header, totals formula, filter, freeze", async () => {
    const { wb, buf } = await build([
      {
        name: "Bookings",
        rows: [
          {
            Customer: "A",
            Phone: "9000000001",
            Status: "Paid",
            Total: 500,
            "Balance due": 0,
          },
          {
            Customer: "=BAD()",
            Phone: "9000000002",
            Status: "Due",
            Total: 300,
            "Balance due": 100,
          },
        ],
      },
    ]);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    const ws = re.getWorksheet("Bookings")!;
    expect(ws.getCell(1, 1).value).toBe("Test Shop");
    expect(ws.getRow(4).getCell(1).value).toBe("Customer");
    expect(ws.getCell(5, 2).value).toBe("9000000001"); // phone stays text
    // A formula-looking name stays inert text (a plain string cell, not a formula).
    expect(ws.getCell(6, 1).value).toBe("=BAD()");
    expect(ws.getCell(6, 1).type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell(5, 4).numFmt).toContain("#,##0");
    const total = ws.getCell(7, 4).value as { formula: string; result: number };
    expect(total.formula).toBe("SUBTOTAL(109,D5:D6)");
    expect(total.result).toBe(800);
    expect(ws.getCell(7, 1).value).toBe("TOTAL");
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
    void wb;
  });
  it("handles empty data with a clean message and no filter", async () => {
    const { buf } = await build([{ name: "Empty", rows: [] }]);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    const ws = re.getWorksheet("Empty")!;
    expect(ws.getCell(3, 1).value).toBe("No records for this period");
    expect(ws.autoFilter).toBeFalsy();
  });
  it("does not sum average columns and dedupes sheet names", async () => {
    const { buf } = await build([
      {
        name: "Same",
        rows: [
          { Item: "a", "Avg. booking value": 10, Total: 5 },
          { Item: "b", "Avg. booking value": 20, Total: 6 },
        ],
      },
      { name: "same", rows: [{ Item: "x" }] },
    ]);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    expect(re.worksheets.map((w) => w.name)).toEqual(["Same", "same 2"]);
    const ws = re.getWorksheet("Same")!;
    expect(ws.getCell(7, 2).value).toBeNull();
  });
});

describe("dashboard + native charts", () => {
  it("defines charts only for datasets that have data", () => {
    const defs = buildChartDefs(dash);
    expect(defs.map((d) => d.title)).toEqual([
      "Revenue vs expenses vs profit",
      "Revenue mix",
      "Payment modes",
      "Expenses by category",
      "Bookings by weekday",
      "Top snack items by revenue",
      "Collected vs dues",
    ]);
    expect(
      buildChartDefs({
        ...dash,
        pnl: [],
        paymentSplit: [],
        expenseCategories: [],
        weekdayBookings: [],
        topItems: [],
      }),
    ).toEqual([]);
  });

  it("injects valid chart parts and the file re-opens", async () => {
    const { wb, buf } = await build([
      { name: "Dashboard", build: (ws) => buildDashboardSheet(ws, dash) },
    ]);
    expect(chartsFor(wb.getWorksheet("Dashboard")!)).toHaveLength(7);
    const out = await injectCharts(buf, wb);
    const zip = await JSZip.loadAsync(out);
    const charts = Object.keys(zip.files).filter((f) =>
      /^xl\/charts\/chart\d+\.xml$/.test(f),
    );
    expect(charts).toHaveLength(7);
    expect(zip.file("xl/drawings/drawing1.xml")).toBeTruthy();
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain("/xl/charts/chart7.xml");
    expect(ct).toContain("/xl/drawings/drawing1.xml");
    const sheetXml = await zip
      .file("xl/worksheets/sheet1.xml")!
      .async("string");
    expect(sheetXml).toContain("<drawing r:id=");
    // <drawing> must be worksheet-level: after conditional formats, before the trailing extLst.
    const dAt = sheetXml.indexOf("<drawing");
    expect(dAt).toBeGreaterThan(
      sheetXml.lastIndexOf("</conditionalFormatting>"),
    );
    expect(dAt).toBeGreaterThan(sheetXml.indexOf("<pageSetup"));
    expect(dAt).toBeLessThan(sheetXml.lastIndexOf("<extLst"));
    expect(
      sheetXml.slice(dAt).startsWith('<drawing r:id="rIdCharts1"/><extLst'),
    ).toBe(true);
    for (const c of charts) {
      const xml = await zip.file(c)!.async("string");
      expect(wellFormed(xml)).toBe(true);
    }
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(
      out.buffer.slice(
        out.byteOffset,
        out.byteOffset + out.byteLength,
      ) as ArrayBuffer,
    ); // not corrupt
    expect(re.worksheets.map((w) => w.name)).toEqual([
      "Dashboard",
      "Chart Data",
    ]);
  });

  it("chart XML references the right ranges and escapes text", () => {
    const xml = buildChartXml({
      type: "column",
      title: "A & <B>",
      anchor: { fromCol: 0, fromRow: 0, toCol: 4, toRow: 10 },
      categoriesRef: "'Chart Data'!$A$5:$A$6",
      categories: ["x", "y"],
      series: [
        {
          name: "S",
          nameRef: "'Chart Data'!$B$4",
          ref: "'Chart Data'!$B$5:$B$6",
          values: [1, 2],
        },
      ],
    });
    expect(xml).toContain("A &amp; &lt;B&gt;");
    expect(xml).toContain("'Chart Data'!$B$5:$B$6");
    expect(xml).toContain('<c:barDir val="col"/>');
  });

  it("workbook without charts passes through untouched", async () => {
    const { wb, buf } = await build([{ name: "X", rows: [{ a: 1 }] }]);
    const out = await injectCharts(buf, wb);
    expect(out.byteLength).toBe(buf.byteLength);
  });
});

describe("indian style + consistency", () => {
  it("groups digits lakh/crore style", () => {
    expect(formatInr(0)).toBe("0");
    expect(formatInr(999)).toBe("999");
    expect(formatInr(1000)).toBe("1,000");
    expect(formatInr(138000)).toBe("1,38,000");
    expect(formatInr(1234567)).toBe("12,34,567");
    expect(formatInr(123456789)).toBe("12,34,56,789");
    expect(formatInr(-4200)).toBe("-4,200");
    expect(formatInr(-1234567)).toBe("-12,34,567");
    expect(formatInr(1234.5, true)).toBe("1,234.50");
  });
  it("number format carries lakh/crore sections", () => {
    const f = inrFormat();
    expect(f).toContain("[>=10000000]");
    expect(f).toContain("[>=100000]");
    expect(inrFormat({ symbol: "₹" })).toContain('"₹ "');
  });
  it("parses dd/mm/yyyy and rejects junk", () => {
    expect(parseDmy("05/09/2026")?.toISOString()).toBe(
      "2026-09-05T00:00:00.000Z",
    );
    expect(parseDmy("31/02/2026")).toBeNull();
    expect(parseDmy("2026-09-05")).toBeNull();
  });
  it("stamp uses the same 3-letter month as the rest of the report", () => {
    expect(formatStamp(new Date(2026, 8, 30, 14, 5))).toBe(
      "30 Sep 2026, 2:05 pm",
    );
  });
  it("title band spans wide enough on a 2-column sheet", async () => {
    const { buf } = await build([
      {
        name: "Payment modes",
        rows: [
          { Mode: "Cash", Amount: 70000 },
          { Mode: "UPI", Amount: 48000 },
        ],
      },
    ]);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    const ws = re.getWorksheet("Payment modes")!;
    const merges = Object.values(ws.model.merges ?? []) as string[];
    const title = merges.find((m) => m.startsWith("A1:"))!;
    const lastCol = title.split(":")[1]!.replace(/\d+/g, "");
    expect(lastCol.charCodeAt(0)).toBeGreaterThan("C".charCodeAt(0));
    // money header is labelled with the currency and right-aligned
    expect(ws.getCell(4, 2).value).toBe("Amount (₹)");
    expect(ws.getCell(4, 2).alignment?.horizontal).toBe("right");
    // Checked in the raw styles.xml (ExcelJS' own reader drops the escapes on
    // load; Excel keeps them, and they are what make the grouping 12,34,567).
    const zip = await JSZip.loadAsync(buf);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    expect(styles).toContain("##\\,##\\,##0");
  });
  it("dd/mm/yyyy text becomes real dates so they sort and filter", async () => {
    const { buf } = await build([
      {
        name: "Bookings",
        rows: [
          { Date: "05/09/2026", Total: 500 },
          { Date: "06/09/2026", Total: 300 },
        ],
      },
    ]);
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    const ws = re.getWorksheet("Bookings")!;
    expect(ws.getCell(5, 1).value).toBeInstanceOf(Date);
    expect(ws.getCell(5, 1).numFmt).toBe("dd/mm/yyyy");
  });
  it("dashboard uses Indian grouping in card and insight text", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dashboard");
    buildDashboardSheet(ws, {
      ...dash,
      kpis: [
        { label: "Revenue", value: 138000, previous: 130000, change: 6.2 },
      ],
      avgBookingValue: 1250,
      topExpense: { name: "Rent", value: 120000 },
    });
    const texts: string[] = [];
    ws.eachRow((r) => r.eachCell((c) => texts.push(String(c.value))));
    expect(texts).toContain("₹ 1,38,000");
    expect(texts).toContain("Rent (₹ 1,20,000)");
    expect(String(ws.getCell(2, 1).value)).toMatch(/^Dashboard {2}·/);
  });
});

describe("dashboard card borders", () => {
  it("draws only the outer frame of each KPI card (no inner lines)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dashboard");
    buildDashboardSheet(ws, dash);
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const re = new ExcelJS.Workbook();
    await re.xlsx.load(buf);
    const d = re.getWorksheet("Dashboard")!;
    // first card occupies rows 4-6, columns A-C
    for (let r = 4; r <= 6; r++) {
      for (let c = 1; c <= 3; c++) {
        const b = d.getCell(r, c).border ?? {};
        expect(!!b.top).toBe(r === 4);
        expect(!!b.bottom).toBe(r === 6);
        expect(!!b.left).toBe(c === 1);
        expect(!!b.right).toBe(c === 3);
        // every cell of the card keeps the card fill, merged or not
        expect(
          (d.getCell(r, c).fill as { fgColor?: { argb?: string } }).fgColor
            ?.argb,
        ).toBe("FFF7F9FE");
      }
    }
  });
});
