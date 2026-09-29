import { describe, expect, it } from "vitest";
import { addCartLine, setCartLineQty, splitComboPrice } from "./cart";
import { rupees } from "./money";

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

describe("setCartLineQty()", () => {
  it("does not merge a combo component with a plain line at the same displayed price", () => {
    const plain = {
      item_name: "A",
      qty: 1,
      unit_price: 8,
      cost_price: 3,
      amount: 8,
    };
    const combo = { ...plain, amount: 7, combo_id: "combo-7" };
    expect(addCartLine([plain], combo)).toEqual([plain, combo]);
  });

  it("does not re-multiply a combo share by its rounded display unit price", () => {
    const cart = [
      {
        item_name: "Combo item",
        qty: 2,
        unit_price: 8,
        cost_price: 3,
        amount: 15,
        combo_id: "combo-15",
      },
    ];
    expect(setCartLineQty(cart, 0, 3)).toEqual(cart);
  });

  it("removes only the selected combo instance when duplicate combo ids are grouped separately", () => {
    const cart = [
      {
        item_name: "A",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 7,
        combo_id: "combo-1",
      },
      {
        item_name: "B",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 8,
        combo_id: "combo-1",
      },
      {
        item_name: "A",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 7,
        combo_id: "combo-2",
      },
      {
        item_name: "B",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 8,
        combo_id: "combo-2",
      },
    ];
    expect(setCartLineQty(cart, 0, 0)).toEqual([cart[2], cart[3]]);
  });

  it("removes an entire combo group when its row is removed", () => {
    const cart = [
      {
        item_name: "A",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 7,
        combo_id: "combo-7",
      },
      {
        item_name: "B",
        qty: 1,
        unit_price: 5,
        cost_price: 2,
        amount: 0,
        combo_id: "combo-7",
      },
      {
        item_name: "Plain",
        qty: 1,
        unit_price: 10,
        cost_price: 4,
        amount: 10,
      },
    ];
    expect(setCartLineQty(cart, 0, 0)).toEqual([cart[2]]);
  });
});

describe("splitComboPrice()", () => {
  it("never goes negative: Rs 3 combo over 6 equal items (audit C3 repro)", () => {
    const lines = Array.from({ length: 6 }, () => ({ qty: 1, unit_price: 10 }));
    const out = splitComboPrice(lines, 3);
    expect(out.every((v) => v >= 0)).toBe(true);
    expect(sum(out)).toBe(3);
  });

  it("splits proportionally to list value and adds to the combo price", () => {
    const out = splitComboPrice(
      [
        { qty: 1, unit_price: 100 },
        { qty: 2, unit_price: 50 },
      ],
      150,
    );
    expect(out).toEqual([75, 75]);
  });

  it("handles a fractional combo price by rounding it once", () => {
    const out = splitComboPrice(
      [
        { qty: 1, unit_price: 10 },
        { qty: 1, unit_price: 10 },
      ],
      99.5,
    );
    expect(sum(out)).toBe(100);
    expect(out.every((v) => Number.isInteger(v))).toBe(true);
  });

  it("splits evenly when every component is free", () => {
    const out = splitComboPrice(
      [
        { qty: 1, unit_price: 0 },
        { qty: 1, unit_price: 0 },
        { qty: 1, unit_price: 0 },
      ],
      10,
    );
    expect(sum(out)).toBe(10);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThanOrEqual(1);
  });

  it("returns [] for no lines and all-zero for a zero / negative price", () => {
    expect(splitComboPrice([], 50)).toEqual([]);
    expect(splitComboPrice([{ qty: 1, unit_price: 5 }], 0)).toEqual([0]);
    expect(splitComboPrice([{ qty: 1, unit_price: 5 }], -20)).toEqual([0]);
  });

  it("invariant over 5000 seeded random combos: sum exact, none negative, each within 1 of raw share", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let t = 0; t < 5000; t++) {
      const n = 1 + Math.floor(rnd() * 12);
      const lines = Array.from({ length: n }, () => ({
        qty: 1 + Math.floor(rnd() * 4),
        unit_price: Math.floor(rnd() * 200),
      }));
      const price = Math.floor(rnd() * 400);
      const out = splitComboPrice(lines, price);
      const list = lines.map((l) => l.qty * l.unit_price);
      const lt = sum(list);
      expect(sum(out)).toBe(price);
      out.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(0);
        const raw = lt > 0 ? (list[i]! * price) / lt : price / n;
        expect(Math.abs(v - raw)).toBeLessThan(1 + 1e-9);
      });
    }
  });
});

describe("addCartLine()", () => {
  const plain = (name: string, qty: number, unit_price: number) => ({
    item_name: name,
    qty,
    unit_price,
    cost_price: 0,
    amount: qty * unit_price,
  });

  it("merges a repeated plain item into one row with the summed amount", () => {
    const cart = addCartLine(
      addCartLine([], plain("Tea", 2, 10)),
      plain("Tea", 3, 10),
    );
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ qty: 5, amount: 50 });
  });

  it("keeps same item at a different unit price as a separate row", () => {
    const cart = addCartLine(
      addCartLine([], plain("Tea", 1, 10)),
      plain("Tea", 1, 8),
    );
    expect(cart).toHaveLength(2);
  });

  it("tapping the same combo twice charges exactly twice the combo price (audit C6 repro)", () => {
    // Rs 25 combo = Tea x1 (Rs 10) + Biscuit x2 (Rs 8): Biscuit share is Rs 15
    // for 2 units, whose display unit price rounds to Rs 8.
    const comps = [
      { item_name: "Tea", qty: 1, unit_price: 10 },
      { item_name: "Biscuit", qty: 2, unit_price: 8 },
    ];
    const tap = (cart: ReturnType<typeof addCartLine>) => {
      const shares = splitComboPrice(comps, 25);
      return comps.reduce(
        (acc, c, i) =>
          addCartLine(acc, {
            item_name: c.item_name,
            qty: c.qty,
            unit_price: rupees(shares[i]! / c.qty),
            cost_price: 0,
            amount: shares[i]!,
          }),
        cart,
      );
    };
    const total = (cart: ReturnType<typeof addCartLine>) =>
      cart.reduce((s, r) => s + r.amount, 0);
    const once = tap([]);
    expect(total(once)).toBe(25);
    expect(total(tap(once))).toBe(50);
    expect(total(tap(tap(once)))).toBe(75);
  });
});
