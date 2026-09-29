import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Gauge, FileDown, Trash2, Play } from "lucide-react";
import { localDateStr } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  LOAD_TEST_MIXES,
  benchmarkPdfDoc,
  clearLoadTestData,
  countLiveBusinessRows,
  countLoadTestRows,
  estimatedRows,
  loadTestYear,
  runLoadTestBenchmark,
  seedLoadTestData,
  type LoadTestBenchmark,
  type LoadTestCounts,
  type LoadTestMix,
  type SeedProgress,
} from "@/lib/loadtest";
import { downloadReportPdf } from "@/lib/report-pdf";

const fmt = (n: number) => n.toLocaleString("en-IN");
const today = () => localDateStr();

function CountLine({ counts }: { counts: LoadTestCounts }) {
  return (
    <div className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
      <p>
        Rows: <strong>{fmt(counts.total)}</strong> · {fmt(counts.customers)}{" "}
        customers · {fmt(counts.bookings)} bookings · {fmt(counts.sales)} sales
        · {fmt(counts.bills)} bills
      </p>
      <p>
        {fmt(counts.payments)} payments · {fmt(counts.expenses)} expenses ·{" "}
        {fmt(counts.receipts)} photos · {fmt(counts.receiptHashes ?? 0)} hashes
      </p>
      <p>
        {fmt(counts.stockHistory)} stock changes · {fmt(counts.tabEntries)} tab
        entries · {fmt(counts.tabs)} tabs
      </p>
      <p>
        {fmt(counts.dayCloses)} day closes · {fmt(counts.dayCloseHistory)}{" "}
        amendments
      </p>
    </div>
  );
}

export function LoadTestCard() {
  const qc = useQueryClient();
  const year = loadTestYear();
  const [mix, setMix] = useState<LoadTestMix>("light");
  const [months, setMonths] = useState<12 | 14>(12);
  const [anchor, setAnchor] = useState(today());
  const [busy, setBusy] = useState<"seed" | "bench" | "pdf" | "remove" | null>(
    null,
  );
  const [progress, setProgress] = useState<SeedProgress | null>(null);
  const [counts, setCounts] = useState<LoadTestCounts | null>(null);
  const [result, setResult] = useState<LoadTestBenchmark | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSeed, setConfirmSeed] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const refreshCounts = () =>
    countLoadTestRows()
      .then(setCounts)
      .catch(() => {});
  useEffect(() => {
    void refreshCounts();
  }, []);
  const seeded = (counts?.total ?? 0) > 0;
  const est = estimatedRows(mix, months);

  const runSeed = async (force = false) => {
    setBusy("seed");
    setProgress({ month: 0, months, rows: 0 });
    try {
      const r = await seedLoadTestData(mix, setProgress, {
        anchor,
        months,
        force,
      });
      await qc.invalidateQueries();
      await refreshCounts();
      setResult(null);
      setConfirmSeed(false);
      toast.success(`Seeded ${fmt(r.total)} rows through ${anchor}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const prepareSeed = async () => {
    const live = await countLiveBusinessRows();
    if (live === 0) {
      void runSeed(false);
      return;
    }
    setLiveCount(live);
    setConfirmSeed(true);
  };
  const runBench = async () => {
    setBusy("bench");
    try {
      const r = await runLoadTestBenchmark({ anchor, months });
      setResult(r);
      toast.success(`Benchmark done in ${fmt(r.totalMs)} ms`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runPdf = async () => {
    if (!result) return;
    setBusy("pdf");
    try {
      await downloadReportPdf(benchmarkPdfDoc(result));
      toast.success("Results PDF created");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runRemove = async () => {
    setBusy("remove");
    try {
      const removed = await clearLoadTestData();
      await qc.invalidateQueries();
      await refreshCounts();
      setResult(null);
      toast.success(`Removed ${fmt(removed.total)} load-test rows`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  return (
    <section className="space-y-3">
      <Card className="frost">
        <CardContent className="space-y-4 p-4">
          <div>
            <p className="font-medium">Load-test laboratory</p>
            <p className="text-sm text-muted-foreground">
              Deterministic seeded data with a selectable 12/14-month window,
              anchor date, benchmark and printable audit summary. Future
              bookings are allowed only in the configured seven-day horizon.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="micro-label">Data mix</Label>
              <Select
                value={mix}
                onValueChange={(v) => setMix(v as LoadTestMix)}
                disabled={!!busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LOAD_TEST_MIXES) as LoadTestMix[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {LOAD_TEST_MIXES[k].label} — ~
                      {fmt(estimatedRows(k, months).total)} rows
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="micro-label">Window</Label>
              <Select
                value={String(months)}
                onValueChange={(v) => setMonths(Number(v) as 12 | 14)}
                disabled={!!busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="12">12 months</SelectItem>
                  <SelectItem value="14">14 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="micro-label">Anchor date</Label>
              <input
                type="date"
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
                disabled={!!busy}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Estimated: {fmt(est.bookings)} bookings · {fmt(est.sales)} sales ·{" "}
            {fmt(est.bills)} bills · {fmt(est.expenses)} expenses.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void prepareSeed()} disabled={!!busy}>
              <Play className="mr-2 h-4 w-4" />
              {busy === "seed"
                ? `Seeding month ${progress?.month ?? 1} of ${progress?.months ?? months}…`
                : seeded
                  ? "Re-seed selected window"
                  : "Seed selected window"}
            </Button>
            <Button
              variant="outline"
              onClick={() => void runBench()}
              disabled={!!busy || !seeded}
            >
              <Gauge className="mr-2 h-4 w-4" />
              {busy === "bench" ? "Benchmarking…" : "Run benchmark"}
            </Button>
            <Button
              variant="outline"
              onClick={() => void runPdf()}
              disabled={!!busy || !result}
            >
              <FileDown className="mr-2 h-4 w-4" />
              {busy === "pdf" ? "Saving…" : "Results PDF"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmRemove(true)}
              disabled={!!busy || !seeded}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Remove load-test data
            </Button>
          </div>
          {busy === "seed" && progress && (
            <div className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${Math.round((progress.month / progress.months) * 100)}%`,
                  }}
                />
              </div>
              <p className="micro-label text-muted-foreground">
                Writing month {progress.month} of {progress.months} —{" "}
                {fmt(progress.rows)} rows so far
              </p>
            </div>
          )}
          {counts && seeded && <CountLine counts={counts} />}
          {result && (
            <div className="frost-soft space-y-1 rounded-xl border p-3 text-sm">
              <p className="font-medium">
                <FlaskConical className="mr-1 inline h-4 w-4" />
                Last run: {fmt(result.rows)} records · {fmt(result.totalMs)} ms
              </p>
              <p className="text-muted-foreground">
                {result.months} months ending {result.anchor} ·{" "}
                {fmt(result.payments)} payments · {fmt(result.receipts)} photos
                ({fmt(result.receiptBytes)} bytes)
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                SHA-256: {result.datasetHash}
              </p>
              <p className="text-muted-foreground">
                Read {fmt(result.readMs)} ms · analytics{" "}
                {fmt(result.analyticsMs)} ms · PDF {fmt(result.pdfMs)} ms
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      <AlertDialog
        open={confirmSeed}
        onOpenChange={(open) => !busy && setConfirmSeed(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Seed load-test data into a live database?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This database already has {fmt(liveCount)} real record(s).
              Load-test rows are tagged and removable, but until you clear them
              they will appear in reports and exports. Your tax settings are not
              changed (F-14). Prefer a separate profile or clear data first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              onClick={(e) => {
                e.preventDefault();
                void runSeed(true);
              }}
            >
              Seed anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmRemove}
        onOpenChange={(open) => !busy && setConfirmRemove(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the load-test data?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the generated customers, bookings, payments, sales,
              bills, expenses, photos, stock history, tabs and day-close rows
              tagged <strong>LT-</strong>. Your own records are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              onClick={(e) => {
                e.preventDefault();
                void runRemove();
              }}
            >
              {busy === "remove" ? "Removing…" : "Yes, remove it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
