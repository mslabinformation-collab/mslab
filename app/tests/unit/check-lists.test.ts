import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IncludesList } from "@/components/site/IncludesList";

// UX pass 11.11 P15 (the audit): „Pärast koolitust oskad“ had bare grey ✓ marks, „Koolitus sisaldab“ beside it ✓ in round tints. Both are the one
// check list now: the tinted round tick, each list keeping its own data name.

// UX pass 11.11 P21 (the Vaiksed board): the home page's course cards on a phone are lower, their photo 200 px (it was 350 px, a card a screen)
describe("the home page's course cards on a phone", () => {
  it("the fixed photo is 200 px at 640 px and below; the catalogue's square one is untouched", () => {
    const css = readFileSync(join(process.cwd(), "src/components/site/CourseCard.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(/\.photo:not\(\.square\)\s*\{([^}]*)\}/.exec(phone)?.[1]).toMatch(/height:\s*200px;/);
    expect(/\.photo\.square\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/aspect-ratio:\s*1 \/ 1;/);
  });
});

describe("the course page's two check lists", () => {
  it("IncludesList draws the round tick; `name` gives the list's data name", () => {
    const html = renderToStaticMarkup(createElement(IncludesList, { items: ["Üks", "Kaks"], name: "outcomes" }));
    expect(html).toMatch(/^<ul class="[^"]+" data-outcomes="">/);
    expect(html.match(/<span class="[^"]*tick[^"]*" aria-hidden="true"><svg/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(IncludesList, { items: ["Üks"] }))).toMatch(/^<ul class="[^"]+" data-includes="">/);
  });

  it("the page draws „Pärast koolitust oskad“ with it, and its own bare-tick list is gone", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
    const page = read("src/app/[locale]/(site)/koolitused/[slug]/page.tsx");
    expect(page).toMatch(/<IncludesList items=\{outcomes\} name="outcomes" \/>/);
    expect(page).not.toMatch(/styles\.checkList/);
    expect(read("src/app/[locale]/(site)/koolitused/[slug]/course.module.css")).not.toMatch(/\.checkList/);
  });
});
