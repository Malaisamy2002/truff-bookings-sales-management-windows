// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { readPersisted, writePersisted } from "./ui-prefs";

describe("ui preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the fallback when stored JSON is corrupted", () => {
    localStorage.setItem("ks:ui:reports-view", "{not-json");
    expect(readPersisted("reports-view", "summary")).toBe("summary");
  });

  it("round-trips valid preferences without leaking the raw key", () => {
    writePersisted("reports-view", "detailed");
    expect(localStorage.getItem("reports-view")).toBeNull();
    expect(readPersisted("reports-view", "summary")).toBe("detailed");
  });
});
