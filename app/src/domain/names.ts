// A student's name in a sentence (the A screens, Task 1; analysis/strings.md S5): the admin's greeting and the lines that address one person use her
// first name and its allative („Saada Katile“). Pure and import-free: the browser runs it too (tests/unit/old-safari.test.ts).

/** The first word of a full name, trimmed ("" for none): "  Kati  Kask " is "Kati". */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

// The vowels S5 names: the Latin ones with Estonian õ ä ö ü (and y), and the Cyrillic а е ё и о у ы э ю я. The Cyrillic letters are built from their
// code points (U+0430 …) and not typed as letters, so that no look-alike Latin letter can stand in for one (tests/unit/names.test.ts also checks that
// no Cyrillic letter is typed in this file's code). Lower case: the last letter is lowered before it is looked up.
const LATIN_VOWELS = "aeiouõäöüy";
const CYRILLIC_VOWELS = String.fromCharCode(0x430, 0x435, 0x451, 0x438, 0x43e, 0x443, 0x44b, 0x44d, 0x44e, 0x44f);
// The endings after a Cyrillic name are Cyrillic: „ле“ (U+043B U+0435) and „иле“ (U+0438 then „ле“).
const CYRILLIC_LE = String.fromCharCode(0x43b, 0x435);
const CYRILLIC_ILE = String.fromCharCode(0x438) + CYRILLIC_LE;

/** Is this letter in the Cyrillic block (U+0400 to U+04FF)? */
const isCyrillic = (letter: string): boolean => {
  const code = letter.charCodeAt(0);
  return code >= 0x400 && code <= 0x4ff;
};

/**
 * The allative of a first name (S5): „le“ after a vowel, „ile“ after anything else — "Kati" is "Katile", "Kristjan" "Kristjanile", "Мария" "Марияле",
 * "Олег" "Олегиле". The ending is in the script of the name's last letter: Cyrillic („ле“, „иле“) after a Cyrillic one, else Latin. Any case; the
 * ending is added as it stands, in lower case. An empty name stays empty.
 */
export function allative(first: string): string {
  if (first === "") return "";
  const last = first.charAt(first.length - 1).toLowerCase();
  if (isCyrillic(last)) return first + (CYRILLIC_VOWELS.includes(last) ? CYRILLIC_LE : CYRILLIC_ILE);
  return first + (LATIN_VOWELS.includes(last) ? "le" : "ile");
}
