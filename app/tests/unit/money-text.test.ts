import { describe, expect, test } from "vitest";
import { euro, euroBare } from "@/domain/money-text";
import { formatEUR } from "@/domain/money";

// domain/money-text.ts (the B screens, Task 1): the two spellings of an amount in the admin's text, in one place. The A screens had them five
// times, as formatEUR(cents, "et") and as formatEUR(cents, "et").replace(/ €$/, "") (InvoiceRow, MoneyCard, the registrations page, the
// cancel form of RegistrationForms, messages.ts' plainAmount); the output of the helpers is that of those copies, byte for byte.

/** The old copies' expression, kept here to compare against. */
const oldBare = (cents: number) => formatEUR(cents, "et").replace(/ €$/, "");

describe("euro: an amount with its euro sign, as formatEUR writes it for Estonian", () => {
  test.each([
    [0, "0 €"],
    [50, "0,50 €"],
    [9950, "99,50 €"],
    [10000, "100 €"],
    [14500, "145 €"],
    [14550, "145,50 €"],
    [129000, "1 290 €"],
    [129050, "1 290,50 €"],
    [1234500, "12 345 €"],
  ])("%i cents is %s", (cents, text) => {
    expect(euro(cents)).toBe(text);
  });

  test("it is formatEUR(cents, 'et'), whatever the amount", () => {
    for (const cents of [0, 1, 99, 100, 101, 9999, 17500, 35000, 39000, 100_000, 999_999, 100_000_000]) expect(euro(cents)).toBe(formatEUR(cents, "et"));
  });

  test("the space before the sign and inside the groups is a regular one", () => {
    expect(euro(1234500)).not.toMatch(/[  ]/);
  });
});

describe("euroBare: the amount without its euro sign (the text writes the sign itself: „Laekunud {x} €“)", () => {
  test.each([
    [0, "0"],
    [50, "0,50"],
    [9950, "99,50"],
    [10000, "100"],
    [14500, "145"],
    [14550, "145,50"],
    [29000, "290"],
    [129000, "1 290"],
    [129050, "1 290,50"],
    [1234500, "12 345"],
  ])("%i cents is %s", (cents, text) => {
    expect(euroBare(cents)).toBe(text);
  });

  test("it is what the five old helpers made, whatever the amount", () => {
    for (const cents of [0, 1, 99, 100, 101, 9999, 17500, 35000, 39000, 100_000, 999_999, 100_000_000]) expect(euroBare(cents)).toBe(oldBare(cents));
  });

  test("it never holds a euro sign", () => {
    for (const cents of [0, 50, 10000, 129050]) expect(euroBare(cents)).not.toContain("€");
  });

  test("euro is euroBare and the sign", () => {
    for (const cents of [0, 50, 10000, 129050, 1234500]) expect(euro(cents)).toBe(`${euroBare(cents)} €`);
  });
});
