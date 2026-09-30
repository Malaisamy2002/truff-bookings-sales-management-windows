import ExcelJS from "exceljs";
import { toast } from "sonner";
import {
  describeSaveError,
  isAndroid,
  isDesktop,
  revealInFolder,
  saveExportFile,
  saveToInvoicesFolder,
  type InvoiceSection,
} from "./desktop";

import { dayKey } from "./analytics";
import {
  fillWorkbook,
  type ExportMeta,
  type SheetRow,
  type SheetSpec,
} from "./xlsx-build";
import { injectCharts } from "./xlsx-charts";
import { readPrintSettings } from "./print";

export type { SheetRow, SheetSpec, ExportMeta } from "./xlsx-build";

/** Download an array of flat objects as an .xlsx file. */
/** Shop name for the title band, from the same settings the receipts use. */
function defaultMeta(): ExportMeta {
  try {
    const ps = readPrintSettings();
    const name = ps.shopName?.trim();
    const symbol = ps.currencySymbol?.trim();
    return name
      ? { shopName: name, ...(symbol ? { currencySymbol: symbol } : {}) }
      : {};
  } catch {
    return {};
  }
}

export function exportToExcel(
  rows: SheetRow[],
  filename: string,
  sheetName = "Sheet1",
  section?: InvoiceSection,
) {
  return exportWorkbook([{ name: sheetName, rows }], filename, section);
}

/**
 * Download several sheets in one workbook. Empty flat-row sheets are kept
 * with a placeholder row.
 *
 * In the browser/PWA we build the workbook bytes with ExcelJS and trigger a
 * Blob + `<a download>` click ourselves (ExcelJS has no writeFile-style
 * browser helper like SheetJS did). The desktop shell's Tauri WebView can't
 * do that trick either — same reason receipt.ts and backup.ts fork on
 * `isDesktop()` — so there we write the same bytes straight into the app's
 * shared `Invoices/` folder via `saveToInvoicesFolder` (desktop.ts) and
 * reveal the file in Explorer, exactly like `downloadReceipt` does.
 */
export async function exportWorkbook(
  sheets: SheetSpec[],
  filename: string,
  section?: InvoiceSection,
  meta?: ExportMeta,
): Promise<boolean> {
  const wb = new ExcelJS.Workbook();
  fillWorkbook(wb, sheets, meta ?? defaultMeta());
  const name = `${filename}-${dayKey(new Date())}.xlsx`;
  let buffer: ArrayBuffer | Uint8Array;
  try {
    buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    // Native charts are zipped in afterwards (ExcelJS can't draw them). A
    // chart failure must never cost the owner the export — keep the plain file.
    try {
      buffer = await injectCharts(buffer, wb);
    } catch (chartErr) {
      console.warn("Excel charts skipped:", chartErr);
    }
  } catch (e) {
    // A big workbook can fail here (out of memory while zipping). Say so
    // instead of the old bare "Excel export failed" with no reason.
    toast.error("Excel export failed", { description: describeSaveError(e) });
    return false;
  }

  // An empty/near-empty buffer means nothing usable was produced — never
  // report success for a 0-byte file.
  if (!buffer || buffer.byteLength === 0) {
    toast.error("Excel export failed", {
      description: "No data was produced for the file.",
    });
    return false;
  }

  // Checked before the generic isDesktop() branch — Android satisfies
  // isDesktop() too, but its $DOCUMENT fs-scope write isn't reliably visible
  // to the user there. See saveExportFile's doc comment in desktop.ts.
  if (isAndroid()) {
    const result = await saveExportFile(
      new Uint8Array(buffer),
      name,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    if (result.saved) {
      toast.success("Excel file saved to Downloads", { description: name });
      return true;
    }
    toast.error("Couldn't save Excel file", {
      description: result.error ?? name,
    });
    return false;
  }

  if (isDesktop()) {
    try {
      const abs = await saveToInvoicesFolder(
        new Uint8Array(buffer),
        name,
        section,
      );
      await revealInFolder(abs);
    } catch (e) {
      // The write itself can fail (folder not writable, disk full). This
      // used to throw past the caller while no toast ever appeared.
      toast.error("Couldn't save Excel file", {
        description: describeSaveError(e),
      });
      return false;
    }
    toast.success("Excel file saved", { description: name });
    return true;
  }

  const blob = new Blob([buffer as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast.success("Excel file downloaded", { description: name });
  return true;
}
