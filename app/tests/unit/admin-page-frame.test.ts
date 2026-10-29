import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Admin polish, Task 3 (the audit of 29.10, F7 F8 F11 F12 F14 F17 F20): the page frame's rules, read from their stylesheets. The screens' own DOM tests
// hold the markup (news-list-dom, course-editor-dom, reviews-panel-dom, session-form-dom, sidebar-dom, feedback-widget-dom; the db tests
// newsletter-page and certificate-admin); the geometry was measured in a browser at 1440, 1280, 390 and 375 px (the task's report). These hold the rules
// that make it, so a later change that undoes one is seen here.

const css = (...path: string[]) => readFileSync(join(process.cwd(), "src", ...path), "utf8").replace(/\r\n/g, "\n");
/** The body of the first `selector { … }` in `sheet` (after `from`, when given: a media block's opening). */
const rule = (sheet: string, selector: string, from = "") => {
  const start = from ? sheet.indexOf(from) : 0;
  expect(start, from).toBeGreaterThan(-1);
  const at = sheet.indexOf(`${selector} {`, start);
  expect(at, `${selector} after ${from || "the start"}`).toBeGreaterThan(-1);
  return sheet.slice(at, sheet.indexOf("}", at));
};

describe("F7: the H1 row's right side — ET | RU, the chip's place, „Vaata lehel ↗“ — on one line", () => {
  for (const [name, sheet] of [
    ["the site editors", css("components", "admin", "site", "SiteEditorPage.module.css")],
    ["the course editor", css("components", "admin", "CourseEditor.module.css")],
  ] as const)
    it(`${name}: the chip's place is as wide as its usual words (12.5 rem, was 15) with the chip at its right end; the line keeps its width beside the text, which keeps 22 rem, else wraps as a whole`, () => {
      expect(rule(sheet, ".statusSlot")).toMatch(/justify-content: flex-end;/);
      const wide = "@media (min-width: 901px) {";
      expect(rule(sheet, ".statusSlot", wide)).toMatch(/min-width: 12\.5rem;/);
      expect(sheet).not.toMatch(/min-width: 15rem/);
      expect(rule(sheet, ".heading", wide)).toMatch(/flex-wrap: wrap;/);
      expect(rule(sheet, ".headText", wide)).toMatch(/flex: 1 1 22rem;/);
      expect(rule(sheet, ".aside", wide)).toMatch(/flex: none;\s*max-width: 100%;\s*margin-left: auto;/);
    });

  it("the post's editor beside the list: the H1, then the line with ET | RU at its left and the chip with „Vaata lehel ↗“ at its right (the C3 frame)", () => {
    const sheet = css("components", "admin", "news", "NewsList.module.css");
    const wide = "@media (min-width: 1180px) {";
    expect(rule(sheet, ".editor [data-site-heading] > :last-child", wide)).toMatch(/flex-basis: 100%;/);
    expect(rule(sheet, ".editor [data-site-heading] [data-site-chip]", wide)).toMatch(/margin-left: auto;/);
  });

  it("the markup the rules name: the heading, its text, its right side and the chip's place", () => {
    const page = readFileSync(join(process.cwd(), "src", "components", "admin", "site", "SiteEditorPage.tsx"), "utf8");
    expect(page).toContain('<div className={`${ui.heading} ${styles.heading}`} data-site-heading="">');
    expect(page).toContain("<div className={`${ui.headAside} ${styles.aside}`}>");
    expect(page).toContain('<span ref={chipSlot} className={styles.statusSlot} data-site-chip="">');
    const course = readFileSync(join(process.cwd(), "src", "components", "admin", "course", "CourseHeader.tsx"), "utf8");
    expect(course).toContain("<div className={`${ui.heading} ${styles.heading}`}>");
    expect(course).toContain("<div className={`${ui.headAside} ${styles.aside}`}>");
  });
});

describe("F8: the course editor's side column scrolls with the page; only „Avaldamine“ sticks", () => {
  const sheet = css("components", "admin", "CourseEditor.module.css");
  const wide = "@media (min-width: 1180px) {";

  it("no box that scrolls inside the page: the column is as tall as the cards, its own cards at their tops", () => {
    const side = rule(sheet, ".side", wide);
    expect(side).not.toMatch(/position: sticky|overflow-y|max-height/);
    expect(side).toMatch(/align-self: stretch;\s*align-content: start;/);
  });

  it("„Avaldamine“'s box sticks at the window's top, the page's colour 24 px over the card (the card at 24 px, as the section map), over the märgis card, which is a stacking context of its own", () => {
    const box = rule(sheet, ".publish", wide);
    expect(box).toMatch(/position: sticky;\s*top: 0;\s*z-index: 1;\s*margin-top: -24px;\s*padding-top: 24px;\s*background: var\(--canvas\);/);
    expect(rule(sheet, ".publish + *", wide)).toMatch(/isolation: isolate;/);
    // the 24 px at the top of the page: the PublishBar's 22 px gap and the columns' own 2 px
    expect(rule(sheet, ".layout", wide)).toMatch(/padding-top: 2px;/);
    expect(css("components", "admin", "PublishBar.module.css")).toMatch(/\.wrap \{\s*margin: 0 0 22px;/);
    expect(css("components", "admin", "SectionMap.module.css")).toMatch(/position: sticky;\s*top: 24px;/);
  });
});

describe("F11: „Lisa õpilane +“ opens its form on a line of its own under the heading", () => {
  const sheet = css("components", "admin", "ClientDrawer.module.css");
  const wide = "@media (min-width: 901px) {";

  it("from 901 px the box gives the button and the form to the heading's wrapping row; the form takes the whole next line, its 460 px at the right", () => {
    expect(rule(sheet, ".addBox", wide)).toMatch(/display: contents;/);
    expect(rule(sheet, ".addBox .add", wide)).toMatch(/flex: 0 0 100%;\s*padding-left: max\(0px, calc\(100% - 460px\)\);/);
    expect(css("app", "admin", "(panel)", "opilased", "clients.module.css")).toMatch(/\.heading \{\s*flex-wrap: wrap;/);
  });
});

describe("F12: „Tellijad | Kirjad“ in the same place in both views", () => {
  const sheet = css("app", "admin", "(panel)", "uudiskiri", "newsletter.module.css");
  const wide = "@media (min-width: 901px) {";

  it("Tellijad's heading is a grid from 901 px: its eyebrow, H1 and lead at the left, the tabs and the CSV level with the H1's foot at the right", () => {
    expect(rule(sheet, "div.subsHeading", wide)).toMatch(/display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(rule(sheet, ".subsTitle", wide)).toMatch(/display: contents;/);
    expect(rule(sheet, ".subsTitle > h1", wide)).toMatch(/margin-top: 0;/);
    expect(rule(sheet, ".subsHeading > .subsAside", wide)).toMatch(/grid-column: 2;\s*grid-row: 1 \/ 3;\s*align-self: end;\s*align-items: flex-end;/);
  });
});

describe("F14: Seaded › Tunnistus — „Koolitaja nimi“ level with „Aasta“ and „Number“", () => {
  const sheet = css("components", "admin", "CertificateSettings.module.css");

  it("the name's field one legend line lower (12 px × 1.3 + 8 px), not when the grid is one column", () => {
    expect(rule(sheet, ".trainer")).toMatch(/margin-top: calc\(12px \* 1\.3 \+ 8px\);/);
    expect(rule(sheet, ".trainer", "@container course-cards (max-width: 560px) {")).toMatch(/margin-top: 0;/);
    expect(rule(sheet, ".trainer", "@media (max-width: 640px) {")).toMatch(/margin-top: 0;/);
    // the two rules it follows: the legend's line and the space under it
    expect(css("components", "admin", "ui.module.css")).toMatch(/\.field label,\n\.legend \{\s*font: 600 12px\/1\.3 var\(--font-body\);/);
    expect(css("components", "admin", "editor.module.css")).toMatch(/\.fieldset legend \{\s*margin-bottom: 8px;/);
    expect(css("components", "admin", "CertificateSettings.tsx")).toContain('text("trainerName", "trainer", CERT_LIMITS.trainerName, t.trainerNameHint, styles.trainer)');
  });
});

describe("F17: the Uudised list as the page", () => {
  const sheet = css("components", "admin", "news", "NewsList.module.css");

  it("its rows in a white card (their 10 px reaching into its padding); on a phone „Lisa postitus +“ takes the line under the lead", () => {
    expect(rule(sheet, ".card .rows")).toMatch(/margin: 0 -10px;/);
    expect(rule(sheet, ".pageHead .add", "@media (max-width: 900px) {")).toMatch(/flex: 1 1 100%;\s*justify-items: start;/);
    // (the rows' old reading width with no post open is gone: the card is the list's width, as every list's)
    expect(sheet).not.toMatch(/max-width: 760px/);
  });
});

describe("F20: the overview's two cards are as tall as each other", () => {
  const sheet = css("app", "admin", "(panel)", "overview.module.css");

  it("the row stretches them; the empty queue keeps its two lines at its top", () => {
    expect(rule(sheet, ".grid")).toMatch(/align-items: stretch;/);
    expect(rule(sheet, ".empty")).toMatch(/display: grid;\s*align-content: start;/);
  });
});
