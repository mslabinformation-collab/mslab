import { describe, expect, it } from "vitest";
import { changedCodeFields, codeColumns, codeFieldProblems, emptyCodeFields, highestListCents, type CodeFields } from "@/domain/discount-code-fields";

// The Sooduskoodid drawer's field rules (F1 Task 13; R16–R18): the one validator the drawer and the server share.

const ok: CodeFields = { ...emptyCodeFields(false), code: "tere 10", percent: "10" };
const check = (over: Partial<CodeFields>, welcome = false, highestCents?: number | null) => codeFieldProblems({ ...ok, ...over }, { welcome, highestCents });

describe("codeFieldProblems", () => {
  it("a valid code has no problem; „tere 10“ is valid after R14's normalising", () => {
    expect(check({})).toEqual({});
    expect(check({ code: "---" })).toEqual({ code: "codeFormat" });
  });

  it("each field error", () => {
    expect(check({ percent: "100" })).toEqual({ percent: "discountRange" });
    expect(check({ percent: "0" })).toEqual({ percent: "discountRange" });
    expect(check({ percent: "7,5" })).toEqual({ percent: "whole" });
    expect(check({ kind: "euro", amount: "abc" })).toEqual({ amount: "amountEuro" });
    expect(check({ kind: "euro", amount: "0" })).toEqual({ amount: "amountEuro" });
    expect(check({ startsOn: "2026-12-10", endsOn: "2026-12-01" })).toEqual({ endsOn: "endBeforeStart" });
    expect(check({ scope: "courses", courseIds: [] })).toEqual({ courseIds: "coursesRequired" });
    expect(check({ daysAfterSignup: "366" }, true)).toEqual({ daysAfterSignup: "codeDaysRange" });
    expect(check({ daysAfterSignup: "366" }, false)).toEqual({}); // (only the welcome row has the field)
    expect(check({ code: "---" }).code).toBe("codeFormat");
    expect(check({ code: "" }).code).toBe("codeRequired");
    expect(check({ code: "   " }).code).toBe("codeRequired");
    expect(check({ code: "A".repeat(31) }).code).toBe("codeFormat");
  });

  it("the other kind's field is not read: euros typed under Protsent are no problem", () => {
    expect(check({ kind: "percent", amount: "abc" })).toEqual({});
    expect(check({ kind: "euro", percent: "100", amount: "5" })).toEqual({});
  });

  it("the dates, the limit and the note", () => {
    expect(check({ startsOn: "2026-02-30" })).toEqual({ startsOn: "date" });
    expect(check({ endsOn: "sel" })).toEqual({ endsOn: "date" });
    expect(check({ maxUses: "0" })).toEqual({ maxUses: "whole" });
    expect(check({ maxUses: "2,5" })).toEqual({ maxUses: "whole" });
    expect(check({ maxUses: "20" })).toEqual({});
    expect(check({ note: "x".repeat(2001) })).toEqual({ note: "tooLong" });
  });

  it("R18: euros above the ceiling are amountTooHigh; no ceiling (none given, or no priced course) checks nothing", () => {
    expect(check({ kind: "euro", amount: "300" }, false, 29_000)).toEqual({ amount: "amountTooHigh" });
    expect(check({ kind: "euro", amount: "290" }, false, 29_000)).toEqual({});
    expect(check({ kind: "euro", amount: "300" })).toEqual({});
    expect(check({ kind: "euro", amount: "300" }, false, null)).toEqual({});
  });
});

describe("highestListCents", () => {
  const courses = [
    { id: 1, type: "contact" as const, listCents: 29_000 },
    { id: 2, type: "e_learning" as const, listCents: 9_500 },
    { id: 3, type: "e_learning" as const, listCents: null },
  ];
  it("reads the courses in the scope only", () => {
    expect(highestListCents("all", [], courses)).toBe(29_000);
    expect(highestListCents("ecourse", [], courses)).toBe(9_500);
    expect(highestListCents("contact", [], courses)).toBe(29_000);
    expect(highestListCents("courses", [2, 3], courses)).toBe(9_500);
    expect(highestListCents("courses", [3], courses)).toBeNull();
    expect(highestListCents("courses", [], courses)).toBeNull();
  });
});

describe("changedCodeFields and codeColumns", () => {
  it("compares text trimmed and the chosen courses as a set", () => {
    const a = { ...ok, scope: "courses" as const, courseIds: [2, 1] };
    expect(changedCodeFields({ ...a, code: " tere 10 ", courseIds: [1, 2] }, { ...a, code: "tere 10" })).toEqual([]);
    expect(changedCodeFields({ ...a, courseIds: [1] }, a)).toEqual(["courseIds"]);
    expect(changedCodeFields(a, null)).toHaveLength(13);
  });

  it("stores the kind's value only, normalised; the welcome row's rules are fixed", () => {
    const euro = codeColumns({ ...ok, kind: "euro", amount: "15,50", percent: "10", maxUses: " 20 ", daysAfterSignup: "30", audience: "returning", oncePerPerson: false }, false);
    expect(euro).toMatchObject({ code: "TERE10", percent: null, amountCents: 1550, maxUses: 20, daysAfterSignup: null, audience: "returning", oncePerPerson: false });
    const welcome = codeColumns({ ...ok, daysAfterSignup: "30", audience: "all", oncePerPerson: false }, true);
    expect(welcome).toMatchObject({ percent: 10, amountCents: null, daysAfterSignup: 30, audience: "first", oncePerPerson: true });
  });
});
