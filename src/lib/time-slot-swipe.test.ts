import { describe, expect, it } from "vitest";
import { swipeDirection } from "./time-slot-utils";

describe("swipeDirection", () => {
  it("recognises a deliberate horizontal swipe", () => {
    expect(swipeDirection(-120, 10)).toBe(1);
    expect(swipeDirection(120, -10)).toBe(-1);
  });
  it("ignores short movements (taps)", () => {
    expect(swipeDirection(30, 0)).toBeNull();
    expect(swipeDirection(-50, 0)).toBeNull();
  });
  it("ignores a diagonal page scroll", () => {
    expect(swipeDirection(-80, 90)).toBeNull();
    expect(swipeDirection(70, 60)).toBeNull();
  });
});
