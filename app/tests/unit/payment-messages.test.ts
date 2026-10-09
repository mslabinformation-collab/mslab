import { describe, expect, test } from "vitest";
import { registrationPaidMail } from "@/server/account-mail";
import { paymentAlertSummary, paymentSummary, type PaymentAlert, type PaymentNotice } from "@/server/messages";

// Phase 2b (spec 6.2.4–6.2.5, 9): Maria's notice of every payment ("Uus makse: {nimi}, {mis}, {summa}"), her alerts ("Kontrolli Montonios"),
// and the payer's mail after a paid registration in the confirmation mails' frame. Maria's texts carry no English Montonio codes (the owner's
// decision of 09.10): the way of paying is Estonian (domain/payments.ts paymentMethodLabel), a refund or a void is told in words, and the
// money she has received is "Laekunud summa". The payer's own mail keeps "Tasutud".

const NOTICE: PaymentNotice = {
  kind: "prepayment",
  name: "Kati Tamm",
  email: "kati@example.test",
  amountCents: 17500,
  course: "Kulmumeistri baaskoolitus",
  startsAt: new Date("2026-11-14T08:00:00Z"),
  method: "paymentInitiation",
  bank: "Swedbank",
  reference: "MSLAB-M7",
  providerUuid: "uuid-7",
  outcome: "confirmed",
  restCents: 17500,
};

const ADMIN = "https://mslab.example/admin";

describe("Maria's notice of a payment", () => {
  test("'Uus makse: {nimi}, {mis}, {summa}': the payment, what it is for, the payer, the way of paying and Montonio's id; what it did", () => {
    const s = paymentSummary(NOTICE, ADMIN);
    expect(s.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(s.short).toBe(s.subject);
    for (const line of ["Makse: Ettemaks", "Summa: 175 €", "Koolitus: Kulmumeistri baaskoolitus, 14.11.2026", "Maksja: Kati Tamm", "E-post: kati@example.test", "Makseviis: Pangalink · Swedbank", "Viide: MSLAB-M7", "Montonio: uuid-7"])
      expect(s.text).toContain(line);
    expect(s.text).toContain("Registreering on kinnitatud. Ülejäänud 175 € tasub ta koolituspäeval või Minu koolitustes.");
    expect(s.text).toContain("Admin: https://mslab.example/admin");
  });

  test("the outcomes: fully paid, the money only recorded, the course full (D2), an e-course opened, or not", () => {
    const note = (over: Partial<PaymentNotice>) => paymentSummary({ ...NOTICE, ...over }, ADMIN);
    expect(note({ kind: "balance", restCents: 0 }).text).toContain("Registreering on kinnitatud ja täielikult tasutud.");
    expect(note({ kind: "balance", restCents: 0 }).text).toContain("Makse: Ülejäänud");
    expect(note({ outcome: "received" }).text).toContain("Makse on registreeringule kirja pandud.");
    const full = note({ outcome: "full" });
    expect(full.subject).toBe("Makse laekus, aga koolitus on täis: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(full.text).toContain("Koolitus on täis: koht jäi kinnitamata");
    const ecourse = note({ kind: "ecourse", course: "Kulmumeistri e-koolitus", startsAt: null, outcome: "opened", amountCents: 19000 });
    expect(ecourse.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus, 190 €");
    expect(ecourse.text).toContain("Makse: E-koolitus");
    expect(ecourse.text).toContain("E-koolitus on avatud.");
    expect(note({ kind: "ecourse", outcome: "notOpened" }).text).toContain("E-koolitust ei avatud: koolitust ei leitud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
    expect(note({ kind: "ecourse", outcome: "notOpened" }).text).not.toContain("kursust");
  });

  test("the way of paying is Maria's word, never Montonio's code", () => {
    const line = (method: string, bank: string) => paymentSummary({ ...NOTICE, method, bank }, ADMIN).text.split("\n").find((l) => l.startsWith("Makseviis:"));
    expect(line("cardPayments", "")).toBe("Makseviis: Kaart");
    expect(line("applePay", "")).toBe("Makseviis: Apple Pay");
    expect(line("googlePay", "")).toBe("Makseviis: Google Pay");
    expect(line("blik", "")).toBe("Makseviis: BLIK");
    expect(line("paymentInitiation", "")).toBe("Makseviis: Pangalink");
    expect(line("somethingNew", "")).toBe("Makseviis: Muu");
    expect(line("", "")).toBe("Makseviis: Muu");
    for (const method of ["paymentInitiation", "cardPayments", "somethingNew"]) expect(paymentSummary({ ...NOTICE, method }, ADMIN).text).not.toMatch(/paymentInitiation|cardPayments|somethingNew|\bViis:/);
  });
});

describe("Maria's alerts: 'Kontrolli Montonios'", () => {
  const ALERT: PaymentAlert = {
    alert: "held",
    kind: "prepayment",
    name: "Kati Tamm",
    email: "kati@example.test",
    amountCents: 17500,
    course: "Kulmumeistri baaskoolitus",
    startsAt: new Date("2026-11-14T08:00:00Z"),
    reference: "MSLAB-M7",
    providerUuid: "uuid-7",
    rawStatus: "PAID",
    paidCents: 100,
    currency: "EUR",
  };
  const alert = (over: Partial<PaymentAlert>) => paymentAlertSummary({ ...ALERT, ...over }, ADMIN);

  test("the subject names her, the course and the amount; the text says what happened and that nothing changed by itself", () => {
    expect(alert({}).subject).toBe("Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(alert({}).text).toContain("Montonio ütleb makstud, aga summa või valuuta ei klapi (Montonio: 1 €). Midagi ei kinnitatud ega avatud: makse on lehel Maksed \"Ootel kontrollil\".");
    expect(alert({ alert: "voided", rawStatus: "VOIDED" }).text).toContain("Pank tühistas juba laekunud makse. Kinnitus ja ligipääs jäid alles: otsusta, kas need tühistada (Registreerimised, Õpilased).");
    expect(alert({ alert: "refunded", rawStatus: "PARTIALLY_REFUNDED" }).text).toContain(
      "Montonio teatab tagastusest (osaliselt tagastatud). Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.",
    );
    expect(alert({ alert: "refunded", rawStatus: "REFUNDED" }).text).toContain("Montonio teatab tagastusest (tagastatud). Laekunud summa,");
  });

  test("the amount Montonio named: euros without a doubled currency, another currency by its code, a missing one said so", () => {
    const held = (over: Partial<PaymentAlert>) => alert(over).text;
    expect(held({ paidCents: 100, currency: "EUR" })).toContain("(Montonio: 1 €)");
    expect(held({ paidCents: 100, currency: "EUR" })).not.toContain("EUR");
    expect(held({ paidCents: 12550, currency: "PLN" })).toContain("(Montonio: 125,50 PLN)");
    expect(held({ paidCents: 100, currency: null })).toContain("(Montonio: 1, valuuta puudub)");
    expect(held({ paidCents: null, currency: "EUR" })).toContain("(Montonio: summa puudub)");
    expect(held({ paidCents: null, currency: null })).toContain("(Montonio: summa puudub, valuuta puudub)");
  });

  test("no English Montonio code in any of her texts: not the statuses, not the methods, not 'EUR'", () => {
    const texts = [
      alert({}),
      alert({ alert: "voided", rawStatus: "VOIDED" }),
      alert({ alert: "refunded", rawStatus: "PARTIALLY_REFUNDED" }),
      alert({ alert: "refunded", rawStatus: "REFUNDED" }),
      paymentSummary(NOTICE, ADMIN),
      paymentSummary({ ...NOTICE, kind: "ecourse", outcome: "notOpened", method: "cardPayments" }, ADMIN),
    ].map((s) => `${s.subject}\n${s.text}\n${s.short}`);
    for (const text of texts) expect(text).not.toMatch(/VOIDED|REFUNDED|ABANDONED|PAID\b|paymentInitiation|cardPayments|\bEUR\b|Tasutud summa/);
  });
});

describe("the payer's mail after a paid registration", () => {
  const input = {
    siteUrl: "https://mslab.example",
    email: "kati@example.test",
    name: "Kati Tamm",
    locale: "et" as const,
    course: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" },
    session: { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" },
    paidCents: 17500,
    restCents: 17500,
    confirmed: true,
    full: false,
  };

  test("confirmed: 'Koht on kinnitatud — …', the course, its date and place, what was paid and what is left; one button, Ava minu konto", () => {
    const mail = registrationPaidMail(input);
    expect([mail.to, mail.subject]).toEqual(["kati@example.test", "Koht on kinnitatud — Kulmumeistri baaskoolitus"]);
    for (const line of ["Tere, Kati!", "Makse on kätte saadud. Sinu koht on kinnitatud.", "Kulmumeistri baaskoolitus", "14.11.2026 · 10:00", "Pärnu, MS LAB stuudio", "Tasutud: 175 €", "Ülejäänud 175 € tasud koolituspäeval või Minu koolitused lehel.", "Ava minu konto:"])
      expect(mail.text).toContain(line);
    expect(mail.html!.match(/bgcolor="#222222"/g)).toHaveLength(1);
    expect(registrationPaidMail({ ...input, restCents: 0 }).text).toContain("Kogu summa on tasutud.");
  });

  test("not confirmed (the course was full): 'Makse on kätte saadud — …' and Maria will be in touch; no rest line", () => {
    const mail = registrationPaidMail({ ...input, confirmed: false, full: true });
    expect(mail.subject).toBe("Makse on kätte saadud — Kulmumeistri baaskoolitus");
    expect(mail.text).toContain("Koolitus on vahepeal täitunud, nii et koht jäi kinnitamata. Maria võtab sinuga ühendust.");
    expect(mail.text).not.toContain("Ülejäänud");
  });

  test("paid but not confirmed and not full (under half): Maria will be in touch", () => {
    const mail = registrationPaidMail({ ...input, confirmed: false, full: false });
    expect(mail.subject).toBe("Makse on kätte saadud — Kulmumeistri baaskoolitus");
    expect(mail.text).toContain("Makse on kätte saadud. Aitäh!");
    expect(mail.text).toContain("Maria võtab sinuga ühendust.");
    expect(mail.text).not.toContain("Ülejäänud");
  });

  test("Russian", () => {
    const mail = registrationPaidMail({ ...input, locale: "ru" });
    expect(mail.subject).toBe("Место подтверждено — Базовый курс бровиста");
    expect(mail.text).toContain("Остаток 175 € оплачивается в день обучения или на странице «Мои курсы».");
    expect(mail.text).toContain("Оплачено: 175 €");
  });
});
