// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhoneFold } from "@/components/admin/PhoneFold";

// PhoneFold (the A screens, Task 6; README A2 "Phone drawer: Invoices and the contract are folded rows"): a block that is a plain section with its
// heading above 640 px (the drawer's phone width) and a 52 px folded row „Arved … 1 tasumata ▸“ below it, closed to begin with. One DOM for both:
// the stylesheet picks, so nothing is drawn twice and no script has to know the width.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof PhoneFold>[0];
const draw = (props: Partial<Props> = {}) =>
  act(async () =>
    root.render(
      createElement(PhoneFold, { title: "Arved", summary: "1 tasumata", "data-registration-invoices": "", ...props } as Props, createElement("p", { "data-child": "" }, "Arve MSL2026-001")),
    ),
  );

const block = () => container.querySelector<HTMLElement>("section[data-phone-fold]")!;
const toggle = () => block().querySelector<HTMLButtonElement>("button[data-phone-fold-toggle]")!;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const css = () => readFileSync(join(process.cwd(), "src/components/admin/PhoneFold.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("PhoneFold", () => {
  it("is a section named by its heading: the title as an h3, the folded row beside it, the children in a body", async () => {
    await draw();
    expect(text(block().querySelector("h3"))).toBe("Arved");
    expect(block().getAttribute("aria-labelledby")).toBe(block().querySelector("h3")!.id);
    expect(text(toggle())).toBe("Arved 1 tasumata ▸");
    expect(toggle().querySelector("[aria-hidden=true]")!.textContent).toBe("▸"); // the glyph is decoration
    expect(text(toggle().querySelector("[data-fold-summary]"))).toBe("1 tasumata");
    expect(block().querySelector("[data-child]")!.textContent).toBe("Arve MSL2026-001");
  });

  it("is closed to begin with; the row opens it and closes it, and says so (aria-expanded, data-open)", async () => {
    await draw();
    expect([toggle().getAttribute("aria-expanded"), block().getAttribute("data-open")]).toEqual(["false", "false"]);
    expect(toggle().getAttribute("aria-controls")).toBe(block().querySelector("[data-child]")!.parentElement!.id);
    await act(async () => void toggle().click());
    expect([toggle().getAttribute("aria-expanded"), block().getAttribute("data-open")]).toEqual(["true", "true"]);
    await act(async () => void toggle().click());
    expect([toggle().getAttribute("aria-expanded"), block().getAttribute("data-open")]).toEqual(["false", "false"]);
  });

  it("a re-render with other words keeps it as she left it", async () => {
    await draw();
    await act(async () => void toggle().click());
    await draw({ summary: "kõik tasutud" });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(text(toggle().querySelector("[data-fold-summary]"))).toBe("kõik tasutud");
  });

  it("an empty summary leaves no summary text behind", async () => {
    await draw({ summary: "" });
    expect(toggle().querySelector("[data-fold-summary]")).toBeNull();
    expect(text(toggle())).toBe("Arved ▸");
  });

  it("the page's own marks land on the section (a test or a link finds the block by them), and so do the classes", async () => {
    await draw({ className: "ulatus" });
    expect(block().hasAttribute("data-registration-invoices")).toBe(true);
    expect(block().classList.contains("ulatus")).toBe(true);
  });

  it("is on the server's first page closed, with both the heading and the row (the stylesheet picks)", () => {
    const html = renderToString(createElement(PhoneFold, { title: "Arved", summary: "arveid pole" } as Props, createElement("p", null, "x")));
    expect(html).toContain("<h3");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-open="false"');
  });
});

describe("PhoneFold: the stylesheet", () => {
  const phone = () => /@media \(max-width:\s*640px\)\s*\{([\s\S]*?\n\})/.exec(css())?.[1] ?? "";
  const rule = (within: string, selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(within)?.[1] ?? "";
  };

  it("above 640 px the row is not there; below it the heading is not, and the row is 52 px tall at least", () => {
    expect(rule(css().replace(phone(), ""), ".toggle")).toMatch(/display:\s*none;/);
    expect(rule(phone(), ".heading")).toMatch(/display:\s*none;/);
    expect(rule(phone(), ".toggle")).toMatch(/min-height:\s*52px;/);
    expect(rule(phone(), ".toggle")).toMatch(/border-bottom:\s*1px solid var\(--line\);/);
  });

  it("only a phone folds the body: closed it is not drawn, open the „▸“ points down", () => {
    expect(phone()).toMatch(/\[data-open="false"\]\s+\.body\s*\{[^}]*display:\s*none;/);
    expect(phone()).toMatch(/\[data-open="true"\]\s+\.arrow\s*\{[^}]*transform:\s*rotate\(90deg\);/);
    // (above 640 px nothing hides the body)
    expect(css().replace(phone(), "")).not.toMatch(/data-open/);
  });

  it("the „▸“ has a square box, so that turning it down adds no sideways scroll to the drawer (a box wider than it is tall sticks out when turned)", () => {
    const box = /\.arrow\s*\{([^}]*)\}/.exec(css())?.[1] ?? "";
    const [w, h] = [/(?:^|;|\s)width:\s*(\d+)px;/.exec(box)?.[1], /(?:^|;|\s)height:\s*(\d+)px;/.exec(box)?.[1]];
    expect([w, h]).toEqual([expect.stringMatching(/^\d+$/), w]);
  });

  it("the row clips what its „▸“ sticks out while it turns (the 0.15 s turn is a diagonal wider than the box), so the drawer shows no scrollbar flash", () => {
    expect(rule(css(), ".row")).toMatch(/overflow:\s*hidden;/);
  });

  it("the keyboard ring is the admin's: 2px rose, offset 2; no motion under reduced motion", () => {
    expect(rule(phone(), ".toggle:focus-visible")).toMatch(/outline:\s*2px solid var\(--rose\);/);
    expect(rule(phone(), ".toggle:focus-visible")).toMatch(/outline-offset:\s*2px;/);
    expect(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\n\})/.exec(css())?.[1] ?? "").toMatch(/\.arrow\s*\{[^}]*transition:\s*none;/);
  });

  it("colours from tokens.css only", () => {
    expect(css().match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });
});
