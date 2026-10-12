import { describe, expect, test } from "vitest";
import { tallinnFormParts, tallinnInstant } from "@/domain/calendar";
import { readBadge, shownBadge } from "@/domain/badge";
import { BADGE_PRESETS, BADGE_SWATCHES, badgeOf, draftFromCourse, moveItem, newCourseDraft, swatchOf } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { isSlug, slugify } from "@/lib/slug";

// Task 13: the pure parts of the course and calendar editors.

describe("Estonian date and time of a session", () => {
  test("winter (UTC+2) and summer (UTC+3), and back to the form's fields", () => {
    expect(tallinnInstant("2026-11-14", "10:00")?.toISOString()).toBe("2026-11-14T08:00:00.000Z");
    expect(tallinnInstant("2027-06-05", "10:00")?.toISOString()).toBe("2027-06-05T07:00:00.000Z");
    expect(tallinnInstant("2027-01-01", "00:30")?.toISOString()).toBe("2026-12-31T22:30:00.000Z");
    expect(tallinnFormParts(new Date("2026-11-14T08:00:00Z"))).toEqual({ date: "2026-11-14", time: "10:00" });
    expect(tallinnFormParts(new Date("2027-06-05T07:00:00Z"))).toEqual({ date: "2027-06-05", time: "10:00" });
    expect(tallinnFormParts(new Date("2026-12-31T22:30:00Z"))).toEqual({ date: "2027-01-01", time: "00:30" });
  });

  test("the days the clocks change: the instants either side are right", () => {
    // 2027-03-28: 03:00 → 04:00; 2026-10-25: 04:00 → 03:00
    expect(tallinnInstant("2027-03-28", "02:30")?.toISOString()).toBe("2027-03-28T00:30:00.000Z");
    expect(tallinnInstant("2027-03-28", "10:00")?.toISOString()).toBe("2027-03-28T07:00:00.000Z");
    expect(tallinnInstant("2026-10-25", "10:00")?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    for (const iso of ["2027-03-28T07:00:00Z", "2026-10-25T08:00:00Z", "2026-10-24T07:00:00Z"]) {
      const { date, time } = tallinnFormParts(new Date(iso));
      expect(tallinnInstant(date, time)?.toISOString(), iso).toBe(new Date(iso).toISOString());
    }
  });

  test("not a real date or time: null", () => {
    for (const [d, t] of [
      ["2026-02-30", "10:00"],
      ["2026-13-01", "10:00"],
      ["14.11.2026", "10:00"],
      ["2026-11-14", "24:00"],
      ["2026-11-14", "10:60"],
      ["2026-11-14", "10"],
      ["", ""],
    ])
      expect(tallinnInstant(d, t), `${d} ${t}`).toBeNull();
  });
});

describe("badges (prototype D)", () => {
  test("D's presets and swatches, every swatch from the palette", () => {
    expect(BADGE_PRESETS.map((p) => p.et)).toEqual(["Uus", "Populaarne", "Bestseller", "Enim müüdud", "Viimased kohad", "Soodus"]);
    // round 2 item 1c: each with its Russian text
    expect(BADGE_PRESETS.map((p) => p.ru)).toEqual(["Новинка", "Популярное", "Бестселлер", "Хит продаж", "Последние места", "Скидка"]);
    expect(BADGE_SWATCHES.map((s) => [adminEt.badge.swatch[s.id], s.bg, s.fg])).toEqual([
      ["Tint", "#222222", "#ffffff"],
      ["Orhidee", "#DDD4DC", "#222222"],
      ["Tuhkroos", "#9E8993", "#222222"],
      ["Ploom", "#6B4F5C", "#ffffff"],
      ["Hele", "#FFFFFF", "#222222"],
    ]);
  });

  test("every swatch's text colour on its background reaches WCAG AA for small text (4.5:1)", () => {
    // WCAG 2.x relative luminance and contrast ratio
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(ratio("#ffffff", "#9E8993")).toBeLessThan(4.5); // D's original Tuhkroos pair, which is why it changed
    for (const s of BADGE_SWATCHES) expect(ratio(s.fg, s.bg), `${s.id}: ${s.fg} on ${s.bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test("badgeOf trims and uses the swatch's colours; swatchOf finds it by background in any case", () => {
    expect(badgeOf({ et: " Uus " }, "orchid")).toEqual({ label: { et: "Uus" }, bg: "#DDD4DC", fg: "#222222" });
    expect(badgeOf({ et: "Uus", ru: " Новинка " }, "orchid")).toEqual({ label: { et: "Uus", ru: "Новинка" }, bg: "#DDD4DC", fg: "#222222" });
    expect(badgeOf({ et: "Uus", ru: "  " }, "tint")!.label).toEqual({ et: "Uus" }); // an empty Russian text is left out
    expect(badgeOf({ et: "  ", ru: "Новинка" }, "tint")).toBeNull(); // no badge without the Estonian text
    expect(swatchOf({ label: "Uus", bg: "#ddd4dc", fg: "#000" })).toBe("orchid");
    expect(swatchOf({ label: "Uus", bg: "#ff0000", fg: "#fff" })).toBeNull();
    expect(swatchOf(null)).toBeNull();
  });
});

describe("badge labels in two languages (round 2 item 1c)", () => {
  test("an old plain label is the Estonian text; RU pages show the Russian text or fall back to the Estonian", () => {
    const old = { label: "Populaarne", bg: "#222222", fg: "#ffffff" };
    const both = { label: { et: "Populaarne", ru: "Популярное" }, bg: "#222222", fg: "#ffffff" };
    expect(readBadge(old)).toEqual({ label: { et: "Populaarne" }, bg: "#222222", fg: "#ffffff" });
    expect(shownBadge(old, "ru")).toEqual({ label: "Populaarne", bg: "#222222", fg: "#ffffff" });
    expect(shownBadge(both, "ru")!.label).toBe("Популярное");
    expect(shownBadge(both, "et")!.label).toBe("Populaarne");
    expect(shownBadge({ ...both, label: { et: "Uus", ru: " " } }, "ru")!.label).toBe("Uus");
    expect(shownBadge(null, "et")).toBeNull();
    expect(shownBadge({ label: "  ", bg: "#222222", fg: "#ffffff" }, "et")).toBeNull();
    expect(readBadge({ label: { et: "" }, bg: "#222222", fg: "#ffffff" })).toBeNull();
  });
});

describe("drafts", () => {
  test("a stored course becomes a draft with euro amounts as typed and empty optional texts", () => {
    const stored = {
      id: 7,
      updatedAt: new Date("2026-10-01T12:00:00.123Z"),
      type: "contact",
      level: "advanced",
      slug: "kulmude-lami",
      language: "ET / RU",
      title: { et: "Kulmude LAMI", ru: "Ламинирование" },
      summary: { et: "S" },
      body: { et: "B" },
      outcomes: [{ et: "O" }],
      includes: [{ et: "I" }],
      protocolStages: ["Ettevalmistus", "  ", "Värvimine"],
      price: null,
      priceGroup: 22050,
      priceIndividual: 30000,
      accessMonths: null,
      videoCount: null,
      durationLabel: { et: "6 ak" },
      nextDiscount: null,
      badge: { label: "Uus", bg: "#DDD4DC", fg: "#222222" }, // stored before round 2: a plain Estonian label
      recommendationIds: [3, 1],
      published: true,
      isSample: true,
      images: [{ key: "/seed/a.jpg", alt: null }],
    } satisfies Parameters<typeof draftFromCourse>[0];
    const d = draftFromCourse(stored);
    expect(d).toMatchObject({
      id: 7,
      version: "2026-10-01T12:00:00.123Z",
      priceGroup: "220,50",
      priceIndividual: "300",
      price: "",
      accessMonths: "",
      nextDiscount: { et: "" },
      durationLabel: { et: "6 ak" },
      images: [{ key: "/seed/a.jpg", alt: { et: "" } }],
      recommendationIds: [3, 1],
      protocolStages: ["Ettevalmistus", "Värvimine"], // the blank one is not a heading
      badge: { label: { et: "Uus" }, bg: "#DDD4DC", fg: "#222222" },
    });
    expect(draftFromCourse({ ...stored, language: "EN" }).language).toBe("ET"); // not one of the three: ET
    expect(newCourseDraft()).toMatchObject({ id: null, version: null, type: "contact", published: false, isSample: false, badge: null, protocolStages: [] });
  });

  test("moveItem moves one item and leaves the input alone", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveItem(list, 9, 0)).toEqual(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  test("slugs: made from Estonian titles, and what the admin may type", () => {
    expect(slugify("Ripsmete tõste ÜLIKURSUS: 2in1!")).toBe("ripsmete-toste-ulikursus-2in1");
    expect(slugify("Kulmukuju ja sümmeetria")).toBe("kulmukuju-ja-summeetria");
    expect(isSlug("kulmude-lami")).toBe(true);
    for (const bad of ["Kulmud", "kulmud--lami", "-lami", "lami-", "kulmud lami", "õ", "a".repeat(81), ""]) expect(isSlug(bad), bad).toBe(false);
  });
});
