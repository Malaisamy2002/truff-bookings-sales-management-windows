import { useId, useState } from "react";
import { QrCode } from "lucide-react";

import { usePrintSettings } from "@/lib/print";
import { UpiPayDialog } from "./UpiPayDialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, cleanAmountInput } from "@/lib/money";
import {
  ONLINE_MODES_FOR_SPLIT,
  draftAmounts,
  planSplit,
  restOf,
  type SplitDraft,
} from "@/lib/split-payment";
import { cn } from "@/lib/utils";

/**
 * The shared "how was this paid?" control: a Cash amount and an Online
 * amount (UPI or Card) that together make one collection. Used by every
 * screen that takes money, so a ₹1000 due can be ₹500 cash + ₹500 UPI
 * everywhere and always ends up as separate payment rows (lib/payments.ts).
 *
 * The boxes are NOT auto-balanced (typing 200 cash must not silently turn a
 * part payment into a full one); the small "₹… rest" button fills the other
 * box with what is still owed.
 */
export function SplitPaymentFields({
  due,
  value,
  onChange,
  disabled = false,
}: {
  /** What this record still owes on its own. */
  due: number;
  value: SplitDraft;
  onChange: (next: SplitDraft) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const plan = planSplit(due, value);
  const { settings } = usePrintSettings();
  const upiId = settings.upiId.trim();
  const [qr, setQr] = useState<number | null>(null);
  const { cash, online } = draftAmounts(value);
  const anyTyped = cash > 0 || online > 0;

  const restForCash = restOf(due, String(online));
  const restForOnline = restOf(due, String(cash));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${uid}-cash`}>Cash</Label>
            {online > 0 && restForCash && restForCash !== String(cash) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-primary"
                disabled={disabled}
                onClick={() => onChange({ ...value, cash: restForCash })}
              >
                ₹{restForCash} rest
              </Button>
            )}
          </div>
          <Input
            id={`${uid}-cash`}
            type="text"
            inputMode="decimal"
            placeholder="0"
            disabled={disabled}
            value={value.cash}
            onChange={(e) =>
              onChange({ ...value, cash: cleanAmountInput(e.target.value) })
            }
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${uid}-online`}>{value.onlineMode}</Label>
            {value.onlineMode === "UPI" && online > 0 && upiId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs"
                aria-label="Show QR for the online part"
                onClick={() => setQr(online)}
              >
                <QrCode className="size-3.5" />
              </Button>
            )}
            {cash > 0 && restForOnline && restForOnline !== String(online) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-primary"
                disabled={disabled}
                onClick={() => onChange({ ...value, online: restForOnline })}
              >
                ₹{restForOnline} rest
              </Button>
            )}
          </div>
          <Input
            id={`${uid}-online`}
            type="text"
            inputMode="decimal"
            placeholder="0"
            disabled={disabled}
            value={value.online}
            onChange={(e) =>
              onChange({ ...value, online: cleanAmountInput(e.target.value) })
            }
          />
        </div>
      </div>

      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        role="group"
        aria-label="Online payment type"
      >
        <span>Online paid by</span>
        {ONLINE_MODES_FOR_SPLIT.map((m) => (
          <Button
            key={m}
            type="button"
            size="sm"
            variant={value.onlineMode === m ? "default" : "outline"}
            className={cn("h-7 px-3 text-xs")}
            aria-pressed={value.onlineMode === m}
            disabled={disabled}
            onClick={() => onChange({ ...value, onlineMode: m })}
          >
            {m}
          </Button>
        ))}
      </div>

      <p
        className={cn(
          "text-sm",
          !plan.ok && anyTyped ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {!anyTyped
          ? `${money(due)} owed`
          : plan.ok
            ? `Collecting ${money(plan.total)} · ${
                plan.remaining > 0
                  ? `${money(plan.remaining)} still owed`
                  : "settles it"
              }`
            : plan.error}
      </p>
      {qr !== null && (
        <UpiPayDialog
          open
          onOpenChange={(o) => {
            if (!o) setQr(null);
          }}
          upiId={upiId}
          payeeName={settings.upiPayeeName?.trim() || settings.shopName}
          note="Split payment (online part)"
          amount={qr}
        />
      )}
    </div>
  );
}
