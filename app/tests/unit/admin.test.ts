import { describe, expect, test } from "vitest";
import { SECTIONS } from "@/components/admin/sections";
import { centsToInput, MAX_PAYMENT_CENTS, parseEuroCents } from "@/domain/money";
import { MAX_PAGE, pageInfo, PAGE_SIZE, parsePage } from "@/domain/paging";
import { registrationPrice, registrationStatusAfterPayment } from "@/domain/registration";
import { adminEt } from "@/i18n/dict/admin";
import { formatDate, formatDayMonth, formatLongDate, formatStamp, formatTime, formatWeekday } from "@/i18n/format";
import { csvCell, toCsv } from "@/server/csv";

// Task 12: the pure parts of the admin inbox — the amount field, the price a payment is measured against, the CSV
// export (formula cells defused), the date formats and the menu.

describe("parseEuroCents (Laekunud summa)", () => {
  test("whole euros, comma or point decimals, spaces and the euro sign", () => {
    expect(parseEuroCents("175")).toBe(17500);
    expect(parseEuroCents("175,5")).toBe(17550);
    expect(parseEuroCents("175,50")).toBe(17550);
    expect(parseEuroCents("175.05")).toBe(17505);
    expect(parseEuroCents(" 1 175 € ")).toBe(117500);
    expect(parseEuroCents("1\u00A0175,00")).toBe(117500);
    expect(parseEuroCents("0")).toBe(0);
  });
  test("anything else is not an amount", () => {
    for (const bad of ["", " ", "abc", "-10", "10,505", "1.175,50", "1,2,3", "+5", "1e3", "12 €x", ",5"]) expect(parseEuroCents(bad), bad).toBeNull();
    expect(parseEuroCents(String(MAX_PAYMENT_CENTS / 100))).toBe(MAX_PAYMENT_CENTS);
    expect(parseEuroCents(String(MAX_PAYMENT_CENTS / 100 + 1))).toBeNull();
  });
  test("centsToInput writes what parseEuroCents reads", () => {
    expect(centsToInput(17500)).toBe("175");
    expect(centsToInput(17550)).toBe("175,50");
    expect(centsToInput(17505)).toBe("175,05");
    expect(centsToInput(0)).toBe("0");
    for (const c of [0, 1, 99, 100, 17499, 17550, 123456]) expect(parseEuroCents(centsToInput(c))).toBe(c);
  });
});

describe("registrationPrice + Maria's 50% rule", () => {
  const contact = { type: "contact" as const, price: null, priceGroup: 35000, priceIndividual: 45000 };
  test("group → group price, individual → individual price, e-learning → its price, missing → null", () => {
    expect(registrationPrice(contact, "group")).toBe(35000);
    expect(registrationPrice(contact, "individual")).toBe(45000);
    expect(registrationPrice({ type: "e_learning", price: 9500, priceGroup: null, priceIndividual: null }, "group")).toBe(9500);
    expect(registrationPrice({ ...contact, priceIndividual: null }, "individual")).toBeNull();
  });
  test("the amount from the form decides the status against that price", () => {
    const total = registrationPrice(contact, "group")!;
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: parseEuroCents("174,99")! }, total)).toBe("awaiting_prepayment");
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: parseEuroCents("175")! }, total)).toBe("confirmed");
    expect(registrationStatusAfterPayment({ status: "confirmed", paidCents: parseEuroCents("100")! }, total)).toBe("awaiting_prepayment");
    expect(registrationStatusAfterPayment({ status: "cancelled", paidCents: parseEuroCents("350")! }, total)).toBe("cancelled");
  });
});

describe("CSV", () => {
  test("cells that a spreadsheet would run as a formula get an apostrophe", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+372 5555")).toBe("'+372 5555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=cmd")).toBe("'\t=cmd");
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("maria@example.com")).toBe("maria@example.com");
    expect(csvCell("a=b")).toBe("a=b");
  });
  test("quotes, commas, semicolons, line breaks and edge spaces are quoted; empty values are empty", () => {
    expect(csvCell('Tere "Maria"')).toBe('"Tere ""Maria"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("rida\nteine")).toBe('"rida\nteine"');
    expect(csvCell(" x")).toBe('" x"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
  test("a file: BOM, header, CRLF lines", () => {
    expect(toCsv(["E-post", "Keel"], [["a@example.ee", "ET"], ["=x", "RU"]])).toBe("\uFEFFE-post,Keel\r\na@example.ee,ET\r\n'=x,RU\r\n");
    expect(toCsv(["E-post"], [])).toBe("\uFEFFE-post\r\n");
  });
});

describe("paging (?leht=, 50 a page)", () => {
  test("parsePage: plain positive numbers only, capped", () => {
    expect(parsePage("2")).toBe(2);
    expect(parsePage("1")).toBe(1);
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "2x", " 2", "1e3"]) expect(parsePage(bad), String(bad)).toBe(1);
    expect(parsePage(["2", "3"])).toBe(1);
    expect(parsePage("999999")).toBe(MAX_PAGE);
    expect(parsePage("1234567")).toBe(1); // more than 6 digits is not a page number
  });
  test("pageInfo boundaries: empty, exactly full, one more, beyond the end, below 1", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageInfo(1, 0)).toEqual({ page: 1, pages: 1, size: 50, offset: 0, total: 0 });
    expect(pageInfo(1, 50)).toMatchObject({ page: 1, pages: 1, offset: 0 });
    expect(pageInfo(2, 50)).toMatchObject({ page: 1, pages: 1, offset: 0 });
    expect(pageInfo(2, 51)).toMatchObject({ page: 2, pages: 2, offset: 50 });
    expect(pageInfo(1, 51)).toMatchObject({ page: 1, pages: 2, offset: 0 });
    expect(pageInfo(99, 120)).toMatchObject({ page: 3, pages: 3, offset: 100 });
    expect(pageInfo(0, 120)).toMatchObject({ page: 1, offset: 0 });
    expect(pageInfo(-5, 120)).toMatchObject({ page: 1 });
    expect(pageInfo(Number.NaN, 120)).toMatchObject({ page: 1 });
    expect(pageInfo(3, 7, 2)).toMatchObject({ page: 3, pages: 4, offset: 4 });
    expect(pageInfo(7, Number.POSITIVE_INFINITY)).toMatchObject({ page: 7, offset: 300 });
  });
});

describe("admin date formats (Estonian time)", () => {
  const d = new Date("2026-10-01T11:05:00Z"); // 14:05 in Tallinn (summer time)
  test("time, long date, CSV stamp", () => {
    expect(formatTime(d, "et")).toBe("14:05");
    expect(formatLongDate(d, "et")).toBe("Neljapäev, 1. oktoober");
    expect(formatStamp(d)).toBe("2026-10-01 14:05");
    expect(formatStamp(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01 00:30"); // winter time, next day
  });
  test("the cached formatters keep locales and options apart", () => {
    for (let i = 0; i < 3; i++) {
      expect(formatDate(d, "et")).toBe("01.10.2026");
      expect(formatDayMonth(d, "et")).toBe("01.10");
      expect(formatWeekday(d, "et")).toBe("neljapäev");
      expect(formatWeekday(d, "ru")).toBe("четверг");
      expect(formatTime(d, "ru")).toBe("14:05");
    }
  });
});

describe("admin menu (prototype B sidebar, A1)", () => {
  test("the sections in the menu's order, each with its Estonian label and its own address", () => {
    expect(SECTIONS.map((s) => adminEt.nav[s.key])).toEqual([
      "Ülevaade",
      "Registreerimised",
      "Protokollid",
      "Hindamine",
      "Päringud",
      "Õpilased",
      "Tagasiside",
      "Maksed ja arved",
      "Koolitused",
      "Kalender",
      "Praktika",
      "Avaleht",
      "Koolitaja",
      "Uudised",
      "Hüpikaken",
      "Uudiskiri",
      "Seaded",
      "Testimine",
    ]);
    expect(new Set(SECTIONS.map((s) => s.href)).size).toBe(SECTIONS.length);
    for (const s of SECTIONS) expect(s.href).toMatch(/^\/admin(\/[a-z]+)?$/);
    // the menu has one „Vaata kodulehte“, in the top line (and in the phone menu's footer): the sidebar footer's „Vaata lehte“ is gone
    expect(adminEt.shell.preview).toBe("Vaata kodulehte");
    expect(adminEt.shell).not.toHaveProperty("viewSite");
    expect(adminEt.shell).not.toHaveProperty("signedInAs");
    expect(adminEt.shell.signedIn).toBe("Sisse logitud");
    expect(adminEt.shell.logout).toBe("Logi välja");
    // Hindamine (e-course completion, spec §5.2): its own address, its badge's words for a screen reader
    expect(SECTIONS.find((s) => s.key === "assessment")).toEqual({ key: "assessment", href: "/admin/hindamine", icon: "check" });
    expect(SECTIONS.find((s) => s.key === "protocols")).toEqual({ key: "protocols", href: "/admin/protokollid", icon: "clipboard" });
    expect(SECTIONS.find((s) => s.key === "testing")).toEqual({ key: "testing", href: "/admin/testimine", icon: "check" });
    expect(adminEt.shell.badgeAssessment).toBe("{n} ootab hindamist");
  });
  test("the status labels are Maria's words; the old 'e-learning purchases will come with the payments' note is gone (they show on Maksed and in the student's drawer)", () => {
    expect(adminEt.registrations.status).toEqual({ awaiting_prepayment: "Ootab ettemaksu", confirmed: "Kinnitatud", cancelled: "Tühistatud" });
    expect(adminEt.registrations.type).toEqual({ all: "Kõik vormid", e: "E-õpe", k: "Kontaktõpe" });
    expect(adminEt.registrations).not.toHaveProperty("eNote");
    expect(JSON.stringify(adminEt)).not.toContain("lisanduvad koos maksetega");
    expect(adminEt.requests.tabs).toEqual({ kontakt: "Kontakt", individuaal: "Individuaal", praktika: "Praktika", ootenimekiri: "Ootenimekiri", muutmine: "Muutmine" });
  });
});

describe("Maksed (phase 2b, spec 8): Maria's words", () => {
  const t = adminEt.payments;
  test("the menu entry, the heading, the lead (Montonio halduses), the filter and the statuses", () => {
    expect(adminEt.nav.payments).toBe("Maksed ja arved");
    // the heading Maksed and Arved share (A6: the eyebrow of W21 and the H1 of the Part 2 mock); `title` is the word „Maksed“ (the card, the Õpilased fold)
    expect([t.eyebrow, t.heading, t.title]).toEqual(["Montonio ja raamatupidamine", "Maksed ja arved", "Maksed"]);
    expect(t.tabs).toEqual({ payments: "Maksed", invoices: "Arved" });
    expect(t.searchPlaceholder).toBe("Otsi nime, e-posti või Montonio id järgi"); // piece 2 texts S3-m
    expect([t.things, t.open, t.openRegistration, t.openStudent]).toEqual(["makseid", "Ava {name}", "Ava registreering →", "Ava õpilane →"]);
    expect([t.montonio, t.montonioCopied]).toEqual(["Montonios", "Montonio id kopeeritud."]); // (the arrow is the component's)
    expect(t.montonioFor).toBe(`${t.montonio} ↗ — {name}`); // (the link's name: its visible text and the payer's, no other words)
    expect(t.lead).toBe("Veebimaksed Montonio kaudu, uuemad eespool. Tagastused tehakse Montonio halduses; pangaülekanded märgid registreerimise juures nagu varem.");
    expect(t.filter).toEqual({ all: "Kõik", paid: "Makstud", pending: "Pooleli", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil" });
    // replaced (B22, README §5): „Asendatud“, with no filter of its own (P-8: under „Kõik“ only)
    expect(t.status).toEqual({ pending: "Pooleli", paid: "Makstud", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil", replaced: "Asendatud" });
    expect(t.statusVoided).toBe("Tühistatud pangas");
    expect(t.kind).toEqual({ prepayment: "Ettemaks", balance: "Ülejäänud", ecourse: "E-koolitus" });
    expect(t.check).toBe("Kontrolli Montonios");
    // a held payment's check reason, said in place of „Kontrolli Montonios“ (B22, README §5)
    expect(t.reason).toEqual({ double: "Topeltmakse — tagasta" });
  });
  test("the column heads: 'Eest', not the bare question word 'Mis'; the kind and the way it was paid are lines under 'Eest' and 'Summa', with no column of their own (A6)", () => {
    expect(t.col).toEqual({ date: "Kuupäev", payer: "Maksja", what: "Eest", amount: "Summa", status: "Staatus", provider: "Montonio id" });
  });
  test("an access a payment opened says so in the student's drawer", () => {
    expect(adminEt.clients.drawer.byPayment).toBe("veebimakse");
  });
});
