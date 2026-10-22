import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allative, firstName } from "@/domain/names";

// The admin's greeting and mail lines address a student by her first name and its „-le“ form (analysis/strings.md S5): „Saada Katile“.
// The rule: +„le“ after a vowel, +„ile“ after anything else, for Latin and Cyrillic names in any case; a Cyrillic name takes the Cyrillic
// ending („ле“, „иле“), a Latin one the Latin ending.

/** The Cyrillic ending „ле“ and „иле“, as code points (no look-alike Latin letters in the expectations). */
const CYR_LE = String.fromCharCode(0x43b, 0x435);
const CYR_ILE = String.fromCharCode(0x438, 0x43b, 0x435);

describe("firstName", () => {
  it("is the first word of the full name, trimmed", () => {
    expect(firstName("  Kati  Kask ")).toBe("Kati");
    expect(firstName("Mari-Liis Tamm")).toBe("Mari-Liis");
    expect(firstName("Мария Иванова")).toBe("Мария");
  });

  it("is the whole text for one word, and empty for nothing", () => {
    expect(firstName("Kati")).toBe("Kati");
    expect(firstName("   ")).toBe("");
    expect(firstName("")).toBe("");
  });

  it("takes tabs and line breaks as word breaks too", () => {
    expect(firstName("Kati\tKask")).toBe("Kati");
    expect(firstName("Kati\nKask")).toBe("Kati");
  });
});

describe("allative (S5)", () => {
  it("adds „le“ after a vowel", () => {
    expect(allative("Kati")).toBe("Katile");
    expect(allative("Anu")).toBe("Anule");
    expect(allative("Merike")).toBe("Merikele");
    expect(allative("Mari-Anne")).toBe("Mari-Annele");
    expect(allative("Helju")).toBe("Heljule");
  });

  it("adds „ile“ after anything else", () => {
    expect(allative("Kristjan")).toBe("Kristjanile");
    expect(allative("Mari-Liis")).toBe("Mari-Liisile");
    expect(allative("Liis")).toBe("Liisile");
  });

  it("knows the Estonian vowels õ ä ö ü and y", () => {
    expect(allative("Tõnõ")).toBe("Tõnõle");
    expect(allative("Pärä")).toBe("Päräle");
    expect(allative("Köö")).toBe("Kööle");
    expect(allative("Tüü")).toBe("Tüüle");
    expect(allative("Kay")).toBe("Kayle");
  });

  it("works for Cyrillic names: a vowel gets „ле“, anything else „иле“", () => {
    expect(allative("Мария")).toBe("Марияле");
    expect(allative("Олег")).toBe("Олегиле");
    expect(allative("Ольга")).toBe("Ольгале");
    expect(allative("Юрий")).toBe("Юрийиле"); // „й“ is not a vowel
    expect(allative("Наталья")).toBe("Натальяле"); // ends in „я“
    expect(allative("Любовь")).toBe("Любовьиле"); // „ь“ is not a vowel
  });

  it("knows every Cyrillic vowel: а е ё и о у ы э ю я", () => {
    for (const code of [0x430, 0x435, 0x451, 0x438, 0x43e, 0x443, 0x44b, 0x44d, 0x44e, 0x44f]) {
      const vowel = String.fromCharCode(code);
      expect(allative(`Ан${vowel}`)).toBe(`Ан${vowel}${CYR_LE}`);
    }
    for (const code of [0x431, 0x432, 0x433, 0x434, 0x43a, 0x43b, 0x43c, 0x43d, 0x439, 0x44c, 0x44a]) {
      const consonant = String.fromCharCode(code);
      expect(allative(`Ан${consonant}`)).toBe(`Ан${consonant}${CYR_ILE}`);
    }
  });

  it("a Cyrillic name takes the Cyrillic ending, a Latin one the Latin ending (the script of the last letter)", () => {
    expect(allative("Мария").endsWith(CYR_LE)).toBe(true); // „ле“, not Latin „le“
    expect(allative("Олег").endsWith(CYR_ILE)).toBe(true); // „иле“, not Latin „ile“
    expect(/^[Ѐ-ӿ]+$/.test(allative("Мария"))).toBe(true);
    expect(/^[Ѐ-ӿ]+$/.test(allative("Олег"))).toBe(true);
    expect(/^[A-Za-z-]+$/.test(allative("Mari-Liis"))).toBe(true);
  });

  it("does not mind the case of the last letter", () => {
    expect(allative("KATI")).toBe("KATIle");
    expect(allative("KRISTJAN")).toBe("KRISTJANile");
    expect(allative("МАРИЯ")).toBe(`МАРИЯ${CYR_LE}`); // МАРИЯ
    expect(allative("ÕÕ")).toBe("ÕÕle");
  });

  it("leaves an empty name empty (nothing to address)", () => {
    expect(allative("")).toBe("");
  });

  it("is used on a first name: firstName then allative", () => {
    expect(allative(firstName("  Kati  Kask "))).toBe("Katile");
    expect(allative(firstName("Олег Иванов"))).toBe("Олегиле");
  });
});

describe("names.ts itself", () => {
  it("types no Cyrillic letter in its code: the vowels and the endings are built from code points (comments may)", () => {
    const source = readFileSync(join(process.cwd(), "src/domain/names.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const cyrillic = new RegExp("[" + String.fromCharCode(0x400) + "-" + String.fromCharCode(0x4ff) + "]");
    expect(code).not.toMatch(cyrillic);
    expect(code).toContain("String.fromCharCode(0x430");
  });
});
