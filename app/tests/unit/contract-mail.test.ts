import { describe, expect, test } from "vitest";
import type { Contract } from "@/db/schema";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import {
  accountLink, contractAttachment, contractMail, contractRequestMail, ecourseOpenMail, registrationConfirmationMail, type ContractMailInput, type EcourseOpenInput, type RegistrationConfirmationInput,
} from "@/server/account-mail";

// The contract's mails (contracts, Task 4; ruling R1; spec D7): contractMail, „MS LAB leping“ (Russian «Договор MS LAB»), the short mail of the
// terms gate that Tasks 5 („Saada koopia õpilasele“) and 6 („Kinnitan“) send too: the contract and its course, the PDF attached with the line
// „Leping on lisatud.“, one button to her account. And the line in the two mails that already carry other things: the registration's
// confirmation and the e-course's paid mail (whose invoice stays the first attachment). Draft wording but the subject and the line; the Russian
// strings are held to the account's typography rule (a no-break space after the one-letter words в, с, к, о, у).

const BASE = "https://mslab.example";
const EMAIL = "kati+test@example.test";
const NBSP = " ";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const ACCEPTED = new Date("2026-10-17T09:00:00Z");

const contract: ContractMailInput["contract"] = {
  id: 7,
  title: "E-koolituse tingimused",
  acceptedAt: ACCEPTED,
  fields: { school: { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, Pärnu" }, student: { name: "Kati Tamm", email: EMAIL }, course: "Kulmumeistri e-koolitus", session: "", price: "", payment: "" },
} satisfies Pick<Contract, "id" | "title" | "acceptedAt" | "fields">;
const input = (over: Partial<ContractMailInput> = {}): ContractMailInput => ({ siteUrl: BASE, email: EMAIL, name: "Kati Tamm", locale: "et", contract, pdf: PDF, ...over });
const lines = (text: string) => text.split("\n");
const buttons = (html: string) => (html.match(/mso-padding-alt/g) ?? []).length;

describe("contractMail: „MS LAB leping“", () => {
  const mail = contractMail(input());

  test("the subject, the greeting, the day she accepted it, the contract and its course; to her address", () => {
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe("MS LAB leping");
    const text = lines(mail.text);
    expect(text[0]).toBe("Tere, Kati!");
    expect(text).toContain("Kinnitasid lepingu 17.10.2026.");
    expect(text).toContain("E-koolituse tingimused");
    expect(text).toContain("Kulmumeistri e-koolitus");
    expect(mail.html).toContain("Kulmumeistri e-koolitus");
  });

  test("the PDF is its one attachment, „MS-LAB-leping-{id}.pdf“, with „Leping on lisatud.“", () => {
    expect(mail.attachments).toHaveLength(1);
    const [file] = mail.attachments!;
    expect([file.filename, file.contentType]).toEqual(["MS-LAB-leping-7.pdf", "application/pdf"]);
    expect(Buffer.from(file.content).equals(Buffer.from(PDF))).toBe(true);
    expect(lines(mail.text)).toContain("Leping on lisatud.");
    expect(mail.html).toContain("Leping on lisatud.");
    expect(et.account.contractMail.attached).toBe("Leping on lisatud.");
    expect(contractAttachment(7, PDF)).toEqual(file);
  });

  test("one button, „Ava minu konto“; for a student with no account (Task 5's copy), no button and no link to an account", () => {
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${accountLink(BASE, EMAIL, "et")}"`);
    const none = contractMail(input({ noAccount: true }));
    expect(buttons(none.html!)).toBe(0);
    expect(none.text).not.toContain("Ava minu konto");
    expect(none.attachments).toHaveLength(1);
  });

  test("a PDF that could not be rendered: no attachment and no line, the rest as it is", () => {
    const without = contractMail(input({ pdf: null }));
    expect(without.attachments).toBeUndefined();
    expect(without.text).not.toContain("Leping on lisatud.");
    expect(without.subject).toBe("MS LAB leping");
  });

  test("a contract with a session shows it under the course; a contract with no title names itself by the subject", () => {
    const contact = contractMail(input({ contract: { ...contract, title: "", fields: { ...contract.fields, course: "Kulmumeistri baaskoolitus", session: "14.11.2026, Pärnu" } } }));
    expect(lines(contact.text)).toEqual(expect.arrayContaining(["MS LAB leping", "Kulmumeistri baaskoolitus", "14.11.2026, Pärnu"]));
  });

  test("Russian: «Договор MS LAB», the Russian lines, the same attachment", () => {
    const r = contractMail(input({ locale: "ru" }));
    expect(r.subject).toBe("Договор MS LAB");
    expect(lines(r.text)).toEqual(expect.arrayContaining(["Здравствуйте, Kati!", "Вы подтвердили договор 17.10.2026.", `Договор во${NBSP}вложении.`]));
    expect(r.html).toContain('lang="ru"');
    expect(r.attachments!.map((a) => a.filename)).toEqual(["MS-LAB-leping-7.pdf"]);
  });
});

describe("contractRequestMail: Maria's „Saada leping kinnitamiseks“ (contracts Task 5, ruling R9, spec D4)", () => {
  const ask = { siteUrl: BASE, email: EMAIL, name: "Kati Tamm", course: "Kulmude baaskoolitus" };

  test("Estonian: „MS LAB leping kinnitamiseks“, a short greeting, one line naming the course, and a plain link to /konto", () => {
    const mail = contractRequestMail({ ...ask, locale: "et" });
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe("MS LAB leping kinnitamiseks");
    const text = lines(mail.text);
    expect(text[0]).toBe("Tere, Kati!");
    expect(text).toContain("Maria palub sul kinnitada lepingu koolituse „Kulmude baaskoolitus“ jaoks.");
    expect(text).toContain(`${BASE}/konto`);
    expect(mail.html).toContain(`href="${BASE}/konto"`);
    expect(mail.html).toContain("Kulmude baaskoolitus");
    expect(mail.attachments).toBeUndefined();
  });

  test("Russian: «Договор MS LAB — подтвердите», the Russian line, the link to /ru/konto", () => {
    const mail = contractRequestMail({ ...ask, locale: "ru" });
    expect(mail.subject).toBe("Договор MS LAB — подтвердите");
    const text = lines(mail.text);
    expect(text[0]).toBe("Здравствуйте, Kati!");
    expect(text).toContain(`Мария просит вас подтвердить договор по${NBSP}курсу «Kulmude baaskoolitus».`);
    expect(text).toContain(`${BASE}/ru/konto`);
    expect(mail.html).toContain('lang="ru"');
    expect(mail.html).toContain(`href="${BASE}/ru/konto"`);
  });

  test("the link carries no login: no token, no code, no address, no fragment (a plain page of the account)", () => {
    for (const locale of ["et", "ru"] as const) {
      const mail = contractRequestMail({ ...ask, locale });
      const links = [...mail.html!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(links.length, locale).toBeGreaterThan(0);
      for (const link of links) {
        expect(link, locale).toMatch(new RegExp(`^${BASE}(/ru)?/konto$`));
        expect(link).not.toMatch(/[?#=@]|verify|token/);
      }
      expect(mail.text).not.toContain("/api/konto/verify");
      expect(mail.text).not.toContain("#email=");
    }
  });

  test("one button; a base address with a trailing slash does not double it; a course name cannot open a tag", () => {
    const mail = contractRequestMail({ ...ask, siteUrl: `${BASE}/`, course: "<b>Kulmud</b> & \"co\"", locale: "et" });
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${BASE}/konto"`);
    expect(mail.html).not.toContain("<b>Kulmud</b>");
    expect(mail.html).toContain("&lt;b&gt;Kulmud&lt;/b&gt; &amp;");
  });

  test("a name with no word is the neutral greeting; a course name over several lines is one line", () => {
    const mail = contractRequestMail({ ...ask, name: "  ", course: "Kulmude\n baaskoolitus", locale: "et" });
    expect(lines(mail.text)[0]).toBe("Tere!");
    expect(lines(mail.text)).toContain("Maria palub sul kinnitada lepingu koolituse „Kulmude baaskoolitus“ jaoks.");
  });
});

describe("the line in the mails that already go out (D7)", () => {
  const registration = (over: Partial<RegistrationConfirmationInput> = {}): RegistrationConfirmationInput => ({
    siteUrl: BASE, email: EMAIL, name: "Kati Tamm", locale: "et", registrationId: 42, course: { et: "Kulmude baaskoolitus" },
    session: { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" }, paymentChoice: "half", priceCents: 39000, prepayment: null, login: null, ...over,
  });
  const ecourse = (over: Partial<EcourseOpenInput> = {}): EcourseOpenInput => ({
    siteUrl: BASE, email: EMAIL, name: "Kati Tamm", locale: "et", course: { et: "Kulmumeistri e-koolitus" }, expiresAt: new Date("2027-04-17T20:59:59.999Z"), login: null, ...over,
  });

  test("the registration's confirmation: „Leping on lisatud.“ when its contract is attached, nothing otherwise", () => {
    const withIt = registrationConfirmationMail(registration({ contractAttached: true }));
    expect(lines(withIt.text)).toContain("Leping on lisatud.");
    expect(withIt.html).toContain("Leping on lisatud.");
    expect(registrationConfirmationMail(registration()).text).not.toContain("Leping on lisatud.");
    expect(lines(registrationConfirmationMail(registration({ locale: "ru", contractAttached: true })).text)).toContain(`Договор во${NBSP}вложении.`);
  });

  test("the e-course's paid mail: the invoice's line and then the contract's", () => {
    const both = lines(ecourseOpenMail(ecourse({ invoiceAttached: true, contractAttached: true })).text);
    expect(both.indexOf("Leping on lisatud.")).toBeGreaterThan(both.indexOf("Arve on lisatud."));
    expect(both.indexOf("Arve on lisatud.")).toBeGreaterThan(-1);
    expect(lines(ecourseOpenMail(ecourse({ contractAttached: true })).text)).toContain("Leping on lisatud.");
    expect(ecourseOpenMail(ecourse({ invoiceAttached: true })).text).not.toContain("Leping on lisatud.");
  });
});

describe("the texts", () => {
  test("Estonian and Russian hold the same keys", () => {
    expect(Object.keys(ru.account.contractMail).sort()).toEqual(Object.keys(et.account.contractMail).sort());
    expect(Object.keys(ru.account.contractRequestMail).sort()).toEqual(Object.keys(et.account.contractRequestMail).sort());
  });

  test("Russian typography: no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = [...Object.entries(ru.account.contractMail), ...Object.entries(ru.account.contractRequestMail), ["forms.contractTerms", ru.forms.contractTerms], ["forms.readContract", ru.forms.readContract], ["forms.contractNoSession", ru.forms.contractNoSession], ["cart.contractTerms", ru.cart.contractTerms]];
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });

  test("the verbatim texts of the spec", () => {
    expect(et.forms.contractTerms).toBe("Olen tutvunud lepingu tingimustega ja nõustun nendega.");
    expect(et.cart.contractTerms).toBe("Olen tutvunud lepingu tingimustega ja nõustun nendega.");
    expect(et.forms.readContract).toBe("Loe lepingut");
    // the individual request keeps today's box (D1)
    expect(et.forms.terms).toBe("Olen tutvunud tingimustega ja nõustun nendega.");
  });
});
