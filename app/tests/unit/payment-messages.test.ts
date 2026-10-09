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
    const ecourse = note({ kind: "ecourse", course: "Kulmumeistri e-koolitus", startsAt: null, outcome: "opened", amountCents: 19000, until: new Date("2027-04-09T20:59:59.999Z") });
    expect(ecourse.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €");
    expect(ecourse.short).toBe(ecourse.subject);
    expect(ecourse.text).toContain("Makse: E-koolitus");
    expect(ecourse.text).toContain("Koolitus: Kulmumeistri e-koolitus\n");
    expect(ecourse.text).toContain("E-koolitus on avatud kuni 09.04.2027.");
    expect(note({ kind: "ecourse", outcome: "opened", startsAt: null }).text).toContain("E-koolitus on avatud.");
    // not opened: one neutral sentence for every reason (the course is gone or is no e-course any more, the grant was refused or failed)
    expect(note({ kind: "ecourse", outcome: "notOpened" }).text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
    expect(note({ kind: "ecourse", outcome: "notOpened" }).text).not.toMatch(/kursust|ei leitud/);
  });

  test("an e-course whose course is gone has no title to show: 'E-koolitus' alone, never a dash in brackets, and no empty 'Koolitus' row", () => {
    const gone = paymentSummary({ ...NOTICE, kind: "ecourse", course: "", startsAt: null, outcome: "notOpened", amountCents: 19000 }, ADMIN);
    expect(gone.subject).toBe("Uus makse: Kati Tamm, E-koolitus, 190 €");
    expect(gone.short).toBe(gone.subject);
    expect(gone.text).not.toMatch(/—|\(e-koolitus\)|^Koolitus:/m);
    expect(gone.text).toContain("Makse: E-koolitus");
    expect(gone.text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
  });

  test("an e-course payment never reads like a registration: no seat, no confirmation, no training day, whatever the outcome it is given", () => {
    for (const outcome of ["opened", "notOpened", "confirmed", "received", "full"] as const) {
      const s = paymentSummary({ ...NOTICE, kind: "ecourse", course: "Kulmumeistri e-koolitus", startsAt: null, outcome, restCents: 17500 }, ADMIN);
      const text = `${s.subject}\n${s.text}`;
      expect(text, outcome).not.toMatch(/registree|kinnita|koolituspäev|Minu koolitus|on täis|koht/i);
      expect(s.subject, outcome).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 175 €");
      expect(text, outcome).toMatch(outcome === "opened" ? /E-koolitus on avatud\./ : /E-koolitust ei avatud/);
    }
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

  test("an e-course's alerts say what happened to the access, not to a seat", () => {
    const e = (over: Partial<PaymentAlert>) => alert({ kind: "ecourse", course: "Kulmumeistri e-koolitus", startsAt: null, amountCents: 19000, ...over });
    expect(e({}).subject).toBe("Kontrolli Montonios: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €");
    expect(e({ course: "" }).subject).toBe("Kontrolli Montonios: Kati Tamm, E-koolitus, 190 €"); // the course is gone
    expect(e({}).text).toContain("Makse: E-koolitus");
    expect(e({}).text).toContain("Midagi ei avatud: makse on lehel Maksed \"Ootel kontrollil\".");
    expect(e({ alert: "voided", rawStatus: "VOIDED" }).text).toContain("Pank tühistas juba laekunud makse. Ligipääs jäi alles: otsusta, kas lõpetada see (Õpilased).");
    expect(e({ alert: "refunded", rawStatus: "REFUNDED" }).text).toContain("Montonio teatab tagastusest (tagastatud). Laekunud summa ja ligipääs jäid muutmata: muuda ligipääsu adminis (Õpilased), kui vaja.");
    expect(e({ alert: "double", otherUuid: "uuid-8" }).subject).toBe("Topeltmakse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €");
    for (const kind of ["held", "voided", "refunded", "double"] as const) {
      const s = e({ alert: kind, otherUuid: "uuid-8", rawStatus: "REFUNDED" });
      expect(`${s.subject}\n${s.text}`, kind).not.toMatch(/registree|kinnita|Kinnitus|koolituspäev|on täis/i);
    }
  });

  test("'Topeltmakse': a second order paid for the same payment; both order ids, and what to do", () => {
    const double = alert({ alert: "double", rawStatus: "PAID", paidCents: 17500, currency: "EUR", otherUuid: "uuid-8" });
    expect(double.subject).toBe("Topeltmakse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(double.short).toBe(double.subject);
    expect(double.text).toContain("Sama makse eest laekus teine tasumine (teine Montonio tellimus). Tagasta üks neist Montonio halduses.");
    expect(double.text).toContain("Montonio: uuid-7\nMontonio: uuid-8");
    for (const line of ["Makse: Ettemaks", "Summa: 175 €", "Maksja: Kati Tamm", "E-post: kati@example.test", "Viide: MSLAB-M7", "Admin: https://mslab.example/admin"]) expect(double.text).toContain(line);
    expect(alert({ alert: "double", otherUuid: null }).text.match(/Montonio: /g)).toHaveLength(1); // no second id to name
  });

  test("'Topeltmakse' names what the second order paid, in the held alert's words; the row's own amount stays in 'Summa'", () => {
    const double = (over: Partial<PaymentAlert>) => alert({ alert: "double", otherUuid: "uuid-8", ...over }).text;
    expect(double({ paidCents: 100, currency: "EUR" })).toContain("Summa: 175 €\n");
    expect(double({ paidCents: 100, currency: "EUR" })).toContain("Teine tasumine: 1 €\n");
    expect(double({ paidCents: 17500, currency: "EUR" })).toContain("Teine tasumine: 175 €\n");
    expect(double({ paidCents: 12550, currency: "PLN" })).toContain("Teine tasumine: 125,50 PLN\n");
    expect(double({ paidCents: null, currency: "EUR" })).toContain("Teine tasumine: summa puudub\n");
    // only the double alert has it: the held one says it in its sentence, the voided and refunded ones are about the row's own money
    for (const kind of ["held", "voided", "refunded"] as const) expect(alert({ alert: kind }).text).not.toContain("Teine tasumine");
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
      alert({ alert: "double", otherUuid: "uuid-8" }),
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
