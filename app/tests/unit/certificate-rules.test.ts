import { describe, expect, test } from "vitest";
import {
  CERT_DEFAULTS, CERT_LIMITS, certificateFileName, certificateSkills, checkCertificateName, formatCertificateNumber, nextNumber, readCertificateSettings,
  tallinnDateText, tallinnYear,
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

  test("Cyrillic and other European letters print, so they are accepted", () => {
    for (const name of ["Мария Соснина", "Ёлкина Анна", "Олеся Ґудзь-Їжакевич", "Ўладзімір Шчэрба", "Zoë Brontë", "Łucja Wąsik", "Ștefan Țepeș", "Ægir Ørsted", "Nguyễn Thị Ánh"])
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
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

  test("a Latin or Cyrillic letter the script font cannot draw is refused like a digit (it would print as an empty box)", () => {
    for (const name of ["Қайрат", "Әлия", "Ａnna", "ſara", "ʃana", "Ƿynn", "Ѳеодор"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
    for (const name of ["Αθηνά", "王芳", "שרה", "Ann̲a"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" }); // Greek, Chinese, Hebrew, a combining mark
  });

  test("every letter the rule accepts is a Latin or Cyrillic letter (\\p{L}, Script=Latin or Cyrillic)", () => {
    const accepted: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (r.ok) accepted.push(...Array.from(r.name));
    }
    expect(accepted.length).toBeGreaterThan(400);
    expect(accepted.filter((c) => !/^\p{L}$/u.test(c) || !/^[\p{Script=Latin}\p{Script=Cyrillic}]$/u.test(c))).toEqual([]);
  });
});

describe("readCertificateSettings: the stored setting read defensively", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const defaults = { ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 1, signatureKey: null };

  test("nothing stored, or not an object: the defaults, this Tallinn year and 1", () => {
    for (const value of [null, undefined, "x", 5, [], true]) expect(readCertificateSettings(value, now)).toEqual(defaults);
    expect(readCertificateSettings(null, new Date("2026-12-31T22:30:00Z"))).toMatchObject({ nextYear: 2027, nextSeq: 1 });
  });

  test("a well-formed setting as it is, its texts trimmed", () => {
    const stored = { place: " Tallinn ", registryCode: "12345678", practicalLine: "Praktiline töö", trainerName: "Maria", nextYear: 2026, nextSeq: 14, signatureKey: "certificate/signature-0b5e.png" };
    expect(readCertificateSettings(stored, now)).toEqual({ ...stored, place: "Tallinn" });
  });

  test("each malformed text is its default: missing, not a string, blank, or over its limit", () => {
    expect(readCertificateSettings({ place: "   ", registryCode: 16346048, trainerName: "x".repeat(61), practicalLine: "y".repeat(201) }, now)).toEqual(defaults);
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

  test("the signature key counts only under certificate/", () => {
    for (const signatureKey of ["img/0b5e.png", "practical/a.jpg", "", 5, null]) expect(readCertificateSettings({ signatureKey }, now).signatureKey).toBeNull();
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
});
