// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PillChoice } from "@/components/admin/PillChoice";

// PillChoice (the A screens, Task 1; the prototype's „Ootab ettemaksu“ / „Kinnitatud“ status pills): native radios drawn as pills inside a fieldset,
// so the browser gives the keyboard (one tab stop, the arrows move and choose) and the screen reader its „1 of 2“ for free.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof PillChoice>[0];
const OPTIONS = [
  { value: "ootab", label: "Ootab ettemaksu" },
  { value: "kinnitatud", label: "Kinnitatud" },
];
const base = (over: Partial<Props> = {}): Props => ({ name: "staatus", legend: "Staatus", options: OPTIONS, value: "ootab", onChange: () => {}, ...over });
const draw = (over: Partial<Props> = {}) => act(async () => root.render(createElement(PillChoice, base(over))));

const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>("input[type=radio]"));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("PillChoice", () => {
  it("is a fieldset with a legend holding native radios of one name, one per option, with the option's value", async () => {
    await draw();
    const set = container.querySelector("fieldset")!;
    expect(set).not.toBeNull();
    expect(text(set.querySelector("legend"))).toBe("Staatus");
    expect(radios().map((r) => [r.name, r.value])).toEqual([
      ["staatus", "ootab"],
      ["staatus", "kinnitatud"],
    ]);
    expect(set.querySelectorAll("input[type=radio]")).toHaveLength(2);
  });

  it("each pill is named by its label (aria-labelledby on the radio), not by the radio's value", async () => {
    await draw();
    const names = radios().map((r) => text(document.getElementById(r.getAttribute("aria-labelledby")!)));
    expect(names).toEqual(["Ootab ettemaksu", "Kinnitatud"]);
  });

  it("clicking a pill calls onChange with its value", async () => {
    const onChange = vi.fn();
    await draw({ onChange });
    await click(radios()[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("kinnitatud");
  });

  it("clicking the pill's label (the text) chooses it too", async () => {
    const onChange = vi.fn();
    await draw({ onChange });
    await click(container.querySelectorAll("label")[1]);
    expect(onChange).toHaveBeenCalledWith("kinnitatud");
  });

  it("the pill of the value is checked; the other is not", async () => {
    await draw({ value: "kinnitatud" });
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    await draw({ value: "ootab" });
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
  });

  it("with no value (null) no pill is checked", async () => {
    await draw({ value: null });
    expect(radios().map((r) => r.checked)).toEqual([false, false]);
  });

  it("is controlled: the checked pill is the parent's value, whatever was clicked, until the parent changes it", async () => {
    const onChange = vi.fn();
    await draw({ onChange, value: "ootab" });
    await click(radios()[1]);
    expect(onChange).toHaveBeenCalledWith("kinnitatud");
    expect(radios().map((r) => r.checked)).toEqual([true, false]); // the parent did not follow
    await draw({ onChange, value: "kinnitatud" });
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
  });

  it("works under a parent that follows it", async () => {
    function Host() {
      const [value, setValue] = useState<string | null>("ootab");
      return createElement(PillChoice, base({ value, onChange: setValue }));
    }
    await act(async () => root.render(createElement(Host)));
    await click(radios()[1]);
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    await click(radios()[0]);
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
  });

  it("choosing the pill that is chosen already says nothing (a radio does not change)", async () => {
    const onChange = vi.fn();
    await draw({ onChange, value: "ootab" });
    await click(radios()[0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled disables every pill, and nothing is called", async () => {
    const onChange = vi.fn();
    await draw({ onChange, disabled: true });
    expect(radios().map((r) => r.disabled)).toEqual([true, true]);
    await click(radios()[1]);
    expect(onChange).not.toHaveBeenCalled();
    await draw({ onChange, disabled: false });
    expect(radios().map((r) => r.disabled)).toEqual([false, false]);
  });

  it("`plain` draws the pills without the dot (the Raha panel's amount and method pills, Task 5); each option's `data` hooks go on its radio", async () => {
    await draw({ plain: true, options: OPTIONS.map((o) => ({ ...o, data: { "data-amount": o.value } })) });
    expect(container.querySelector("[data-pill-choice]")!.className).toMatch(/plain/);
    expect(radios().map((r) => r.getAttribute("data-amount"))).toEqual(["ootab", "kinnitatud"]);
    await draw();
    expect(container.querySelector("[data-pill-choice]")!.className).not.toMatch(/plain/);
    expect(radios().map((r) => r.getAttribute("data-amount"))).toEqual([null, null]);
  });

  it("the legend is for the screen reader: the page has its own heading above the pills", async () => {
    await draw();
    expect(container.querySelector("legend")!.className).toMatch(/legend/);
    const css = readFileSync(join(process.cwd(), "src/components/admin/PillChoice.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.legend\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\);|clip-path:\s*inset\(50%\);/);
  });
});

describe("PillChoice: the stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src/components/admin/PillChoice.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  it("a pill is a 44 px target", () => {
    expect(rule(".pill > span")).toMatch(/min-height:\s*44px;/);
  });

  it("the chosen pill is the prototype's: ink border on first-light, the dot filled", () => {
    expect(css).toMatch(/\.pill\s*>\s*input:checked\s*\+\s*span\s*\{[^}]*border-color:\s*var\(--ink\);[^}]*background:\s*var\(--first\);/);
    expect(css).toMatch(/input:checked\s*\+\s*span::before\s*\{[^}]*background:\s*var\(--ink\);/);
  });

  it("the keyboard ring is the admin's: 2px rose, offset 2 (on the pill the radio is in)", () => {
    expect(css).toMatch(/input:focus-visible\s*\+\s*span\s*\{[^}]*outline:\s*2px solid var\(--rose\);[^}]*outline-offset:\s*2px;/);
  });

  it("a plain pill has no dot, and the chosen one is bold (the Part 2 prototype's amount and method pills)", () => {
    expect(css).toMatch(/\.plain\s+\.pill\s*>\s*span::before\s*\{[^}]*content:\s*none;/);
    expect(css).toMatch(/\.plain\s+\.pill\s*>\s*input:checked\s*\+\s*span\s*\{[^}]*font-weight:\s*600;/);
  });

  it("does not rely on :has (old iPads)", () => {
    expect(css).not.toMatch(/:has\(/);
  });
});
