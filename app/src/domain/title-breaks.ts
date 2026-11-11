// A course title's line breaks (UX pass 11.11 P18): on a phone „Lash Lift BOTOX baaskoolitus“ broke inside the product's name. A run of two or three
// capitalised words of at most 20 letters in all (a name: „Lash Lift BOTOX“, „Kulmude LAMI“) is joined by no-break spaces, so it wraps as one word.
// Pure and import-free (tests/unit/title-breaks.test.ts).

const NBSP = " ";
const MAX_WORDS = 3;
const MAX_LENGTH = 20;

const capitalised = (word: string) => /^\p{Lu}/u.test(word);

export function keepNameTogether(title: string): string {
  const words = title.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let end = i;
    while (end < words.length && capitalised(words[end])) end++;
    const run = words.slice(i, end);
    if (run.length >= 2 && run.length <= MAX_WORDS && run.join(" ").length <= MAX_LENGTH) {
      out.push(run.join(NBSP));
      i = end;
    } else if (run.length > 0) {
      out.push(...run);
      i = end;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(" ");
}
