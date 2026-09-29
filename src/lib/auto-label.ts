import { useEffect } from "react";

/**
 * Most forms here are written as `<Label>Date</Label><Input … />` with no
 * `htmlFor`/`id` pair, so the field has no accessible name (screen readers
 * announce "edit text") and clicking the label doesn't focus it. Rather than
 * threading an id through ~100 call sites, this links each unassociated
 * label to the control that follows it:
 *
 *  - the next sibling, if it is a control (input, textarea, select, Radix
 *    select trigger, switch, checkbox), or the only control inside it;
 *  - otherwise, for switches/checkboxes/radios written control-first
 *    (`<Switch/><Label>…</Label>`), the previous sibling.
 *
 * Labels that already have `for`, that wrap their control, or whose control
 * is already claimed by another label are left alone.
 */
const CONTROL =
  'input:not([type="hidden"]):not([aria-hidden="true"]),textarea,select:not([aria-hidden="true"]),button[role="combobox"],[role="switch"],[role="checkbox"]';
const TOGGLE =
  '[role="switch"],[role="checkbox"],input[type="checkbox"],input[type="radio"]';

let seq = 0;

function claimed(root: ParentNode, id: string) {
  return root.querySelector(`label[for="${id}"]`) !== null;
}

export function associateLabels(root: ParentNode = document): void {
  for (const label of root.querySelectorAll<HTMLLabelElement>(
    "label:not([for])",
  )) {
    if (label.querySelector(CONTROL)) continue; // wraps its control already

    let target: Element | null = null;
    const next = label.nextElementSibling;
    if (next) {
      if (next.matches(CONTROL)) target = next;
      else {
        const inside = next.querySelectorAll(CONTROL);
        if (inside.length === 1) target = inside[0]!;
      }
    }
    if (!target) {
      const prev = label.previousElementSibling;
      if (prev?.matches(TOGGLE)) target = prev;
    }
    if (!target) continue;

    if (target.id && claimed(root, target.id)) continue;
    if (!target.id) target.id = `auto-field-${++seq}`;
    label.htmlFor = target.id;
  }
}

/** Keeps labels linked as tabs/dialogs mount (one rAF-throttled pass). */
export function useAutoLabelAssociation(): void {
  useEffect(() => {
    let raf = 0;
    const run = () => {
      raf = 0;
      associateLabels();
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(run);
    };
    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);
}
