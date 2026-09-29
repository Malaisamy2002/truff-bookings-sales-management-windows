// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { associateLabels } from "./auto-label";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("associateLabels", () => {
  it("links a label to the input right after it", () => {
    document.body.innerHTML = `<div><label>Date</label><input type="date" /></div>`;
    associateLabels();
    const label = document.querySelector("label")!;
    const input = document.querySelector("input")!;
    expect(input.id).not.toBe("");
    expect(label.htmlFor).toBe(input.id);
  });

  it("links to the only control inside the next sibling (Radix select trigger)", () => {
    document.body.innerHTML = `<div><label>Business</label><div><button role="combobox"></button></div></div>`;
    associateLabels();
    const btn = document.querySelector("button")!;
    expect(document.querySelector("label")!.htmlFor).toBe(btn.id);
  });

  it("does not guess when the next sibling holds several controls", () => {
    document.body.innerHTML = `<div><label>Range</label><div><input /><input /></div></div>`;
    associateLabels();
    expect(document.querySelector("label")!.htmlFor).toBe("");
  });

  it("keeps an existing for/id pair and does not touch wrapping labels", () => {
    document.body.innerHTML = `
      <label for="x">A</label><input id="x" />
      <label>B <input id="y" /></label>`;
    associateLabels();
    expect(document.querySelector("#x")!.id).toBe("x");
    expect(document.querySelectorAll("label")[1]!.htmlFor).toBe("");
  });

  it("links control-first toggles to the label after them", () => {
    document.body.innerHTML = `<div><button role="switch"></button><label>Active</label></div>`;
    associateLabels();
    const sw = document.querySelector("button")!;
    expect(document.querySelector("label")!.htmlFor).toBe(sw.id);
  });

  it("does not steal a control already labelled by another label", () => {
    document.body.innerHTML = `<div><label for="z">One</label><label>Two</label><input id="z" /></div>`;
    associateLabels();
    expect(document.querySelectorAll("label")[1]!.htmlFor).toBe("");
  });

  it("ignores aria-hidden native selects", () => {
    document.body.innerHTML = `<div><label>Type</label><select aria-hidden="true"></select></div>`;
    associateLabels();
    expect(document.querySelector("label")!.htmlFor).toBe("");
  });
});
