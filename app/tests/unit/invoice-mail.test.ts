import { describe, expect, test } from "vitest";
import { accountLink, invoiceMail, type InvoiceMailInput } from "@/server/account-mail";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// Maria's „Saada õpilasele“ mail (invoices Task 5, ruling R1; spec §4, D11): „MS LAB arve {number}“, in Russian «Счёт MS LAB {number}». It
// carries the amount, the due date, the bank details and the reference (an unpaid invoice) or the paid date (a paid one), the invoice's
// PDF as its attachment, and one button to the student's account. All Draft wording but the subject; the Russian ones are held to the
// account's typography rule (a no-break space, written  , after the one-letter words в, с, к, о, у).

const BASE = "https://mslab.example";
const EMAIL = "kati+test@example.test";
const NBSP = " ";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

type Shown = InvoiceMailInput["invoice"];
const invoice = (over: Partial<Shown> = {}): Shown => ({
  number: "MSL2026-001",
  status: "unpaid",
  amountCents: 17500,
  dueAt: new Date("2026-10-23T09:00:00Z"),
  paidAt: null,
  reference: "MSLAB-42",
  line: { course: "Kulmude baaskoolitus", session: "14.11.2026 Pärnu", part: "Ettemaks 50%" },
  seller: { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, Pärnu", vatNumber: "", receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank" },
  ...over,
});
const input = (over: Partial<InvoiceMailInput> = {}): InvoiceMailInput => ({ siteUrl: BASE, email: EMAIL, name: "Kati Tamm", locale: "et", invoice: invoice(), pdf: PDF, ...over });

const lines = (text: string) => text.split("\n");
const buttons = (html: string) => (html.match(/mso-padding-alt/g) ?? []).length;

describe("the invoice mail, Estonian, an unpaid invoice", () => {
  const mail = invoiceMail(input());

  test("the subject is „MS LAB arve {number}“, the mail goes to the address it was made for", () => {
    expect(mail.subject).toBe("MS LAB arve MSL2026-001");
    expect(mail.to).toBe(EMAIL);
    expect(et.account.invoiceMail.subject).toBe("MS LAB arve {number}");
  });

  test("the greeting by first name, the course and its date, the amount, the due date, the bank details and the reference", () => {
    const text = lines(mail.text);
    expect(text[0]).toBe("Tere, Kati!");
    expect(text).toContain("Kulmude baaskoolitus");
    expect(text).toContain("14.11.2026 Pärnu");
    expect(text).toContain(`Summa: 175,00${NBSP}€`);
    expect(text).toContain("Tasumise tähtaeg: 23.10.2026");
    expect(text).toContain("Saaja: MS LAB Koolituskeskus OÜ");
    expect(text).toContain("IBAN: EE38 2200 2210 2014 5685");
    expect(text).toContain("Pank: Swedbank");
    expect(text).toContain("Selgitus: MSLAB-42");
    expect(text.at(-1)).toBe("MS LAB Koolituskeskus");
  });

  test("the PDF is the mail's one attachment, named after the number", () => {
    expect(mail.attachments).toHaveLength(1);
    const [file] = mail.attachments!;
    expect([file.filename, file.contentType]).toEqual(["MS-LAB-arve-MSL2026-001.pdf", "application/pdf"]);
    expect(Buffer.from(file.content).equals(Buffer.from(PDF))).toBe(true);
    expect(lines(mail.text)).toContain(et.account.invoiceMail.attached);
  });

  test("one button, „Ava minu konto“, to the login page with the address filled in; no login in the mail", () => {
    const link = accountLink(BASE, EMAIL, "et");
    expect(lines(mail.text)).toContain("Ava minu konto:");
    expect(lines(mail.text)).toContain(link);
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.html).not.toContain("/api/konto/verify");
    expect(mail.html).not.toContain("Logi sisse");
  });

  test("the HTML holds the same parts, and escapes what the course or the name holds", () => {
    const html = mail.html!;
    expect(html.startsWith('<!doctype html><html lang="et">')).toBe(true);
    expect(html).toContain("<title>MS LAB arve MSL2026-001</title>");
    for (const part of ["Tere, Kati!", "Kulmude baaskoolitus", `175,00${NBSP}€`, "23.10.2026", "EE38 2200 2210 2014 5685", "MSLAB-42"]) expect(html, part).toContain(part);
    const wild = invoiceMail(input({ name: "<b>Kati</b>", invoice: invoice({ line: { course: 'Kulmud <script>alert("x")</script>', session: "", part: "Ettemaks 50%" } }) }));
    expect(wild.html).not.toContain("<script>");
    expect(wild.html).not.toContain("<b>");
    expect(wild.html).toContain("Kulmud &lt;script&gt;");
  });

  test("a subject is one line, whatever the number holds", () => {
    expect(invoiceMail(input({ invoice: invoice({ number: "MSL2026-001\nBcc: x" }) })).subject).toBe("MS LAB arve MSL2026-001 Bcc: x");
  });

  test("the bank rows that are empty are left out; no due date, no row for it", () => {
    const bare = invoiceMail(input({ invoice: invoice({ reference: "", dueAt: null, seller: { ...invoice().seller, bank: "" } }) }));
    expect(bare.text).not.toContain("Pank:");
    expect(bare.text).not.toContain("Selgitus:");
    expect(bare.text).not.toContain("Tasumise tähtaeg");
  });
});

describe("the invoice mail, Estonian, a paid invoice", () => {
  const mail = invoiceMail(input({ invoice: invoice({ status: "paid", dueAt: null, paidAt: new Date("2026-10-15T08:00:00Z"), reference: "" }) }));

  test("says it is paid and when; asks for no payment: no due date, no bank details", () => {
    const text = lines(mail.text);
    expect(text).toContain(`Summa: 175,00${NBSP}€`);
    expect(text).toContain("Tasutud: 15.10.2026");
    expect(mail.text).not.toContain("IBAN");
    expect(mail.text).not.toContain("Tasumise tähtaeg");
    expect(mail.html).not.toContain("EE38 2200");
  });

  test("the PDF and the button are there all the same", () => {
    expect(mail.attachments).toHaveLength(1);
    expect(buttons(mail.html!)).toBe(1);
  });
});

describe("the invoice mail, Russian", () => {
  const mail = invoiceMail(input({ locale: "ru", name: "Мария Иванова" }));

  test("the subject is «Счёт MS LAB {number}», the greeting by first name, the labels and the button in Russian", () => {
    expect(mail.subject).toBe("Счёт MS LAB MSL2026-001");
    expect(ru.account.invoiceMail.subject).toBe("Счёт MS LAB {number}");
    const text = lines(mail.text);
    expect(text[0]).toBe("Здравствуйте, Мария!");
    expect(text).toContain(`${ru.account.dashboard.payment.amount}: 175,00${NBSP}€`);
    expect(text).toContain(`${ru.account.invoiceMail.due}: 23.10.2026`);
    expect(text).toContain(`${ru.account.dashboard.payment.iban}: EE38 2200 2210 2014 5685`);
    expect(text).toContain(`${ru.account.dashboard.payment.reference}: MSLAB-42`);
    expect(text).toContain(`${ru.account.mail.confirm.open}:`);
    expect(text).toContain(accountLink(BASE, EMAIL, "ru"));
    expect(mail.html!.startsWith('<!doctype html><html lang="ru">')).toBe(true);
  });

  test("the attachment is the same PDF under the same name; its line is in Russian", () => {
    expect(mail.attachments![0].filename).toBe("MS-LAB-arve-MSL2026-001.pdf");
    expect(lines(mail.text)).toContain(ru.account.invoiceMail.attached);
  });

  test("a paid invoice: «Оплачено» with the date, no bank details", () => {
    const paid = invoiceMail(input({ locale: "ru", invoice: invoice({ status: "paid", dueAt: null, paidAt: new Date("2026-10-15T08:00:00Z"), reference: "" }) }));
    expect(lines(paid.text)).toContain(`${ru.account.invoiceMail.paidOn}: 15.10.2026`);
    expect(paid.text).not.toContain("IBAN");
  });
});

describe("m9: the copy for „Saada ka aadressile“ (`second`, say the student's accountant)", () => {
  test("Estonian: a neutral greeting „Tere!“ (not the student's first name) and no „Ava minu konto“ (the account is the student's); the rest as the student's copy", () => {
    const mail = invoiceMail(input({ email: "raamatupidaja@firma.example", second: true }));
    const text = lines(mail.text);
    expect(text[0]).toBe("Tere!");
    expect(mail.text).not.toContain("Kati");
    expect(mail.text).not.toContain(et.account.mail.confirm.open);
    expect(mail.text).not.toContain("/konto/sisene");
    expect(buttons(mail.html!)).toBe(0);
    expect(mail.html).not.toContain("Kati");
    expect(mail.html).not.toContain("/konto/sisene");
    expect(mail.html).not.toContain(et.account.mail.confirm.open);
    // the invoice is all there: the subject, the amount, the bank details, the PDF, the signature
    expect(mail.subject).toBe("MS LAB arve MSL2026-001");
    expect(mail.to).toBe("raamatupidaja@firma.example");
    for (const part of [`Summa: 175,00${NBSP}€`, "IBAN: EE38 2200 2210 2014 5685", "Selgitus: MSLAB-42", et.account.invoiceMail.attached]) expect(text, part).toContain(part);
    expect(text.at(-1)).toBe("MS LAB Koolituskeskus");
    expect(mail.attachments).toHaveLength(1);
  });

  test("Russian: «Здравствуйте!» and no «Открыть мой кабинет»", () => {
    const mail = invoiceMail(input({ locale: "ru", name: "Мария Иванова", email: "buh@firma.example", second: true }));
    expect(lines(mail.text)[0]).toBe("Здравствуйте!");
    expect(mail.text).not.toContain("Мария");
    expect(mail.text).not.toContain(ru.account.mail.confirm.open);
    expect(buttons(mail.html!)).toBe(0);
  });

  test("the student's own copy keeps her name and the button", () => {
    const mail = invoiceMail(input({ second: false }));
    expect(lines(mail.text)[0]).toBe("Tere, Kati!");
    expect(buttons(mail.html!)).toBe(1);
  });
});

describe("Russian typography in every invoice-mail string", () => {
  const strings = (value: unknown, path: string): [string, string][] =>
    typeof value === "string" ? [[path, value]] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, `${path}.${k}`));

  test("no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = strings(ru.account.invoiceMail, "invoiceMail");
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });

  test("both dictionaries hold the same keys", () => {
    expect(Object.keys(ru.account.invoiceMail).sort()).toEqual(Object.keys(et.account.invoiceMail).sort());
  });
});
