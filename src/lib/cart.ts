import { allocateWhole, rupees } from "./money";
import type { SnackSaleItem } from "./ops";

/**
 * Cart-line logic for the snack bill builder — kept separate from the
 * component so "how a repeat item behaves" is one small, testable place.
 */

/**
 * Adds a line to the cart. If the same item at the same unit price is
 * already in the cart, the quantities are merged into that one row instead
 * of adding a duplicate — so buying 2 now and 3 more a bit later shows up as
 * a single row with qty 5, not two rows.
 *
 * Rows are only merged when the unit price also matches: combo lines are
 * deliberately priced differently from a plain add, so two "same item, two
 * different prices" rows stay separate and each keeps its own correct total.
 */
export function addCartLine(
  cart: SnackSaleItem[],
  line: SnackSaleItem,
): SnackSaleItem[] {
  const idx = cart.findIndex(
    (row) =>
      row.item_name === line.item_name &&
      row.unit_price === line.unit_price &&
      row.combo_id === line.combo_id,
  );
  if (idx === -1) return [...cart, line];

  const next = [...cart];
  const existing = next[idx]!;
  const qty = existing.qty + line.qty;
  // Amounts add; they are NOT recomputed as qty x unit_price. A combo line's
  // `amount` is a whole-rupee share of the combo price while its `unit_price`
  // is only that share / qty rounded for display (Rs 15 over 2 units -> 8),
  // so re-deriving the amount here charged Rs 16 for a second Rs 15 tap of
  // the same combo (audit C6). For a plain line the two are identical.
  next[idx] = { ...existing, qty, amount: existing.amount + line.amount };
  return next;
}

/**
 * Updates a plain cart row's quantity in place. Combo rows are fixed-price
 * groups: their component shares use a rounded display unit_price, so
 * multiplying that value would corrupt the combo total. A combo can instead
 * be removed as a whole and re-added at its fixed price.
 */
export function setCartLineQty(
  cart: SnackSaleItem[],
  index: number,
  qty: number,
): SnackSaleItem[] {
  const row = cart[index];
  if (!row) return cart;
  if (qty <= 0) {
    return row.combo_id
      ? cart.filter((r) => r.combo_id !== row.combo_id)
      : cart.filter((_, i) => i !== index);
  }
  if (row.combo_id) return cart;
  return cart.map((r, i) =>
    i === index ? { ...r, qty, amount: qty * r.unit_price } : r,
  );
}

/**
 * Splits a combo's price across its component lines as whole rupees that add
 * back to the (whole-rupee) combo price exactly, with no share ever negative.
 *
 * Each line's raw share is proportional to its list value (qty x unit price).
 * Uses the largest-remainder `allocateWhole()` rather than rounding each
 * share on its own and dumping the leftover on the last line: with many
 * near-equal components the independent roundings can overshoot the combo
 * price and leave the last line negative (e.g. Rs 3 over 6 equal items).
 */
export function splitComboPrice(
  lines: { qty: number; unit_price: number }[],
  comboPrice: number,
): number[] {
  const total = Math.max(0, rupees(comboPrice));
  const list = lines.map((l) => l.qty * l.unit_price);
  const listTotal = list.reduce((s, v) => s + v, 0);
  // Free / zero-priced components: fall back to an even split so the combo
  // price is still fully distributed.
  const weights = listTotal > 0 ? list : list.map(() => 1);
  const weightTotal = weights.reduce((s, v) => s + v, 0);
  return allocateWhole(
    weights.map((w) => (w * total) / weightTotal),
    total,
  );
}
