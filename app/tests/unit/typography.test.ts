import { describe, expect, test } from "vitest";
import { keepNamesTogether } from "@/lib/typography";

describe("keepNamesTogether (popup title, round 2 item 8)", () => {
  test("two Title-case Latin words stay together; all-caps words and other text wrap as before", () => {
    expect(keepNamesTogether("−15% Lash Lift BOTOX koolitusele")).toBe("−15% Lash Lift BOTOX koolitusele");
    expect(keepNamesTogether("−15% на курс Lash Lift BOTOX")).toBe("−15% на курс Lash Lift BOTOX");
    expect(keepNamesTogether("Brow Lamination Pro Course")).toBe("Brow Lamination Pro Course");
    expect(keepNamesTogether("MS LAB Koolituskeskus")).toBe("MS LAB Koolituskeskus");
    expect(keepNamesTogether("Talvine pakkumine")).toBe("Talvine pakkumine");
    expect(keepNamesTogether("Мария Соснина")).toBe("Мария Соснина"); // Cyrillic names wrap as any text
  });
});

// The final review: the old rule had a lookbehind, which stops the whole script on iOS Safari before 16.4, and the home page's two popup cards
// bring typography.ts to the browser. This is the old rule, word for word (the tests run on Node, which has lookbehinds): keepNamesTogether
// must answer exactly as it did.
const BEFORE = new RegExp(["(?<", "![\\p{L}\\p{N}])(\\p{Lu}\\p{Ll}+) (?=\\p{Lu}\\p{Ll}+(?![\\p{L}\\p{N}]))"].join(""), "gu");
const before = (text: string): string => text.replace(BEFORE, (_, word: string) => (/^[A-Za-z]+$/.test(word) ? `${word}\u00a0` : `${word} `));

describe("keepNamesTogether answers as its old rule did (final review: no lookbehind)", () => {
  test("the old rule is the oracle", () => {
    expect(before("Lash Lift BOTOX")).toBe("Lash\u00a0Lift BOTOX");
    expect(before("aLash Lift")).toBe("aLash Lift");
  });

  test("the popups' texts and the edges: a word glued to a letter, a number or a letter beyond the BMP before it, Cyrillic and Estonian title case, the ends", () => {
    const cases = [
      "−15% Lash Lift BOTOX koolitusele", "−15% на курс Lash Lift BOTOX", "Brow Lamination Pro Course", "aLash Lift", "1Lash Lift", "Lash Lift1",
      "Lash Liftx", "Lash LiftX", "Lash  Lift", "Lash\u00a0Lift", "(Lash Lift)", "Lash Lift. Brow Pro", "Õie Lill", "Ärni Lash Lift", "Мария Lash Lift",
      "\u{1d400}Lash Lift", "\ud835Lash Lift", "\udc00Lash Lift", "Lash \u{1d400}b", "\u01c5a Lash", "", "L", "La", "La Lo", "LaLo Ma",
      "ProX Course Lash Lift", "x Brow Lamination ProX Course Today",
    ];
    for (const text of cases) expect(keepNamesTogether(text), JSON.stringify(text)).toBe(before(text));
  });

  test("every string of up to six of the characters that matter", () => {
    const chars = ["L", "a", "М", "я", "1", " ", "\u00a0", "\u{1d400}", "\ud835"]; // (an ASCII word's letters and others', a number, two spaces, a letter beyond the BMP, a broken one)
    let count = 0;
    const walk = (s: string, depth: number) => {
      count++;
      if (keepNamesTogether(s) !== before(s)) expect(keepNamesTogether(s), JSON.stringify(s)).toBe(before(s));
      if (depth < 6) for (const c of chars) walk(s + c, depth + 1);
    };
    walk("", 0);
    expect(count).toBe([0, 1, 2, 3, 4, 5, 6].reduce((n, k) => n + chars.length ** k, 0));
  });
});
