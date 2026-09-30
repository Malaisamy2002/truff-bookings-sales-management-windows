import type { Workbook, Worksheet } from "exceljs";
import { CHART_COLORS, inrFormat } from "./xlsx-style";

/**
 * Native Excel charts.
 *
 * ExcelJS has no chart API, so charts are described here as plain data, held
 * in a registry keyed by worksheet, and injected into the finished .xlsx zip
 * (`injectCharts`) as real DrawingML chart parts. They read from cell ranges
 * (with cached values), so they stay live when the owner edits the data and
 * render in Excel, LibreOffice and Google Sheets.
 *
 * Chart failure must never block an export: `injectCharts` throws, and the
 * caller (`exportWorkbook`) catches it and saves the workbook without charts.
 */

export type ChartType =
  "column" | "bar" | "line" | "pie" | "doughnut" | "combo";

export type ChartSeries = {
  name: string;
  /** e.g. 'Chart Data'!$B$1 — header cell holding the series name. */
  nameRef?: string;
  /** e.g. 'Chart Data'!$B$2:$B$7 */
  ref: string;
  values: number[];
  /** Combo charts only: which series render as lines. Default bar. */
  kind?: "bar" | "line";
  color?: string;
};

export type ChartSpec = {
  type: ChartType;
  title: string;
  /** 0-based cell anchor on the host sheet. `to` is exclusive-ish (twoCell). */
  anchor: { fromCol: number; fromRow: number; toCol: number; toRow: number };
  categoriesRef: string;
  categories: string[];
  series: ChartSeries[];
  /** Number format for the value axis / data labels. */
  numFmt?: string;
  stacked?: boolean;
  legend?: "b" | "r" | "none";
  dataLabels?: boolean;
};

const registry = new WeakMap<Worksheet, ChartSpec[]>();

export function registerChart(ws: Worksheet, spec: ChartSpec) {
  const list = registry.get(ws) ?? [];
  list.push(spec);
  registry.set(ws, list);
}

export function chartsFor(ws: Worksheet): ChartSpec[] {
  return registry.get(ws) ?? [];
}

export const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are illegal in XML 1.0 and would corrupt the file.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const solid = (hex: string) =>
  `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;

const strCache = (vals: string[]) =>
  `<c:strCache><c:ptCount val="${vals.length}"/>${vals
    .map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`)
    .join("")}</c:strCache>`;

const numCache = (vals: number[], fmt: string) =>
  `<c:numCache><c:formatCode>${xmlEscape(fmt)}</c:formatCode><c:ptCount val="${vals.length}"/>${vals
    .map(
      (v, i) =>
        `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`,
    )
    .join("")}</c:numCache>`;

function serName(s: ChartSeries): string {
  return s.nameRef
    ? `<c:tx><c:strRef><c:f>${xmlEscape(s.nameRef)}</c:f>${strCache([s.name])}</c:strRef></c:tx>`
    : `<c:tx><c:v>${xmlEscape(s.name)}</c:v></c:tx>`;
}

const catXml = (spec: ChartSpec) =>
  `<c:cat><c:strRef><c:f>${xmlEscape(spec.categoriesRef)}</c:f>${strCache(spec.categories)}</c:strRef></c:cat>`;

const valXml = (s: ChartSeries, fmt: string) =>
  `<c:val><c:numRef><c:f>${xmlEscape(s.ref)}</c:f>${numCache(s.values, fmt)}</c:numRef></c:val>`;

function labels(fmt: string, on: boolean, pct = false): string {
  if (!on && !pct) return "";
  return (
    `<c:dLbls><c:numFmt formatCode="${xmlEscape(pct ? "0%" : fmt)}" sourceLinked="0"/>` +
    `<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>` +
    `<c:showLegendKey val="0"/><c:showVal val="${pct ? 0 : 1}"/><c:showCatName val="0"/>` +
    `<c:showSerName val="0"/><c:showPercent val="${pct ? 1 : 0}"/><c:showBubbleSize val="0"/>` +
    (pct ? `<c:showLeaderLines val="1"/>` : "") +
    `</c:dLbls>`
  );
}

const colorOf = (s: ChartSeries, i: number) =>
  s.color ?? CHART_COLORS[i % CHART_COLORS.length] ?? "3B5FCC";

function barSer(spec: ChartSpec, s: ChartSeries, i: number, fmt: string) {
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serName(s)}` +
    `<c:spPr>${solid(colorOf(s, i))}</c:spPr><c:invertIfNegative val="0"/>` +
    `${labels(fmt, !!spec.dataLabels)}${catXml(spec)}${valXml(s, fmt)}</c:ser>`
  );
}

function lineSer(spec: ChartSpec, s: ChartSeries, i: number, fmt: string) {
  const c = colorOf(s, i);
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serName(s)}` +
    `<c:spPr><a:ln w="28575" cap="rnd">${solid(c)}<a:round/></a:ln></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solid(c)}</c:spPr></c:marker>` +
    `${labels(fmt, !!spec.dataLabels)}${catXml(spec)}${valXml(s, fmt)}<c:smooth val="0"/></c:ser>`
  );
}

function pieSer(spec: ChartSpec, s: ChartSeries, fmt: string) {
  const pts = spec.categories
    .map(
      (_, i) =>
        `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${solid(
          CHART_COLORS[i % CHART_COLORS.length] ?? "3B5FCC",
        )}<a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`,
    )
    .join("");
  return (
    `<c:ser><c:idx val="0"/><c:order val="0"/>${serName(s)}${pts}` +
    `${labels(fmt, false, true)}${catXml(spec)}${valXml(s, fmt)}</c:ser>`
  );
}

const AX_CAT = 111111;
const AX_VAL = 222222;

const axisText = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="6B7690"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const axLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D8E0F2"/></a:solidFill></a:ln></c:spPr>`;

function axes(horizontal: boolean, fmt: string): string {
  return (
    `<c:catAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/>` +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${axLine}${axisText}` +
    `<c:crossAx val="${AX_VAL}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="${AX_VAL}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/>` +
    `<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E6EBF6"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` +
    `<c:numFmt formatCode="${xmlEscape(fmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${axisText}` +
    `<c:crossAx val="${AX_CAT}"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`
  );
}

/** Builds the complete chartN.xml for one spec. Exported for tests. */
export function buildChartXml(spec: ChartSpec): string {
  const fmt = spec.numFmt ?? inrFormat();
  let plot = "";
  const isPie = spec.type === "pie" || spec.type === "doughnut";
  if (isPie) {
    const s = spec.series[0];
    const inner = s ? pieSer(spec, s, fmt) : "";
    plot =
      spec.type === "pie"
        ? `<c:pieChart><c:varyColors val="1"/>${inner}<c:firstSliceAng val="0"/></c:pieChart>`
        : `<c:doughnutChart><c:varyColors val="1"/>${inner}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  } else {
    const horizontal = spec.type === "bar";
    const bars: string[] = [];
    const lines: string[] = [];
    spec.series.forEach((s, i) => {
      const asLine =
        spec.type === "line" || (spec.type === "combo" && s.kind === "line");
      (asLine ? lines : bars).push(
        asLine ? lineSer(spec, s, i, fmt) : barSer(spec, s, i, fmt),
      );
    });
    const ax = `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/>`;
    if (bars.length) {
      plot +=
        `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/>` +
        `<c:grouping val="${spec.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${bars.join("")}` +
        `<c:gapWidth val="70"/>${spec.stacked ? '<c:overlap val="100"/>' : ""}${ax}</c:barChart>`;
    }
    if (lines.length) {
      plot += `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lines.join("")}<c:marker val="1"/>${ax}</c:lineChart>`;
    }
    plot += axes(horizontal, fmt);
  }
  const legend = spec.legend ?? (isPie ? "r" : "b");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>` +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="1B2436"/></a:solidFill></a:defRPr></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="1B2436"/></a:solidFill></a:rPr><a:t>${xmlEscape(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
    `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>` +
    (legend === "none"
      ? ""
      : `<c:legend><c:legendPos val="${legend}"/><c:overlay val="0"/>${axisText}</c:legend>`) +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr>${solid("FFFFFF")}<a:ln w="9525"><a:solidFill><a:srgbClr val="D8E0F2"/></a:solidFill></a:ln></c:spPr>` +
    `</c:chartSpace>`
  );
}

function buildDrawingXml(specs: ChartSpec[], relIds: string[]): string {
  const anchors = specs
    .map((s, i) => {
      const a = s.anchor;
      return (
        `<xdr:twoCellAnchor editAs="oneCell">` +
        `<xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${relIds[i]}"/>` +
        `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`
  );
}

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Maps worksheet name -> zip path of its sheet xml, via workbook.xml + rels. */
async function sheetPaths(zip: import("jszip")): Promise<Map<string, string>> {
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  const relXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!wbXml || !relXml) throw new Error("workbook parts missing");
  const targets = new Map<string, string>();
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target);
  }
  const out = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (!name || !target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    out.set(name, path);
  }
  return out;
}

/**
 * Injects every registered chart into the xlsx bytes and returns the new
 * bytes. Returns the input untouched when no sheet has charts. Throws on any
 * structural surprise (caller falls back to the chart-less workbook).
 */
export async function injectCharts(
  buffer: ArrayBuffer | Uint8Array,
  wb: Workbook,
): Promise<Uint8Array> {
  const hosts = wb.worksheets.filter((ws) => chartsFor(ws).length > 0);
  if (hosts.length === 0) return new Uint8Array(buffer);

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const paths = await sheetPaths(zip);

  let chartN = Object.keys(zip.files).filter((f) =>
    /^xl\/charts\/chart\d+\.xml$/.test(f),
  ).length;
  let drawingN = Object.keys(zip.files).filter((f) =>
    /^xl\/drawings\/drawing\d+\.xml$/.test(f),
  ).length;
  const overrides: string[] = [];

  for (const ws of hosts) {
    const specs = chartsFor(ws);
    const sheetPath = paths.get(xmlEscape(ws.name));
    if (!sheetPath) throw new Error(`sheet not found: ${ws.name}`);
    let sheetXml = await zip.file(sheetPath)!.async("string");
    if (/<drawing\b/.test(sheetXml))
      throw new Error("sheet already has a drawing");

    drawingN += 1;
    const relIds: string[] = [];
    let drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">`;
    specs.forEach((spec, i) => {
      chartN += 1;
      const rid = `rId${i + 1}`;
      relIds.push(rid);
      zip.file(`xl/charts/chart${chartN}.xml`, buildChartXml(spec));
      drawingRels += `<Relationship Id="${rid}" Type="${REL_TYPE}/chart" Target="../charts/chart${chartN}.xml"/>`;
      overrides.push(
        `<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      );
    });
    drawingRels += "</Relationships>";
    zip.file(
      `xl/drawings/drawing${drawingN}.xml`,
      buildDrawingXml(specs, relIds),
    );
    zip.file(`xl/drawings/_rels/drawing${drawingN}.xml.rels`, drawingRels);
    overrides.push(
      `<Override PartName="/xl/drawings/drawing${drawingN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    );

    // Sheet rels (may already exist for tables/hyperlinks).
    const fileName = sheetPath.split("/").pop()!;
    const relsPath = `xl/worksheets/_rels/${fileName}.rels`;
    const relEntry = `<Relationship Id="rIdCharts1" Type="${REL_TYPE}/drawing" Target="../drawings/drawing${drawingN}.xml"/>`;
    const existing = await zip.file(relsPath)?.async("string");
    zip.file(
      relsPath,
      existing
        ? existing.replace("</Relationships>", `${relEntry}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${relEntry}</Relationships>`,
    );

    const tag = `<drawing r:id="rIdCharts1"/>`;
    // <drawing> goes after pageSetup/headerFooter, before legacyDrawing/tableParts/extLst.
    if (!/<worksheet\b[^>]*xmlns:r=/.test(sheetXml)) {
      sheetXml = sheetXml.replace(
        /<worksheet\b/,
        `<worksheet xmlns:r="${REL_TYPE}"`,
      );
    }
    // Insert before the first worksheet-level element that must follow
    // <drawing>. Careful: <extLst> also appears NESTED inside <cfRule> (data
    // bars), so the worksheet-level one is the last <extLst>, right before
    // </worksheet>. Inserting at the first match corrupts the file in Excel.
    const following = [
      "legacyDrawing",
      "legacyDrawingHF",
      "picture",
      "oleObjects",
      "controls",
      "webPublishItems",
      "tableParts",
    ]
      .map((n) => sheetXml.indexOf(`<${n}`))
      .filter((i) => i >= 0);
    const extAt = sheetXml.lastIndexOf("<extLst");
    if (
      extAt >= 0 &&
      /^<extLst[\s\S]*<\/extLst>\s*<\/worksheet>\s*$/.test(
        sheetXml.slice(extAt),
      )
    ) {
      following.push(extAt);
    }
    const at = following.length
      ? Math.min(...following)
      : sheetXml.lastIndexOf("</worksheet>");
    if (at < 0) throw new Error("malformed sheet xml");
    sheetXml = sheetXml.slice(0, at) + tag + sheetXml.slice(at);
    zip.file(sheetPath, sheetXml);
  }

  const ctPath = "[Content_Types].xml";
  const ct = await zip.file(ctPath)!.async("string");
  zip.file(ctPath, ct.replace("</Types>", `${overrides.join("")}</Types>`));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
