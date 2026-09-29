import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { monthLabel } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "YYYY-MM" month picker that reads "Sept 2026" like everywhere else in the
 * app. It replaces <input type="month">, which shows the raw "2026-09"
 * string wherever the browser has no native month control.
 */
export function MonthPicker({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  /** "YYYY-MM" */
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selYear = Number(value.slice(0, 4));
  const selMonth = Number(value.slice(5, 7)); // 1-12
  const [year, setYear] = useState(selYear);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Reopen on the year that's actually selected.
        if (o) setYear(selYear);
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={`Report month: ${monthLabel(value)}. Change month`}
          className={cn(
            "frost-soft h-12 min-w-40 justify-between gap-3 rounded-xl px-3 font-normal",
            className,
          )}
        >
          <span>{monthLabel(value)}</span>
          <CalendarDays className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Previous year"
            onClick={() => setYear((y) => y - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-semibold tabular-nums">{year}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Next year"
            onClick={() => setYear((y) => y + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {MONTHS.map((m, i) => {
            const active = year === selYear && i + 1 === selMonth;
            return (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                onClick={() => {
                  onChange(`${year}-${String(i + 1).padStart(2, "0")}`);
                  setOpen(false);
                }}
              >
                {m}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
