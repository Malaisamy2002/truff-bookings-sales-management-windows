import type { LucideIcon } from "lucide-react";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";

/**
 * One collapsible block inside the Settings accordion — a tap-to-expand
 * dropdown per section (Appearance, Pricing, Backup, …) instead of one long
 * scroll. `action` (e.g. a sort menu) renders next to the chevron, outside
 * the trigger's own click target, so tapping it doesn't also toggle the
 * section open/closed.
 */
export function SettingsSection({
  value,
  eyebrow,
  title,
  hint,
  icon: Icon,
  action,
  children,
  className,
}: {
  /** Unique key for this section — also what's saved to remember which
   * sections were left open across a refresh. */
  value: string;
  eyebrow?: string;
  title: string;
  hint?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <AccordionItem
      value={value}
      // Lets the first-run checklist (or anything else) scroll straight to
      // this card via document.getElementById — see FirstRunChecklistCard.
      id={`settings-section-${value}`}
      className={cn("frost overflow-hidden rounded-2xl border px-4", className)}
    >
      {/* Mobile: header and action stack in a COLUMN — the title gets the
          full width of its own line (never truncated, never overlapped) and
          the sort controls sit on the line below. (A wrapped flex ROW could
          not be used here: the trigger's flex-1 makes its flex-basis 0, so
          flex-wrap never engaged and the action printed over the title.)
          Desktop (sm+): single row as before. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
        <AccordionTrigger className="py-4 hover:no-underline">
          <span className="flex min-w-0 items-center gap-3">
            {Icon ? (
              <span className="frost-soft grid size-9 shrink-0 place-items-center rounded-xl border">
                <Icon className="size-4 text-primary" />
              </span>
            ) : null}
            <span className="block min-w-0">
              {eyebrow ? (
                <span className="micro-label block truncate">{eyebrow}</span>
              ) : null}
              {/* Full title, never truncated (owner preference). */}
              <span className="page-title block">{title}</span>
              {hint ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {hint}
                </span>
              ) : null}
            </span>
          </span>
        </AccordionTrigger>
        {/* The wrapper below only contains clicks (taps on `action` don't
            reach ancestors); it isn't interactive, so it's marked
            presentational rather than given a fake keyboard handler. */}
        {action ? (
          <div
            className="shrink-0 self-end pb-2 sm:self-auto sm:pb-0"
            role="presentation"
            onClick={(e) => e.stopPropagation()}
          >
            {action}
          </div>
        ) : null}
      </div>
      <AccordionContent className="pt-1">{children}</AccordionContent>
    </AccordionItem>
  );
}
