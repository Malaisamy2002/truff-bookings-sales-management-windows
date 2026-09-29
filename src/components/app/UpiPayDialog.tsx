import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import QRCode from "qrcode";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/money";
import { upiUri } from "@/lib/receipt-upi";

/** Pay-by-UPI with two choices: open your own UPI app (self pay), or show a
 * QR for the customer to scan. The QR carries the amount, and for split
 * cash+online it is the UPI (online) part only. */
export function UpiPayDialog({
  open,
  onOpenChange,
  upiId,
  payeeName,
  note,
  amount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  upiId: string;
  payeeName?: string;
  note?: string;
  amount: number;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const uri = upiUri({ upiId: upiId ?? "", payeeName, note, amount });
  useEffect(() => {
    if (open)
      QRCode.toDataURL(uri, { width: 260, margin: 1 })
        .then(setQr)
        .catch(() => setQr(null));
  }, [open, uri]);
  const selfPay = () => {
    const isAndroid =
      typeof navigator !== "undefined" &&
      /android/i.test(navigator.userAgent) &&
      "__TAURI_INTERNALS__" in window;
    if (isAndroid)
      void openUrl(uri).catch(() => toast.error("Could not open a UPI app"));
    else window.location.href = uri;
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay {money(amount)} by UPI</DialogTitle>
          <DialogDescription>
            Pay yourself, or show this QR for the customer to scan. The payee
            name must match your bank's registered name - otherwise the payer's
            app shows "could not load banking name".
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {qr ? (
            <img src={qr} alt="UPI QR" className="size-52 rounded-md border" />
          ) : (
            <p className="text-sm text-muted-foreground">Building QR...</p>
          )}
          <p className="text-center text-sm text-muted-foreground">
            Scanning pays exactly {money(amount)} - the UPI part only when you
            split cash + online.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={selfPay}>
            Self pay
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
