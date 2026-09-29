import { useState } from "react";
import { Banknote, Smartphone, IndianRupee, Split } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, type Bill } from "@/lib/biz";
import { useCollectBillPayment } from "@/lib/collect";
import { billDue } from "@/lib/dues";
import { cleanAmountInput, rupees } from "@/lib/money";
import type { PaymentEntry } from "@/lib/payments";
import { useTabEntries } from "@/lib/tabs";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { CollectPaymentDialog } from "./CollectPaymentDialog";

/**
 * One-tap payment shortcuts and partial payment entry for a single bill.
 * Every collection is recorded as real payment rows (lib/collect.ts), so a
 * bill can be paid part cash / part UPI and the cash drawer and the
 * Cash/Online split see exactly which part arrived in which mode.
 *
 * Used for merged bills too — collecting further money against a bill that
 * already carries over other records' merged-in payments works exactly the
 * same way (recordPayment just appends more rows), so there is no reason to
 * restrict a merged bill to cash-only the way this row used to.
 */
export function QuickPayRow({ bill }: { bill: Bill }) {
  const collect = useCollectBillPayment();
  const [part, setPart] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ amount: number } | null>(null);
  // One-tap full payments write real money movement, so they ask first.
  const [confirmFull, setConfirmFull] = useState<null | "Cash" | "UPI">(null);
  const { data: tabEntries = [] } = useTabEntries();
  // What this bill still owes ON ITS OWN: anything already pushed onto the
  // customer's running tab (or a bill saved "On tab") belongs to the tab
  // ledger, so collecting it here too would take the same rupee twice.
  const due = billDue(bill, tabEntries);

  const record = async (entries: PaymentEntry[]) => {
    const total = entries.reduce((s, e) => s + e.amount, 0);
    await collect.mutateAsync({ bill, tabEntries, entries });
    const modes = [...new Set(entries.map((e) => e.mode))].join(" + ");
    toast.success(
      total >= due
        ? `Paid via ${modes}`
        : `Recorded ${money(total)} via ${modes} · Due ${money(Math.max(0, due - total))}`,
    );
  };

  const payFull = async (mode: "Cash" | "UPI") => {
    if (busy) return;
    setBusy(true);
    try {
      await record([{ amount: due, mode }]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record payment");
    } finally {
      setBusy(false);
    }
  };

  const payPart = async () => {
    if (busy) return;
    // Whole rupee — matches every other payable amount in the app (see
    // money.ts); the field is free-text, so a typed "50.5" would otherwise
    // save a fractional amount.
    const amt = rupees(Number(part));
    if (!amt || amt <= 0) {
      toast.error("Enter an amount");
      return;
    }
    const applied = Math.min(amt, due);
    // Ask how it was paid — cash, online, or a mix.
    setDialog({ amount: applied });
  };

  return (
    <div className="space-y-2">
      {due > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="lift h-12"
            disabled={busy}
            onClick={() => setConfirmFull("Cash")}
          >
            <Banknote className="size-4" /> Paid · Cash
          </Button>
          <Button
            className="lift h-12"
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirmFull("UPI")}
          >
            <Smartphone className="size-4" /> Paid · UPI
          </Button>
        </div>
      )}
      {due > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center text-primary"
          disabled={busy}
          onClick={() => setDialog({ amount: due })}
        >
          <Split className="size-4" /> Split cash + online
        </Button>
      )}
      {due > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IndianRupee className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-12 pl-9"
              type="text"
              inputMode="decimal"
              placeholder={`Part payment (due ${due})`}
              value={part}
              onChange={(e) => setPart(cleanAmountInput(e.target.value))}
            />
          </div>
          <Button
            variant="outline"
            className="h-12"
            disabled={busy}
            onClick={payPart}
          >
            Record
          </Button>
        </div>
      )}
      <AlertDialog
        open={confirmFull !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmFull(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payment</AlertDialogTitle>
            <AlertDialogDescription>
              Record {money(due)} for {bill.invoice_no} as paid in {confirmFull}
              ? This writes payment rows and updates reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const m = confirmFull;
                setConfirmFull(null);
                if (m) void payFull(m);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CollectPaymentDialog
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        title={`Collect for ${bill.invoice_no}`}
        due={due}
        initialAmount={dialog?.amount ?? due}
        onConfirm={async (entries) => {
          await record(entries);
          setPart("");
        }}
      />
    </div>
  );
}
