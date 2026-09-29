// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { queryVisible } from "./visible-query";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("queryVisible", () => {
  it("skips matches inside a hidden (kept-mounted) tab", () => {
    document.body.innerHTML = `
      <div hidden><input id="a" data-shortcut="search" /></div>
      <div><input id="b" data-shortcut="search" /></div>`;
    expect(queryVisible('[data-shortcut="search"]')?.id).toBe("b");
  });
  it("finds a match nested deeper inside a visible tab", () => {
    document.body.innerHTML = `<div><section><input id="c" data-shortcut="save" /></section></div>`;
    expect(queryVisible('[data-shortcut="save"]')?.id).toBe("c");
  });
  it("returns null when every match is hidden", () => {
    document.body.innerHTML = `<div hidden><input data-shortcut="save" /></div>`;
    expect(queryVisible('[data-shortcut="save"]')).toBeNull();
  });
});
