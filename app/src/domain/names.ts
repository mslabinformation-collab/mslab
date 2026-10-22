// A student's name in a sentence (the A screens, Task 1; analysis/strings.md S5): the admin's greeting and the lines that address one person use her
// first name and its allative („Saada Katile“). Pure and import-free: the browser runs it too (tests/unit/old-safari.test.ts).

/** The first word of a full name, trimmed ("" for none): "  Kati  Kask " is "Kati". */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

// The vowels S5 names: the Latin ones with Estonian õ ä ö ü (and y), and the Cyrillic а е ё и о у ы э ю я. The Cyrillic ones are escapes so that no
// look-alike Latin letter can stand in for one. Lower case: the last letter is lowered before it is looked up.
const LATIN_VOWELS = "aeiouõäöüy";
const CYRILLIC_VOWELS = "аеёиоуыэюя";
// The endings after a Cyrillic name are Cyrillic: „ле“ and „иле“.
const CYRILLIC_LE = "ле";
const CYRILLIC_ILE = "иле";

/** Is this letter Cyrillic? (The Cyrillic block, U+0400–U+04FF.) */
const isCyrillic = (letter: string): boolean => /[Ѐ-ӿ]/.test(letter);

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
