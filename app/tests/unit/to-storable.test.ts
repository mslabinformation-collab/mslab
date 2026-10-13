import { describe, expect, test } from "vitest";
import { checkFeedback } from "@/domain/protocols";
import { storable } from "@/lib/storable";
import { toStorable } from "@/lib/to-storable";

// What Postgres can store, from any pasted text (lib/to-storable.ts): Word's line break (VT, U+000B) and page break (FF, U+000C) become line
// breaks, so pasted words never run together; the other control characters and broken surrogates go. `storable` still asks "as it is?".

const VT = "\u000b";
const FF = "\u000c";

describe("toStorable and storable", () => {
  test("Word's line and page breaks become line breaks; NUL and the other control characters go; tabs, line breaks and emoji stay", () => {
    expect(toStorable(`Kulmud${VT}hästi${FF}Järgmine${"\u0000"}\tjah\r\nlõpp 😀${"\ud800"}`)).toBe("Kulmud\nhästi\nJärgmine\tjah\r\nlõpp 😀");
  });

  test("a text with VT or FF is not storable as it is; the mapped text is", () => {
    for (const raw of [`a${VT}b`, `a${FF}b`]) {
      expect(storable(raw)).toBe(false);
      expect(storable(toStorable(raw))).toBe(true);
    }
  });

  test("the feedback's server check refuses a raw VT or FF and takes the mapped text", () => {
    for (const raw of [`Väga${VT}hea`, `Väga${FF}hea`]) {
      expect(checkFeedback({ message: raw })).toMatchObject({ ok: false, error: "message" });
      expect(checkFeedback({ message: toStorable(raw) })).toEqual({ ok: true, answers: { message: "Väga\nhea" } });
    }
  });
});
