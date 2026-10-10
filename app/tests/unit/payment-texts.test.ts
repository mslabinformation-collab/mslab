import { describe, expect, test } from "vitest";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The visitor-facing texts of online payments (phase 2b, spec 9), pinned as the spec gives them. {amount} and {title} are the spec's
// {summa} and {kursus}. The Russian ones are drafts for the native-speaker check (docs/launch-checklist.md §10), with the account's typography
// rule: a no-break space ( ) after the one-letter words в, с, к, о, у.

describe("spec 9, verbatim", () => {
  test("Estonian", () => {
    expect([et.payment.pay, et.payment.payRest, et.payment.transfer]).toEqual(["Maksa {amount}", "Maksa ülejäänud {amount}", "või tasu pangaülekandega"]);
    expect(et.payment.page).toEqual({ heading: "Koolituse eest tasumine", nothing: "Selle registreeringu eest pole praegu midagi tasuda.", full: "See koolitus on täis. Võta ühendust Mariaga." });
    expect([et.payment.result.paid, et.payment.result.pending, et.payment.result.cancelled, et.payment.result.retry]).toEqual([
      "Makse õnnestus. Saatsime sulle kinnituse e-postiga.",
      "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.",
      "Makse jäi tegemata.",
      "Proovi uuesti",
    ]);
    expect([et.payment.mail.subjectConfirmed, et.payment.mail.subjectReceived, et.payment.mail.subjectEcourse]).toEqual(["Koht on kinnitatud — {title}", "Makse on kätte saadud — {title}", "E-koolitus on avatud — {title}"]);
    expect(et.payment.mail.rest).toBe("Ülejäänud {amount} tasud koolituspäeval või Minu koolitused lehel.");
  });

  test("Russian (with the no-break spaces)", () => {
    expect([ru.payment.pay, ru.payment.payRest, ru.payment.transfer]).toEqual(["Оплатить {amount}", "Оплатить остаток {amount}", "или оплатите банковским переводом"]);
    expect(ru.payment.page).toEqual({ heading: "Оплата обучения", nothing: "По этой регистрации сейчас ничего оплачивать не нужно.", full: "Эта группа заполнена. Свяжитесь с Марией." });
    expect([ru.payment.result.paid, ru.payment.result.pending, ru.payment.result.cancelled, ru.payment.result.retry]).toEqual([
      "Оплата прошла. Мы отправили вам подтверждение по e-mail.",
      "Платёж в обработке. Когда банк его подтвердит, мы пришлём подтверждение.",
      "Оплата не прошла.",
      "Попробовать снова",
    ]);
    expect([ru.payment.mail.subjectConfirmed, ru.payment.mail.subjectReceived, ru.payment.mail.subjectEcourse]).toEqual(["Место подтверждено — {title}", "Платёж получен — {title}", "Онлайн-курс открыт — {title}"]);
  });

  test("the Russian rest line is the passive of the card's own sentence (owner decision 09.10, wording.md item 8)", () => {
    expect(ru.payment.mail.rest).toBe("Остаток {amount} оплачивается в день обучения или на странице «Мои курсы».");
  });
});

describe("the e-course cart's own lines (owner's wording: 09.10, and 10.10 for the paid-a-moment-ago line)", () => {
  test("Estonian", () => {
    expect(et.payment.cartDown).toBe("Makse ei avanenud. Jäta oma e-post, anname teada.");
    expect(et.payment.alreadyPaid).toBe("Makse on juba tehtud — vaata oma e-posti.");
  });

  test("Russian", () => {
    expect(ru.payment.cartDown).toBe("Оплата не открылась. Оставьте свой e-mail, и мы сообщим.");
    expect(ru.payment.alreadyPaid).toBe("Оплата уже прошла — проверьте свою почту.");
  });
});

describe("Russian typography in every payment string", () => {
  const strings = (value: unknown, path: string): [string, string][] =>
    typeof value === "string" ? [[path, value]] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, `${path}.${k}`));

  test("no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = strings(ru.payment, "payment");
    expect(all.length).toBeGreaterThan(20);
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });
});
