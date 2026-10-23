import { describe, expect, test } from "vitest";
import { accessState, addMonths, defaultExpiryDate, endOfDayTallinn, extendBase, extendByMonths, grantExpiry, isExtension, purchaseExpiryDate, tallinnToday } from "@/domain/client-access";
import { containsPattern, parseSearch } from "@/domain/paging";
import { compactIban, groupIban } from "@/domain/account-cards";
import { isIban, normalizeIban, prepaymentDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";

// Phase 2a Task 9: the pure parts of the admin's Õpilased (expiry dates, the search) and of Seaded "Ettemaksu juhised".

describe("e-course access dates (Estonian calendar days)", () => {
  test("addMonths keeps the day, or the month's last one", () => {
    expect(addMonths("2026-10-04", 6)).toBe("2027-04-04");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 12)).toBe("2027-12-15");
    expect(addMonths("2026-10-04", 0)).toBe("2026-10-04");
    expect(addMonths("2026-02-30", 1)).toBeNull();
    expect(addMonths("4.10.2026", 1)).toBeNull();
  });

  test("today is the Estonian date: just after midnight in Tallinn it is already the next day", () => {
    expect(tallinnToday(new Date("2026-10-04T20:59:00Z"))).toBe("2026-10-04");
    expect(tallinnToday(new Date("2026-10-04T21:01:00Z"))).toBe("2026-10-05");
  });

  test("the form's default: today + the course's access months; 12 when it has none", () => {
    const now = new Date("2026-10-04T09:00:00Z");
    expect(defaultExpiryDate(now, 6)).toBe("2027-04-04");
    expect(defaultExpiryDate(now, null)).toBe("2027-10-04");
    expect(defaultExpiryDate(now, 0)).toBe("2027-10-04");
    expect(defaultExpiryDate(new Date("2026-10-04T21:30:00Z"), 1)).toBe("2026-11-05");
  });

  test("a purchase gives today + the months, but never shortens access she has: the later of the two days; a revoked access counts as none (phase 2b)", () => {
    const now = new Date("2026-10-09T10:00:00Z");
    const open = (expiresAt: string, revokedAt: Date | null = null) => ({ expiresAt: new Date(expiresAt), revokedAt });
    expect(purchaseExpiryDate(now, 6, null)).toBe("2027-04-09");
    expect(purchaseExpiryDate(now, 6, open("2026-12-01T21:59:59.999Z"))).toBe("2027-04-09"); // earlier than the new end: the new one
    expect(purchaseExpiryDate(now, 6, open("2027-12-01T21:59:59.999Z"))).toBe("2027-12-01"); // later: kept
    expect(purchaseExpiryDate(now, 6, open("2027-04-09T20:59:59.999Z"))).toBe("2027-04-09"); // the same day
    expect(purchaseExpiryDate(now, 6, open("2026-01-01T21:59:59.999Z"))).toBe("2027-04-09"); // run out
    expect(purchaseExpiryDate(now, 6, open("2027-12-01T21:59:59.999Z", new Date("2026-09-01T10:00:00Z")))).toBe("2027-04-09"); // ended by an admin
    expect(purchaseExpiryDate(now, null, open("2027-06-01T20:59:59.999Z"))).toBe("2027-10-09"); // 12 months without any
    // the day is the Estonian one: the last moment of a winter day is 21:59 UTC
    expect(purchaseExpiryDate(now, 1, open("2026-12-31T21:59:59.999Z"))).toBe("2026-12-31");
  });

  test("stored as the end of that day in Tallinn (summer and winter time)", () => {
    expect(endOfDayTallinn("2027-04-04")?.toISOString()).toBe("2027-04-04T20:59:59.999Z");
    expect(endOfDayTallinn("2027-01-31")?.toISOString()).toBe("2027-01-31T21:59:59.999Z");
    expect(endOfDayTallinn("2027-02-29")).toBeNull();
  });

  test("a typed date: today up to 10 years ahead", () => {
    const now = new Date("2026-10-04T09:00:00Z");
    expect(grantExpiry("2026-10-04", now)?.toISOString()).toBe("2026-10-04T20:59:59.999Z");
    expect(grantExpiry("2036-10-04", now)).not.toBeNull();
    for (const bad of ["2026-10-03", "2036-10-05", "", "2026-13-01", "2026-10-4", " 2026-10-05"]) expect(grantExpiry(bad, now), bad).toBeNull();
  });

  test("an access is open until its last moment, then run out; ended by an admin wins", () => {
    const row = { expiresAt: new Date("2027-04-04T20:59:59.999Z"), revokedAt: null };
    expect(accessState(row, new Date("2027-04-04T20:59:59.998Z"))).toBe("active");
    expect(accessState(row, new Date("2027-04-04T20:59:59.999Z"))).toBe("expired");
    expect(accessState({ ...row, revokedAt: new Date("2026-10-04T09:00:00Z") }, new Date("2026-10-05T00:00:00Z"))).toBe("revoked");
  });
});

describe("„Pikenda“ (B12): the base of +1 / +3 / +6 kuud is the later of the current end and the end of today in Tallinn (piece 2 texts §4)", () => {
  const now = new Date("2026-10-04T09:00:00Z"); // 12:00 in Tallinn; today ends 2026-10-04T20:59:59.999Z
  const todayEnd = "2026-10-04T20:59:59.999Z";

  test("an open access is extended from its own end; one that ran out, from the end of today", () => {
    const open = new Date("2027-04-04T20:59:59.999Z");
    expect(extendBase(open, now)).toEqual(open);
    expect(extendBase(new Date("2026-09-01T20:59:59.999Z"), now).toISOString()).toBe(todayEnd);
    // it ended earlier today: still today's end
    expect(extendBase(new Date("2026-10-04T05:00:00Z"), now).toISOString()).toBe(todayEnd);
    // it ends tonight: the same moment either way
    expect(extendBase(new Date(todayEnd), now).toISOString()).toBe(todayEnd);
  });

  test("today is the Estonian day: just after midnight in Tallinn the base is already the next day's end", () => {
    const afterMidnight = new Date("2026-10-04T21:30:00Z"); // 00:30 on the 5th in Tallinn
    expect(extendBase(new Date("2026-10-04T20:59:59.999Z"), afterMidnight).toISOString()).toBe("2026-10-05T20:59:59.999Z");
  });

  test("+n kuud counts whole months from the base's Estonian day to the end of that day (a short month gives its last day; winter time follows)", () => {
    const open = new Date("2027-04-04T20:59:59.999Z"); // summer time: the 4th ends 20:59 UTC
    expect(extendByMonths(open, now, 1).toISOString()).toBe("2027-05-04T20:59:59.999Z");
    expect(extendByMonths(open, now, 3).toISOString()).toBe("2027-07-04T20:59:59.999Z");
    expect(extendByMonths(open, now, 6).toISOString()).toBe("2027-10-04T20:59:59.999Z");
    expect(extendByMonths(new Date("2027-08-31T20:59:59.999Z"), now, 6).toISOString()).toBe("2028-02-29T21:59:59.999Z"); // winter: 21:59 UTC
    expect(extendByMonths(new Date("2027-01-31T21:59:59.999Z"), now, 1).toISOString()).toBe("2027-02-28T21:59:59.999Z");
    // ran out in the summer: from today, not from the old end
    expect(extendByMonths(new Date("2026-06-01T20:59:59.999Z"), now, 1).toISOString()).toBe("2026-11-04T21:59:59.999Z");
  });
});

describe("isExtension: a new end „Pikenda“ takes", () => {
  const now = new Date("2026-10-04T09:00:00Z");
  const open = new Date("2027-04-04T20:59:59.999Z");
  const ranOut = new Date("2026-08-01T20:59:59.999Z");
  test("later than the end it counts from (the current end, or the end of today for one that ran out), and within 10 years from today", () => {
    expect(isExtension(new Date("2027-04-04T21:00:00.000Z"), open, now)).toBe(true);
    expect(isExtension(open, open, now)).toBe(false); // the same moment
    expect(isExtension(new Date("2026-12-31T21:59:59.999Z"), open, now)).toBe(false); // a shortening
    expect(isExtension(new Date("2026-10-04T20:59:59.999Z"), ranOut, now)).toBe(false); // the end of today is not later than itself
    expect(isExtension(new Date("2026-10-05T20:59:59.999Z"), ranOut, now)).toBe(true);
    expect(isExtension(new Date("2036-10-04T20:59:59.999Z"), open, now)).toBe(true);
    expect(isExtension(new Date("2036-10-05T20:59:59.999Z"), open, now)).toBe(false);
  });
});

describe("the list's search", () => {
  test("?otsi= is one trimmed line of at most 100 characters", () => {
    expect(parseSearch("  Kati   Kask \n")).toBe("Kati Kask");
    expect(parseSearch(undefined)).toBe("");
    expect(parseSearch(["a", "b"])).toBe("");
    expect(parseSearch("x".repeat(150))).toHaveLength(100);
  });

  test("taken literally: LIKE's wildcards and escape character are escaped", () => {
    expect(containsPattern("kati")).toBe("%kati%");
    expect(containsPattern("100%")).toBe("%100\\%%");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("Ettemaksu juhised", () => {
  test("an IBAN as typed: spaces out (also non-breaking), capitals; the shape checked", () => {
    expect(normalizeIban(" ee38 2200 2210 2014 5685 ")).toBe("EE382200221020145685");
    expect(isIban("EE382200221020145685")).toBe(true);
    expect(isIban("GB82WEST12345698765432")).toBe(true);
    for (const bad of ["", "EE38", "EE38220022102", "E382200221020145685", "EEX82200221020145685", "EE38220022102014568-", `EE38${"1".repeat(31)}`]) expect(isIban(bad), bad).toBe(false);
  });

  test("the student's card reads the IBAN in groups of four and copies it without spaces", () => {
    expect(groupIban("EE382200221020145685")).toBe("EE38 2200 2210 2014 5685");
    expect(groupIban(" ee38 2200 2210 2014 5685")).toBe("EE38 2200 2210 2014 5685"); // a row written by hand
    expect(groupIban("GB82WEST12345698765432")).toBe("GB82 WEST 1234 5698 7654 32");
    expect(compactIban("EE38 2200 2210 2014 5685")).toBe("EE382200221020145685");
    expect(groupIban("")).toBe("");
  });

  test("the draft: the four fields as strings, empty for a missing or odd setting", () => {
    expect(prepaymentDraft(null)).toEqual({ receiver: "", iban: "", bank: "", referencePrefix: "" });
    expect(prepaymentDraft({ receiver: "MS LAB OÜ", iban: 5, extra: "x" })).toEqual({ receiver: "MS LAB OÜ", iban: "", bank: "", referencePrefix: "" });
  });
});

describe("the texts the brief fixes", () => {
  test("the view-as banner and the change request words", () => {
    expect(fill(adminEt.viewAs.banner, { nimi: "Kati Kask" })).toBe("Vaatad kliendi Kati Kask vaadet — muuta ei saa");
    expect(adminEt.requests.wish).toEqual({ cancel: "Soovib tühistada", change: "Soovib muuta aega" });
    expect(adminEt.clients.grant.button).toBe("Ava ligipääs");
    expect(adminEt.clients.revoke.button).toBe("Lõpeta ligipääs");
    expect(adminEt.clients.drawer.viewAs).toBe("Vaata tema vaadet");
    expect(adminEt.clients.type).toEqual({ all: "Kõik", e: "E-õpe", k: "Kontaktõpe" });
  });
});
