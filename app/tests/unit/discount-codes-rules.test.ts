import { describe, expect, test } from "vitest";
import type { RegStatus } from "@/domain/registration";
import {
  addDays, codeHint, codeRefusal, codeState, codeValueText, discountCents, isCode, listCentsOf, normalizeCode, personRefusal, registrationDiscount, registrationTotal,
  totalWith, useMark, validOn, type CodeRule,
} from "@/domain/discount-codes";

const rule = (over: Partial<CodeRule> = {}): CodeRule => ({ code: "TERE10", welcome: false, percent: 10, amountCents: null, scope: "all", courseIds: [], startsOn: null, endsOn: null, maxUses: null, audience: "all", oncePerPerson: true, daysAfterSignup: null, active: true, ...over });
const at = { courseId: 7, courseType: "contact" as const, listCents: 35000, today: "2026-12-01", uses: 0 };

describe("discount codes: the pure rules", () => {
  test("the rounding: 10 % of 199,99 € is 20,00 € and 15 % of 333,00 € is 49,95 €", () => {
    expect(discountCents(rule(), 19999)).toBe(2000);
    expect(discountCents(rule({ percent: 15 }), 33300)).toBe(4995);
  });
  test("half a cent rounds up", () => expect(discountCents(rule({ percent: 5 }), 1010)).toBe(51)); // 50.5 → 51
  test("the 1 € floor caps a euro code", () => {
    expect(discountCents(rule({ percent: null, amountCents: 50000 }), 35000)).toBe(34900);
    expect(totalWith(35000, 50000)).toBe(100);
  });
  test("a course at 1 € or less gets no discount and keeps its price", () => {
    expect(discountCents(rule({ percent: null, amountCents: 500 }), 100)).toBe(0);
    expect(totalWith(80, 0)).toBe(80);
    expect(codeRefusal(rule(), { ...at, listCents: 100 })).toBe("scope");
  });
  test("registrationTotal follows the live list price minus the frozen euros", () => {
    const c = { type: "contact" as const, price: null, priceGroup: 40000, priceIndividual: 60000 };
    expect(registrationTotal(c, { kind: "group", discountCents: 3500 })).toBe(36500);
    expect(registrationTotal(c, { kind: "individual", discountCents: 0 })).toBe(60000);
    expect(registrationTotal({ ...c, priceGroup: null }, { kind: "group", discountCents: 3500 })).toBeNull();
    expect(registrationDiscount(c, { kind: "group", discountCents: 3500, discountCode: "TERE10" })).toEqual({ code: "TERE10", listCents: 40000, cents: 3500 });
    expect(registrationDiscount(c, { kind: "group", discountCents: 0, discountCode: "" })).toBeNull();
    expect(registrationDiscount(c, { kind: "group", discountCents: 3500, discountCode: "" })).toBeNull();
    expect(registrationDiscount({ ...c, priceGroup: null }, { kind: "group", discountCents: 3500, discountCode: "TERE10" })).toBeNull();
  });
  test("listCentsOf is the e-course's price, a contact course's group price, or null", () => {
    expect(listCentsOf({ type: "e_learning", price: 9500, priceGroup: null, priceIndividual: null })).toBe(9500);
    expect(listCentsOf({ type: "contact", price: null, priceGroup: 40000, priceIndividual: 60000 })).toBe(40000);
    expect(listCentsOf({ type: "contact", price: null, priceGroup: null, priceIndividual: 60000 })).toBeNull();
    expect(listCentsOf({ type: "e_learning", price: null, priceGroup: null, priceIndividual: null })).toBeNull();
  });
  test.each([
    [{ active: false }, "paused"],
    [{ endsOn: "2026-11-30" }, "ended"],
    [{ startsOn: "2026-12-02" }, "notYet"],
    [{ scope: "ecourse" as const }, "scope"],
    [{ scope: "courses" as const, courseIds: [8] }, "scope"],
    [{ scope: "courses" as const, courseIds: [7] }, null],
    [{ scope: "contact" as const }, null],
    [{ maxUses: 3 }, null],
  ])("codeRefusal %o → %s", (over, want) => expect(codeRefusal(rule(over), at)).toBe(want));
  test("the last day is included and the first day is the start date", () => {
    expect(codeRefusal(rule({ startsOn: "2026-12-01", endsOn: "2026-12-01" }), at)).toBeNull();
  });
  test("usedUp once the uses reach the limit, not before", () => {
    expect(codeRefusal(rule({ maxUses: 3 }), { ...at, uses: 2 })).toBeNull();
    expect(codeRefusal(rule({ maxUses: 3 }), { ...at, uses: 3 })).toBe("usedUp");
  });
  test("scope is told before usedUp", () => expect(codeRefusal(rule({ scope: "ecourse", maxUses: 1 }), { ...at, uses: 1 })).toBe("scope"));
  test.each([
    [rule(), { uses: 1, trained: false, subscribedOn: null }, false, "used"],
    [rule({ audience: "first" }), { uses: 0, trained: true, subscribedOn: null }, false, "first"],
    [rule({ audience: "returning" }), { uses: 0, trained: false, subscribedOn: null }, false, "returning"],
    [rule({ welcome: true, audience: "first" }), { uses: 0, trained: false, subscribedOn: null }, false, "subscriber"],
    [rule({ welcome: true, audience: "first" }), { uses: 0, trained: false, subscribedOn: null }, true, null],
    [rule({ welcome: true, audience: "first", daysAfterSignup: 30 }), { uses: 0, trained: false, subscribedOn: "2026-11-01" }, false, null],
    [rule({ welcome: true, audience: "first", daysAfterSignup: 29 }), { uses: 0, trained: false, subscribedOn: "2026-11-01" }, false, "expired"],
  ])("personRefusal %#", (code, facts, subscribing, want) => expect(personRefusal(code, facts, { subscribing, today: "2026-12-01" })).toBe(want));
  test("codeValueText", () => {
    expect(codeValueText(rule())).toBe("10%");
    expect(codeValueText(rule({ percent: null, amountCents: 1500 }))).toBe("15 €");
    expect(codeValueText(rule({ percent: null, amountCents: 1550 }))).toBe("15,50 €");
  });
  test("codeState", () => {
    expect(codeState(rule({ active: false, endsOn: "2026-11-01" }), "2026-12-01", 0)).toBe("paused");
    expect(codeState(rule({ endsOn: "2026-11-30" }), "2026-12-01", 0)).toBe("ended");
    expect(codeState(rule({ startsOn: "2026-12-02" }), "2026-12-01", 0)).toBe("upcoming");
    expect(codeState(rule({ maxUses: 2 }), "2026-12-01", 2)).toBe("full");
    expect(codeState(rule(), "2026-12-01", 5)).toBe("active");
  });
  test("useMark mirrors D7's limit rule", () => {
    const now = new Date("2026-12-01T12:00:00Z"), h = (n: number) => new Date(now.getTime() - n * 3_600_000);
    const reg = (status: RegStatus, paidCents: number, createdAt: Date) => ({ registration: { status, paidCents, createdAt }, payment: null });
    const pay = (status: "pending" | "paid" | "failed" | "refunded" | "held" | "replaced", inWindow = false, accessKept = false) => ({ registration: null, payment: { status, inWindow, accessKept } });
    expect(useMark(reg("awaiting_prepayment", 0, h(23)), now)).toBe("counts");
    expect(useMark(reg("awaiting_prepayment", 0, h(25)), now)).toBe("unpaid");
    expect(useMark(reg("awaiting_prepayment", 5000, h(99)), now)).toBe("counts");
    expect(useMark(reg("confirmed", 0, h(99)), now)).toBe("counts");
    expect(useMark(reg("cancelled", 5000, h(1)), now)).toBe("cancelled");
    expect([useMark(pay("paid"), now), useMark(pay("held"), now), useMark(pay("pending", true), now)]).toEqual(["counts", "counts", "counts"]);
    expect([useMark(pay("pending"), now), useMark(pay("replaced"), now), useMark(pay("failed"), now), useMark(pay("refunded"), now)]).toEqual(["pending", "pending", "failed", "refunded"]);
    expect(useMark(pay("refunded", false, true), now)).toBe("counts");
    expect(useMark({ registration: null, payment: null }, now)).toBe("gone");
  });
  test("validOn includes both days", () => {
    expect(validOn(rule({ startsOn: "2026-12-01", endsOn: "2026-12-01" }), "2026-12-01")).toBe(true);
    expect(validOn(rule({ endsOn: "2026-11-30" }), "2026-12-01")).toBe(false);
    expect(validOn(rule({ active: false }), "2026-12-01")).toBe(false);
  });
  test("normalizeCode and isCode", () => {
    expect(normalizeCode("  tere10 ")).toBe("TERE10");
    // R14: spaces inside, NBSP, zero-width and dash variants
    expect(normalizeCode("suvi 10")).toBe("SUVI10");
    expect(normalizeCode("tere 10​")).toBe("TERE10");
    expect(normalizeCode("tere–10")).toBe("TERE-10");
    // M2 (R14's NFKC): fullwidth letters, digits and dash, as an East Asian keyboard or a copied text gives them
    expect(normalizeCode("ＴＥＲＥ１０")).toBe("TERE10");
    expect(normalizeCode("ｔｅｒｅ－１０")).toBe("TERE-10");
    // no look-alike folding (ruling F-M2): a Cyrillic „ТЕРЕ10“ stays Cyrillic and so is no code (`unknown`)
    expect(isCode(normalizeCode("ТЕРЕ10"))).toBe(false);
    expect(isCode("TERE-10")).toBe(true);
    expect(isCode("TERE 10")).toBe(false);
    expect(isCode("---")).toBe(false);
    expect(isCode("")).toBe(false);
    expect(isCode("A".repeat(31))).toBe(false);
  });
  test("codeHint: the welcome code says so whatever its audience; a first or returning code says its audience; a code for all says nothing", () => {
    expect(codeHint({ welcome: true, audience: "first" })).toBe("welcome");
    expect(codeHint({ welcome: true, audience: "returning" })).toBe("welcome");
    expect(codeHint({ welcome: true, audience: "all" })).toBe("welcome");
    expect(codeHint({ welcome: false, audience: "first" })).toBe("first");
    expect(codeHint({ welcome: false, audience: "returning" })).toBe("returning");
    expect(codeHint({ welcome: false, audience: "all" })).toBeNull();
  });
  test("addDays crosses the month and the year", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-30", 2)).toBe("2026-12-02");
  });
});
