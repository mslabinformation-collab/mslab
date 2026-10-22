import { describe, expect, it } from "vitest";
import { containsPattern } from "@/domain/paging";
import { digitsOf, phoneQuery } from "@/domain/search";

// The admin lists' search (admin UX pass, README §1.10): text parts are compared with containsPattern (literal, ILIKE), a phone number by its digits
// only, so „+372 5123 4567“ and „5123-4567“ find a number stored with any spaces, dashes or plus. The SQL side compares
// regexp_replace(<column>, '[^0-9]', '', 'g') like phoneQuery(q).

describe("digitsOf", () => {
  it("keeps the digits and drops everything else", () => {
    expect(digitsOf("+372 5123 4567")).toBe("37251234567");
    expect(digitsOf("5123-4567")).toBe("51234567");
    expect(digitsOf("(0)51 234.567")).toBe("051234567");
    expect(digitsOf("Kati")).toBe("");
    expect(digitsOf("")).toBe("");
  });

  it("keeps ASCII digits only, as the SQL side's [^0-9] does", () => {
    expect(digitsOf("٣٧٢ 123")).toBe("123"); // Arabic-Indic digits are not digits to the database's regexp
  });
});

describe("phoneQuery", () => {
  it("is %<digits>% when the query has at least 3 digits", () => {
    expect(phoneQuery("5123-4567")).toBe("%51234567%");
    expect(phoneQuery("123")).toBe("%123%");
    expect(phoneQuery("  50 00  ")).toBe("%5000%");
  });

  it("a number typed with +372 is searched by the digits after the 372, so it also finds a number stored without the country code", () => {
    expect(phoneQuery("+372 5123 4567")).toBe("%51234567%");
    expect(phoneQuery("+37251234567")).toBe("%51234567%");
    expect(phoneQuery("372 5123 4567")).toBe("%51234567%");
    expect(phoneQuery("(+372) 5123-4567")).toBe("%51234567%");
    // the same number typed without it is the same search
    expect(phoneQuery("5123 4567")).toBe(phoneQuery("+372 5123 4567"));
  });

  it("keeps the 372 when 7 digits or fewer follow it (a number typed so far, or one that merely begins with 372)", () => {
    expect(phoneQuery("+372")).toBe("%372%");
    expect(phoneQuery("+372 51")).toBe("%37251%");
    expect(phoneQuery("+372 5123 45")).toBe("%372512345%");
    expect(phoneQuery("372 5123 456")).toBe("%3725123456%"); // 7 digits after the 372: not more than 7
    expect(phoneQuery("37251234")).toBe("%37251234%");
  });

  it("takes only a leading 372: a 372 inside the digits stays", () => {
    expect(phoneQuery("5123 3725 4567")).toBe("%512337254567%");
  });

  it("is null for fewer than 3 digits, or none", () => {
    expect(phoneQuery("ab12")).toBeNull();
    expect(phoneQuery("12")).toBeNull();
    expect(phoneQuery("Kati")).toBeNull();
    expect(phoneQuery("")).toBeNull();
  });

  it("counts the digits of a mixed query (an invoice number, a name with a number)", () => {
    expect(phoneQuery("MSL2026-001")).toBe("%2026001%");
    expect(phoneQuery("Kati 5")).toBeNull();
  });

  it("holds nothing LIKE could take as a wildcard", () => {
    for (const q of ["50% 123", "_123_", "\\123", "+372 5%00"]) expect(phoneQuery(q) ?? "").toMatch(/^%[0-9]+%$/);
  });
});

describe("the text side stays containsPattern (escaped, literal)", () => {
  it("escapes %, _ and \\", () => {
    expect(containsPattern("50%")).toBe("%50\\%%");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
  });
});
