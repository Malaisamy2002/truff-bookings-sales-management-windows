import { describe, expect, it } from "vitest";

import {
  allocateAcrossDues,
  draftAmounts,
  planSplit,
  restOf,
  singleModeDraft,
  type SplitDraft,
} from "./split-payment";

const draft = (over: Partial<SplitDraft> = {}): SplitDraft => ({
  cash: "",
  online: "",
  onlineMode: "UPI",
  ...over,
});

describe("planSplit", () => {
  it("splits ₹1000 into ₹500 cash + ₹500 UPI", () => {
    const plan = planSplit(1000, draft({ cash: "500", online: "500" }));
    expect(plan).toEqual({
      ok: true,
      entries: [
        { amount: 500, mode: "Cash" },
        { amount: 500, mode: "UPI" },
      ],
      total: 1000,
      remaining: 0,
    });
  });

  it("uses the chosen online mode and writes no row for an empty part", () => {
    const plan = planSplit(800, draft({ online: "300", onlineMode: "Card" }));
    expect(plan).toMatchObject({
      ok: true,
      entries: [{ amount: 300, mode: "Card" }],
      remaining: 500,
    });
  });

  it("allows a part payment and reports what is still owed", () => {
    const plan = planSplit(1000, draft({ cash: "200" }));
    expect(plan).toMatchObject({ ok: true, total: 200, remaining: 800 });
  });

  it("refuses to collect more than is owed", () => {
    const plan = planSplit(1000, draft({ cash: "700", online: "400" }));
    expect(plan.ok).toBe(false);
    if (!plan.ok)
      expect(plan.error).toContain("₹100 more than the ₹1,000 owed");
  });

  it("refuses an empty collection", () => {
    const plan = planSplit(1000, draft());
    expect(plan).toMatchObject({ ok: false, error: "Enter an amount" });
  });

  it("works in whole rupees only", () => {
    expect(draftAmounts(draft({ cash: "50.4", online: "49.6" }))).toEqual({
      cash: 50,
      online: 50,
    });
  });
});

describe("split helpers", () => {
  it("singleModeDraft puts everything in one mode", () => {
    expect(singleModeDraft(750, "Cash")).toEqual({
      cash: "750",
      online: "",
      onlineMode: "UPI",
    });
    expect(singleModeDraft(750, "Card")).toEqual({
      cash: "",
      online: "750",
      onlineMode: "Card",
    });
  });

  it("restOf fills the other box with what is left", () => {
    expect(restOf(1000, "300")).toBe("700");
    expect(restOf(1000, "1000")).toBe("");
    expect(restOf(1000, "1500")).toBe("");
    expect(restOf(1000, "")).toBe("1000");
  });
});

describe("allocateAcrossDues", () => {
  it("drains cash across dues in order, rest online", () => {
    expect(allocateAcrossDues([300, 500, 200], 600, "UPI")).toEqual([
      [{ amount: 300, mode: "Cash" }],
      [
        { amount: 300, mode: "Cash" },
        { amount: 200, mode: "UPI" },
      ],
      [{ amount: 200, mode: "UPI" }],
    ]);
  });

  it("every entry sums back to the due, and every Cash entry sums to cash", () => {
    const dues = [173, 41, 900, 0, 286];
    const cash = 500;
    const result = allocateAcrossDues(dues, cash, "UPI");
    result.forEach((entries, i) => {
      const total = entries.reduce((s, e) => s + e.amount, 0);
      expect(total).toBe(dues[i]);
    });
    const cashTotal = result
      .flat()
      .filter((e) => e.mode === "Cash")
      .reduce((s, e) => s + e.amount, 0);
    expect(cashTotal).toBe(cash);
  });

  it("all cash covers everything, no online entries", () => {
    expect(allocateAcrossDues([100, 200], 300, "Card")).toEqual([
      [{ amount: 100, mode: "Cash" }],
      [{ amount: 200, mode: "Cash" }],
    ]);
  });

  it("zero cash puts everything online", () => {
    expect(allocateAcrossDues([100, 200], 0, "UPI")).toEqual([
      [{ amount: 100, mode: "UPI" }],
      [{ amount: 200, mode: "UPI" }],
    ]);
  });

  it("a zero or negative due contributes no entries", () => {
    expect(allocateAcrossDues([0, -5, 100], 100, "UPI")).toEqual([
      [],
      [],
      [{ amount: 100, mode: "Cash" }],
    ]);
  });
});
