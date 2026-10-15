// The e-course certificate's pure rules (phase 3d, spec §3–§5): the limits, Seaded → Tunnistus's defaults and their defensive read, the
// name rules, the number and its file name, the next number with the year's turn at Tallinn midnight, and the course's competency lines.
// No database, no React: the server, Maria's screens and the student's "Tunnistus" row share them. It runs in the browser too (the name
// field, Seaded), on iOS Safari before 16.4 as well: no lookbehind here nor in what it imports (tests/unit/old-safari.test.ts).

import { tallinnFormParts } from "./calendar";

/**
 * The name 2–80 characters; at most 16 competency lines of at most 120 characters; the volume, the place, the registry code, the practical
 * line and the trainer's name at most these characters (spec §3, §5).
 */
export const CERT_LIMITS = { nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 } as const;

/** The `settings` key "certificate" as read (readCertificateSettings): what Seaded → Tunnistus sets and the number series' next number. */
export type CertificateSettings = {
  place: string;
  registryCode: string;
  practicalLine: string;
  /** Written in the script font where the signature goes, while there is no signature image. */
  trainerName: string;
  /** The next certificate of `nextYear` gets `nextSeq` (nextNumber); another year starts at 1. */
  nextYear: number;
  nextSeq: number;
  /** The private R2 object `certificate/signature-<uuid>.png` (white ink on transparent), or null. */
  signatureKey: string | null;
};

/** Before Maria saves Seaded → Tunnistus (spec §3). The practical line is a draft for her. */
export const CERT_DEFAULTS = {
  place: "Pärnu linn",
  registryCode: "16346048",
  practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
  trainerName: "Maria Sosnina",
} as const;

/** The Tallinn calendar year of a moment: 31.12 22:30 UTC is already the next year in Tallinn (UTC+2 in winter). */
export function tallinnYear(d: Date): number {
  return Number(tallinnFormParts(d).date.slice(0, 4));
}

/** "dd.mm.yyyy" of the Tallinn date of a moment: the date the PDF prints after the place. */
export function tallinnDateText(d: Date): string {
  const [y, m, day] = tallinnFormParts(d).date.split("-");
  return `${day}.${m}.${y}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The stored setting read defensively (jsonb: anything). Each text is trimmed; a missing, blank or over-long one is the default. The next
 * number is a pair: a whole year 2000–9999 and a whole number from 1, else both are the default (this Tallinn year, 1). The signature key
 * counts only under "certificate/": the PDF never reads any other object of the store.
 */
export function readCertificateSettings(value: unknown, now: Date): CertificateSettings {
  const v = isObject(value) ? value : {};
  const text = (key: keyof typeof CERT_DEFAULTS, max: number): string => {
    const s = typeof v[key] === "string" ? (v[key] as string).trim() : "";
    return s && s.length <= max ? s : CERT_DEFAULTS[key];
  };
  const numbered = wholeIn(v.nextYear, 2000, 9999) && wholeIn(v.nextSeq, 1, Number.MAX_SAFE_INTEGER);
  const key = v.signatureKey;
  return {
    place: text("place", CERT_LIMITS.place),
    registryCode: text("registryCode", CERT_LIMITS.registryCode),
    practicalLine: text("practicalLine", CERT_LIMITS.practicalLine),
    trainerName: text("trainerName", CERT_LIMITS.trainerName),
    nextYear: numbered ? (v.nextYear as number) : tallinnYear(now),
    nextSeq: numbered ? (v.nextSeq as number) : 1,
    signatureKey: typeof key === "string" && key.startsWith("certificate/") ? key : null,
  };
}

/**
 * The letters a name may hold: the Latin and Cyrillic letters (\p{Script=Latin} / \p{Script=Cyrillic}) that the script font, Great Vibes,
 * draws. That is A–Z, the Latin-1 letters, Latin Extended-A but ŉ and ſ, Romanian Ș ș Ț ț, Latin Extended Additional (Vietnamese) but
 * the few it lacks, and Cyrillic А–я with Ѐ–Џ, ѐ–џ and Ґ ґ (Russian, Ukrainian, Belarusian, Serbian, Macedonian, Bulgarian). A Latin or
 * Cyrillic letter outside it (IPA, most of Latin Extended-B, Kazakh Қ, fullwidth Ａ) would print as an empty box, so it is refused like a
 * digit (tests/unit/certificate-pdf.test.ts asks the font for every letter accepted here).
 */
const LETTER = /^[A-Za-zÀ-ÖØ-öø-ňŊ-žȘ-țЀ-џҐґḀ-ẕẞẠ-ỹ]$/;
/** Between the letters: a space, a hyphen, an apostrophe (' or ’) or a dot. */
const JOINERS = " -'’.";

/**
 * The name on the certificate (spec §5): NFC, trimmed, every run of white space one space; 2–80 characters ("length"); then only letters
 * (LETTER) and joiners, with at least two letters ("letters": "Kasuta nimes ainult tähti, tühikuid ja sidekriipse"). A digit, an emoji or a
 * letter the font lacks is refused before anything is stored.
 */
export function checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" } {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  const chars = Array.from(name);
  if (chars.length < CERT_LIMITS.nameMin || chars.length > CERT_LIMITS.nameMax) return { ok: false, error: "length" };
  let letters = 0;
  for (const c of chars) {
    if (LETTER.test(c)) letters++;
    else if (!JOINERS.includes(c)) return { ok: false, error: "letters" };
  }
  return letters >= 2 ? { ok: true, name } : { ok: false, error: "letters" };
}

const seqText = (seq: number): string => String(seq).padStart(2, "0");

/** "MS LAB 2026-03" (spec §4): the number padded to at least 2 digits, so 2026-123 once the year reaches it. */
export function formatCertificateNumber(year: number, seq: number): string {
  return `MS LAB ${year}-${seqText(seq)}`;
}

/** "MS-LAB-tunnistus-2026-03.pdf": the download's file name (Content-Disposition). */
export function certificateFileName(year: number, seq: number): string {
  return `MS-LAB-tunnistus-${year}-${seqText(seq)}.pdf`;
}

/**
 * The number a certificate issued in `year` (its Tallinn year, tallinnYear) takes, and the setting after it (spec §4): the setting's
 * `nextSeq` when its `nextYear` is that year, else 1, so each year starts again at 1; then the setting is that year and the next number.
 */
export function nextNumber(s: { nextYear: number; nextSeq: number }, year: number): { year: number; seq: number; next: { nextYear: number; nextSeq: number } } {
  const seq = s.nextYear === year ? s.nextSeq : 1;
  return { year, seq, next: { nextYear: year, nextSeq: seq + 1 } };
}

/** A line as the PDF draws it: every run of white space (a line break too) one space, trimmed. */
const oneLine = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * The course's certificate lines (spec §3): its own "Oskused tunnistusel" when it has any, else its outcomes' Estonian texts ("Mida
 * õpid"); each on one line and trimmed, the blank ones left out, at most CERT_LIMITS.skills.
 */
export function certificateSkills(course: { certificateSkills: readonly string[]; outcomes: readonly { et: string }[] }): string[] {
  const own = course.certificateSkills.map(oneLine).filter(Boolean);
  const lines = own.length ? own : course.outcomes.map((o) => oneLine(o?.et)).filter(Boolean);
  return lines.slice(0, CERT_LIMITS.skills);
}
