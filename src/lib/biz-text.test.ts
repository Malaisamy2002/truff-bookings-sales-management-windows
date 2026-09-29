import { describe, expect, it } from "vitest";
import { billText, type Bill } from "./biz";

const base: Bill = {
  id: "b1",
  invoice_no: "INV-1",
  customer_name: "Ravi",
  customer_phone: null,
  items: [{ item: "Chips", qty: 10, unit: "kg", rate: 100, total: 1000 }],
  subtotal: 1000,
  discount: 0,
  total: 1000,
  amount_paid: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
};

describe("billText()", () => {
  it("prints taxable amount and each frozen tax line when tax was charged (audit O1)", () => {
    const text = billText({
      ...base,
      tax_amount: 180,
      tax_lines: [
        { label: "CGST 9%", value: 90 },
        { label: "SGST 9%", value: 90 },
      ],
    });
    const lines = text.split("\n");
    expect(lines).toContain("Taxable amount: ₹1,000");
    expect(lines).toContain("CGST 9%: ₹90");
    expect(lines).toContain("SGST 9%: ₹90");
    expect(lines).toContain("Payable: ₹1,180");
    // tax rows sit between Subtotal and Payable
    expect(lines.indexOf("CGST 9%: ₹90")).toBeGreaterThan(
      lines.indexOf("Subtotal: ₹1,000"),
    );
    expect(lines.indexOf("CGST 9%: ₹90")).toBeLessThan(
      lines.indexOf("Payable: ₹1,180"),
    );
  });

  it("omits tax rows when the bill carries no tax", () => {
    const text = billText({ ...base, tax_amount: 0, tax_lines: [] });
    expect(text).not.toMatch(/Taxable amount/);
    expect(text).toContain("Payable: ₹1,000");
  });
});
