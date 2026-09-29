import { Fragment, useMemo } from "react";
import { Flame } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading } from "@/components/app/SectionHeading";
import { cn, localDateStr } from "@/lib/utils";
import { DAY_PARTS, parseMinutes } from "@/lib/time-slot-utils";
import type { TurfBooking } from "@/lib/ops";
import { courtHourSegments, utilisationPct } from "@/lib/courts";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first weekday index, matching TimeSlotPicker's week strip. */
const weekdayOf = (dateStr: string) => {
  const d = new Date(`${dateStr}T00:00:00`);
  return (d.getDay() + 6) % 7;
};

const LOOKBACK_DAYS = 84; // 12 weeks — enough to smooth out one-off busy days

type Props = {
  bookings: TurfBooking[];
  /** Venue court count — lets each cell also show % of capacity. */
  totalCourts?: number;
};

/**
 * Hour × weekday isn't legible as 24 separate columns on a phone, so hours
 * are grouped into the same day-part buckets already used by the booking
 * picker (Late Night / Morning / Afternoon / Evening / Night) — same
 * vocabulary the owner already sees when creating a booking.
 */
const SHORT_PART_LABEL: Record<(typeof DAY_PARTS)[number]["id"], string> = {
  latenight: "Late",
  morning: "Morn",
  afternoon: "Aft",
  evening: "Eve",
  night: "Night",
};

export function TurfUtilizationCard({ bookings, totalCourts = 1 }: Props) {
  const { grid, maxAvg, insight, hasData } = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    // Local calendar day — toISOString() is UTC and shifted the window start
    // by a day for IST.
    const cutoffKey = localDateStr(cutoff);

    // "Occupied" here means the court was actually in use, not just
    // reserved on the calendar — a Cancelled booking never happened, so it
    // was already excluded. No-show gets the same treatment for the same
    // reason: the customer never arrived, so the court sat empty for that
    // slot even though it was booked. This was flagged as an open question
    // after Step 27 (which excluded No-show from the money side via
    // isFinancialBooking) and is resolved here the same way, for
    // consistency between the two views rather than because one implies
    // the other technically.
    const inWindow = bookings.filter(
      (b) =>
        b.status !== "Cancelled" &&
        b.status !== "No-show" &&
        b.booking_date >= cutoffKey &&
        b.start_time &&
        b.end_time,
    );

    // Booked-hours accumulated per (weekday, day-part) cell.
    const totals = new Map<string, number>();
    for (const b of inWindow) {
      const weekday = weekdayOf(b.booking_date);
      // Shared court math: splits a past-midnight booking across two days.
      const segments = courtHourSegments(b).map((sg) => ({
        weekday: (weekday + sg.dayOffset) % 7,
        from: sg.from,
        to: sg.to,
        courts: sg.n,
      }));

      for (const seg of segments) {
        for (const part of DAY_PARTS) {
          const from = part.from * 60;
          const to = part.to * 60;
          const overlap = Math.min(seg.to, to) - Math.max(seg.from, from);
          if (overlap > 0) {
            const key = `${seg.weekday}-${part.id}`;
            totals.set(
              key,
              (totals.get(key) ?? 0) + (overlap / 60) * seg.courts,
            );
          }
        }
      }
    }

    // How many times each weekday actually occurred in the window, so the
    // grid shows an *average* booked-hours per occurrence rather than a raw
    // sum that would just keep climbing the longer the app has been used.
    const occurrences = new Array(7).fill(0);
    for (let i = 0; i < LOOKBACK_DAYS; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      occurrences[(d.getDay() + 6) % 7]! += 1;
    }

    const grid = WEEKDAY_LABELS.map((label, weekday) =>
      DAY_PARTS.map((part) => {
        const raw = totals.get(`${weekday}-${part.id}`) ?? 0;
        const occ = occurrences[weekday] || 1;
        return { weekday, weekdayLabel: label, part, avgHours: raw / occ };
      }),
    );

    const flat = grid.flat();
    const maxAvg = Math.max(0, ...flat.map((c) => c.avgHours));
    const hasData = flat.some((c) => c.avgHours > 0);

    let insight: string | null = null;
    if (hasData) {
      const best = flat.reduce((a, b) => (b.avgHours > a.avgHours ? b : a));
      const nonZero = flat.filter((c) => c.avgHours > 0);
      const worst = nonZero.reduce(
        (a, b) => (b.avgHours < a.avgHours ? b : a),
        nonZero[0]!,
      );
      if (best.avgHours > 0 && worst.avgHours < best.avgHours) {
        insight = `${best.weekdayLabel} ${best.part.label.toLowerCase()} is your busiest slot, averaging ${best.avgHours.toFixed(1)} booked hours — ${worst.weekdayLabel} ${worst.part.label.toLowerCase()} runs quietest at ${worst.avgHours.toFixed(1)}. Worth a discount there to fill it?`;
      }
    }

    return { grid, maxAvg, insight, hasData };
  }, [bookings]);

  return (
    <Card>
      <CardContent className="space-y-4">
        <SectionHeading
          icon={Flame}
          eyebrow="Insights"
          title="Slot utilisation · 12 weeks"
        />
        {!hasData ? (
          <p className="text-sm text-muted-foreground">
            Not enough timed bookings yet to build a utilisation pattern.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <div className="grid grid-cols-[2rem_repeat(5,minmax(0,1fr))] gap-1 sm:min-w-[420px] sm:grid-cols-[2.5rem_repeat(5,minmax(0,1fr))]">
                <div />
                {DAY_PARTS.map((p) => (
                  <div
                    key={p.id}
                    className="stat-label text-center text-muted-foreground"
                    title={p.label}
                  >
                    {/* 5 columns must fit a 360px phone without a hidden
                        sideways scroll (the Night column used to sit off
                        screen), so short names there, full names from sm. */}
                    <span className="sm:hidden">{SHORT_PART_LABEL[p.id]}</span>
                    <span className="hidden sm:inline">
                      {p.label.split(" ")[0]}
                    </span>
                  </div>
                ))}
                {grid.map((row) => (
                  <Fragment key={`row-${row[0]!.weekday}`}>
                    <div className="flex items-center text-xs font-medium text-muted-foreground">
                      {row[0]!.weekdayLabel}
                    </div>
                    {row.map((cell) => {
                      const intensity = maxAvg > 0 ? cell.avgHours / maxAvg : 0;
                      return (
                        <div
                          key={`${cell.weekday}-${cell.part.id}`}
                          title={`${cell.weekdayLabel} ${cell.part.label}: avg ${cell.avgHours.toFixed(1)} court-hrs · ${utilisationPct(cell.avgHours, cell.part.to - cell.part.from, totalCourts)}% of ${totalCourts} court${totalCourts > 1 ? "s" : ""}`}
                          className={cn(
                            "flex h-9 items-center justify-center rounded-md text-[11px] font-medium tabular-nums",
                            intensity === 0 &&
                              "bg-muted text-muted-foreground/60",
                          )}
                          style={
                            intensity > 0
                              ? {
                                  backgroundColor: `oklch(0.55 0.16 250 / ${(0.12 + intensity * 0.68).toFixed(2)})`,
                                  // Keep the normal text colour: white on this
                                  // 50–80% blue tint never reached 4.5:1 (2.1–3.4).
                                }
                              : undefined
                          }
                        >
                          {cell.avgHours > 0 ? cell.avgHours.toFixed(1) : "–"}
                        </div>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
            {insight && (
              <p className="frost-well mt-3 rounded-lg border p-3 text-xs text-muted-foreground">
                {insight}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
