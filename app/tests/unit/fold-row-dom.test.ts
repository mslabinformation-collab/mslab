// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FoldRow } from "@/components/admin/FoldRow";

// FoldRow (the A screens, Task 1; the Part 2 prototype's folded rows „Leping … puudub ▸“, „Tehtud (1) ▸“): a native <details data-fold> whose 52 px
// summary row shows the title, the count, the one-line summary and a „▸“ that turns when the row is open. Closed, the summary is all there is.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof FoldRow>[0];
const draw = (props: Partial<Props> = {}, children: ReactNode = createElement("p", { "data-child": "" }, "Lepingu tekst")) =>
  act(async () => root.render(createElement(FoldRow, { title: "Leping", summary: "puudub", ...props }, children)));

const fold = () => container.querySelector<HTMLDetailsElement>("details[data-fold]")!;
const summary = () => fold().querySelector<HTMLElement>("summary")!;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const css = () => readFileSync(join(process.cwd(), "src/components/admin/FoldRow.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("FoldRow", () => {
  it("is a <details data-fold> whose summary holds the title, the summary and the „▸“; closed to begin with", async () => {
    await draw();
    expect(fold()).not.toBeNull();
    expect(fold().open).toBe(false);
    expect(text(summary())).toContain("Leping");
    expect(text(summary())).toContain("puudub");
    expect(text(summary())).toContain("▸");
    expect(summary().querySelector("[aria-hidden=true]")!.textContent).toBe("▸"); // the glyph is decoration
  });

  it("the title stands first, the summary and the „▸“ last (the prototype's row: title left, „puudub ▸“ right)", async () => {
    await draw({ title: "Tagasiside", summary: "pole antud" });
    expect(text(summary())).toBe("Tagasiside pole antud ▸");
  });

  it("the count follows the title in brackets: „Tehtud (1) ▸“", async () => {
    await draw({ title: "Tehtud", summary: "", count: 1 });
    expect(text(summary())).toBe("Tehtud (1) ▸");
    expect(text(summary().querySelector("[data-fold-count]"))).toBe("(1)");
  });

  it("a count of 0 is shown; no count, no brackets", async () => {
    await draw({ title: "Päringud", summary: "", count: 0 });
    expect(text(summary())).toBe("Päringud (0) ▸");
    await draw({ title: "Päringud", summary: "", count: undefined });
    expect(summary().querySelector("[data-fold-count]")).toBeNull();
    expect(text(summary())).toBe("Päringud ▸");
  });

  it("an empty summary leaves no summary text behind", async () => {
    await draw({ summary: "" });
    expect(summary().querySelector("[data-fold-summary]")).toBeNull();
    await draw({ summary: "11 rida" });
    expect(text(summary().querySelector("[data-fold-summary]"))).toBe("11 rida");
  });

  it("a short summary for a phone: both are in the row (the stylesheet shows one), the short one is drawn only when given", async () => {
    await draw({ summary: "Sellele registreeringule pole lepingut", shortSummary: "puudub" });
    expect(text(summary().querySelector("[data-fold-summary]"))).toBe("Sellele registreeringule pole lepingut");
    expect(text(summary().querySelector("[data-fold-summary-short]"))).toBe("puudub");
    expect(text(summary())).toBe("Leping Sellele registreeringule pole lepingut puudub ▸");
    await draw({ summary: "Kinnitatud 17.10.2026", shortSummary: undefined });
    expect(summary().querySelector("[data-fold-summary-short]")).toBeNull();
    await draw({ summary: "", shortSummary: "puudub" });
    expect(summary().querySelector("[data-fold-summary-short]")).toBeNull(); // (a short line for no line makes none)
  });

  it("opening shows the children; they stay in the details, after the summary", async () => {
    await draw();
    expect(fold().open).toBe(false);
    await act(async () => void (fold().open = true));
    expect(fold().open).toBe(true);
    const child = fold().querySelector("[data-child]")!;
    expect(child.textContent).toBe("Lepingu tekst");
    expect(child.closest("details")).toBe(fold());
    expect(summary().nextElementSibling!.contains(child)).toBe(true);
  });

  it("a click on the summary opens it, and another closes it", async () => {
    await draw();
    await act(async () => void summary().click());
    expect(fold().open).toBe(true);
    await act(async () => void summary().click());
    expect(fold().open).toBe(false);
  });

  it("defaultOpen starts it open, and a re-render does not close what the visitor opened or open what she closed", async () => {
    await draw({ defaultOpen: true });
    expect(fold().open).toBe(true);
    await act(async () => void (fold().open = false));
    await draw({ defaultOpen: true, summary: "puudub veel" });
    expect(fold().open).toBe(false); // she closed it: the same prop does not open it again
    await draw({ defaultOpen: undefined });
    await act(async () => void (fold().open = true));
    await draw({ defaultOpen: undefined, summary: "puudub" });
    expect(fold().open).toBe(true);
  });

  it("the id lands on the <details> (a link such as #arveta opens onto it)", async () => {
    await draw({ id: "arveta" });
    expect(fold().id).toBe("arveta");
    await draw({ id: undefined });
    expect(fold().hasAttribute("id")).toBe(false);
  });

  it("is plain markup: it renders on the server with the summary and the closed/open state in the first HTML", () => {
    const closed = renderToString(createElement(FoldRow, { title: "Leping", summary: "puudub" }, createElement("p", null, "x")));
    expect(closed).toMatch(/<details[^>]*data-fold/);
    expect(closed).not.toMatch(/<details[^>]*\sopen/);
    expect(closed).toContain("puudub");
    const open = renderToString(createElement(FoldRow, { title: "Leping", summary: "puudub", defaultOpen: true }, createElement("p", null, "x")));
    expect(open).toMatch(/<details[^>]*\sopen/);
  });
});

describe("FoldRow: the stylesheet", () => {
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css())?.[1] ?? "";
  };

  it("the summary row is 52 px tall at least, with the prototype's rule under it", () => {
    expect(rule(".summary")).toMatch(/min-height:\s*52px;/);
    expect(rule(".summary")).toMatch(/border-bottom:\s*1px solid #e6e1e3;/);
  });

  it("the „▸“ turns a quarter when the row is open, and the turn is animated except under reduced motion", () => {
    expect(css()).toMatch(/details\[open\]\s*>\s*\.summary\s+\.arrow\s*\{[^}]*transform:\s*rotate\(90deg\);/);
    expect(rule(".arrow")).toMatch(/transition:\s*transform/);
    const reduced = /@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\n\})/.exec(css())?.[1] ?? "";
    expect(reduced).toMatch(/\.arrow\s*\{[^}]*transition:\s*none;/);
  });

  it("the short summary replaces the long one on a phone (640 px, the drawer's) and is hidden above it", () => {
    expect(rule(".short")).toMatch(/display:\s*none;/);
    const phone = /@media \(max-width:\s*640px\)\s*\{([\s\S]*?\n\})/.exec(css())?.[1] ?? "";
    expect(phone).toMatch(/\.short\s*\{[^}]*display:\s*inline;/);
    expect(phone).toMatch(/\.hasShort\s*\{[^}]*display:\s*none;/);
  });

  it("the „▸“ has a square box, so that turning it down adds no sideways scroll to the drawer (a box wider than it is tall sticks out when turned)", () => {
    const box = /\.arrow\s*\{([^}]*)\}/.exec(css())?.[1] ?? "";
    const [w, h] = [/(?:^|;|\s)width:\s*(\d+)px;/.exec(box)?.[1], /(?:^|;|\s)height:\s*(\d+)px;/.exec(box)?.[1]];
    expect([w, h]).toEqual([expect.stringMatching(/^\d+$/), w]);
  });

  it("the row clips what its „▸“ sticks out while it turns (the 0.15 s turn is a diagonal wider than the box), so the drawer shows no scrollbar flash", () => {
    expect(rule(".row")).toMatch(/overflow:\s*hidden;/);
  });

  it("the keyboard ring is the admin's: 2px rose, offset 2", () => {
    expect(rule(".summary:focus-visible")).toMatch(/outline:\s*2px solid var\(--rose\);/);
    expect(rule(".summary:focus-visible")).toMatch(/outline-offset:\s*2px;/);
  });

  it("the browser's own marker is hidden (Safari's and the standard one)", () => {
    expect(rule(".summary")).toMatch(/list-style:\s*none;/);
    expect(css()).toMatch(/\.summary::-webkit-details-marker\s*\{[^}]*display:\s*none;/);
  });
});
