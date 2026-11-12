import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The site header's menu (review of the UX pass 11.11): six links with „Uudised ja nõuanded“ / „Новости и советы“ fill the row at 1100 px — the language
// switch stood at the menu's own gap (it read as a seventh link) and „Logi sisse“ was squeezed (its box 166 px of 188, ET; 202 px in RU). From about
// 1150 px nothing is squeezed and from 1200 px the actions stand 47–52 px clear. So the burger and B's 84 px bar go on below 1200 px, together.

const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8").replace(/\r\n/g, "\n");

describe("the site header: the full menu from 1200 px, the burger below", () => {
  test("the menu hides and the burger shows below 1200 px; the open menu closes from 1200 px", () => {
    const css = read("src", "components", "site", "Header.module.css");
    expect(css).toMatch(/@media \(max-width: 1199px\) \{\s*\.nav \{\s*display: none;\s*\}\s*\.menuToggle \{\s*display: inline-grid;/);
    expect(css).not.toMatch(/max-width: 1099px/);
    expect(read("src", "components", "site", "MobileMenu.tsx")).toContain('window.matchMedia("(min-width: 1200px)")');
  });

  test("B's 84 px bar comes with the burger", () => {
    expect(read("src", "styles", "tokens.css")).toMatch(/@media \(max-width: 1199px\) \{\s*:root \{\s*--header-h: 84px;/);
  });
});
