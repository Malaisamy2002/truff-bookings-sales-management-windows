import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Ban,
  Eye,
  Pencil,
  ChevronLeft,
  ChevronRight,
  Receipt,
  QrCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrintSettings } from "@/lib/print";
import { UpiPayDialog } from "./UpiPayDialog";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDMY, money, snackSaleGrossTotal } from "@/lib/biz";
import { cleanAmountInput, rupees } from "@/lib/money";
import { snackSaleReceipt } from "@/lib/receipt";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { exportToExcel } from "@/lib/xlsx";
import {
  SNACK_PAYMENT_MODES,
  TAB_PAYMENT_MODE,
  useDeleteSnackSale,
  useSnackSales,
  useUpdateSnackSale,
  useVoidSnackSale,
} from "@/lib/ops";
import { useCorrectSnackSaleMode } from "@/lib/collect";
import { advanceEntries } from "@/lib/split-payment";
import { dueNoForRef, saleMovedToDues, saleStateLabel } from "@/lib/dues";
import { TAB_REF_SNACK_SALE, useTabEntries } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import {
  useBills,
  useCustomers,
  usePayments,
  customerPhoneForName,
} from "@/lib/data";
import { Badge } from "@/components/ui/badge";
import {
  compareBy,
  sortSuffix,
  useSortState,
  type SortOption,
} from "@/lib/sort";
import { ListDisclosure } from "./ListDisclosure";
import { SectionHeading } from "@/components/app/SectionHeading";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { RecordActionRow } from "./RecordActionRow";
import { SortMenu } from "./SortMenu";
import { usePrintPreview } from "@/lib/use-print-preview";

const PAGE_SIZE = 25;

type SnackSaleSortField = "date" | "amount" | "customer";

const SNACK_SALE_SORT_OPTIONS: SortOption<SnackSaleSortField>[] = [
  { value: "date", label: "Date", defaultDir: "desc" },
  { value: "amount", label: "Amount", defaultDir: "desc" },
  { value: "customer", label: "Customer", defaultDir: "asc" },
];

/** Legacy snacks-only bills, kept visible inside the combined Turf & Snacks tab. */
export function SnackSalesList() {
  const { data: sales = [] } = useSnackSales();
  const del = useDeleteSnackSale();
  const voidSale = useVoidSnackSale();
  const update = useUpdateSnackSale();
  const correctMode = useCorrectSnackSaleMode();
  // Lightweight edit path (see PROGRESS-NOTES.md Step 40): fixes the common
  // "typo'd the name" / "picked the wrong payment mode" / "forgot a note"
  // slip-ups without delete-and-re-ring-up, which would also needlessly
  // disturb stock even though the sold items themselves aren't changing.
  // Deliberately does NOT let you edit the items/cart — swapping what was
  // sold is a stock- and revenue-affecting change that deserves the same
  // reason-tracked treatment Step 25 built for stock adjustments, not a
  // silent field patch; delete-and-re-ring-up remains the way to do that.
  const { settings } = usePrintSettings();
  const upiId = settings.upiId.trim();
  const [qrFor, setQrFor] = useState<null | { amount: number; note: string }>(
    null,
  );
  const [editTarget, setEditTarget] = useState<{
    id: string;
    customer_name: string;
    payment_mode: string;
    /** The mode the sale ACTUALLY had before this edit — so Save only
     * touches payment rows when the mode (or the cash part below) really
     * changed, never on an edit that just fixes the name or a note. */
    original_mode: string;
    /** "Paid in cash" carved out of a UPI sale — same optional field the
     * sale-creation form (SnacksTab) offers, prefilled from whatever the
     * sale's REAL payment rows currently show so an unrelated edit can't
     * silently collapse an existing split. Blank/irrelevant for Cash or
     * On-tab sales, same as at creation. */
    cash_part: string;
    /** `cash_part` as it stood when the dialog opened — compared against
     * on Save so an edit that leaves it untouched changes nothing. */
    original_cash_part: string;
    notes: string;
  } | null>(null);
  const { data: bills = [] } = useBills();
  const { data: customers = [] } = useCustomers();
  const { data: tabEntries = [] } = useTabEntries();
  const { data: payments = [] } = usePayments();
  const invoiceNoById = useMemo(
    () => new Map(bills.map((b) => [b.id, b.invoice_no])),
    [bills],
  );
  const { openPreview, previewDialog } = usePrintPreview();

  const sort = useSortState<SnackSaleSortField>(
    "snack-sales",
    SNACK_SALE_SORT_OPTIONS,
    {
      field: "date",
      dir: "desc",
    },
  );
  const sortedSales = useMemo(
    () =>
      [...sales].sort((a, b) => {
        switch (sort.field) {
          case "amount":
            return compareBy(a.total, b.total, sort.dir);
          case "customer":
            return compareBy(
              (a.customer_name ?? "").toLowerCase(),
              (b.customer_name ?? "").toLowerCase(),
              sort.dir,
            );
          case "date":
          default:
            return compareBy(a.sale_date, b.sale_date, sort.dir);
        }
      }),
    [sales, sort.field, sort.dir],
  );

  /** Set by the calendar-popup on the "Date" sort control — narrows the
   * snack bills list to exactly one day. */
  const [saleDate, setSaleDate] = useState<string | undefined>(undefined);
  const dateFilteredSales = useMemo(
    () =>
      saleDate
        ? sortedSales.filter((s) => s.sale_date === saleDate)
        : sortedSales,
    [sortedSales, saleDate],
  );

  const [page, setPage] = useState(1);
  const pageCount = Math.max(
    1,
    Math.ceil(dateFilteredSales.length / PAGE_SIZE),
  );
  useEffect(() => {
    setPage(1);
  }, [sales.length, sort.field, sort.dir, saleDate]);
  const pageSales = useMemo(
    () => dateFilteredSales.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [dateFilteredSales, page],
  );

  const exportSales = () =>
    exportToExcel(
      dateFilteredSales.flatMap((s) =>
        s.items.map((it) => ({
          "Bill No": s.bill_no,
          Date: formatDMY(s.sale_date),
          Customer: s.customer_name ?? "",
          Item: it.item_name,
          Qty: it.qty,
          "Unit Price": it.unit_price,
          Amount: it.amount,
          Profit: rupees(it.amount - it.qty * it.cost_price),
          "Payment Mode": s.payment_mode,
          Notes: s.notes ?? "",
        })),
      ),
      `snack-sales-${sortSuffix(sort.field, sort.dir)}`,
      "Snack Sales",
      INVOICE_SECTIONS.snacks,
    );

  return (
    <>
      <Card>
        <CardContent className="space-y-4">
          <LayoutParts sectionId="snacks.sales" className="space-y-4">
            <LayoutPart id="snacks.sales.toolbar">
              <SectionHeading
                icon={Receipt}
                eyebrow="Bills"
                title="Saved snack bills"
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <SortMenu
                      options={SNACK_SALE_SORT_OPTIONS}
                      field={sort.field}
                      dir={sort.dir}
                      onFieldChange={sort.setField}
                      onToggleDir={sort.toggleDir}
                      dateField="date"
                      selectedDate={saleDate}
                      onSelectDate={setSaleDate}
                    />
                    <Button size="sm" variant="outline" onClick={exportSales}>
                      <Download className="mr-1 h-4 w-4" /> Excel
                    </Button>
                  </div>
                }
              />
            </LayoutPart>
            <LayoutPart id="snacks.sales.list" className="space-y-4">
              <ListDisclosure
                storageKey="snacks.sales"
                label="Sales list"
                count={dateFilteredSales.length}
              >
                {saleDate && (
                  <div className="frost-soft flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                    <span>
                      Showing{" "}
                      <span className="font-medium">
                        {dateFilteredSales.length}
                      </span>{" "}
                      snack bill
                      {dateFilteredSales.length === 1 ? "" : "s"} for{" "}
                      <span className="font-medium">{formatDMY(saleDate)}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSaleDate(undefined)}
                    >
                      Clear
                    </Button>
                  </div>
                )}
                {sales.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No snack bills yet.
                  </p>
                )}
                {pageSales.map((s) => {
                  const moved = saleMovedToDues(s, tabEntries);
                  const dueNo = moved
                    ? dueNoForRef(
                        tabEntries,
                        TAB_REF_SNACK_SALE,
                        s.id,
                        s.bill_no,
                        s.sale_date,
                      )
                    : null;
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        "frost-soft lift rounded-xl border p-3 text-sm",
                        moved && "border-dashed saturate-50",
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 font-semibold">
                            <span>
                              {s.bill_no}
                              {s.customer_name ? ` · ${s.customer_name}` : ""}
                            </span>
                            {moved ? (
                              <>
                                <Badge variant="secondary">
                                  Moved to dues · {dueNo}
                                </Badge>
                                {moved && upiId && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-1.5 text-xs"
                                    aria-label="Pay via UPI"
                                    onClick={() =>
                                      setQrFor({
                                        amount: s.total + (s.tax_amount ?? 0),
                                        note: s.bill_no,
                                      })
                                    }
                                  >
                                    <QrCode className="size-3.5" /> Pay via UPI
                                  </Button>
                                )}
                              </>
                            ) : (
                              (() => {
                                const state = saleStateLabel(
                                  s,
                                  s.merged_into_bill_id
                                    ? invoiceNoById.get(s.merged_into_bill_id)
                                    : null,
                                );
                                return (
                                  <>
                                    {state ? (
                                      <Badge variant="outline">{state}</Badge>
                                    ) : null}
                                    {upiId &&
                                      s.payment_mode !== "On tab" &&
                                      s.payment_mode !== "Pending" && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-6 px-1.5 text-xs"
                                          aria-label="Pay via UPI"
                                          onClick={() =>
                                            setQrFor({
                                              amount:
                                                s.total + (s.tax_amount ?? 0),
                                              note: s.bill_no,
                                            })
                                          }
                                        >
                                          <QrCode className="size-3.5" /> Pay
                                          via UPI
                                        </Button>
                                      )}
                                  </>
                                );
                              })()
                            )}
                          </div>
                          <p className="text-muted-foreground">
                            {formatDMY(s.sale_date)} · {s.payment_mode}
                            {s.booking_no ? ` · Linked to ${s.booking_no}` : ""}
                          </p>
                          <ul className="mt-1 text-muted-foreground">
                            {s.items.map((it, i) => (
                              <li key={i}>
                                {it.item_name} · {it.qty} ×{" "}
                                {money(it.unit_price)} = {money(it.amount)}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 font-medium">
                            Total{" "}
                            <span className="stat-value">{money(s.total)}</span>
                          </p>
                          {moved && (
                            <p className="text-xs text-muted-foreground">
                              On {s.customer_name || "the customer"}'s tab —
                              collect it from Outstanding so the same money
                              isn't counted twice.
                            </p>
                          )}
                        </div>
                        <div className="flex w-full flex-wrap gap-1 sm:w-auto sm:justify-end">
                          <RecordActionRow
                            doc={snackSaleReceipt(s)}
                            phone={customerPhoneForName(
                              customers,
                              s.customer_name,
                            )}
                            section={INVOICE_SECTIONS.snacks}
                            noun="snack bill"
                            size="sm"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label="Preview snack bill before printing"
                            title="Preview"
                            onClick={() =>
                              openPreview(
                                snackSaleReceipt(s),
                                INVOICE_SECTIONS.snacks,
                              )
                            }
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label="Edit snack bill"
                            title="Edit customer, payment mode, or notes"
                            // Same guard as Void/Delete below: a merged sale's
                            // fields now belong to the bill (edit there), and
                            // a sale already moved to a customer's tab has a
                            // separately-keyed tab charge (lib/tabs.ts
                            // TAB_REF_SNACK_SALE) that a name edit here
                            // wouldn't follow — see the guard's reasoning on
                            // the Void button.
                            disabled={!!s.merged_into_bill_id || moved}
                            onClick={() => {
                              const cashRows = payments.filter(
                                (p) =>
                                  p.parent_type === "snack_sale" &&
                                  p.parent_id === s.id &&
                                  p.mode === "Cash",
                              );
                              const cash = cashRows.reduce(
                                (sum, r) => sum + r.amount,
                                0,
                              );
                              setEditTarget({
                                id: s.id,
                                customer_name: s.customer_name ?? "",
                                payment_mode: s.payment_mode,
                                original_mode: s.payment_mode,
                                cash_part:
                                  s.payment_mode === "UPI" && cash > 0
                                    ? String(cash)
                                    : "",
                                original_cash_part:
                                  s.payment_mode === "UPI" && cash > 0
                                    ? String(cash)
                                    : "",
                                notes: s.notes ?? "",
                              });
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {!s.cancelled && (
                            <ConfirmDeleteButton
                              size="sm"
                              // A merged sale's revenue now lives on its bill
                              // (undo there — Bills tab Void/un-merge), and a
                              // sale moved to dues has a live tab charge
                              // referencing this row by id (lib/tabs.ts
                              // TAB_REF_SNACK_SALE) that voiding doesn't
                              // reverse — same guard the delete button below
                              // already uses.
                              className="text-muted-foreground"
                              icon={Ban}
                              disabled={!!s.merged_into_bill_id || moved}
                              ariaLabel="Void snack bill"
                              confirmLabel="Void snack bill"
                              title={`Void snack bill ${s.bill_no}?`}
                              description={`This cancels ${s.bill_no} for ${s.customer_name || "the customer"} — the sold items go back to stock and it stops counting toward revenue or dues. The record stays for history; this doesn't delete it.`}
                              onConfirm={() =>
                                voidSale.mutate(s.id, {
                                  onSuccess: () =>
                                    toast.success(`${s.bill_no} cancelled`),
                                  onError: (e) => toast.error(e.message),
                                })
                              }
                            />
                          )}
                          <ConfirmDeleteButton
                            size="sm"
                            // A merged sale's revenue now lives on its bill (undo
                            // there — Bills tab Void/un-merge), and a sale moved
                            // to dues has a live tab charge referencing this row
                            // by id (lib/tabs.ts TAB_REF_SNACK_SALE) that plain
                            // delete never releases. Deleting either here would
                            // either desync the merged bill's line items or leave
                            // an orphaned tab charge with no source record — same
                            // class of bug Step 27 fixed for Turf bookings
                            // (TurfTab's `disabled={!!b.merged_into_bill_id || moved}`),
                            // which this mirrors. A cancelled sale already had its
                            // stock restored (useVoidSnackSale) and isn't merged
                            // or moved by definition, so it's always deletable
                            // here.
                            disabled={
                              !s.cancelled && (!!s.merged_into_bill_id || moved)
                            }
                            ariaLabel="Delete snack bill"
                            title={`Delete snack bill ${s.bill_no}?`}
                            description={
                              s.cancelled
                                ? `This permanently removes the cancelled record for ${s.bill_no} and can't be undone.`
                                : `This permanently removes ${s.bill_no} (${money(s.total)}) and restores the sold items back to stock. This can't be undone.`
                            }
                            onConfirm={() =>
                              del.mutate(s.id, {
                                onSuccess: () => toast.success("Deleted"),
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}

                {dateFilteredSales.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between pt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" /> Prev
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page {page} of {pageCount} · {dateFilteredSales.length}{" "}
                      bills
                      {saleDate ? ` (of ${sales.length} total)` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page >= pageCount}
                      onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    >
                      Next <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                )}
              </ListDisclosure>
            </LayoutPart>
          </LayoutParts>
        </CardContent>
      </Card>
      <Dialog
        open={editTarget != null}
        onOpenChange={(o) => !o && setEditTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit snack bill</DialogTitle>
            <DialogDescription>
              Updates the customer, payment mode, and notes only — the items
              sold and stock are unchanged. To change what was sold, delete and
              re-ring up the sale instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="micro-label">Customer</Label>
              <Input
                value={editTarget?.customer_name ?? ""}
                onChange={(e) =>
                  setEditTarget((t) =>
                    t ? { ...t, customer_name: e.target.value } : t,
                  )
                }
                placeholder="Walk-in customer"
              />
            </div>
            <div className="space-y-1">
              <Label className="micro-label">Payment mode</Label>
              <Select
                value={editTarget?.payment_mode ?? "Cash"}
                onValueChange={(v) =>
                  setEditTarget((t) =>
                    t
                      ? {
                          ...t,
                          payment_mode: v,
                          cash_part: v === "UPI" ? t.cash_part : "",
                        }
                      : t,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SNACK_PAYMENT_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editTarget?.payment_mode === "UPI" && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs">Paid in cash (optional)</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="0"
                    value={editTarget.cash_part}
                    onChange={(e) =>
                      setEditTarget((t) =>
                        t
                          ? {
                              ...t,
                              cash_part: cleanAmountInput(e.target.value),
                            }
                          : t,
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    The rest is recorded as UPI.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="micro-label">Notes</Label>
              <Textarea
                value={editTarget?.notes ?? ""}
                onChange={(e) =>
                  setEditTarget((t) =>
                    t ? { ...t, notes: e.target.value } : t,
                  )
                }
                placeholder="Optional"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={update.isPending || correctMode.isPending}
              onClick={async () => {
                if (!editTarget) return;
                const sale = sales.find((s) => s.id === editTarget.id);
                // Only touch the payment rows when there's actually a new
                // mode/split to record — an edit that's just a name or note
                // fix leaves an already-correct split untouched. Converting
                // to/from "On tab" is deliberately left to the plain field
                // patch below: that's a real charge-vs-tab structural
                // change (the tab ledger, not just a payment row's mode)
                // that this correction flow doesn't attempt.
                const modeChanged =
                  editTarget.payment_mode !== editTarget.original_mode ||
                  editTarget.cash_part !== editTarget.original_cash_part;
                const isTabTransition =
                  editTarget.payment_mode === TAB_PAYMENT_MODE ||
                  editTarget.original_mode === TAB_PAYMENT_MODE;
                try {
                  if (sale && modeChanged && !isTabTransition) {
                    await correctMode.mutateAsync({
                      id: editTarget.id,
                      saleDate: sale.sale_date,
                      entries: advanceEntries(
                        snackSaleGrossTotal(sale),
                        editTarget.payment_mode === "UPI" ? "UPI" : "Cash",
                        editTarget.cash_part,
                      ),
                    });
                  }
                  await update.mutateAsync({
                    id: editTarget.id,
                    customer_name: editTarget.customer_name.trim() || null,
                    payment_mode: editTarget.payment_mode,
                    notes: editTarget.notes.trim() || null,
                  });
                  toast.success("Saved");
                  setEditTarget(null);
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Could not save",
                  );
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {qrFor && (
        <UpiPayDialog
          open
          onOpenChange={(o) => {
            if (!o) setQrFor(null);
          }}
          upiId={upiId}
          payeeName={settings.upiPayeeName?.trim() || settings.shopName}
          note={qrFor.note}
          amount={qrFor.amount}
        />
      )}
      {previewDialog}
    </>
  );
}
