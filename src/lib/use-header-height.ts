import { useEffect, useRef } from "react";

/**
 * Publishes the sticky header's real rendered height (safe-area padding and
 * border included) as `--app-header-h` on <html>, so anything that sticks
 * directly beneath it (AppStatusStrip) can't drift from a hard-coded offset —
 * a few pixels of mismatch left a slit where scrolled content showed through.
 */
export function useHeaderHeightVar<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--app-header-h",
        `${el.offsetHeight}px`,
      );
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--app-header-h");
    };
  }, []);
  return ref;
}
