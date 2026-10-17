// The text helpers the PDFs share (contracts, Task 2: extracted from server/invoice-pdf.ts, whose output did not change by it; the contract's
// PDF, server/contract-pdf.ts, uses them too). Pure functions over strings and a font's measure: no pdf-lib, no I/O.

/**
 * `text` cleaned for drawing: white space is one space, control and format characters are dropped, a character `chars` (the font's character
 * set) lacks is "?", never a missing-glyph box. `keepNoBreakSpace` leaves the no-break spaces (U+00A0) as they are, where the text is typeset
 * (a contract's Russian paragraphs, "350,00 €"); the invoice's short fields have none of it, and its output is as it was.
 */
export function clean(text: string, chars: ReadonlySet<number>, keepNoBreakSpace = false): string {
  const spaced = text.replace(keepNoBreakSpace ? /[^\S\xa0]+/g : /\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ {2,}/g, " ").trim();
  return Array.from(spaced, (ch) => (chars.has(ch.codePointAt(0)!) ? ch : "?")).join("");
}

/**
 * `text` broken at its spaces into lines that fit `width`, a word wider than the box broken at the box; past `maxLines` the last line is cut and
 * ends in "…".
 */
export function wrap(text: string, fits: (line: string) => boolean, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!word) continue;
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (!fits(rest)) {
      const chars = Array.from(rest);
      let n = 1;
      while (n < chars.length - 1 && fits(chars.slice(0, n + 1).join(""))) n++;
      lines.push(chars.slice(0, n).join(""));
      rest = chars.slice(n).join("");
    }
    line = rest;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = Array.from(kept[maxLines - 1]);
  while (last.length > 0 && !fits(`${last.join("").trimEnd()}…`)) last.pop();
  kept[maxLines - 1] = `${last.join("").trimEnd()}…`;
  return kept;
}
