import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { nextStep, type ContactCard } from "@/domain/account-cards";
import { getDict } from "@/i18n/locales";
import { fill } from "@/i18n/format";
import { accountLink, ecourseOpenMail, esc, loginMail, passwordChangedMail, payLinkUrl, registrationConfirmationMail, requestConfirmationMail, verifyLink, welcomeMail, type EcourseOpenInput, type RegistrationConfirmationInput } from "@/server/account-mail";

// The confirmation e-mails to a visitor who registered or sent a request (phase 2a Task 10): the texts in Estonian and
// Russian, with and without the prepayment instructions, with and without a login code, escaping, the "Ava minu konto"
// link and the colours. The sending (sample addresses, the login caps, the form handlers) is tests/db/actions.test.ts.

const BASE = "https://mslab.example";
const EMAIL = "kati+test@example.test";
const TOKEN = "tok-en_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PAY = { receiver: "MS LAB Koolituskeskus OÜ", iban: "ee382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
// 14.11.2026 10:00 in Estonia (UTC+2 in November)
const SESSION = { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" };

const registration = (over: Partial<RegistrationConfirmationInput> = {}): RegistrationConfirmationInput => ({
  siteUrl: BASE,
  email: EMAIL,
  name: "Kati Tamm",
  locale: "et",
  registrationId: 42,
  course: { et: "Kulmude baaskoolitus", ru: "Базовый курс по бровям" },
  session: SESSION,
  paymentChoice: "half",
  priceCents: 39000,
  prepayment: PAY,
  login: null,
  ...over,
});

const lines = (text: string) => text.split("\n");
const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;
/** The buttons of an HTML e-mail: the 48 px ink pills. */
const buttons = (html: string) => count(html, /mso-padding-alt/g);

describe("accountLink: Ava minu konto", () => {
  test("the login page with the address in the FRAGMENT (never a query), Russian under /ru", () => {
    expect(accountLink(BASE, "kati@example.test")).toBe(`${BASE}/konto/sisene#email=kati%40example.test`);
    expect(accountLink(`${BASE}/`, "kati@example.test", "ru")).toBe(`${BASE}/ru/konto/sisene#email=kati%40example.test`);
  });

  test("a '+' is %2B: a raw plus in a fragment would be read back as a space", () => {
    const link = accountLink(BASE, EMAIL);
    expect(link).toBe(`${BASE}/konto/sisene#email=kati%2Btest%40example.test`);
    expect(link).not.toContain("+");
    expect(link).not.toContain("?");
    expect(decodeURIComponent(link.split("#email=")[1])).toBe(EMAIL);
  });

  test("enterCode adds &kood=1 to the same fragment (the login page opens at the code step); still no query", () => {
    expect(accountLink(BASE, EMAIL, "et", true)).toBe(`${BASE}/konto/sisene#email=kati%2Btest%40example.test&kood=1`);
    expect(accountLink(`${BASE}/`, "kati@example.test", "ru", true)).toBe(`${BASE}/ru/konto/sisene#email=kati%40example.test&kood=1`);
    expect(accountLink(BASE, EMAIL, "et", true)).not.toContain("?");
    expect(accountLink(BASE, EMAIL)).not.toContain("kood");
  });
});

describe("registration confirmation, Estonian", () => {
  const mail = registrationConfirmationMail(registration());

  test("subject, recipient, greeting by first name, what was received, the course, when and where", () => {
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe("Registreering on vastu võetud — Kulmude baaskoolitus");
    const text = lines(mail.text);
    expect(text[0]).toBe("Tere, Kati!");
    expect(text).toContain("Registreering on vastu võetud.");
    expect(text).toContain("Kulmude baaskoolitus");
    expect(text).toContain("14.11.2026 · 10:00");
    expect(text).toContain("Pärnu, MS LAB stuudio");
    expect(text.at(-1)).toBe("MS LAB Koolituskeskus");
  });

  test("the next step: the prepayment (half of 390 € = 195 €) with the account's own sentence, and the payment rows", () => {
    const text = lines(mail.text);
    expect(text).toContain("Koha kinnitamiseks tasu ettemaks 195 €.");
    expect(text).toContain("Saaja: MS LAB Koolituskeskus OÜ");
    expect(text).toContain("IBAN: EE38 2200 2210 2014 5685");
    expect(text).toContain("Pank: Swedbank");
    expect(text).toContain("Summa: 195 €");
    expect(text).toContain("Selgitus: MSLAB-42");
    expect(text).toContain("Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.");
  });

  test("full payment asks for the whole price", () => {
    const full = registrationConfirmationMail(registration({ paymentChoice: "full" }));
    expect(lines(full.text)).toContain("Koha kinnitamiseks tasu ettemaks 390 €.");
    expect(lines(full.text)).toContain("Summa: 390 €");
  });

  test("Järelmaks (Inbank) asks for the whole price too (instalments spec D3)", () => {
    const financing = registrationConfirmationMail(registration({ paymentChoice: "financing" }));
    expect(lines(financing.text)).toContain("Koha kinnitamiseks tasu ettemaks 390 €.");
    expect(lines(financing.text)).toContain("Summa: 390 €");
  });

  test("the same sentence the dashboard card says (domain/account-cards.ts nextStep)", () => {
    const card: ContactCard = {
      kind: "contact", registrationId: 42, course: { slug: "kulmud", title: { et: "Kulmude baaskoolitus" } },
      session: { startsAt: SESSION.startsAt.toISOString(), city: "Pärnu", venue: "MS LAB stuudio", cancelled: false },
      status: "awaiting_prepayment", paymentChoice: "half", priceCents: 39000, paidCents: 0, createdAt: "2026-10-01T10:00:00Z",
    };
    for (const [locale, pay] of [["et", PAY], ["ru", PAY], ["et", null], ["ru", null]] as const) {
      const step = nextStep(card, new Date("2026-10-01T10:00:00Z"), pay, locale);
      const sentence = fill(getDict(locale).account.next[step.key as "pay" | "invoice"], step.vars);
      const sent = registrationConfirmationMail(registration({ locale, prepayment: pay }));
      expect(lines(sent.text), `${locale} ${pay ? "with" : "without"} instructions`).toContain(sentence);
    }
  });

  test("the button 'Ava minu konto' with the address pre-filled, and no login in it", () => {
    expect(lines(mail.text)).toContain("Ava minu konto:");
    expect(lines(mail.text)).toContain(`${BASE}/konto/sisene#email=kati%2Btest%40example.test`);
    expect(mail.text).not.toContain("/api/konto/verify");
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${BASE}/konto/sisene#email=kati%2Btest%40example.test"`);
    expect(mail.html).toContain(">Ava minu konto</a>");
    expect(mail.html).not.toContain("Logi sisse");
    expect(mail.html).not.toContain("30 minutit");
  });

  test("HTML: the greeting, the course box, the payment rows and the 'place' note, all there", () => {
    const html = mail.html!;
    expect(html.startsWith('<!doctype html><html lang="et">')).toBe(true);
    expect(html).toContain("<title>Registreering on vastu võetud — Kulmude baaskoolitus</title>");
    for (const part of ["Tere, Kati!", "Kulmude baaskoolitus", "14.11.2026 · 10:00", "Pärnu, MS LAB stuudio", "Koha kinnitamiseks tasu ettemaks 195 €.", "EE38 2200 2210 2014 5685", "MSLAB-42", "Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist."])
      expect(html, part).toContain(part);
  });
});

describe("registration confirmation, Russian", () => {
  const mail = registrationConfirmationMail(registration({ locale: "ru", name: "Мария Иванова" }));

  test("the texts, the course title, the date and the euros in Russian; the button goes to the Russian login page", () => {
    expect(mail.subject).toBe("Регистрация принята — Базовый курс по бровям");
    const text = lines(mail.text);
    expect(text[0]).toBe("Здравствуйте, Мария!");
    expect(text).toContain("Регистрация принята.");
    expect(text).toContain("Базовый курс по бровям");
    expect(text).toContain("14.11.2026 · 10:00");
    expect(text).toContain("Чтобы подтвердить место, оплатите предоплату 195 €.");
    expect(text).toContain("Получатель: MS LAB Koolituskeskus OÜ");
    expect(text).toContain("Назначение платежа: MSLAB-42");
    expect(text).toContain("Место подтверждается после поступления предоплаты не менее 50%.");
    expect(text.at(-1)).toBe("MS LAB Учебный центр");
    expect(text).toContain("Открыть мой кабинет:");
    expect(text).toContain(`${BASE}/ru/konto/sisene#email=kati%2Btest%40example.test`);
    expect(mail.html).toContain('lang="ru"');
    expect(mail.html).toContain(">Открыть мой кабинет</a>");
  });

  test("a course without a Russian title is named in Estonian", () => {
    expect(registrationConfirmationMail(registration({ locale: "ru", course: { et: "Ainult eesti" } })).subject).toBe("Регистрация принята — Ainult eesti");
  });
});

describe("registration confirmation without payment instructions", () => {
  test("no prepayment setting, or without a receiver or an IBAN: Maria sends an invoice, and there are no payment rows", () => {
    for (const prepayment of [null, { ...PAY, iban: "" }, { ...PAY, receiver: " " }]) {
      const mail = registrationConfirmationMail(registration({ prepayment }));
      const text = lines(mail.text);
      expect(text).toContain("Maria saadab sulle arve ettemaksu tasumiseks.");
      expect(mail.text).not.toMatch(/Saaja|IBAN|Pank|Summa|Selgitus|tasu ettemaks/);
      expect(text).toContain("Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.");
      expect(buttons(mail.html!)).toBe(1);
    }
    const ru = registrationConfirmationMail(registration({ locale: "ru", prepayment: null }));
    expect(lines(ru.text)).toContain("Мария пришлёт вам счёт для оплаты предоплаты.");
  });

  test("a course without a price cannot name an amount: the invoice sentence", () => {
    const mail = registrationConfirmationMail(registration({ priceCents: null }));
    expect(lines(mail.text)).toContain("Maria saadab sulle arve ettemaksu tasumiseks.");
    expect(mail.text).not.toContain("Summa");
  });

  test("the bank is optional: its row is left out, the others stay", () => {
    const mail = registrationConfirmationMail(registration({ prepayment: { ...PAY, bank: "" } }));
    expect(mail.text).not.toContain("Pank");
    expect(lines(mail.text)).toContain("Selgitus: MSLAB-42");
  });

  test("an empty reference prefix is the registration number alone", () => {
    expect(lines(registrationConfirmationMail(registration({ prepayment: { ...PAY, referencePrefix: "" } })).text)).toContain("Selgitus: 42");
  });
});

describe("with a login code (the visitor ticked 'Loo mulle kohe konto')", () => {
  const login = { token: TOKEN, code: "042917" };
  const CASES = [
    {
      locale: "et", intro: "Sinu sisselogimiskood:", button: "Logi sisse", valid: "Kood ja link kehtivad 30 minutit.",
      ignore: "Kui sa ei palunud sisselogimist, võid selle kirja kustutada.",
      codeHere: "Kui nupp ei tööta, sisesta kood siin:", codeLink: "Ava sisselogimine",
      link: `${BASE}/api/konto/verify?t=${TOKEN}`, codePage: `${BASE}/konto/sisene#email=kati%2Btest%40example.test&kood=1`,
    },
    {
      locale: "ru", intro: "Ваш код для входа:", button: "Войти", valid: "Код и ссылка действуют 30 минут.",
      ignore: "Если вы не запрашивали вход, просто удалите это письмо.",
      codeHere: "Если кнопка не работает, введите код здесь:", codeLink: "Открыть страницу входа",
      link: `${BASE}/api/konto/verify?t=${TOKEN}&l=ru`, codePage: `${BASE}/ru/konto/sisene#email=kati%2Btest%40example.test&kood=1`,
    },
  ] as const;

  test.each(CASES)(
    "$locale: the code large, ONE button 'Logi sisse' to the login link, the 30 minutes, the ignore line and a small link to the code step",
    ({ locale, intro, button, valid, ignore, codeHere, codeLink, link, codePage }) => {
      const mail = registrationConfirmationMail(registration({ locale, login }));
      expect(link).toBe(verifyLink(BASE, TOKEN, locale));
      const text = lines(mail.text);
      expect(text).toContain(intro);
      expect(text).toContain("042917");
      expect(text).toContain(`${button}:`);
      expect(text).toContain(link);
      expect(text).toContain(valid);
      // the 30 minutes, then the ignore line, then one sentence followed by the URL of the login page's code step
      expect(text.indexOf(ignore)).toBe(text.indexOf(valid) + 1);
      expect(text.slice(text.indexOf(codeHere), text.indexOf(codeHere) + 2)).toEqual([codeHere, codePage]);
      expect(mail.text).not.toMatch(/Ava minu konto|Открыть мой кабинет/); // the one button is the login's
      // the registration part is still all there
      expect(mail.text).toContain("14.11.2026 · 10:00");
      expect(mail.text).toContain("MSLAB-42");

      const html = mail.html!;
      expect(buttons(html)).toBe(1);
      expect(html).toContain(`href="${esc(link)}"`);
      expect(html).toContain(`>${button}</a>`);
      expect(html).toContain("font:600 32px"); // the code, large
      expect(html).toContain(">042917</div>");
      expect(html).toContain(valid);
      expect(html).toContain(ignore);
      expect(html.indexOf(ignore)).toBeGreaterThan(html.indexOf(valid));
      // the small link: text, not a button (no pill, no 48 px height), to the code step
      expect(html).toContain(`${codeHere} <a href="${esc(codePage)}" style="color:#222222;text-decoration:underline;">${codeLink}</a>`);
      expect(html.indexOf(codeHere)).toBeGreaterThan(html.indexOf(ignore));
      expect(html).not.toMatch(/Ava minu konto|Открыть мой кабинет/);
    },
  );

  test("the e-mail without a code has none of it: no code step link, no ignore line, no 30 minutes", () => {
    for (const locale of ["et", "ru"] as const) {
      const mail = registrationConfirmationMail(registration({ locale }));
      expect(mail.text).not.toContain("kood=1");
      expect(mail.html).not.toContain("kood=1");
      expect(mail.text).not.toMatch(/30 minut/);
    }
  });

  test("the subject is the registration's, not the login e-mail's: the code is not shown in a notification", () => {
    expect(registrationConfirmationMail(registration({ login })).subject).toBe("Registreering on vastu võetud — Kulmude baaskoolitus");
  });
});

describe("request confirmations", () => {
  test("individual request, Estonian: the dashboard card's sentence (account.next.requestNew), the course and the button", () => {
    const mail = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Kati Tamm", locale: "et", kind: "individual", title: { et: "Kulmude baaskoolitus" } });
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe("Päring on vastu võetud — Kulmude baaskoolitus");
    expect(lines(mail.text)).toEqual([
      "Tere, Kati!", "",
      "Päring on saadetud. Maria vastab peagi.", "",
      "Kulmude baaskoolitus", "",
      "Ava minu konto:",
      `${BASE}/konto/sisene#email=kati%2Btest%40example.test`, "",
      "MS LAB Koolituskeskus",
    ]);
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(">Ava minu konto</a>");
    expect(mail.html).toContain("Päring on saadetud. Maria vastab peagi.");
    expect(mail.text).toContain(getDict("et").account.next.requestNew); // what the card says (final review M6)
    expect(mail.text).not.toContain("Maria võtab sinuga ühendust.");
  });

  test("practice request, Russian: the package, the same short form", () => {
    const mail = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Мария", locale: "ru", kind: "practice", title: { et: "MINI", ru: "МИНИ" } });
    expect(mail.subject).toBe("Запрос принят — МИНИ");
    expect(lines(mail.text)).toEqual([
      "Здравствуйте, Мария!", "",
      getDict("ru").account.next.requestNew, "",
      "МИНИ", "",
      "Открыть мой кабинет:",
      `${BASE}/ru/konto/sisene#email=kati%2Btest%40example.test`, "",
      "MS LAB Учебный центр",
    ]);
  });

  test("waitlist, Estonian and Russian: the dashboard's sentence (account.next.waitlist) and the date and place; no 'Maria võtab sinuga ühendust.'", () => {
    const et = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Kati", locale: "et", kind: "waitlist", title: { et: "Kulmud" }, session: SESSION });
    expect(et.subject).toBe("Oled ootenimekirjas — Kulmud");
    expect(lines(et.text)).toEqual([
      "Tere, Kati!", "",
      "Oled ootenimekirjas. Anname teada, kui koht vabaneb.", "",
      "Kulmud", "14.11.2026 · 10:00", "Pärnu, MS LAB stuudio", "",
      "Ava minu konto:", `${BASE}/konto/sisene#email=kati%2Btest%40example.test`, "",
      "MS LAB Koolituskeskus",
    ]);
    expect(et.text).not.toContain("Maria võtab sinuga ühendust.");
    const ru = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Kati", locale: "ru", kind: "waitlist", title: { et: "Kulmud", ru: "Брови" }, session: SESSION });
    expect(ru.subject).toBe("Вы в\u00a0списке ожидания — Брови");
    expect(lines(ru.text)).toEqual(expect.arrayContaining([getDict("ru").account.next.waitlist, "Брови", "14.11.2026 · 10:00", "Открыть мой кабинет:"]));
    expect(ru.text).not.toContain("свяжется");
    // the same sentence as the dashboard card says
    for (const [locale, mail] of [["et", et], ["ru", ru]] as const) expect(mail.text).toContain(getDict(locale).account.next.waitlist);
    expect(et.html).toContain("Oled ootenimekirjas. Anname teada, kui koht vabaneb.");
  });

  test("an individual request that ticked the account box can carry a login code and then has ONE button, 'Logi sisse'", () => {
    const mail = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Kati", locale: "et", kind: "individual", title: { et: "Kulmud" }, login: { token: TOKEN, code: "000123" } });
    expect(lines(mail.text)).toEqual(expect.arrayContaining(["000123", "Logi sisse:", `${BASE}/api/konto/verify?t=${TOKEN}`, "Kood ja link kehtivad 30 minutit.", "Päring on saadetud. Maria vastab peagi."]));
    expect(mail.text).not.toContain("Ava minu konto");
    expect(buttons(mail.html!)).toBe(1);
  });

  test("the time is Estonian time wherever the server runs (summer: UTC+3, here already past midnight)", () => {
    const mail = requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "Kati", locale: "et", kind: "waitlist", title: { et: "Kulmud" }, session: { startsAt: new Date("2026-06-20T21:30:00Z"), city: "Tallinn", venue: "" } });
    expect(lines(mail.text)).toContain("21.06.2026 · 00:30"); // after midnight in Tallinn
    expect(lines(mail.text)).toContain("Tallinn"); // no venue: no trailing comma
  });
});

describe("HTML safety and design", () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&<script>alert(2)</script>';
  const mails = (login: { token: string; code: string } | null) => [
    registrationConfirmationMail(
      registration({
        name: `"><b>x</b> Tamm`,
        course: { et: hostile, ru: hostile },
        session: { startsAt: SESSION.startsAt, city: hostile, venue: hostile },
        prepayment: { receiver: hostile, iban: "<i>EE38</i>", bank: hostile, referencePrefix: "<u>" },
        login,
      }),
    ),
    requestConfirmationMail({ siteUrl: BASE, email: EMAIL, name: "<i>Kati</i>", locale: "ru", kind: "waitlist", title: { et: hostile }, session: { startsAt: SESSION.startsAt, city: hostile, venue: "" }, login }),
  ];

  test.each([["without a code", null], ["with a code", { token: TOKEN, code: "042917" }]])("%s: a hostile course title, name, place or payment value never opens a tag or ends an attribute", (_name, login) => {
    for (const mail of mails(login)) {
      const html = mail.html!;
      expect(html).not.toMatch(/<(img|script|b|i|u)\b/i);
      expect(html).not.toContain("onerror=alert(1)>");
      expect(html).not.toContain('"><b>');
      expect(html).toContain("&lt;");
      // the text body is plain text: nothing to escape, but the title stays one line in the subject
      expect(mail.subject).not.toMatch(/\n/);
    }
    expect(mails(login)[0].html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(mails(login)[0].html).toContain("Tere, &quot;&gt;&lt;b&gt;x&lt;/b&gt;!");
  });

  test("a site address with quotes and angle brackets cannot break the button's href", () => {
    const mail = registrationConfirmationMail(registration({ siteUrl: `https://x.example/a"><i>` }));
    expect(mail.html).not.toContain("<i>");
    expect(mail.html).toContain("https://x.example/a&quot;&gt;&lt;i&gt;/konto/sisene#email=");
  });

  test("a subject is one line: line breaks in a course title are folded into spaces", () => {
    expect(registrationConfirmationMail(registration({ course: { et: "Kulmud\r\nBcc: x\n  kaks" } })).subject).toBe("Registreering on vastu võetud — Kulmud Bcc: x kaks");
  });

  test("tables and inline styles only: no images, scripts, external CSS, web fonts or addresses but the one link", () => {
    for (const login of [null, { token: TOKEN, code: "042917" }])
      for (const locale of ["et", "ru"] as const) {
        const html = registrationConfirmationMail(registration({ locale, login })).html!;
        expect(html).not.toMatch(/<(img|script|link|style|iframe|video|svg)\b/i);
        expect(html).not.toMatch(/@import|@font-face|url\(|src=/i);
        const links = new Set(html.match(/https?:\/\/[^"'<\s]+/g));
        expect([...links].every((u) => u.startsWith(`${BASE}/`)), [...links].join(" ")).toBe(true);
        expect(html).toContain("Jost, Manrope, Arial, sans-serif");
        // the button is as tall as the site's (48 px), a link a thumb can hit
        expect(html).toContain("height:48px");
      }
  });

  test("every colour is one of the site's tokens (src/styles/tokens.css)", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens = new Set(css.match(/#[0-9a-f]{6}\b/gi)!.map((c) => c.toLowerCase()));
    for (const mail of [...mails(null), ...mails({ token: TOKEN, code: "042917" })]) {
      const used = new Set(mail.html!.match(/#[0-9a-f]{3,8}\b/gi)!.map((c) => c.toLowerCase()));
      expect(used.size).toBeGreaterThan(3);
      for (const colour of used) expect(tokens.has(colour), colour).toBe(true);
    }
    // the registration e-mail with its boxes uses the canvas and line tokens too
    const plain = registrationConfirmationMail(registration()).html!;
    expect(plain).toContain("#f6f4f5");
    expect(plain).toContain("#e6e1e3");
  });
});

describe("the welcome mail (phase 2c; one step, 09.10)", () => {
  const LINK = "https://mslab.example/api/newsletter/loobu?t=tok-en_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  test("Estonian, with a code: the subject, the code large, how to use it, that Maria takes the discount off the invoice, and the unsubscribe line last before the signature", () => {
    const mail = welcomeMail("uus@example.test", "TERE10", "et", LINK);
    expect(mail.to).toBe("uus@example.test");
    expect(mail.subject).toBe("Tere tulemast MS LABi!");
    expect(mail.text).toBe(
      [
        "Tere!", "", "Aitäh, et liitusid MS LABi uudiskirjaga.", "",
        "Sinu tervituskood:", "", "TERE10", "",
        "Lisa kood registreerimisel lahtrisse „Sõnum“.", "Maria arvestab soodustuse sinu arvelt maha.", "",
        `Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: ${LINK}`, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(mail.html).toContain(">TERE10</div>");
    expect(mail.html).toContain("Lisa kood registreerimisel lahtrisse „Sõnum“.");
    expect(mail.html).toContain("Maria arvestab soodustuse sinu arvelt maha.");
  });

  test("with the code's days (Hüpikaken „Kood kehtib (päeva)“, S4-Q3 A): one line after the code's lines, in the language's number form; none without a code", () => {
    const mail = welcomeMail("uus@example.test", "TERE10", "et", LINK, 30);
    expect(mail.text).toBe(
      [
        "Tere!", "", "Aitäh, et liitusid MS LABi uudiskirjaga.", "",
        "Sinu tervituskood:", "", "TERE10", "",
        "Lisa kood registreerimisel lahtrisse „Sõnum“.", "Maria arvestab soodustuse sinu arvelt maha.", "Kood kehtib 30 päeva.", "",
        `Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: ${LINK}`, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(mail.html).toContain("Kood kehtib 30 päeva.");
    expect(mail.html!.indexOf("Kood kehtib")).toBeGreaterThan(mail.html!.indexOf("arvestab soodustuse"));
    expect(welcomeMail("uus@example.test", "TERE10", "et", LINK, 1).text).toContain("\nKood kehtib 1 päev.\n");
    expect(welcomeMail("uus@example.test", "TERE10", "ru", LINK, 5).text).toContain("\nКод действует 5 дней.\n");
    for (const [code, days] of [[null, 30], ["TERE10", null], ["TERE10", undefined]] as const) {
      const other = welcomeMail("uus@example.test", code, "et", LINK, days);
      expect(other.text + other.html, `${code} ${days}`).not.toContain("Kood kehtib");
    }
  });

  test("Estonian, without a code: no code lines (nor the text about using one), the unsubscribe line stays", () => {
    const mail = welcomeMail("uus@example.test", null, "et", LINK);
    expect(mail.text).toBe(
      ["Tere!", "", "Aitäh, et liitusid MS LABi uudiskirjaga.", "", `Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: ${LINK}`, "", "MS LAB Koolituskeskus"].join("\n"),
    );
    for (const body of [mail.text, mail.html!]) {
      expect(body).not.toContain("Sinu tervituskood");
      expect(body).not.toContain("Lisa kood");
      expect(body).not.toContain("arvestab soodustuse");
    }
    expect(mail.html).not.toContain("letter-spacing"); // the code box is not there either
    expect(mail.html).toContain("loobu siit:");
  });

  test("the HTML body has the unsubscribe line as the last row before the signature, with the link clickable and escaped", () => {
    const tricky = "https://mslab.example/api/newsletter/loobu?t=a&b=\"<x>";
    const html = welcomeMail("uus@example.test", "TERE10", "et", tricky).html!;
    expect(html).toContain(`<a href="${esc(tricky)}`);
    expect(html).not.toContain(tricky);
    expect(html.indexOf("loobu siit")).toBeGreaterThan(html.indexOf("TERE10"));
    expect(html.indexOf("loobu siit")).toBeLessThan(html.indexOf("MS LAB Koolituskeskus"));
    expect(welcomeMail("uus@example.test", null, "et", LINK).html).toContain(`<a href="${LINK}"`);
  });

  test("Russian: the code lines when there is a code, the unsubscribe line in both cases, with no-break spaces where the rule asks (there is no one-letter word in it)", () => {
    const mail = welcomeMail("uus@example.test", "TERE10", "ru", LINK);
    expect(mail.subject).toBe("Добро пожаловать в\u00a0MS LAB!");
    expect(mail.text).toContain(getDict("ru").mail.welcome.use); // "Укажите код при регистрации в поле «Сообщение»."
    expect(mail.text).toContain("Мария вычтет скидку из вашего счёта.");
    const line = `Если вы не подписывались сами или больше не хотите получать письма MS LAB, отпишитесь здесь: ${LINK}`;
    expect(mail.text).toContain(line);
    expect(welcomeMail("uus@example.test", null, "ru", LINK).text).toBe(
      ["Здравствуйте!", "", "Спасибо, что подписались на рассылку MS LAB.", "", line, "", "MS LAB Учебный центр"].join("\n"),
    );
  });
});

describe("the password changed mail (phase 2c)", () => {
  test("the line, and whom to write to if it was not her: Maria's address when the contact setting has one", () => {
    const mail = passwordChangedMail("kati@example.test", "et", "info@mslab.ee");
    expect(mail.subject).toBe("MS LABi konto parool on muudetud");
    expect(mail.text).toBe(["Tere!", "", "Sinu MS LABi konto parool on muudetud.", "Kui see polnud sina, kirjuta kohe Mariale: info@mslab.ee", "", "MS LAB Koolituskeskus"].join("\n"));
    expect(passwordChangedMail("kati@example.test", "et", "").text).toContain("Kui see polnud sina, kirjuta kohe Mariale.");
    expect(mail.html).toContain("Sinu MS LABi konto parool on muudetud.");
  });

  test("Russian", () => {
    const mail = passwordChangedMail("kati@example.test", "ru", "info@mslab.ee");
    expect(mail.subject).toBe("Пароль кабинета MS LAB изменён");
    expect(mail.text).toContain("Если это были не вы, сразу напишите Марии: info@mslab.ee");
  });
});

describe("registration confirmation with online payments (phase 2b)", () => {
  const LINK = `${BASE}/maksa/${TOKEN}`;
  test("payLinkUrl: the registration's own page, /maksa/<pay_token>", () => {
    expect(payLinkUrl(`${BASE}/`, TOKEN)).toBe(LINK);
  });

  test("'Maksa 195 €' is the one button, then 'või tasu pangaülekandega' and the transfer rows; 'Ava minu konto' becomes a text link", () => {
    const mail = registrationConfirmationMail(registration({ payLink: LINK }));
    expect(mail.text).toContain(["Koha kinnitamiseks tasu ettemaks 195 €.", "", `Maksa 195 €: ${LINK}`, "", "või tasu pangaülekandega", "", "Saaja: MS LAB Koolituskeskus OÜ"].join("\n"));
    expect(mail.text).toContain("Selgitus: MSLAB-42");
    expect(mail.text).toContain("Ava minu konto:");
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${esc(LINK)}"`);
    expect(mail.html).toMatch(/<a href="[^"]*konto\/sisene#email=[^"]*" style="color:#222222;text-decoration:underline;">Ava minu konto<\/a>/);
  });

  test("without the transfer instructions: the button alone (no 'Maria saadab sulle arve'); paid enough: today's mail", () => {
    const noIban = registrationConfirmationMail(registration({ payLink: LINK, prepayment: null }));
    expect(noIban.text).toContain(`Maksa 195 €: ${LINK}`);
    expect(noIban.text).not.toContain("või tasu pangaülekandega");
    expect(noIban.text).not.toContain(getDict("et").account.next.invoice);
    expect(registrationConfirmationMail(registration({ payLink: LINK, priceCents: null })).text).not.toContain("Maksa");
  });

  test("with a login code the code block stays as it is (its own 'Logi sisse')", () => {
    const mail = registrationConfirmationMail(registration({ payLink: LINK, login: { token: TOKEN, code: "123456" } }));
    expect(buttons(mail.html!)).toBe(2);
    expect(mail.text).toContain("123456");
  });

  test("Russian", () => {
    const mail = registrationConfirmationMail(registration({ locale: "ru", payLink: LINK }));
    expect(mail.text).toContain(`Оплатить 195 €: ${LINK}`);
    expect(mail.text).toContain("или оплатите банковским переводом");
  });

  test("without payments (no payLink) the mail is today's", () => {
    expect(registrationConfirmationMail(registration({ payLink: null }))).toEqual(registrationConfirmationMail(registration()));
  });

  test("a Järelmaks (Inbank) registration (instalments §4): the whole price, and the one 'Maksa' link to the pay page — where both buttons are, not a second link in the mail", () => {
    const mail = registrationConfirmationMail(registration({ paymentChoice: "financing", payLink: LINK }));
    expect(mail.text).toContain(["Koha kinnitamiseks tasu ettemaks 390 €.", "", `Maksa 390 €: ${LINK}`, "", "või tasu pangaülekandega"].join("\n"));
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.text.split(LINK)).toHaveLength(2);
    expect(mail.text).not.toContain("järelmaks");
    expect(mail.text).not.toContain("Inbank");
  });
});

describe("ecourseOpenMail: 'E-koolitus on avatud' (phase 2b, spec 6.2.4)", () => {
  const input = (over: Partial<EcourseOpenInput> = {}): EcourseOpenInput => ({
    siteUrl: BASE,
    email: EMAIL,
    name: "Kati Tamm",
    locale: "et",
    course: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" },
    expiresAt: new Date("2027-04-09T20:59:59.999Z"),
    login: { token: TOKEN, code: "123456" },
    ...over,
  });
  const IGNORE = { et: getDict("et").account.mail.ignore, ru: getDict("ru").account.mail.ignore };

  test("subject, lead, the course with 'Ligipääs kuni …', the code large and one button, Logi sisse, that opens the login link", () => {
    const mail = ecourseOpenMail(input());
    expect([mail.to, mail.subject]).toEqual([EMAIL, "E-koolitus on avatud — Kulmumeistri e-koolitus"]);
    for (const line of ["Tere, Kati!", "Makse on kätte saadud. E-koolitus on sinu jaoks avatud.", "Kulmumeistri e-koolitus", "Ligipääs kuni 09.04.2027.", "123456", "Logi sisse:", verifyLink(BASE, TOKEN), "Kood ja link kehtivad 30 minutit."])
      expect(mail.text).toContain(line);
    expect(buttons(mail.html!)).toBe(1);
    expect(mail.html).toContain(`href="${esc(verifyLink(BASE, TOKEN))}"`);
  });

  test("it never tells the buyer to delete it: the 'Kui sa ei palunud sisselogimist' line is left out, in both languages, in text and HTML", () => {
    for (const locale of ["et", "ru"] as const) {
      const mail = ecourseOpenMail(input({ locale }));
      expect(mail.text, locale).not.toContain(IGNORE[locale]);
      expect(mail.html, locale).not.toContain(IGNORE[locale]);
      expect(mail.text, locale).toContain(getDict(locale).account.mail.valid);
      expect(mail.text, locale).toContain("123456");
    }
    // the login mail itself, and the other confirmations that carry a code, keep the line
    expect(loginMail(BASE, EMAIL, TOKEN, "123456", "et").text).toContain(IGNORE.et);
    expect(registrationConfirmationMail(registration({ login: { token: TOKEN, code: "123456" } })).text).toContain(IGNORE.et);
  });

  test("without a live login (the address has its 3 already): 'Ava minu konto', no code", () => {
    const mail = ecourseOpenMail(input({ login: null }));
    expect(mail.text).toContain("Ava minu konto:");
    expect(mail.text).toContain(accountLink(BASE, EMAIL));
    expect(mail.text).not.toContain("123456");
    expect(mail.text).toContain("Ligipääs kuni 09.04.2027.");
    expect(buttons(mail.html!)).toBe(1);
  });

  test("Russian: the subject, the lead and the access line; the date is the Estonian day", () => {
    const mail = ecourseOpenMail(input({ locale: "ru" }));
    expect(mail.subject).toBe("Онлайн-курс открыт — Онлайн-курс бровиста");
    expect(mail.text).toContain("Платёж получен. Онлайн-курс для вас открыт.");
    expect(mail.text).toContain("Доступ до 09.04.2027.");
    expect(mail.text).toContain(verifyLink(BASE, TOKEN, "ru"));
  });

  test("a title with a line break stays one line in the subject; nothing the title holds opens a tag in the HTML", () => {
    const mail = ecourseOpenMail(input({ course: { et: "Kulmu\n<b>e-koolitus</b>" } }));
    expect(mail.subject).toBe("E-koolitus on avatud — Kulmu <b>e-koolitus</b>");
    expect(mail.html).not.toContain("<b>e-koolitus</b>");
  });
});
