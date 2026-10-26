import { describe, expect, test } from "vitest";
import { looseBody, looseFaq, loosePackage, looseSlides, looseTrainer, looseWorks } from "@/domain/site-checks";
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

  test("every part of Avaleht and Koolitaja has its loose check", () => {
    expect(Object.entries({ ...homeParts, ...trainerParts }).filter(([, p]) => !p.loose).map(([n]) => n)).toEqual([]);
  });
});
