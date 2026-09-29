import { useMemo } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useArrangeMode } from "@/lib/arrange-mode-context";
import { toast } from "sonner";
import {
  applyPreset,
  orderedSections,
  usePresets,
  useLayoutPrefs,
} from "@/lib/layout-prefs";
import { SettingsActions } from "./SettingsField";

/**
 * Settings → Layout & arrangement.
 *
 * A short summary of the current arrangement plus the button that switches on
 * arrange mode: the app itself becomes the editor, so this leaves Settings and
 * drops you on the Home tab with every block framed.
 */
export function LayoutSettingsCard() {
  const { layout } = useLayoutPrefs();
  const { presets, appliedId } = usePresets();
  const { setOn } = useArrangeMode();

  const applied = presets.find((p) => p.id === appliedId) ?? null;
  const { visibleTabs, totalSections, visibleSections } = useMemo(() => {
    const allSections = layout.tabs.flatMap((t) =>
      orderedSections(layout, t.tabId),
    );
    return {
      visibleTabs: layout.tabs.filter((t) => t.visible).length,
      totalSections: allSections.length,
      visibleSections: allSections.filter((s) => s.visible).length,
    };
  }, [layout]);

  const start = () => {
    setOn(true);
    window.dispatchEvent(new CustomEvent("arrange:start"));
  };

  return (
    <>
      {presets.length > 0 && (
        <div className="frost rounded-xl border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            Layout presets - swipe sideways, tap one to switch
          </p>
          <div
            className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1"
            style={{ scrollbarWidth: "none" }}
          >
            {presets.map((p) => {
              const active = p.id === appliedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    applyPreset(p.id);
                    toast.success(`Layout preset "${p.name}" applied`);
                  }}
                  className={
                    "flex w-36 shrink-0 snap-start flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors " +
                    (active ? "border-primary bg-primary/10" : "hover:bg-muted")
                  }
                >
                  <span className="w-full truncate text-sm font-medium">
                    {p.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {active ? "Applied" : "Tap to apply"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Card className="frost">
        <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {applied ? applied.name : "Custom (unsaved)"}
            </p>
            <p className="text-xs leading-4 text-muted-foreground">
              {visibleTabs} of {layout.tabs.length} tabs · {visibleSections} of{" "}
              {totalSections} sections ·{" "}
              {layout.density === "compact" ? "Compact" : "Comfortable"}
            </p>
          </div>
          <SettingsActions className="sm:shrink-0">
            <Button size="sm" onClick={start}>
              <SlidersHorizontal className="h-3.5 w-3.5" /> Arrange this app
            </Button>
          </SettingsActions>
        </CardContent>
      </Card>
    </>
  );
}
