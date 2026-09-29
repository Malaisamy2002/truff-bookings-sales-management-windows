import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MessageCircle, Phone, HandCoins, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  billGrossTotal,
  bookingGrossTotal,
  customerTag,
  formatDMY,
  money,
  whatsappUrl,
} from "@/lib/biz";
import { useBills, matchesCustomer } from "@/lib/data";
import { useCollectBillPayment, useCollectBookingPayment } from "@/lib/collect";
import { useSnackSales, useTurfBookings } from "@/lib/ops";
import { isFinancialBooking } from "@/lib/analytics";
import {
  billCollected,
  billDue,
  billMovedToDues,
  bookingCashCollected,
  bookingDue,
  customerOutstanding,
  dueNoForRef,
  isFinancialSale,
  saleStateLabel,
  snackSaleCollected,
  type CustomerDues,
  type DueLine,
} from "@/lib/dues";
import {
  TAB_REF_BILL,
  tabKey,
  useTabEntries,
  useTabSummaries,
} from "@/lib/tabs";
import { useSettleCustomer } from "@/lib/customer-actions";
import {
  describePaymentSplit,
  receiptModeLabel,
  type PaymentEntry,
} from "@/lib/payments";
import {
  customerStatementReceipt,
  paymentReceipt,
  printReceipt,
} from "@/lib/receipt";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { RecordActionRow } from "./RecordActionRow";
import { CustomerTabCard } from "./CustomerTabCard";
import { CollectPaymentDialog } from "./CollectPaymentDialog";

type Props = {
  name: string | null;
  phone: string | null;
  onOpenChange: (open: boolean) => void;
};

/** Name-only fallback for records with no phone field of their own (snack
 * sales — see SnackSale's shape). Case/whitespace-insensitive. */
const sameName = (a: string | null | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One pending line with its own collect actions when it's backed by a real
 * record (booking/bill) — a partial-amount input plus "Mark paid", so a
 * balance can be settled right here instead of sending the operator back to
 * the Turf or Bills tab for the same rupee.
 */
function PendingLineRow({
  line,
  onOpenCollect,
  busy,
}: {
  line: DueLine;
  /** Opens the shared split dialog for this line, pre-filled with
   * `amount` — an entered part payment, or the line's whole due for
   * "Mark paid". The dialog itself asks cash vs online. */
  onOpenCollect: (line: DueLine, amount: number) => void;
  busy: boolean;
}) {
  const [amount, setAmount] = useState("");
  const actionable = line.kind !== "tab" && Boolean(line.id);
  const entered = Math.min(Math.max(Number(amount) || 0, 0), line.amount);

  return (
    <div className="space-y-1.5 border-b pb-1.5 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words text-muted-foreground">
          {line.label}
          {line.date ? ` · ${formatDMY(line.date)}` : ""}
        </span>
        <span className="stat-value shrink-0 text-sm text-destructive">
          {money(line.amount)}
        </span>
      </div>
      {actionable && (
        <div className="flex items-center gap-1.5">
          <Input
            inputMode="decimal"
            className="h-8 min-w-0 flex-1 text-xs"
            placeholder={`Part payment (max ${money(line.amount)})`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={entered <= 0 || busy}
            onClick={() => {
              onOpenCollect(line, entered);
              setAmount("");
            }}
          >
            <HandCoins className="mr-1 size-3.5" /> Collect
          </Button>
          <Button
            size="sm"
            className="h-8"
            disabled={busy}
            onClick={() => onOpenCollect(line, line.amount)}
          >
            <CheckCircle2 className="mr-1 size-3.5" /> Mark paid
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Everything about one customer: bills, bookings, snack orders and dues.
 * Self-contained (fetches its own data) so it can be dropped in either
 * place that needs a customer's full picture — inside the `CustomerDetailDialog`
 * modal (narrow windows) or directly in `OutstandingTab`'s desktop two-pane
 * detail column (md+ windows) — without either caller re-fetching or
 * re-deriving anything.
 */
export function CustomerDetailContent({
  name,
  phone,
}: {
  name: string;
  phone: string | null;
}) {
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: tabEntries = [] } = useTabEntries();
  const tabSummaries = useTabSummaries();
  const tabBalance = name
    ? (tabSummaries.get(tabKey(name, phone))?.balance ?? 0)
    : 0;
  const myEntries = useMemo(
    () =>
      name
        ? tabEntries.filter((e) => e.customer_key === tabKey(name, phone))
        : [],
    [name, phone, tabEntries],
  );
  const collectBooking = useCollectBookingPayment();
  const collectBill = useCollectBillPayment();
  const { settleAll: settleCustomer, isPending: settlingAll } =
    useSettleCustomer();
  // The one shared "how was this paid" dialog for a single pending line
  // (Collect / Mark paid) — opened with the line and the amount to collect
  // (a typed part, or the whole due), asked for cash/online, then recorded.
  const [lineDialog, setLineDialog] = useState<{
    line: DueLine;
    amount: number;
  } | null>(null);
  // Same dialog, for "Settle all" — due is the WHOLE outstanding balance,
  // and `requireFull` means the two boxes must add up to every rupee of it.
  const [settleAllOpen, setSettleAllOpen] = useState(false);

  const data = useMemo(() => {
    if (!name) return null;
    // Phone-first, name-fallback — the same identity rule `matchesCustomer`
    // uses everywhere else (dues.ts's default customerOutstanding matcher,
    // useMergeCustomers). This view used to compare by name alone even
    // though it already has this customer's phone in hand, which meant two
    // different customers who happen to share a name (each with their own,
    // different, phone) would have their bills/bookings/dues shown as one
    // person's here — the same class of identity bug fixed in
    // useMergeCustomers, just on the read side instead of a write.
    const matches = (n: string | null | undefined, p?: string | null) =>
      matchesCustomer({ name, phone }, n, p);
    const myBills = bills.filter((b) =>
      matches(b.customer_name, b.customer_phone),
    );
    // myBookings keeps merged rows in — it's used to render the raw booking
    // list below (with a "merged" badge), not to total money or visits.
    const myBookings = bookings.filter(
      (b) => matches(b.customer_name, b.phone) && b.status !== "Cancelled",
    );
    // Money and visit-count math routes through isFinancialBooking() so a
    // merged booking's amount/visit (already represented via myBills) isn't
    // counted twice — same rule as every other revenue/dues calc in the app.
    const myFinancialBookings = myBookings.filter(isFinancialBooking);
    // Snack sales carry no phone field of their own, so name is the only
    // signal available here — same limitation useMergeCustomers has for
    // sales.
    const mySales = sales.filter((s) => sameName(s.customer_name, name));
    const myFinancialSales = mySales.filter(isFinancialSale);

    // Pre-tax throughout, on purpose — matches customerLifetimeStats()'s
    // totalSpend (billsSpend + turfSpend + snacksSpend, all pre-tax). This
    // used to add tax-INCLUSIVE bill totals (billGrossTotal) to pre-tax
    // booking/sale totals in the same sum, which inflated this dialog's
    // figure above the customer's totalSpend shown everywhere else
    // (Top Customers, dashboard rollups, Excel export) by exactly the tax
    // on that customer's bills. Tax-inclusive figures still belong in
    // `dues` below — outstanding balances are correctly tax-inclusive.
    const spent =
      myBills.reduce((s, b) => s + (Number(b.total) || 0), 0) +
      myFinancialBookings.reduce(
        (s, b) => s + (Number(b.total_amount) || 0),
        0,
      ) +
      myFinancialSales.reduce((s, b) => s + (Number(b.total) || 0), 0);

    // The ONE dues source of truth — tab, bookings and bills, each counted once.
    const dues: CustomerDues = customerOutstanding(
      { name, phone },
      {
        bills: myBills,
        bookings: myBookings,
        tabEntries: myEntries,
        tabBalance,
        match: matches,
      },
    );

    return {
      myBills,
      myBookings,
      mySales,
      spent,
      dues,
      visits:
        myBills.length + myFinancialBookings.length + myFinancialSales.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, bookings, sales, name, phone, tabBalance, tabEntries]);

  /** Full transaction history as one printable/shareable document — the
   * "Customer statement" template from Section 5 of the UX plan. Reuses the
   * exact same due/state text each record's own row below already shows
   * (billDue/bookingDue/saleStateLabel), so the statement can never disagree
   * with what the screen displays for the same record. `totalPaid` is
   * `spent - dues.total` rather than a separately-tracked figure — an
   * approximation that's exactly right whenever every unpaid item is
   * captured by `dues` (true for every current due type), so it only drifts
   * if a future due type isn't added to `customerOutstanding()` too. */
  const statementDoc = useMemo(() => {
    if (!name || !data) return null;
    const billLines = data.myBills.map((b) => {
      const due = billDue(b, myEntries);
      const onTab = billMovedToDues(b, myEntries);
      const paid = billCollected(b);
      return {
        label: `Bill ${b.invoice_no}`,
        date: b.bill_date,
        amount: billGrossTotal(b),
        status:
          due > 0
            ? `Due ${money(due)}`
            : onTab
              ? `On tab · ${dueNoForRef(myEntries, TAB_REF_BILL, b.id, b.invoice_no, b.bill_date)}`
              : paid > 0
                ? `Paid · ${receiptModeLabel("bill", b.id, b.payment_mode ?? "Cash")}`
                : b.status,
      };
    });
    const bookingLines = data.myBookings.map((b) => {
      const due = bookingDue(b, myEntries);
      const paid = bookingCashCollected(b, myEntries);
      return {
        label: `Booking ${b.booking_no}`,
        date: b.booking_date,
        amount: b.total_amount,
        status: b.merged_into_bill_id
          ? "Merged into bill"
          : due > 0
            ? `Due ${money(due)}`
            : paid > 0
              ? `Paid · ${receiptModeLabel("turf_booking", b.id, b.payment_mode ?? "Cash")}`
              : b.status,
      };
    });
    const saleLines = data.mySales.map((s) => ({
      label: `Snacks ${s.bill_no}`,
      date: s.sale_date,
      amount: s.total,
      status:
        saleStateLabel(s) ??
        (snackSaleCollected(s) > 0
          ? `Paid · ${receiptModeLabel("snack_sale", s.id, s.payment_mode)}`
          : s.payment_mode),
    }));
    return customerStatementReceipt({
      customer: name,
      phone,
      lines: [...billLines, ...bookingLines, ...saleLines].sort((a, b) =>
        a.date < b.date ? 1 : -1,
      ),
      totalSpent: data.spent,
      totalPaid: Math.max(0, data.spent - data.dues.total),
      totalOutstanding: data.dues.total,
    });
  }, [data, name, phone, myEntries]);

  /** `mode` reflects whatever was actually recorded — the split ("Cash
   * ₹500 + UPI ₹200") when it was mixed, otherwise the one mode used —
   * rather than a hardcoded "Cash", now that every collection here goes
   * through the shared split dialog. */
  const printPaymentReceipt = (
    against: string,
    entries: PaymentEntry[],
    after: number,
  ) =>
    printReceipt(
      paymentReceipt({
        customer: name ?? "",
        phone,
        against,
        amount: entries.reduce((s, e) => s + e.amount, 0),
        mode: describePaymentSplit(entries) ?? entries[0]?.mode ?? "Cash",
        balanceAfter: Math.max(0, after),
      }),
      undefined,
      INVOICE_SECTIONS.dues,
    );

  /** Records `entries` (built by the shared `CollectPaymentDialog`, so
   * already cash/online split and clamped to what's owed) against one
   * booking/bill line — the exact same math the Turf and Bills tabs use for
   * their own "Collect" / "Mark paid" actions, just triggerable from here so
   * the operator doesn't have to leave. Every successful collection also
   * offers a "Print receipt" toast action for a payment-receipt slip of
   * exactly this event. */
  const collectLineEntries = async (line: DueLine, entries: PaymentEntry[]) => {
    if (!line.id || !data) return;
    const amount = entries.reduce((s, e) => s + e.amount, 0);
    if (amount <= 0) return;
    try {
      if (line.kind === "booking") {
        const booking = data.myBookings.find((b) => b.id === line.id);
        if (!booking) return;
        const due = bookingDue(booking, myEntries);
        await collectBooking.mutateAsync({
          booking,
          tabEntries: myEntries,
          entries,
          markCompleted: true,
        });
        toast.success(
          amount >= due ? "Booking marked paid" : `Collected ${money(amount)}`,
          {
            action: {
              label: "Print receipt",
              onClick: () =>
                printPaymentReceipt(
                  `Booking ${booking.booking_no}`,
                  entries,
                  due - amount,
                ),
            },
          },
        );
      } else if (line.kind === "bill") {
        const bill = data.myBills.find((b) => b.id === line.id);
        if (!bill) return;
        const due = billDue(bill, myEntries);
        await collectBill.mutateAsync({
          bill,
          tabEntries: myEntries,
          entries,
        });
        toast.success(
          amount >= due ? "Bill marked paid" : `Collected ${money(amount)}`,
          {
            action: {
              label: "Print receipt",
              onClick: () =>
                printPaymentReceipt(
                  `Bill ${bill.invoice_no}`,
                  entries,
                  due - amount,
                ),
            },
          },
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not collect");
    }
  };

  /** Settles every open booking/bill line at once, plus the running tab —
   * the "Settle all" action the plan calls for on the unified Outstanding
   * view, so a customer's whole balance clears in one collection. Asks how
   * that whole balance was received (cash, online, or a mix) via the shared
   * split dialog, then delegates the actual mutation sequence to
   * `useSettleCustomer()` so `OutstandingTab`'s row context menu can trigger
   * the identical action. */
  const settleAll = (entries: PaymentEntry[]) => {
    if (!name || !data) return;
    settleCustomer({
      name,
      phone,
      myBookings: data.myBookings,
      myBills: data.myBills,
      myEntries,
      tabBalance,
      entries,
    });
  };

  if (!name || !data) return null;

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-lg font-semibold leading-tight">
          {name}
        </span>
        <Badge
          variant={data.visits >= 5 ? "default" : "secondary"}
          className="shrink-0"
        >
          {customerTag(data.visits)}
        </Badge>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">
        {phone || "No phone saved"}
      </p>

      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
        <Metric label="Visits" value={String(data.visits)} />
        <Metric label="Total spent" value={money(data.spent)} />
        <Metric
          label="Pending"
          value={money(data.dues.total)}
          danger={data.dues.total > 0}
        />
      </div>

      {statementDoc && data.visits > 0 && (
        <div className="frost-well flex items-center justify-between gap-2 rounded-xl border p-3">
          <p className="micro-label">Customer statement</p>
          <div className="flex gap-1.5">
            <RecordActionRow
              doc={statementDoc}
              phone={phone}
              section={INVOICE_SECTIONS.dues}
              noun="customer statement"
              size="sm"
            />
          </div>
        </div>
      )}

      {data.dues.total > 0 && (
        <Button
          className="w-full"
          variant="outline"
          disabled={
            collectBooking.isPending || collectBill.isPending || settlingAll
          }
          onClick={() => setSettleAllOpen(true)}
        >
          <CheckCircle2 className="mr-1 size-4" /> Settle all{" "}
          {money(data.dues.total)}
        </Button>
      )}

      {data.dues.lines.length > 0 && (
        <div className="frost-well space-y-2 rounded-xl border p-3">
          <p className="micro-label">Pending breakdown</p>
          {data.dues.lines.map((l, i) => (
            <PendingLineRow
              key={`${l.kind}-${l.id ?? l.label}-${i}`}
              line={l}
              busy={collectBooking.isPending || collectBill.isPending}
              onOpenCollect={(line, amount) => setLineDialog({ line, amount })}
            />
          ))}
        </div>
      )}

      <CollectPaymentDialog
        open={lineDialog !== null}
        onOpenChange={(o) => {
          if (!o) setLineDialog(null);
        }}
        title={`Collect ${lineDialog?.line.label ?? ""}`}
        due={lineDialog?.line.amount ?? 0}
        initialAmount={lineDialog?.amount}
        onConfirm={async (entries) => {
          if (lineDialog) await collectLineEntries(lineDialog.line, entries);
          setLineDialog(null);
        }}
      />

      <CollectPaymentDialog
        open={settleAllOpen}
        onOpenChange={setSettleAllOpen}
        title="Settle all"
        description={`${money(data.dues.total)} across every open booking, bill and running tab. Settling needs the whole amount — split it between cash and online if needed.`}
        due={data.dues.total}
        requireFull
        onConfirm={(entries) => settleAll(entries)}
      />

      <CustomerTabCard
        name={name ?? ""}
        phone={phone}
        autoDue={data.dues.bookings + data.dues.bills}
      />

      {phone && (
        <div className="flex gap-2">
          <Button variant="outline" className="h-12 flex-1" asChild>
            <a href={`tel:${phone}`}>
              <Phone className="mr-1 size-4" /> Call
            </a>
          </Button>
          <Button className="h-12 flex-1" asChild>
            <a
              href={whatsappUrl(
                data.dues.total > 0
                  ? `Hi ${name}, your pending balance is ${money(data.dues.total)}. Thank you!`
                  : `Hi ${name}, thanks for visiting!`,

                phone,
              )}
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircle className="mr-1 size-4" /> WhatsApp
            </a>
          </Button>
        </div>
      )}

      <Section title="Bills">
        {data.myBills.length === 0 ? (
          <Empty />
        ) : (
          data.myBills
            .slice(0, 20)
            .map((b) => (
              <Row
                key={b.id}
                left={`${b.invoice_no} · ${formatDMY(b.bill_date)}`}
                right={money(billGrossTotal(b))}
                note={
                  billDue(b, myEntries) > 0
                    ? `Paid ${money(b.status === "paid" ? billGrossTotal(b) : b.amount_paid)} · Due ${money(billDue(b, myEntries))}`
                    : billMovedToDues(b, myEntries)
                      ? `On tab · ${dueNoForRef(myEntries, TAB_REF_BILL, b.id, b.invoice_no, b.bill_date)}`
                      : b.status
                }
              />
            ))
        )}
      </Section>

      <Section title="Turf bookings">
        {data.myBookings.length === 0 ? (
          <Empty />
        ) : (
          data.myBookings.slice(0, 20).map((b) => {
            const due = bookingDue(b, myEntries);
            return (
              <Row
                key={b.id}
                left={`${b.booking_no} · ${formatDMY(b.booking_date)}${
                  b.start_time ? ` · ${b.start_time}` : ""
                }`}
                right={money(b.total_amount)}
                note={
                  b.merged_into_bill_id
                    ? "Merged into bill"
                    : due > 0
                      ? // Real cash taken, never `advance_paid` at face
                        // value — a balance moved to dues inflates that.
                        `Paid ${money(bookingCashCollected(b, myEntries))} · Due ${money(due)}`
                      : b.status
                }
              />
            );
          })
        )}
      </Section>

      <Section title="Snack orders">
        {data.mySales.length === 0 ? (
          <Empty />
        ) : (
          data.mySales
            .slice(0, 20)
            .map((s) => (
              <Row
                key={s.id}
                left={`${s.bill_no} · ${formatDMY(s.sale_date)}`}
                right={money(s.total)}
                note={saleStateLabel(s) ?? s.payment_mode}
              />
            ))
        )}
      </Section>
    </div>
  );
}

/**
 * Modal wrapper around `CustomerDetailContent` — used on narrow windows
 * (below the two-pane breakpoint) where there's no room for a persistent
 * detail column, so tapping a customer instead pops this dialog open, same
 * as it always has. The visible name/phone heading lives inside
 * `CustomerDetailContent` itself now (so the desktop pane gets it too);
 * the header here exists only for the dialog's own accessible
 * title/description and is visually hidden to avoid showing the name twice.
 */
export function CustomerDetailDialog({ name, phone, onOpenChange }: Props) {
  return (
    <Dialog open={!!name} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>{name ?? "Customer details"}</DialogTitle>
          <DialogDescription>{phone || "No phone saved"}</DialogDescription>
        </DialogHeader>
        {name && <CustomerDetailContent name={name} phone={phone} />}
      </DialogContent>
    </Dialog>
  );
}

function Metric({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="frost-well rounded-xl border p-3">
      <p className="micro-label truncate">{label}</p>
      <p
        className={
          danger
            ? "stat-value truncate text-sm text-destructive"
            : "stat-value truncate text-sm text-primary"
        }
      >
        {value}
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="micro-label">{title}</p>
      <div className="frost-soft space-y-1 rounded-xl border p-2">
        {children}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <p className="px-1 py-2 text-xs text-muted-foreground">Nothing yet.</p>
  );
}

function Row({
  left,
  right,
  note,
}: {
  left: string;
  right: string;
  note?: string;
}) {
  return (
    <div className="lift grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1.5 py-1 text-sm sm:flex sm:justify-between">
      <span className="min-w-0 break-words">
        {left}
        {note && <span className="text-muted-foreground"> · {note}</span>}
      </span>
      <span className="stat-value shrink-0 text-sm">{right}</span>
    </div>
  );
}
