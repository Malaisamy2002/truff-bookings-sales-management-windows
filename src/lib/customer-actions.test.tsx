// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// React only flushes effects/state inside act() when this flag is set.
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess, warning: toastWarning },
}));

// customer-actions.ts only pulls these two hooks from "./collect" — mocked
// directly rather than through the real Dexie-backed mutationFn, so this
// test controls exactly which of two independent collections fails without
// needing to contrive a real accounting error to trigger it.
const bookingMutateAsync = vi.fn();
const billMutateAsync = vi.fn();
vi.mock("./collect", () => ({
  useCollectBookingPayment: () => ({
    mutateAsync: bookingMutateAsync,
    isPending: false,
  }),
  useCollectBillPayment: () => ({
    mutateAsync: billMutateAsync,
    isPending: false,
  }),
}));

const settleTabMutateAsync = vi.fn();
vi.mock("./tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tabs")>();
  return {
    ...actual,
    useSettleAndCloseTab: () => ({
      mutateAsync: settleTabMutateAsync,
      isPending: false,
    }),
    useTabSummaries: () => new Map(),
  };
});

const printReceipt = vi.fn();
vi.mock("./receipt", () => ({
  paymentReceipt: (x: unknown) => x,
  printReceipt,
}));

const { useSettleCustomer } = await import("./customer-actions");
type BillT = import("./biz").Bill;
type TurfBookingT = import("./ops").TurfBooking;

function billRow(over: Partial<BillT> = {}): BillT {
  return {
    id: "b1",
    invoice_no: "INV-1",
    customer_name: "Ravi",
    customer_phone: "9876543210",
    items: [],
    subtotal: 300,
    discount: 0,
    total: 300,
    amount_paid: 0,
    status: "unpaid",
    payment_mode: null,
    bill_date: "2026-01-05",
    ...over,
  };
}

function bookingRow(over: Partial<TurfBookingT> = {}): TurfBookingT {
  return {
    id: "bk1",
    booking_no: "BK-1",
    booking_date: "2026-01-05",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Court 1",
    hours: 1,
    rate_per_hour: 500,
    total_amount: 500,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Confirmed",
    discount: 0,
    notes: null,
    start_time: "10:00",
    end_time: "11:00",
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 500,
    ...over,
  };
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let hook: ReturnType<typeof useSettleCustomer> | null = null;
  function Probe() {
    hook = useSettleCustomer();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
  });
  return {
    get hook() {
      return hook!;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("useSettleCustomer — partial-failure reporting (audit F99)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports full success and the FULL total when every collection succeeds", async () => {
    bookingMutateAsync.mockResolvedValue(undefined);
    billMutateAsync.mockResolvedValue(undefined);
    const { hook, unmount } = setup();

    await act(async () => {
      await hook.settleAll({
        name: "Ravi",
        phone: "9876543210",
        myBookings: [
          bookingRow({ id: "bk1", total_amount: 500, advance_paid: 0 }),
        ],
        myBills: [
          billRow({ id: "b1", total: 300, amount_paid: 0, status: "unpaid" }),
        ],
        myEntries: [],
        tabBalance: 0,
      });
    });

    expect(toastSuccess).toHaveBeenCalledWith(
      "Settling full balance…",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Print receipt" }),
      }),
    );
    // The success path's receipt action prints the FULL total (₹800), not a
    // reduced amount — call it and check what it was built with. Other
    // per-item "marked paid" toasts fire first, so find the summary one.
    const successCall = toastSuccess.mock.calls.find(
      (c) => c[0] === "Settling full balance…",
    )!;
    const call = successCall[1] as { action: { onClick: () => void } };
    call.action.onClick();
    expect(printReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 800, balanceAfter: 0 }),
      undefined,
      expect.anything(),
    );
    expect(toastWarning).not.toHaveBeenCalled();
    unmount();
  });

  it("reports only the amount that actually settled when one collection fails (F99)", async () => {
    // Booking succeeds (₹500 collected); bill fails outright.
    bookingMutateAsync.mockResolvedValue(undefined);
    billMutateAsync.mockRejectedValue(new Error("boom"));
    const { hook, unmount } = setup();

    await act(async () => {
      await hook.settleAll({
        name: "Ravi",
        phone: "9876543210",
        myBookings: [
          bookingRow({ id: "bk1", total_amount: 500, advance_paid: 0 }),
        ],
        myBills: [
          billRow({ id: "b1", total: 300, amount_paid: 0, status: "unpaid" }),
        ],
        myEntries: [],
        tabBalance: 0,
      });
    });

    // The old bug: this fired unconditionally regardless of the bill's
    // failure above, claiming the FULL ₹800 was settled.
    expect(toastSuccess).not.toHaveBeenCalledWith(
      "Settling full balance…",
      expect.anything(),
    );
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const [message, opts] = toastWarning.mock.calls[0]! as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(message).toContain("500");
    expect(message).toContain("800");
    opts.action.onClick();
    // The receipt, if printed at all, must be for what actually settled
    // (₹500) — never the original ₹800 total the bug used to claim.
    expect(printReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, balanceAfter: 300 }),
      undefined,
      expect.anything(),
    );
    unmount();
  });

  it("reports nothing settled, with no receipt offered, when every collection fails", async () => {
    bookingMutateAsync.mockRejectedValue(new Error("boom"));
    billMutateAsync.mockRejectedValue(new Error("boom"));
    const { hook, unmount } = setup();

    await act(async () => {
      await hook.settleAll({
        name: "Ravi",
        phone: "9876543210",
        myBookings: [
          bookingRow({ id: "bk1", total_amount: 500, advance_paid: 0 }),
        ],
        myBills: [
          billRow({ id: "b1", total: 300, amount_paid: 0, status: "unpaid" }),
        ],
        myEntries: [],
        tabBalance: 0,
      });
    });

    expect(toastWarning).toHaveBeenCalledTimes(1);
    const [message, opts] = toastWarning.mock.calls[0]! as [
      string,
      { action?: unknown },
    ];
    expect(message).toMatch(/nothing was settled/i);
    expect(opts.action).toBeUndefined();
    expect(printReceipt).not.toHaveBeenCalled();
    unmount();
  });
});
