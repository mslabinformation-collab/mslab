import { describe, expect, test } from "vitest";
import { clean, wrap } from "@/server/pdf-text";

// The text helpers the invoice's and the contract's PDFs share (contracts, Task 2: extracted from server/invoice-pdf.ts). The invoice's own
// tests hold that its PDF still says what it said; these hold the helpers themselves.

const CHARS = new Set(Array.from("abcdefghijklmnopqrstuvwxyz0123456789õäöüABC .,?€…\xa0").map((c) => c.codePointAt(0)!));
/** A width in characters, one unit each: a line fits when it is at most `n` characters long. */
const within = (n: number) => (line: string) => Array.from(line).length <= n;

describe("clean", () => {
  test("white space is one space, trimmed; control and format characters are dropped", () => {
    expect(clean("  a \t b\n\n c  ", CHARS)).toBe("a b c");
    expect(clean("a\u0000b\u{200b}c\u{202e}a", CHARS)).toBe("abca");
    expect(clean("   ", CHARS)).toBe("");
  });

  test("a character the font lacks is one \"?\", never a missing-glyph box (an emoji is one character, not two)", () => {
    expect(clean("a日b", CHARS)).toBe("a?b");
    expect(clean("a\u{1F600}b", CHARS)).toBe("a?b");
    expect(clean("õäöü €", CHARS)).toBe("õäöü €");
  });

  test("a no-break space is a space by default, and stays itself when the text is typeset (a contract's paragraph)", () => {
    expect(clean("a\xa0b", CHARS)).toBe("a b");
    expect(clean("350,00\xa0€", CHARS)).toBe("350,00 €");
    expect(clean("350,00\xa0€ a\xa0\xa0b\n c", CHARS, true)).toBe("350,00\xa0€ a\xa0\xa0b c");
    expect(clean("\xa0 a\t\xa0b", CHARS, true)).toBe("a \xa0b"); // the ends are trimmed, a no-break space inside stays as typed
  });
});

describe("wrap", () => {
  test("lines are broken at the spaces and each fits", () => {
    expect(wrap("aaa bbb ccc ddd", within(7), 10)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(wrap("aaa bbb", within(20), 10)).toEqual(["aaa bbb"]);
    expect(wrap("", within(7), 10)).toEqual([]);
  });

  test("a word wider than the box is broken at the box, whole and in order", () => {
    const lines = wrap("a bbbbbbbbbbbbbbbbbbbb c", within(6), 10);
    expect(lines.every(within(6))).toBe(true);
    expect(lines.join("").replace(/ /g, "")).toBe("abbbbbbbbbbbbbbbbbbbbc");
  });

  test("past the lines the box allows the last one is cut and ends in an ellipsis that still fits; no limit (Infinity) keeps every line", () => {
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const cut = wrap(text, within(8), 2);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith("…")).toBe(true);
    expect(cut.every(within(8))).toBe(true);
    expect(wrap(text, within(8), Number.POSITIVE_INFINITY).length).toBeGreaterThan(4);
  });
});
