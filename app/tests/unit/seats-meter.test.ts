// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SeatsMeter, SeatsWords } from "@/components/admin/SeatsMeter";
import { seatFill } from "@/domain/sessions";

const host = (html: string) => {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box;
};

describe("the seats in one wording on Ülevaade and Kalender (UX pass 11.11 A2, the Kohad board)", () => {
  test("the free seats of the capacity, „{n} vaba {cap}-st“; none left, „Täis“", () => {
    expect(host(renderToStaticMarkup(createElement(SeatsWords, { capacity: 6, taken: 4 }))).textContent).toBe("2 vaba 6-st");
    expect(host(renderToStaticMarkup(createElement(SeatsWords, { capacity: 6, taken: 0 }))).textContent).toBe("6 vaba 6-st");
    const full = host(renderToStaticMarkup(createElement(SeatsWords, { capacity: 4, taken: 4 })));
    expect(full.textContent).toBe("Täis");
    expect(full.querySelector("[data-seats-full]")).not.toBeNull();
    // more taken than the seats (a hold over a lowered capacity): still „Täis“
    expect(host(renderToStaticMarkup(createElement(SeatsWords, { capacity: 4, taken: 5 }))).textContent).toBe("Täis");
  });

  test("the bar fills with the taken seats (a live hold counts, as the free seats do), whole when full", () => {
    expect(seatFill(6, 4)).toBe(67);
    expect(seatFill(6, 0)).toBe(0);
    expect(seatFill(4, 4)).toBe(100);
    expect(seatFill(4, 9)).toBe(100);
    expect(seatFill(0, 0)).toBe(100);
    const meter = host(renderToStaticMarkup(createElement(SeatsMeter, { capacity: 6, taken: 4 })));
    expect(meter.querySelector("[data-session-seats]")!.textContent).toBe("2 vaba 6-st");
    const bar = meter.querySelector("[data-seats-bar]")!;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.querySelector("span")!.getAttribute("style")).toContain("width:67%");
    expect(bar.hasAttribute("data-full")).toBe(false);
    const full = host(renderToStaticMarkup(createElement(SeatsMeter, { capacity: 2, taken: 2 })));
    expect(full.querySelector("[data-seats-bar]")!.hasAttribute("data-full")).toBe(true);
  });

  // (review of the UX pass) the Kohad board's colours: every bar fills in its plum #6b4f5c (tokens.css --warn), a full one too, at 100 %; the
  // „Täis“ tag on the board's light grey #ebe8e9 (--first)
  test("the board's colours: the plum fill on every bar, the tag „Täis“ light grey", () => {
    const css = readFileSync(join(process.cwd(), "src", "components", "admin", "SeatsMeter.module.css"), "utf8").replace(/\r\n/g, "\n");
    const tokens = readFileSync(join(process.cwd(), "src", "styles", "tokens.css"), "utf8");
    expect(tokens).toMatch(/--warn: #6b4f5c;/);
    expect(tokens).toMatch(/--first: #ebe8e9;/);
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".bar > span")).toMatch(/background: var\(--warn\);/);
    expect(css).not.toMatch(/\.bar\[data-full\]/);
    expect(rule(".full")).toMatch(/background: var\(--first\);/);
  });
});
