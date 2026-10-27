import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  COURSE_REVIEWS_MAX, COURSE_REVIEWS_SHOWN, HOME_REVIEWS_MAX, REVIEW_NAME_MAX, REVIEW_NOTE_MAX, REVIEW_TEXT_MAX,
  checkConsent, checkManualReview, reviewMonth, shownNameFrom, starsOf,
} from "@/domain/review";
import { FEEDBACK_TEXT_MAX } from "@/domain/protocols";

// The review's pure rules (student reviews, Task 1; spec §2 D1, D4, D5, §3): the limits, the name a form offers from a full name, the consent the
// feedback form's tick and name field must satisfy, what Maria's „Lisa arvustus“ form must hold, and the month a review shows.

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
};

describe("the limits (pinned here and nowhere else)", () => {
  test("as the spec and the plan name them", () => {
    expect(REVIEW_TEXT_MAX).toBe(2000);
    expect(REVIEW_TEXT_MAX).toBe(FEEDBACK_TEXT_MAX); // the review is a copy of the form's answer: the same limit, from the same constant
    expect(REVIEW_NAME_MAX).toBe(40);
    expect(REVIEW_NOTE_MAX).toBe(500);
    expect(COURSE_REVIEWS_SHOWN).toBe(6);
    expect(COURSE_REVIEWS_MAX).toBe(50);
    expect(HOME_REVIEWS_MAX).toBe(6);
  });
});

describe("shownNameFrom: her first name and the initial of her last name (D1)", () => {
  test("a first and a last name", () => {
    expect(shownNameFrom("Kati Kask")).toBe("Kati K.");
  });
  test("a middle name is left out: the first word and the last word's initial", () => {
    expect(shownNameFrom("Kati Maria Kask")).toBe("Kati K.");
  });
  test("Cyrillic names", () => {
    expect(shownNameFrom("Анна Иванова")).toBe("Анна И.");
    expect(shownNameFrom("Анна Мария Петрова-Сидорова")).toBe("Анна П.");
  });
  test("a hyphenated surname gives one initial; a hyphenated first name stays whole", () => {
    expect(shownNameFrom("Kati Mänd-Kask")).toBe("Kati M.");
    expect(shownNameFrom("Anna-Liisa Tamm")).toBe("Anna-Liisa T.");
  });
  test("one word is shown as it is", () => {
    expect(shownNameFrom("Kati")).toBe("Kati");
    expect(shownNameFrom("  Kati  ")).toBe("Kati");
  });
  test("nothing, or only white space, is nothing", () => {
    expect(shownNameFrom("")).toBe("");
    expect(shownNameFrom("  ")).toBe("");
    expect(shownNameFrom(" \t\n ")).toBe("");
  });
  test("extra spaces (any white space, a no-break space too) between and around the words do not matter", () => {
    expect(shownNameFrom("  Kati   Maria \t Kask  ")).toBe("Kati K.");
    expect(shownNameFrom("Kati Kask")).toBe("Kati K.");
  });
  test("the initial is a capital, and is a whole letter (a letter with its accent, a letter outside the BMP)", () => {
    expect(shownNameFrom("ülle õun")).toBe("ülle Õ.");
    expect(shownNameFrom("Kati élo")).toBe("Kati É."); // e + combining acute: one letter, É
    expect(shownNameFrom("Kati \u{1d4a2}ask")).toBe("Kati \u{1d4a2}."); // a mathematical script G: two UTF-16 units, one initial
  });
  test("an initial that is not a letter is still the first character (nothing is invented)", () => {
    expect(shownNameFrom("Kati 3M")).toBe("Kati 3.");
  });
});

describe("checkConsent: the tick needs an answer to publish and a name to show it under (D1)", () => {
  test("an answer and a name", () => {
    expect(checkConsent("Soovitaksin, sest õppisin palju.", "Kati K.")).toEqual({ ok: true, name: "Kati K." });
  });
  test("no answer text: consentText (checked before the name)", () => {
    expect(checkConsent(undefined, "Kati K.")).toEqual({ ok: false, error: "consentText" });
    expect(checkConsent("", "Kati K.")).toEqual({ ok: false, error: "consentText" });
    expect(checkConsent("   \n ", "Kati K.")).toEqual({ ok: false, error: "consentText" });
    expect(checkConsent(undefined, "")).toEqual({ ok: false, error: "consentText" });
    expect(checkConsent(undefined, undefined)).toEqual({ ok: false, error: "consentText" });
  });
  test("an answer but no name: consentName (empty, white space only, missing, not a text)", () => {
    for (const name of ["", "   ", " \t\n", undefined, null, 5, {}, ["Kati"], true]) {
      expect(checkConsent("Soovitaksin.", name), String(name)).toEqual({ ok: false, error: "consentName" });
    }
  });
  test("the name is trimmed and its white space collapsed to single spaces", () => {
    expect(checkConsent("Soovitaksin.", "  Kati   K.  ")).toEqual({ ok: true, name: "Kati K." });
    expect(checkConsent("Soovitaksin.", "Kati\t\nK.")).toEqual({ ok: true, name: "Kati K." });
    expect(checkConsent("Soovitaksin.", "Kati K.")).toEqual({ ok: true, name: "Kati K." });
  });
  test("the 40-character edge: 40 is let in, 41 is not", () => {
    const edge = "K".repeat(REVIEW_NAME_MAX);
    expect(checkConsent("Soovitaksin.", edge)).toEqual({ ok: true, name: edge });
    expect(checkConsent("Soovitaksin.", edge + "K")).toEqual({ ok: false, error: "consentName" });
  });
  test("the length is counted after the white space is collapsed", () => {
    const padded = ` ${"K".repeat(20)}    ${"K".repeat(19)} `; // 20 + 1 + 19 = 40 once collapsed, 45 as typed
    expect(checkConsent("Soovitaksin.", padded)).toEqual({ ok: true, name: `${"K".repeat(20)} ${"K".repeat(19)}` });
    expect(checkConsent("Soovitaksin.", `${"K".repeat(20)} ${"K".repeat(20)}`)).toEqual({ ok: false, error: "consentName" }); // 41
  });
  test("a name that Postgres cannot store (a NUL, a lone surrogate) is refused rather than written", () => {
    expect(checkConsent("Soovitaksin.", "Kati\u0000K.")).toEqual({ ok: false, error: "consentName" });
    expect(checkConsent("Soovitaksin.", "Kati\ud800")).toEqual({ ok: false, error: "consentName" });
  });
  test("it accepts every name that shownNameFrom offers", () => {
    for (const full of ["Kati Maria Kask", "Анна Иванова", "Kati", "Anna-Liisa Mänd-Kask"]) {
      expect(checkConsent("Soovitaksin.", shownNameFrom(full)), full).toEqual({ ok: true, name: shownNameFrom(full) });
    }
  });
});

describe("checkManualReview: Maria's „Lisa arvustus“ (D4)", () => {
  const valid = { courseId: 7, name: "Kati K.", text: "Väga hea koolitus.", writtenAt: "2026-10-01", locale: "et", note: "Paberkandjal vorm, 12.09.2026" };
  const without = (key: keyof typeof valid) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key)); // (the key absent, not undefined)

  test("a complete form passes, as it is", () => {
    expect(checkManualReview(valid)).toEqual({ ok: true, value: valid });
  });
  test("the text, the name and the note are trimmed; the name's white space is collapsed; the text keeps its own line breaks", () => {
    const r = ok(checkManualReview({ ...valid, name: "  Kati   K. ", text: "  Esimene rida.\n\nTeine rida.  ", note: "  Kiri e-postiga  " }));
    expect(r.value).toEqual({ ...valid, name: "Kati K.", text: "Esimene rida.\n\nTeine rida.", note: "Kiri e-postiga" });
  });
  test("the Russian language, and a course id typed into a form (digits as text)", () => {
    expect(ok(checkManualReview({ ...valid, locale: "ru", courseId: "12" })).value).toMatchObject({ locale: "ru", courseId: 12 });
  });
  test("a future date is allowed (Maria may be adding ahead of a posted card)", () => {
    expect(ok(checkManualReview({ ...valid, writtenAt: "2031-01-31" })).value.writtenAt).toBe("2031-01-31");
  });
  test("a missing note, or a blank one: note required", () => {
    expect(checkManualReview(without("note"))).toEqual({ ok: false, fields: { note: "required" } });
    expect(checkManualReview({ ...valid, note: "" })).toEqual({ ok: false, fields: { note: "required" } });
    expect(checkManualReview({ ...valid, note: "  \n " })).toEqual({ ok: false, fields: { note: "required" } });
    expect(checkManualReview({ ...valid, note: null })).toEqual({ ok: false, fields: { note: "required" } });
  });
  test("a note over its limit, or one that is not text", () => {
    expect(ok(checkManualReview({ ...valid, note: "n".repeat(REVIEW_NOTE_MAX) })).value.note).toHaveLength(REVIEW_NOTE_MAX);
    expect(checkManualReview({ ...valid, note: "n".repeat(REVIEW_NOTE_MAX + 1) })).toEqual({ ok: false, fields: { note: "tooLong" } });
    expect(checkManualReview({ ...valid, note: 5 })).toEqual({ ok: false, fields: { note: "invalid" } });
  });
  test("a course id of a type or value that is no row id: courseId", () => {
    for (const courseId of [undefined, null, "", "abc", "7a", "07", " 7", "-7", "1.5", 1.5, 0, -7, NaN, Infinity, 2_147_483_648, "2147483648", true, {}, [7], [], "7,5"]) {
      expect(checkManualReview({ ...valid, courseId }), String(courseId)).toEqual({ ok: false, fields: { courseId: courseId === undefined || courseId === null || courseId === "" ? "required" : "invalid" } });
    }
    expect(ok(checkManualReview({ ...valid, courseId: 2_147_483_647 })).value.courseId).toBe(2_147_483_647);
  });
  test("an empty text (or blank, or missing): text required; a text over the limit; one Postgres cannot store", () => {
    expect(checkManualReview({ ...valid, text: "" })).toEqual({ ok: false, fields: { text: "required" } });
    expect(checkManualReview({ ...valid, text: " \n\t " })).toEqual({ ok: false, fields: { text: "required" } });
    expect(checkManualReview(without("text"))).toEqual({ ok: false, fields: { text: "required" } });
    expect(ok(checkManualReview({ ...valid, text: "t".repeat(REVIEW_TEXT_MAX) })).value.text).toHaveLength(REVIEW_TEXT_MAX);
    expect(checkManualReview({ ...valid, text: "t".repeat(REVIEW_TEXT_MAX + 1) })).toEqual({ ok: false, fields: { text: "tooLong" } });
    expect(checkManualReview({ ...valid, text: "Hea\u0000koolitus" })).toEqual({ ok: false, fields: { text: "invalid" } });
    expect(checkManualReview({ ...valid, text: 42 })).toEqual({ ok: false, fields: { text: "invalid" } });
  });
  test("the text is trimmed before it is measured", () => {
    expect(ok(checkManualReview({ ...valid, text: ` ${"t".repeat(REVIEW_TEXT_MAX)} ` })).value.text).toHaveLength(REVIEW_TEXT_MAX);
  });
  test("the name: required, at most 40 once collapsed, storable", () => {
    expect(checkManualReview({ ...valid, name: "  " })).toEqual({ ok: false, fields: { name: "required" } });
    expect(checkManualReview({ ...valid, name: undefined })).toEqual({ ok: false, fields: { name: "required" } });
    expect(ok(checkManualReview({ ...valid, name: "K".repeat(REVIEW_NAME_MAX) })).value.name).toHaveLength(REVIEW_NAME_MAX);
    expect(checkManualReview({ ...valid, name: "K".repeat(REVIEW_NAME_MAX + 1) })).toEqual({ ok: false, fields: { name: "tooLong" } });
    expect(checkManualReview({ ...valid, name: "Kati\u0000" })).toEqual({ ok: false, fields: { name: "invalid" } });
    expect(checkManualReview({ ...valid, name: ["Kati"] })).toEqual({ ok: false, fields: { name: "invalid" } });
  });
  test("the date: YYYY-MM-DD and a real day, from the year 2000", () => {
    for (const writtenAt of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2025-02-29", "26-10-01", "2026/10/01", "01.10.2026", "2026-10-01T10:00", " 2026-10-01", "1999-12-31", "0026-10-01", 20261001, {}, true]) {
      expect(checkManualReview({ ...valid, writtenAt }), String(writtenAt)).toEqual({ ok: false, fields: { writtenAt: "invalid" } });
    }
    for (const writtenAt of [undefined, null, ""]) {
      expect(checkManualReview({ ...valid, writtenAt }), String(writtenAt)).toEqual({ ok: false, fields: { writtenAt: "required" } });
    }
    expect(ok(checkManualReview({ ...valid, writtenAt: "2024-02-29" })).value.writtenAt).toBe("2024-02-29"); // a leap day
    expect(ok(checkManualReview({ ...valid, writtenAt: "2000-01-01" })).value.writtenAt).toBe("2000-01-01");
  });
  test("the language: et or ru", () => {
    for (const locale of ["en", "ET", "est", " et", 1, {}, true]) {
      expect(checkManualReview({ ...valid, locale }), String(locale)).toEqual({ ok: false, fields: { locale: "invalid" } });
    }
    for (const locale of [undefined, null, ""]) {
      expect(checkManualReview({ ...valid, locale }), String(locale)).toEqual({ ok: false, fields: { locale: "required" } });
    }
  });
  test("every wrong field is named, not just the first", () => {
    expect(checkManualReview({ courseId: "x", name: "", text: "", writtenAt: "nope", locale: "en", note: "" })).toEqual({
      ok: false,
      fields: { courseId: "invalid", name: "required", text: "required", writtenAt: "invalid", locale: "invalid", note: "required" },
    });
  });
  test("keys that are not the form's are left out of the value", () => {
    const r = ok(checkManualReview({ ...valid, status: "pending", featured: true, kind: "student", id: 9 }));
    expect(Object.keys(r.value).sort()).toEqual(["courseId", "locale", "name", "note", "text", "writtenAt"]);
  });
  test("not an object: a form-level refusal", () => {
    for (const raw of [undefined, null, "form", 5, true, [], [valid]]) {
      expect(checkManualReview(raw), String(raw)).toEqual({ ok: false, fields: { form: "invalid" } });
    }
  });
});

describe("reviewMonth: the month and year a review shows, in Tallinn time (D5)", () => {
  test("Estonian: the short month and the year", () => {
    expect(reviewMonth(new Date("2026-10-15T12:00:00Z"), "et")).toBe("okt 2026");
    expect(reviewMonth(new Date("2027-05-15T12:00:00Z"), "et")).toBe("mai 2027");
    expect(reviewMonth(new Date("2026-03-15T12:00:00Z"), "et")).toBe("märts 2026");
  });
  test("Russian: the short month with its dot, and the year without the „г.“", () => {
    expect(reviewMonth(new Date("2026-10-15T12:00:00Z"), "ru")).toBe("окт. 2026");
    expect(reviewMonth(new Date("2026-11-15T12:00:00Z"), "ru")).toBe("нояб. 2026");
    expect(reviewMonth(new Date("2027-05-15T12:00:00Z"), "ru")).toBe("май 2027");
  });
  test("near the month's end it is Tallinn's month, not UTC's: summer time (+3) puts 21:30 UTC on the 30th into the next month", () => {
    expect(reviewMonth(new Date("2026-09-30T20:59:59Z"), "et")).toBe("sept 2026"); // 23:59:59 on the 30th
    expect(reviewMonth(new Date("2026-09-30T21:00:00Z"), "et")).toBe("okt 2026"); // 00:00 on the 1st
    expect(reviewMonth(new Date("2026-09-30T21:00:00Z"), "ru")).toBe("окт. 2026");
  });
  test("winter time (+2): the last second of October, and the first of November", () => {
    expect(reviewMonth(new Date("2026-10-31T21:59:59Z"), "et")).toBe("okt 2026"); // 23:59:59 on the 31st (summer time ended on the 25th)
    expect(reviewMonth(new Date("2026-10-31T22:00:00Z"), "et")).toBe("nov 2026"); // 00:00 on 1 November
    expect(reviewMonth(new Date("2026-10-31T22:00:00Z"), "ru")).toBe("нояб. 2026");
  });
  test("the year turns at Tallinn midnight too", () => {
    expect(reviewMonth(new Date("2026-12-31T21:59:59Z"), "et")).toBe("dets 2026");
    expect(reviewMonth(new Date("2026-12-31T22:00:00Z"), "et")).toBe("jaan 2027");
    expect(reviewMonth(new Date("2026-12-31T22:00:00Z"), "ru")).toBe("янв. 2027");
  });
});

describe("starsOf: a review card's stars from the student's „Hinne“ (piece 4c, S4-Q5 = B)", () => {
  test("9–10 → 5, 7–8 → 4, 5–6 → 3, 3–4 → 2, 0–2 → 1", () => {
    const stars = Object.fromEntries([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((score) => [score, starsOf(score)]));
    expect(stars).toEqual({ 10: 5, 9: 5, 8: 4, 7: 4, 6: 3, 5: 3, 4: 2, 3: 2, 2: 1, 1: 1, 0: 1 });
  });
  test("no score, no stars: undefined, null (a review Maria added), and what is no score of 0–10", () => {
    for (const score of [undefined, null, -1, 11, Number.NaN, Number.POSITIVE_INFINITY]) expect(starsOf(score), String(score)).toBe(0);
  });
});

describe("the module stays pure: client components import it (Tasks 3 and 5)", () => {
  const source = readFileSync("src/domain/review.ts", "utf8");
  const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);

  test("it imports no server, no database and no node module, and not the schema", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/^@\/server\b/);
      expect(spec, spec).not.toMatch(/^@\/db\b/);
      expect(spec, spec).not.toMatch(/^node:/);
    }
    expect(source).not.toMatch(/\brequire\(/);
  });
  test("it holds no lookbehind and no Object.hasOwn (iOS Safari before 16.4)", () => {
    expect(source).not.toMatch(new RegExp(["\\(\\?<", "="].join("") + "|" + ["\\(\\?<", "!"].join("")));
    expect(source).not.toContain(["Object", "hasOwn"].join("."));
  });
  test("it takes the text limit from domain/protocols.ts, not a copy of the number", () => {
    expect(imports).toContain("./protocols");
    expect(source).toMatch(/REVIEW_TEXT_MAX\s*=\s*FEEDBACK_TEXT_MAX/);
  });
});
