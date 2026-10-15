import { describe, expect, test } from "vitest";
import {
  CERT_DEFAULTS, CERT_LIMITS, certificateFileName, certificateSkills, checkCertificateName, formatCertificateNumber, nextNumber, outcomesTooLong,
  readCertificateSettings, seqToIssue, tallinnDateText, tallinnYear,
} from "@/domain/certificate";

// The certificate's pure rules (phase 3d, spec §3–§5, §10 unit): the limits and the defaults, the stored setting read defensively, the name
// rules (Review Focus 2), the number and the file name, the next number at the year's turn in Tallinn (Review Focus 3) and the course's lines.

describe("the limits and the defaults (spec §3)", () => {
  test("as the spec and the plan name them", () => {
    expect(CERT_LIMITS).toEqual({ nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 });
    expect(CERT_DEFAULTS).toEqual({
      place: "Pärnu linn",
      registryCode: "16346048",
      practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
      trainerName: "Maria Sosnina",
    });
  });
});

describe("Review Focus 3: the year turns at Tallinn midnight", () => {
  test("tallinnYear and tallinnDateText: 22:30 UTC on 31.12 is already 1 January in Tallinn (UTC+2); 21:59 is not", () => {
    expect(tallinnYear(new Date("2026-12-31T21:59:59Z"))).toBe(2026);
    expect(tallinnDateText(new Date("2026-12-31T21:59:59Z"))).toBe("31.12.2026");
    expect(tallinnYear(new Date("2026-12-31T22:30:00Z"))).toBe(2027);
    expect(tallinnDateText(new Date("2026-12-31T22:30:00Z"))).toBe("01.01.2027");
    // summer time (UTC+3): 21:30 UTC on 30 June is 1 July in Tallinn
    expect(tallinnDateText(new Date("2026-06-30T21:30:00Z"))).toBe("01.07.2026");
    expect(tallinnDateText(new Date("2026-10-15T09:00:00Z"))).toBe("15.10.2026");
  });

  test("nextNumber: the setting's number in its own year; the next year starts at 1, and Maria's number for the old year does not carry over", () => {
    const setting = { nextYear: 2026, nextSeq: 7 };
    expect(nextNumber(setting, tallinnYear(new Date("2026-12-31T21:30:00Z")))).toEqual({ year: 2026, seq: 7, next: { nextYear: 2026, nextSeq: 8 } });
    expect(nextNumber(setting, tallinnYear(new Date("2026-12-31T22:30:00Z")))).toEqual({ year: 2027, seq: 1, next: { nextYear: 2027, nextSeq: 2 } });
    // the next issue of the new year continues from the setting the first one left
    expect(nextNumber({ nextYear: 2027, nextSeq: 2 }, 2027)).toEqual({ year: 2027, seq: 2, next: { nextYear: 2027, nextSeq: 3 } });
    // a setting of another year, earlier or later, gives 1 (spec §4: seq = nextSeq only when nextYear is the issue's year)
    expect(nextNumber({ nextYear: 2025, nextSeq: 40 }, 2026)).toEqual({ year: 2026, seq: 1, next: { nextYear: 2026, nextSeq: 2 } });
    expect(nextNumber({ nextYear: 2027, nextSeq: 5 }, 2026)).toEqual({ year: 2026, seq: 1, next: { nextYear: 2026, nextSeq: 2 } });
  });
});

describe("seqToIssue: the number an issue takes — the one rule of the issue, Seaded's save and Seaded's card (spec §4 as amended)", () => {
  // (setting, the Tallinn year of the issue, the highest seq already issued in that year, 0 for none) → the number taken and the setting after it
  const CASES: { name: string; setting: { nextYear: number; nextSeq: number }; year: number; top: number; takes: [number, number] }[] = [
    { name: "this year, nothing issued: the setting's number", setting: { nextYear: 2026, nextSeq: 3 }, year: 2026, top: 0, takes: [2026, 3] },
    { name: "this year, the setting is just past the highest: kept", setting: { nextYear: 2026, nextSeq: 15 }, year: 2026, top: 14, takes: [2026, 15] },
    { name: "this year, ahead of the highest (Maria's jump): kept", setting: { nextYear: 2026, nextSeq: 20 }, year: 2026, top: 14, takes: [2026, 20] },
    { name: "this year, behind the highest (the default 1 of a deleted row, or a number Maria set long ago): the highest + 1", setting: { nextYear: 2026, nextSeq: 1 }, year: 2026, top: 14, takes: [2026, 15] },
    { name: "this year, equal to the highest: the highest + 1", setting: { nextYear: 2026, nextSeq: 14 }, year: 2026, top: 14, takes: [2026, 15] },
    { name: "the previous year's setting, nothing issued this year yet (January): the new year starts at 1", setting: { nextYear: 2026, nextSeq: 15 }, year: 2027, top: 0, takes: [2027, 1] },
    { name: "the previous year's setting, this year's numbers already begun: the highest + 1", setting: { nextYear: 2026, nextSeq: 15 }, year: 2027, top: 3, takes: [2027, 4] },
    { name: "a setting for next year (a preset in December) is not used before that year: this year's highest + 1", setting: { nextYear: 2027, nextSeq: 20 }, year: 2026, top: 14, takes: [2026, 15] },
    { name: "a setting for next year, once that year has come: its number", setting: { nextYear: 2027, nextSeq: 20 }, year: 2027, top: 0, takes: [2027, 20] },
    { name: "a setting for next year, once that year has come and passed it: the highest + 1", setting: { nextYear: 2027, nextSeq: 20 }, year: 2027, top: 25, takes: [2027, 26] },
  ];
  test.each(CASES)("$name", ({ setting, year, top, takes: [takesYear, takesSeq] }) => {
    expect(seqToIssue(setting, year, top)).toEqual({ year: takesYear, seq: takesSeq, next: { nextYear: takesYear, nextSeq: takesSeq + 1 } });
  });

  test("a deleted or malformed setting reads as this year's number 1 (readCertificateSettings), and the highest still wins", () => {
    const now = new Date("2026-10-15T09:00:00Z");
    const stored = readCertificateSettings(undefined, now);
    expect(seqToIssue(stored, tallinnYear(now), 0)).toMatchObject({ year: 2026, seq: 1 });
    expect(seqToIssue(stored, tallinnYear(now), 14)).toMatchObject({ year: 2026, seq: 15 });
  });

  test("with nothing issued it is nextNumber, and never below it: the number is nextNumber's or the highest + 1, whichever is larger", () => {
    for (const setting of [{ nextYear: 2026, nextSeq: 7 }, { nextYear: 2025, nextSeq: 40 }, { nextYear: 2027, nextSeq: 5 }])
      for (const top of [0, 3, 7, 50]) {
        const wanted = nextNumber(setting, 2026);
        expect(seqToIssue(setting, 2026, top).seq).toBe(Math.max(wanted.seq, top + 1));
      }
    expect(seqToIssue({ nextYear: 2026, nextSeq: 7 }, 2026, 0)).toEqual(nextNumber({ nextYear: 2026, nextSeq: 7 }, 2026));
  });
});

describe("the number and the file name (spec §4, §5)", () => {
  test("padded to at least 2 digits", () => {
    expect(formatCertificateNumber(2026, 3)).toBe("MS LAB 2026-03");
    expect(formatCertificateNumber(2026, 12)).toBe("MS LAB 2026-12");
    expect(formatCertificateNumber(2026, 123)).toBe("MS LAB 2026-123");
    expect(certificateFileName(2026, 3)).toBe("MS-LAB-tunnistus-2026-03.pdf");
    expect(certificateFileName(2027, 104)).toBe("MS-LAB-tunnistus-2027-104.pdf");
  });
});

describe("Review Focus 2: the name rules (spec §5)", () => {
  test("Estonian letters, a double surname with a hyphen, apostrophes and dots", () => {
    for (const name of ["Kertu Õunapuu", "Mari-Liis Tamm-Šmidt", "Žanna Äär", "Ülle Öövel", "D'Artagnan O’Neill", "Anna M. Kask", "Jõe", "Li"])
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
  });

  test("Finnish, German, French, Scandinavian, Spanish, Portuguese and Italian names print too, so they are accepted", () => {
    for (const name of ["Päivi Hämäläinen", "Jürgen Weiß", "François Müller-Weiß", "Chloé Dubois", "Åsa Lindqvist", "Søren Ørsted", "Ægir Þórunn", "Zoë Brontë", "José Peña", "Cañizares", "João Gonçalves", "Niccolò Alighieri", "Œdipe Ÿvonne"])
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
  });

  test("a name is written in Latin letters, as in the passport: Cyrillic and the letters of Latvian, Lithuanian, Polish, Czech, Romanian and Icelandic are refused", () => {
    for (const name of ["Мария Соснина", "Ёлкина Анна", "Олеся Ґудзь-Їжакевич", "Jānis Bērziņš", "Łukasz Wąsik", "Čapek Šimek", "Ștefan Țepeș", "Žilvinas Ūdra", "Nguyễn Thị Ánh", "Guðrún", "Dagþór", "Đorđe"])
      expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
  });

  test("cleaned first: NFC, trimmed, every run of white space one space", () => {
    expect(checkCertificateName("  Kertu \t\n Õunapuu  ")).toEqual({ ok: true, name: "Kertu Õunapuu" });
    expect(checkCertificateName("Kertu Õunapuu")).toEqual({ ok: true, name: "Kertu Õunapuu" }); // a no-break space; õ as o + combining tilde
    expect(checkCertificateName("Kertu Õunapuu")).toEqual({ ok: true, name: "Kertu Õunapuu" });
  });

  test("length: 2–80 characters after the cleaning", () => {
    expect(checkCertificateName("A")).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName("   A   ")).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName("")).toEqual({ ok: false, error: "length" });
    const long = `Anna-Maria ${"Õ".repeat(69)}`; // 80
    expect(Array.from(long)).toHaveLength(80);
    expect(checkCertificateName(long)).toEqual({ ok: true, name: long });
    expect(checkCertificateName(`${long}a`)).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName(`  ${long}  `)).toEqual({ ok: true, name: long }); // measured after trimming
  });

  test("letters: an emoji, digits or another sign are refused, and so is a name with fewer than two letters", () => {
    for (const name of ["Kertu 🌸", "Kertu2", "Kertu Tamm 3", "Kertu_Tamm", "Kertu@Tamm", "Kertu, Tamm", "Kertu (Tamm)", "Kertu/Tamm", "Kertu Tamm!"])
      expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
    for (const name of ["--", "A.", "' '", "A -"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
  });

  test("a letter the script font cannot draw is refused like a digit (it would print as an empty box)", () => {
    for (const name of ["Ａnna", "ſara", "ʃana", "Ƿynn", "Kŵsi", "×Anna", "Anna÷Mari", "Aª", "Mº"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
    for (const name of ["Αθηνά", "Қайрат", "王芳", "שרה", "Ann̲a"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" }); // Greek, Kazakh, Chinese, Hebrew, a combining mark
  });

  test("the letters the rule accepts are exactly the Latin ones Revive 80 Signature draws: A–Z a–z À–Ö Ø–ï ñ–ö ø–ý ÿ ı Œ œ Š š Ÿ Ž ž (120)", () => {
    const accepted = new Set<string>();
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (r.ok) for (const c of Array.from(r.name)) accepted.add(c);
    }
    const expected = new Set<string>();
    for (const [from, to] of [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0xd6], [0xd8, 0xef], [0xf1, 0xf6], [0xf8, 0xfd], [0xff, 0xff], [0x131, 0x131], [0x152, 0x153], [0x160, 0x161], [0x178, 0x178], [0x17d, 0x17e]])
      for (let cp = from; cp <= to; cp++) expected.add(String.fromCodePoint(cp));
    expect(expected.size).toBe(120);
    expect([...accepted].sort()).toEqual([...expected].sort());
    // every one is a Latin letter; ð (U+00F0) and þ (U+00FE), which the font lacks, and º (a sign, not a name letter) are out
    expect([...accepted].filter((c) => !/^\p{L}$/u.test(c) || !/^\p{Script=Latin}$/u.test(c))).toEqual([]);
    expect(["ð", "þ", "º", "ª", "×", "÷"].filter((c) => accepted.has(c))).toEqual([]);
    expect(["Ð", "Þ", "ß", "ı"].filter((c) => !accepted.has(c))).toEqual([]);
  });
});

describe("readCertificateSettings: the stored setting read defensively", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const defaults = { ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 1 };

  test("nothing stored, or not an object: the defaults, this Tallinn year and 1", () => {
    for (const value of [null, undefined, "x", 5, [], true]) expect(readCertificateSettings(value, now)).toEqual(defaults);
    expect(readCertificateSettings(null, new Date("2026-12-31T22:30:00Z"))).toMatchObject({ nextYear: 2027, nextSeq: 1 });
  });

  test("a well-formed setting as it is, its texts trimmed", () => {
    const stored = { place: " Tallinn ", registryCode: "12345678", practicalLine: "Praktiline töö", trainerName: "Maria", nextYear: 2026, nextSeq: 14 };
    expect(readCertificateSettings(stored, now)).toEqual({ ...stored, place: "Tallinn" });
  });

  test("each malformed text is its default: missing, not a string, blank, or over its limit", () => {
    // a registry code that is a number, not a string, and not the default's digits (else a read that took its digits would pass unseen)
    expect(readCertificateSettings({ place: "   ", registryCode: 12345678, trainerName: "x".repeat(61), practicalLine: "y".repeat(201) }, now)).toEqual(defaults);
    expect(readCertificateSettings({ place: "x".repeat(60), trainerName: "x".repeat(60), registryCode: "1".repeat(20), practicalLine: "y".repeat(200) }, now)).toMatchObject({
      place: "x".repeat(60),
      trainerName: "x".repeat(60),
      registryCode: "1".repeat(20),
      practicalLine: "y".repeat(200),
    });
  });

  test("the next number is a pair: a whole year 2000–9999 and a whole number from 1, else both are the default", () => {
    for (const [nextYear, nextSeq] of [[2026, 0], [2026, 1.5], [2026, "3"], [26, 3], [10_000, 3], [2026.5, 3], [null, 3], [2026, null]])
      expect(readCertificateSettings({ nextYear, nextSeq }, now), `${nextYear} ${nextSeq}`).toMatchObject({ nextYear: 2026, nextSeq: 1 });
    expect(readCertificateSettings({ nextYear: 2025, nextSeq: 31 }, now)).toMatchObject({ nextYear: 2025, nextSeq: 31 }); // nextNumber then starts 2026 at 1
  });

  test("the trainer's name is kept only when it can be printed: the name rules accept it (cleaned: NFC, trimmed, one space), else Maria's own", () => {
    expect(readCertificateSettings({ trainerName: "  Maria   Sosnina " }, now).trainerName).toBe("Maria Sosnina");
    expect(readCertificateSettings({ trainerName: "Õie-Mai Šõrmus" }, now).trainerName).toBe("Õie-Mai Šõrmus");
    // Cyrillic, a digit, an emoji, a single letter, a letter the font lacks, not a string, blank: the default
    for (const trainerName of ["Мария Соснина", "Maria 2", "Maria 🌸", "M", "Jānis Ozols", 5, null, "", "   "])
      expect(readCertificateSettings({ trainerName }, now).trainerName, String(trainerName)).toBe(CERT_DEFAULTS.trainerName);
    // longer than the trainer's limit (60) though within a name's (80): the default as well
    expect(readCertificateSettings({ trainerName: "A".repeat(61) }, now).trainerName).toBe(CERT_DEFAULTS.trainerName);
    expect(readCertificateSettings({ trainerName: "A".repeat(60) }, now).trainerName).toBe("A".repeat(60));
  });
});

describe("certificateSkills: the course's lines (spec §3)", () => {
  const outcomes = [{ et: " Kulmude kuju " }, { et: "" }, { et: "Värvimine\nja hooldus", ru: "Окрашивание" }];

  test("its own lines when it has any: trimmed, on one line, the blank ones left out", () => {
    expect(certificateSkills({ certificateSkills: [" Kulmude analüüs ", "  ", "Kulmude\tvärvimine"], outcomes })).toEqual(["Kulmude analüüs", "Kulmude värvimine"]);
  });

  test("else the outcomes' Estonian texts, the same way", () => {
    expect(certificateSkills({ certificateSkills: [], outcomes })).toEqual(["Kulmude kuju", "Värvimine ja hooldus"]);
    expect(certificateSkills({ certificateSkills: ["   "], outcomes })).toEqual(["Kulmude kuju", "Värvimine ja hooldus"]);
    expect(certificateSkills({ certificateSkills: [], outcomes: [] })).toEqual([]);
  });

  test("at most 16 lines", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Oskus ${i + 1}`);
    expect(certificateSkills({ certificateSkills: many, outcomes })).toEqual(many.slice(0, 16));
    expect(certificateSkills({ certificateSkills: [], outcomes: many.map((et) => ({ et })) })).toEqual(many.slice(0, 16));
  });

  test("M-4 outcomesTooLong: no line of its own, and one of the outcomes it prints is over CERT_LIMITS.skill (120) characters as the PDF writes it", () => {
    const fits = { et: "x".repeat(120) };
    const long = { et: "x".repeat(121) };
    expect(outcomesTooLong({ certificateSkills: [], outcomes: [fits, long] })).toBe(true);
    expect(outcomesTooLong({ certificateSkills: ["  "], outcomes: [long] })).toBe(true); // a blank line is none
    expect(outcomesTooLong({ certificateSkills: ["Oskus"], outcomes: [long] })).toBe(false); // its own lines are printed
    expect(outcomesTooLong({ certificateSkills: [], outcomes: [fits, { et: ` ${"y".repeat(60)}\n\n${"y".repeat(59)} ` }] })).toBe(false); // on one line: 120
    expect(outcomesTooLong({ certificateSkills: [], outcomes: [...Array.from({ length: 16 }, () => fits), long] })).toBe(false); // the 17th is not printed
    expect(outcomesTooLong({ certificateSkills: [], outcomes: [] })).toBe(false);
  });
});
