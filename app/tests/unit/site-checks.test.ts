import { describe, expect, test } from "vitest";
import { looseBody, looseFaq, loosePackage, loosePost, looseSlides, looseTrainer, looseWorks, numberedSlug, postSlug, postSlugProblem, slugFollowsTitle } from "@/domain/site-checks";
import { newSlideDraft, type PackageDraft, type SlideDraft, type TrainerDraft } from "@/domain/site-editor";
import { homeParts, trainerParts } from "@/server/admin-site";
import { Check } from "@/server/edit-check";

// The site editors' loose checks (admin UX pass piece 4a, ruling R-d): a draft save refuses what the strict check (server/admin-site.ts Part.check)
// refuses, but for what is missing, which waits in the draft until „Avalda muudatused“ (S4-2 „Puudub: …“). Pure: the editors run them too.

const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const slide = (over: Partial<SlideDraft> = {}): SlideDraft => ({ ...newSlideDraft("n1"), imageKey: UPLOAD, title: { et: "Pealkiri" }, ...over });
const trainer = (over: Partial<TrainerDraft> = {}): TrainerDraft => ({ portraitKey: UPLOAD, portraitPos: "50% 20%", name: { et: "Maria" }, role: { et: "" }, stats: [], ...over });
const pkg = (over: Partial<PackageDraft> = {}): PackageDraft => ({ name: { et: "MAXI" }, tagline: { et: "" }, models: "4", durationLabel: { et: "8 ak" }, price: "150", items: [], ...over });
/** The codes of a strict check of a part's draft. */
const strict = (parts: typeof homeParts, part: string, value: unknown) => {
  const c = new Check();
  parts[part].check(c, value, part);
  return c.errors as Record<string, string>;
};
const MISSING = ["required", "imageRequired", "listEt"];

describe("nothing is required: an incomplete row waits in the draft", () => {
  test("a new slide without its picture, title and link; a FAQ row without its answer; a stat without its label; a package without its price, models or name", () => {
    expect(looseSlides([newSlideDraft("n1"), slide({ ctaHref: "" })])).toEqual({});
    expect(looseFaq([{ uid: "f", id: null, q: { et: "Kas?" }, a: { et: "" } }])).toEqual({});
    expect(looseTrainer(trainer({ name: { et: "" }, portraitKey: "", stats: [{ uid: "t0", value: "8+", label: { et: "" } }] }))).toEqual({});
    expect(loosePackage(pkg({ name: { et: "" }, models: "", price: "", durationLabel: { et: "" }, items: [{ et: "", ru: "Только" }] }))).toEqual({});
    expect(looseWorks([{ key: "", alt: { et: "" } }])).toEqual({});
    // only the Russian text there: the Estonian one is missing, which the publish says
    expect(looseBody({ body: { et: "", ru: "Только" } }, 400)).toEqual({});
  });
});

describe("what the strict check refuses besides is refused at the save, by the field's path", () => {
  test("lengths, list caps and forms", () => {
    expect(looseSlides([slide({ title: { et: "x".repeat(121) } }), slide({ ctaHref: "/ru/praktika", imagePos: "120% 50%" }), slide({ ctaHref: "javascript:x", imageKey: "https://evil.example/a.jpg" })])).toEqual({
      "slides.0.title": "tooLong",
      "slides.1.ctaHref": "localeHref",
      "slides.1.imagePos": "focal",
      "slides.2.ctaHref": "href",
      "slides.2.imageKey": "image",
    });
    expect(looseSlides(Array.from({ length: 9 }, () => newSlideDraft("n")))).toEqual({ slides: "tooMany" });
    expect(looseFaq(Array.from({ length: 31 }, (_, i) => ({ uid: `f${i}`, id: null, q: { et: "Kas?" }, a: { et: "" } })))).toEqual({ faq: "tooMany" });
    // empty rows are no rows: they are dropped at the publish
    expect(looseFaq([...Array.from({ length: 30 }, (_, i) => ({ uid: `f${i}`, id: null, q: { et: "Kas?" }, a: { et: "Jah." } })), { uid: "e", id: null, q: { et: " " }, a: { et: "" } }])).toEqual({});
    expect(looseTrainer(trainer({ stats: Array.from({ length: 4 }, (_, i) => ({ uid: `t${i}`, value: "1", label: { et: "x" } })), portraitKey: "../x.jpg" }))).toEqual({ portraitKey: "image", stats: "tooMany" });
    expect(looseTrainer(trainer({ stats: [{ uid: "t0", value: "1234567890123", label: { et: "x" } }] }))).toEqual({ "stats.0.value": "tooLong" });
    expect(loosePackage(pkg({ price: "abc", models: "99", items: [{ et: "x".repeat(301) }] }))).toEqual({ price: "amount", models: "whole", "items.0": "tooLong" });
    expect(loosePackage(pkg({ items: Array.from({ length: 21 }, () => ({ et: "x" })) }))).toEqual({ items: "tooMany" });
    expect(looseWorks(Array.from({ length: 25 }, () => ({ key: UPLOAD, alt: { et: "" } })))).toEqual({ works: "tooMany" });
  });

  test("a draft the loose check passes fails the strict check only on what is missing (the publish's „Puudub: …“)", () => {
    const cases: [typeof homeParts, string, unknown][] = [
      [homeParts, "slides", [newSlideDraft("n1"), slide({ ctaHref: "", title: { et: "", ru: "Только" } })]],
      [homeParts, "faq", [{ uid: "f", id: null, q: { et: "" }, a: { et: "Vastus." } }]],
      [homeParts, "statement", { body: { et: "", ru: "Только" } }],
      [trainerParts, "trainer", trainer({ name: { et: "" }, stats: [{ uid: "t0", value: "", label: { et: "aastat" } }] })],
      [trainerParts, "works", [{ key: "", alt: { et: "Pilt" } }]],
    ];
    for (const [parts, part, value] of cases) {
      expect(parts[part].loose?.(value), part).toEqual({});
      const codes = Object.values(strict(parts, part, value));
      expect(codes.length, part).toBeGreaterThan(0);
      for (const code of codes) expect(MISSING, `${part}: ${code}`).toContain(code);
    }
  });

  test("the loose check refuses what the strict check refuses, with the same code at the same field: its rules are Check's (M1: they cannot drift)", () => {
    // malformed values of every rule a loose check runs: the strict check (the part's own, named <part>.<path>) gives the same code at the same path
    const cases: [typeof homeParts, string, unknown, Record<string, string>][] = [
      [
        homeParts,
        "slides",
        [
          slide({ ctaHref: "javascript:alert(1)", imageKey: "https://evil.example/a.jpg", imagePos: "120% 50%" }),
          slide({ ctaHref: "/ru/praktika", imagePosMobile: "50%", kicker: { et: "k".repeat(81) } }),
          slide({ ctaHref: "//evil.example/x", text: { et: "t", ru: "т".repeat(301) }, ctaLabel: { et: "c".repeat(41) } }),
        ],
        {
          "slides.0.imageKey": "image",
          "slides.0.imagePos": "focal",
          "slides.0.ctaHref": "href",
          "slides.1.imagePosMobile": "focal",
          "slides.1.kicker": "tooLong",
          "slides.1.ctaHref": "localeHref",
          "slides.2.text": "tooLong",
          "slides.2.ctaLabel": "tooLong",
          "slides.2.ctaHref": "href",
        },
      ],
      [homeParts, "faq", [{ uid: "f", id: null, q: { et: "q".repeat(201) }, a: { et: "a".repeat(2001) } }], { "faq.0.q": "tooLong", "faq.0.a": "tooLong" }],
      [homeParts, "teaser", { body: { et: "b".repeat(301) } }, { body: "tooLong" }],
      [
        trainerParts,
        "trainer",
        trainer({ portraitKey: "../etc/passwd", portraitPos: "x", name: { et: "n".repeat(81) }, role: { et: "r".repeat(161) }, stats: [{ uid: "t0", value: "1234567890123", label: { et: "l".repeat(41) } }] }),
        { portraitKey: "image", portraitPos: "focal", name: "tooLong", role: "tooLong", "stats.0.value": "tooLong", "stats.0.label": "tooLong" },
      ],
      [trainerParts, "works", [{ key: "img/not-an-upload.jpg", alt: { et: "a".repeat(201) } }], { "works.0.key": "image", "works.0.alt": "tooLong" }],
      [trainerParts, "center_story", { title: { et: "t".repeat(121) }, body: { et: "" } }, { title: "tooLong" }],
    ];
    for (const [parts, part, value, expected] of cases) {
      expect(parts[part].loose?.(value), part).toEqual(expected);
      const prefix = ["slides", "faq", "works"].includes(part) ? "" : `${part}.`;
      expect(strict(parts, part, value), part).toEqual(Object.fromEntries(Object.entries(expected).map(([path, code]) => [prefix + path, code])));
    }
    // a package (its part is made per code from the table: checked here by the same Check calls its strict check makes)
    const bad = pkg({ price: "12,345", models: "21", items: [{ et: "x".repeat(301) }] });
    expect(loosePackage(bad)).toEqual({ price: "amount", models: "whole", "items.0": "tooLong" });
    const c = new Check();
    expect([c.amount("price", bad.price), c.whole("models", bad.models, 0, 20), c.list("items", bad.items, 300, 20)]).toEqual([null, null, []]);
    expect(c.errors).toEqual({ price: "amount", models: "whole", items: "tooLong" });
  });

  test("every part of Avaleht and Koolitaja has its loose check", () => {
    expect(Object.entries({ ...homeParts, ...trainerParts }).filter(([, p]) => !p.loose).map(([n]) => n)).toEqual([]);
  });
});

describe("a post's rules (piece 4b; R-a, R-g; the browser and the server share them)", () => {
  const post = { title: { et: "Uus postitus" }, slug: "uus-postitus", category: { et: "" }, excerpt: { et: "" }, body: { et: "" }, coverKey: "", publishedAt: "2026-10-27" };

  test("loosePost holds the Estonian title and the day at every save; the cover, category, text and Russian wait for the publish", () => {
    expect(loosePost(post)).toEqual({});
    expect(loosePost({ ...post, body: { et: "", ru: "Только по-русски" }, category: { et: "", ru: "Новость" } })).toEqual({});
    expect(loosePost({ ...post, title: { et: " " } })).toEqual({ title: "required" });
    expect(loosePost({ ...post, publishedAt: "" })).toEqual({ publishedAt: "required" });
    expect(loosePost({ ...post, publishedAt: "2026-02-30" })).toEqual({ publishedAt: "date" });
    expect(loosePost({ ...post, slug: "Mitte Nii!" })).toEqual({ slug: "slugFormat" });
    expect(loosePost({ ...post, slug: "" })).toEqual({});
    expect(loosePost({ ...post, coverKey: "https://evil.example/a.jpg" })).toEqual({ coverKey: "image" });
  });

  test("the address: typed in small letters, or made from the title; its form's one refusal", () => {
    expect(postSlug(" Talvine-Uudis ", "x")).toBe("talvine-uudis");
    expect(postSlug("", "Kevadine uudis!")).toBe("kevadine-uudis");
    expect(postSlugProblem("", "Kevad")).toBeNull();
    expect(postSlugProblem("Mitte Nii!", "Kevad")).toBe("slugFormat");
    expect(postSlugProblem("", "!!!")).toBe("slugFormat");
    expect(postSlugProblem("", " ")).toBe("required");
  });

  test("the title's series (S4-19): the title's own address or it numbered from 2, cut to 80 before the number; a typed address is in none", () => {
    expect(slugFollowsTitle("uus-postitus", "Uus postitus")).toBe(true);
    expect(slugFollowsTitle("uus-postitus-2", "Uus postitus")).toBe(true);
    expect(slugFollowsTitle("uus-postitus-12", "Uus postitus")).toBe(true);
    expect(slugFollowsTitle("uus-postitus-1", "Uus postitus")).toBe(false);
    expect(slugFollowsTitle("uus-postitus-02", "Uus postitus")).toBe(false);
    expect(slugFollowsTitle("minu-aadress", "Uus postitus")).toBe(false);
    expect(slugFollowsTitle("uus-postitus-2", "Kevad")).toBe(false);
    expect(slugFollowsTitle("", "!!!")).toBe(false);
    const long = "a".repeat(85);
    expect(numberedSlug(postSlug("", long), 2)).toBe(`${"a".repeat(78)}-2`);
    expect(slugFollowsTitle(`${"a".repeat(78)}-2`, long)).toBe(true);
    expect(numberedSlug("uus-postitus", 3)).toBe("uus-postitus-3");
  });
});
