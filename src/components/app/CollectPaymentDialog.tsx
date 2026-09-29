import { useEffect, useState } from "react";
import { toast } from "sonner";

import { QrCode } from "lucide-react";

import { usePrintSettings } from "@/lib/print";
import { UpiPayDialog } from "./UpiPayDialog";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/lib/money";
import type { PaymentEntry, ReceivedPaymentMode } from "@/lib/payments";
import {
  planSplit,
  singleModeDraft,
  type SplitDraft,
} from "@/lib/split-payment";

import { SplitPaymentFields } from "./SplitPaymentFields";

/**
 * "Collect payment" with the cash/online split. Opens pre-filled with the
 * whole amount in one mode (so the usual one-mode payment is two taps) and
 * lets the person divide it — ₹500 cash + ₹500 UPI — or take only part.
 * `onConfirm` receives ready-to-record entries; the caller records them
 * through lib/collect.ts.
 */
export function CollectPaymentDialog({
  open,
  onOpenChange,
  title = "Collect payment",
  description,
  due,
  initialAmount,
  defaultMode = "Cash",
  requireFull = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string | undefined;
  description?: string | undefined;
  /** What this record still owes on its own — the most that can be taken. */
  due: number;
  /** Starting amount (defaults to the whole due). */
  initialAmount?: number | undefined;
  defaultMode?: ReceivedPaymentMode | undefined;
  /** When true, the two boxes must add up to the WHOLE due — used for an
   * action (e.g. "Settle all") whose whole point is closing out every last
   * rupee, where a smaller amount silently confirming would leave some of
   * it settled and some not despite the button saying "all". A plain
   * partial collection (the default) allows any amount up to the due. */
  requireFull?: boolean | undefined;
  onConfirm: (entries: PaymentEntry[]) => Promise<unknown> | unknown;
}) {
  const start = () =>
    singleModeDraft(
      initialAmount ?? due,
      defaultMode === "Card" ? "Card" : defaultMode,
    );
  const [draft, setDraft] = useState<SplitDraft>(start);
  const [busy, setBusy] = useState(false);

  const { settings } = usePrintSettings();
  const upiId = settings.upiId.trim();
  const [qrPay, setQrPay] = useState(false);

  // A fresh draft every time the dialog opens.
  useEffect(() => {
    if (open) setDraft(start());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, due, initialAmount, defaultMode]);

  const plan = planSplit(due, draft);
  const ready = plan.ok && (!requireFull || plan.remaining <= 0);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onConfirm(plan.entries);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record payment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              (requireFull
                ? `${money(due)} owed — settling needs the whole amount. Split it between cash and online if needed.`
                : `${money(due)} owed. Split it between cash and online if needed.`)}
          </DialogDescription>
        </DialogHeader>
        <SplitPaymentFields
          due={due}
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !upiId}
            title={upiId ? undefined : "Set your UPI ID in Settings"}
            onClick={() => setQrPay(true)}
          >
            <QrCode className="mr-1 size-4" /> Paid via QR
          </Button>
          <Button type="button" disabled={!ready || busy} onClick={submit}>
            {plan.ok ? `Collect ${money(plan.total)}` : "Collect"}
          </Button>
        </DialogFooter>
        {qrPay && (
          <UpiPayDialog
            open={qrPay}
            onOpenChange={setQrPay}
            upiId={upiId}
            payeeName={settings.upiPayeeName?.trim() || settings.shopName}
            note={title}
            amount={Number(draft.online) > 0 ? Number(draft.online) : due}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
