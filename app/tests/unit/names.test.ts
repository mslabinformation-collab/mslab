import { describe, expect, it } from "vitest";
import { allative, firstName } from "@/domain/names";

// The admin's greeting and mail lines address a student by her first name and its „-le“ form (analysis/strings.md S5): „Saada Katile“.
// The rule: +„le“ after a vowel, +„ile“ after anything else, for Latin and Cyrillic names in any case; a Cyrillic name takes the Cyrillic
// ending („ле“, „иле“), a Latin one the Latin ending.

/** The Cyrillic ending „ле“ and „иле“, as code points (no look-alike Latin letters in the expectations). */
const CYR_LE = "ле";
const CYR_ILE = "иле";

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
    for (const vowel of ["а", "е", "ё", "и", "о", "у", "ы", "э", "ю", "я"]) {
      expect(allative(`Ан${vowel}`)).toBe(`Ан${vowel}${CYR_LE}`);
    }
    for (const consonant of ["б", "в", "г", "д", "к", "л", "м", "н", "й", "ь", "ъ"]) {
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
