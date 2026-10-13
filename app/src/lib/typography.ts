/** A Title-case word followed by one space and another Title-case word that ends there (the next one is the lookahead, so it can start a run too). */
const PAIR = /(\p{Lu}\p{Ll}+) (?=\p{Lu}\p{Ll}+(?![\p{L}\p{N}]))/gu;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

/** The code point that ends `text` before `at` (a surrogate pair is one, as for the `u` flag), or "" at the start. */
function before(text: string, at: number): string {
  const last = Array.from(text.slice(Math.max(0, at - 2), at));
  return last.length > 0 ? last[last.length - 1] : "";
}

/**
 * Keeps a run of Title-case Latin words ("Lash Lift") on one line, whatever the language around it: the spaces between
 * them become no-break spaces. Product names are written that way ("Lash Lift BOTOX"); Estonian and Russian sentences
 * almost never have two such words in a row, and an all-caps word ("BOTOX", "MS LAB") is left to wrap (N6).
 * A word glued to a letter or a number before it is no word of its own and is left as it is. This runs in the browser (the home page's popup
 * cards), on iOS Safari before 16.4 too, so it has no lookbehind (tests/unit/old-safari.test.ts): what comes before is read by hand. (A match
 * that is left as it is takes nothing another could start with: inside it there is no capital after its first letter.)
 */
export function keepNamesTogether(text: string): string {
  return text.replace(PAIR, (match: string, word: string, at: number) => {
    if (LETTER_OR_NUMBER.test(before(text, at))) return match;
    return /^[A-Za-z]+$/.test(word) ? `${word}\u00a0` : `${word} `;
  });
}
