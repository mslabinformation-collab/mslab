// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReviewList } from "@/components/site/ReviewList";
import { COURSE_REVIEWS_SHOWN, HOME_REVIEWS_MAX } from "@/domain/review";
import type { PublicReview } from "@/server/reviews";

// The student reviews on the public pages (student reviews, Task 5; spec D5, D7, §5): the course page's block and the home page's section, in a
// browser-like document (happy-dom). With 0, 1, 6 and 7 reviews: what each review shows (its words as paragraphs, the name, the month and year),
// the six and „Näita kõiki“ (the count of the rest, the rest opened in place with no request, the keyboard focus on the first one newly shown),
// the course's title linked on the home page only, the language mark on a review in the other language, the notice under both, and nothing at all
// (no heading, no notice) when there is nothing to show. No stars, no score, no average.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (props: Parameters<typeof ReviewList>[0]) => {
  await act(async () => root.render(createElement(ReviewList, props)));
  await settle();
};
// (a tap or a key press focuses the button first, as it does in a browser)
const click = async (el: Element | null) => {
  await act(async () => {
    (el as HTMLElement).focus();
    (el as HTMLElement).click();
  });
  await settle();
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const COURSE = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
/** Review n (1 = the newest): written n days before 13.10.2026, in Estonian, by "Mari n.". */
const review = (n: number, over: Partial<PublicReview> = {}): PublicReview => ({
  id: 100 + n,
  text: `Soovitaksin kindlasti ${n}.`,
  name: `Mari ${n}.`,
  locale: "et",
  writtenAt: new Date(Date.UTC(2026, 9, 13 - n, 8)),
  course: COURSE,
  ...over,
});
const list = (n: number) => Array.from({ length: n }, (_, i) => review(i + 1));
const items = () => all("[data-review]");
const button = () => $<HTMLButtonElement>("[data-reviews-more]");
const ids = () => items().map((el) => el.getAttribute("data-review"));

describe("nothing to show", () => {
  test.each(["course", "home"] as const)("%s: with no reviews nothing is rendered, not even a heading or the notice", async (variant) => {
    await show({ reviews: [], locale: "et", variant });
    expect(container.innerHTML).toBe("");
    for (const locale of ["et", "ru"] as const) expect(renderToStaticMarkup(createElement(ReviewList, { reviews: [], locale, variant }))).toBe("");
  });
});

describe("the course page's block", () => {
  test("one review: the heading, its words, the shown name, the month and year, and the notice; no button", async () => {
    await show({ reviews: [review(1, { text: "Väga hea koolitus.", name: "Kati K." })], locale: "et", variant: "course" });
    const section = $("section[data-reviews]")!;
    expect(section.getAttribute("data-reviews")).toBe("course");
    const heading = $("h2", section)!;
    expect(heading.textContent).toBe("Õpilaste tagasiside");
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(items()).toHaveLength(1);
    const item = items()[0];
    expect($("blockquote", item)!.textContent).toBe("Väga hea koolitus.");
    expect(item.textContent).toContain("Kati K.");
    expect(item.textContent).toContain("okt 2026");
    expect($("[data-reviews-notice]")!.textContent).toBe("Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.");
    expect(button()).toBeNull();
    expect($("a", section)).toBeNull(); // (the course is the page itself: nothing to link)
  });

  test("the words are paragraphs split on blank lines; a single line break stays a line break, and nothing is added or left out", async () => {
    const text = "Esimene lõik.\nSama lõigu teine rida.\n\nTeine lõik.\r\n \r\nKolmas lõik.";
    await show({ reviews: [review(1, { text })], locale: "et", variant: "course" });
    const paragraphs = all("blockquote p");
    expect(paragraphs.map((p) => p.textContent)).toEqual(["Esimene lõik.\nSama lõigu teine rida.", "Teine lõik.", "Kolmas lõik."]);
  });

  test("markup in a review is text, never markup", async () => {
    await show({ reviews: [review(1, { text: "<b>Tore</b> <script>alert(1)</script>", name: "<i>Kati</i>" })], locale: "et", variant: "course" });
    expect($("blockquote b")).toBeNull();
    expect($("script")).toBeNull();
    expect($("blockquote")!.textContent).toBe("<b>Tore</b> <script>alert(1)</script>");
    expect(items()[0].textContent).toContain("<i>Kati</i>");
  });

  test("no stars, no score, no average", async () => {
    await show({ reviews: list(7), locale: "et", variant: "course" });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[★☆⭐]|\d\s*\/\s*(5|10)\b|hinne|keskmine|punkti/i);
    expect($("svg, img, [role='img'], meter, progress", container)).toBeNull();
  });

  test.each([6, 7])("%i reviews: the six newest at first, in the order given", async (n) => {
    await show({ reviews: list(n), locale: "et", variant: "course" });
    expect(ids()).toEqual(list(COURSE_REVIEWS_SHOWN).map((r) => String(r.id)));
    expect(items().map((el) => $("figcaption", el)!.textContent!.startsWith(`Mari ${Number(el.getAttribute("data-review")) - 100}.`))).toEqual(Array(6).fill(true));
  });

  test("six reviews: no button (nothing is left to show)", async () => {
    await show({ reviews: list(6), locale: "et", variant: "course" });
    expect(items()).toHaveLength(6);
    expect(button()).toBeNull();
  });

  test("seven reviews: „Näita kõiki (1)“ under the six, above the notice", async () => {
    await show({ reviews: list(7), locale: "et", variant: "course" });
    expect(items()).toHaveLength(6);
    const more = button()!;
    expect(more.tagName).toBe("BUTTON");
    expect(more.type).toBe("button");
    expect(more.textContent).toBe("Näita kõiki (1)");
    const order = all("[data-review], [data-reviews-more], [data-reviews-notice]").map((el) => (el.hasAttribute("data-review") ? "review" : el.hasAttribute("data-reviews-more") ? "more" : "notice"));
    expect(order).toEqual([...Array(6).fill("review"), "more", "notice"]);
    expect(container.textContent).not.toContain("Soovitaksin kindlasti 7.");
  });

  test("the count is the number of reviews that are not shown yet", async () => {
    await show({ reviews: list(18), locale: "et", variant: "course" });
    expect(button()!.textContent).toBe("Näita kõiki (12)");
  });

  test("the button opens the rest in place with no request, takes itself away, and puts the keyboard focus on the first review newly shown", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    try {
      await show({ reviews: list(9), locale: "et", variant: "course" });
      expect(items()).toHaveLength(6);
      await click(button());
      expect(items()).toHaveLength(9);
      expect(ids()).toEqual(list(9).map((r) => String(r.id)));
      expect(button()).toBeNull();
      expect(fetched).not.toHaveBeenCalled();
      const first = items()[COURSE_REVIEWS_SHOWN];
      expect(first.getAttribute("data-review")).toBe("107");
      expect(first.getAttribute("tabindex")).toBe("-1"); // (focusable by script, not a stop of the Tab key)
      expect(document.activeElement).toBe(first);
      // the notice is still the last thing in the block
      expect(all("[data-review], [data-reviews-notice]").at(-1)!.hasAttribute("data-reviews-notice")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("the focus goes to the first newly shown review, not to the last one nor to the page", async () => {
    await show({ reviews: list(50), locale: "et", variant: "course" });
    expect(button()!.textContent).toBe("Näita kõiki (44)");
    await click(button());
    expect(items()).toHaveLength(50);
    expect(document.activeElement).toBe(items()[6]);
  });

  test("pressed by the keyboard (a native button: Enter and Space click it) it does the same", async () => {
    await show({ reviews: list(7), locale: "et", variant: "course" });
    const more = button()!;
    await act(async () => {
      more.focus();
      more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      more.click(); // (the browser's own step after Enter on a button)
    });
    await settle();
    expect(document.activeElement).toBe(items()[6]);
  });

  test("a rendered-again block with the same reviews stays open; with more reviews it shows them all", async () => {
    await show({ reviews: list(8), locale: "et", variant: "course" });
    await click(button());
    await show({ reviews: list(9), locale: "et", variant: "course" });
    expect(items()).toHaveLength(9);
    expect(button()).toBeNull();
  });
});

describe("the home page's section", () => {
  test("the heading, and each review with its words, name, month and year, and the course's title as a link to the course", async () => {
    await show({ reviews: [review(1), review(2, { course: { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine" } } })], locale: "et", variant: "home" });
    const section = $("section[data-reviews]")!;
    expect(section.getAttribute("data-reviews")).toBe("home");
    const heading = $("h2", section)!;
    expect(heading.textContent).toBe("Õpilaste kogemused");
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    const [first, second] = items();
    expect(first.textContent).toContain("Soovitaksin kindlasti 1.");
    expect(first.textContent).toContain("Mari 1.");
    expect(first.textContent).toContain("okt 2026");
    const link = $<HTMLAnchorElement>("a", first)!;
    expect(link.textContent).toBe("Kulmude lamineerimine");
    expect(link.getAttribute("href")).toBe("/koolitused/kulmude-lami");
    expect($<HTMLAnchorElement>("a", second)!.getAttribute("href")).toBe("/koolitused/ripsmete-tostmine");
    expect($("[data-reviews-notice]")!.textContent).toContain("Avaldame selle õpilase loal ja pärast kontrolli.");
  });

  test(`up to ${HOME_REVIEWS_MAX} reviews are all shown, with no „Näita kõiki“`, async () => {
    await show({ reviews: list(HOME_REVIEWS_MAX), locale: "et", variant: "home" });
    expect(items()).toHaveLength(HOME_REVIEWS_MAX);
    expect(button()).toBeNull();
    expect(all("a")).toHaveLength(HOME_REVIEWS_MAX);
  });

  test("one review is enough for the section", async () => {
    await show({ reviews: list(1), locale: "et", variant: "home" });
    expect(items()).toHaveLength(1);
    expect($("[data-reviews-notice]")).not.toBeNull();
  });
});

describe("the page's language (D7)", () => {
  test("a review in the other language than the page carries lang on its words, and one in the page's language does not", async () => {
    await show({ reviews: [review(1, { locale: "et" }), review(2, { locale: "ru", text: "Рекомендую!" }), review(3, { locale: "et" })], locale: "et", variant: "course" });
    expect(items().map((el) => $("blockquote", el)!.getAttribute("lang"))).toEqual([null, "ru", null]);
    expect(items().map((el) => $(".name, [class*='name']", el)!.getAttribute("lang"))).toEqual([null, "ru", null]); // (the shown name too)
    await show({ reviews: [review(1, { locale: "et" }), review(2, { locale: "ru", text: "Рекомендую!" })], locale: "ru", variant: "course" });
    expect(items().map((el) => $("blockquote", el)!.getAttribute("lang"))).toEqual(["et", null]);
    expect(items().map((el) => $("[class*='name']", el)!.getAttribute("lang"))).toEqual(["et", null]);
  });

  test("the home section marks the language the same way", async () => {
    await show({ reviews: [review(1, { locale: "ru" }), review(2, { locale: "et" })], locale: "et", variant: "home" });
    expect(items().map((el) => $("blockquote", el)!.getAttribute("lang"))).toEqual(["ru", null]);
  });

  test("the Russian page: the heading, the notice, the button and the month are Russian, the review is shown as written", async () => {
    await show({ reviews: list(7).map((r, i) => (i === 0 ? { ...r, text: "Soovitan kõigile." } : r)), locale: "ru", variant: "course" });
    expect($("h2")!.textContent).toBe("Отзывы учеников");
    expect($("[data-reviews-notice]")!.textContent).toBe(
      "Отзывы оставляют ученики, прошедшие обучение в MS LAB. Мы публикуем их с согласия ученика и после проверки.",
    );
    expect(button()!.textContent).toBe("Показать все (1)");
    expect(items()[0].textContent).toContain("окт. 2026");
    expect($("blockquote", items()[0])!.textContent).toBe("Soovitan kõigile.");
    expect($("blockquote", items()[0])!.getAttribute("lang")).toBe("et");
  });

  test("the Russian home section: its heading, the course's Russian title (the Estonian one where there is none), and the link under /ru", async () => {
    await show({ reviews: [review(1), review(2, { course: { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine" } } })], locale: "ru", variant: "home" });
    expect($("h2")!.textContent).toBe("Опыт учеников");
    const [first, second] = items().map((el) => $<HTMLAnchorElement>("a", el)!);
    expect([first.textContent, first.getAttribute("href")]).toEqual(["Ламинирование бровей", "/ru/koolitused/kulmude-lami"]);
    expect([second.textContent, second.getAttribute("href")]).toEqual(["Ripsmete tõstmine", "/ru/koolitused/ripsmete-tostmine"]);
  });

  test("the month is Estonian time: 30.09 at 21:30 UTC is already October", async () => {
    await show({ reviews: [review(1, { writtenAt: new Date("2026-09-30T21:30:00Z") }), review(2, { writtenAt: new Date("2026-09-30T20:30:00Z") })], locale: "et", variant: "course" });
    expect(items().map((el) => /(sept|okt) 2026/.exec(el.textContent!)![0])).toEqual(["okt 2026", "sept 2026"]);
  });
});

describe("the stylesheet's classes", () => {
  test("a class name is used on one kind of element only, in either variant (a class for the block that the course link shares would give the block the link's look)", () => {
    for (const variant of ["course", "home"] as const) {
      const doc = new DOMParser().parseFromString(renderToStaticMarkup(createElement(ReviewList, { reviews: list(7), locale: "et", variant })), "text/html");
      const kinds = new Map<string, Set<string>>();
      for (const el of doc.body.querySelectorAll("[class]"))
        for (const name of el.getAttribute("class")!.split(/\s+/)) kinds.set(name, (kinds.get(name) ?? new Set()).add(el.tagName));
      expect(kinds.size).toBeGreaterThan(6);
      for (const [name, tags] of kinds) expect([...tags], `${variant}: ${name}`).toHaveLength(1);
    }
  });
});

describe("the markup a page sends", () => {
  test("rendered on the server the block is the same: the six, the button with the count, the notice; the rest is not in the page until it is asked for", () => {
    const html = renderToStaticMarkup(createElement(ReviewList, { reviews: list(8), locale: "et", variant: "course" }));
    expect((html.match(/data-review="/g) ?? []).length).toBe(6);
    expect(html).toContain("Näita kõiki (2)");
    expect(html).toContain("Õpilaste tagasiside");
    expect(html).toContain("data-reviews-notice");
    expect(html).not.toContain("Soovitaksin kindlasti 7.");
  });

  test("a review's words and its shown name carry lang; the month and the course's title (the page's own) do not", () => {
    for (const variant of ["course", "home"] as const) {
      const html = renderToStaticMarkup(createElement(ReviewList, { reviews: [review(1, { locale: "ru", name: "Мария М." })], locale: "et", variant }));
      expect(html.match(/lang="/g), variant).toHaveLength(2);
      expect(html).toMatch(/<blockquote[^>]*lang="ru"/);
      expect(html).toMatch(/<span[^>]*lang="ru"[^>]*>Мария М\.<\/span>/);
      expect(html).not.toMatch(/<span[^>]*lang="ru"[^>]*>okt 2026/);
      expect(html).not.toMatch(/<a[^>]*lang=/);
    }
  });
});
