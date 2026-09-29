/**
 * `document.querySelector`, but skipping matches inside a hidden tab.
 *
 * Visited tabs stay mounted (wrapped in a `hidden` element) so their state
 * survives a tab switch. A plain querySelector would therefore find the
 * first `data-shortcut` control in DOM order — which can belong to a tab
 * the person isn't looking at (Ctrl+Enter would "click" a hidden Save
 * button; "/" would focus a hidden search box).
 */
export function queryVisible<T extends HTMLElement = HTMLElement>(
  selector: string,
): T | null {
  for (const el of document.querySelectorAll<T>(selector)) {
    if (!el.closest("[hidden]")) return el;
  }
  return null;
}
