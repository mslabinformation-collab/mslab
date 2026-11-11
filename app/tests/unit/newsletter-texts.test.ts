import { describe, expect, test } from "vitest";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The visitor-facing texts of the newsletter in one step (owner decision 09.10), pinned as the brief gives them. The Russian ones are
// drafts for the native-speaker check (docs/launch-checklist.md §9); the typography rule is the account's: a no-break space after the
// one-letter words в, с, к, о, у.

describe("the answers after \"Liitu\"", () => {
  test("Estonian: the heading, the line and the popup's one sentence; the line under the button is as it was", () => {
    expect(et.newsletter.sentTitle).toBe("Aitäh, oled liitunud!");
    expect(et.newsletter.sentText).toBe("Saatsime sulle tervituskirja.");
    expect(et.newsletter.popupSent).toBe("Aitäh, oled liitunud! Saatsime sulle tervituskirja.");
    expect(et.newsletter.notice).toBe("Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda.");
  });

  test("Russian", () => {
    expect(ru.newsletter.sentTitle).toBe("Спасибо, вы подписались!");
    expect(ru.newsletter.sentText).toBe("Мы отправили вам приветственное письмо.");
    expect(ru.newsletter.popupSent).toBe("Спасибо, вы подписались! Мы отправили вам приветственное письмо.");
    expect(ru.newsletter.notice).toBe("Подписываясь, вы получаете рассылку MS LAB. Отписаться можно в любой момент.");
  });

  test("nothing of the confirmation step is left to be shown: no 'check your inbox', no confirmation link in the answers", () => {
    for (const dict of [et, ru]) {
      const keys = Object.keys(dict.newsletter);
      expect(keys).not.toContain("confirmTitle");
      expect(keys).not.toContain("confirmText");
      expect(Object.keys(dict.mail)).not.toContain("confirmSubject");
      expect(Object.keys(dict.mail)).not.toContain("confirmText");
    }
  });
});

describe("the unsubscribe line of the welcome mail", () => {
  test("Estonian and Russian, with the link where {link} stands", () => {
    expect(et.mail.welcome.unsubscribe).toBe("Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: {link}");
    expect(ru.mail.welcome.unsubscribe).toBe("Если вы не подписывались сами или больше не хотите получать письма MS LAB, отпишитесь здесь: {link}");
  });
});

describe("the notice after the unsubscribe link (?uudiskiri=loobutud)", () => {
  test("Estonian and Russian", () => {
    expect(et.newsletter.unsubscribedTitle).toBe("Oled uudiskirjast loobunud.");
    expect(et.newsletter.unsubscribedText).toBe("Me ei saada sulle enam MS LABi uudiskirja.");
    expect(ru.newsletter.unsubscribedTitle).toBe("Вы отписались от рассылки.");
    expect(ru.newsletter.unsubscribedText).toBe("Мы больше не будем присылать вам рассылку MS LAB.");
  });
});

describe("the page behind the unsubscribe link (GET /api/newsletter/loobu)", () => {
  test("Estonian and Russian: heading, lead and the one button", () => {
    expect(et.newsletter.unsubscribePage).toEqual({
      heading: "Uudiskirjast loobumine",
      lead: "Vajuta nuppu, et MS LABi uudiskirjast loobuda.",
      button: "Loobu uudiskirjast",
    });
    expect(ru.newsletter.unsubscribePage).toEqual({
      heading: "Отказ от рассылки",
      lead: "Нажмите кнопку, чтобы отписаться от рассылки MS LAB.",
      button: "Отписаться от рассылки",
    });
  });
});

// F1 Task 11 (the spec's texts table): the welcome code's lines follow its row. Russian: the no-break space after в, as the typography rule asks.
describe("the welcome code's texts (they follow the welcome row)", () => {
  test("Estonian", () => {
    expect(et.mail.welcome.use).toBe("Kirjuta kood registreerimisel või ostukorvis lahtrisse „Sooduskood“.");
    expect(et.mail.welcome.value).toBe("Kood annab {soodustus} soodustust sinu esimeselt koolituselt.");
    expect(Object.keys(et.mail.welcome)).not.toContain("invoice");
    expect(et.mail.welcome.days.many).toBe("Kood kehtib {n} päeva.");
    expect(et.newsletter.codeLine).toBe("Sinu tervituskood: {code}. Kirjuta see registreerimisel või ostukorvis lahtrisse „Sooduskood“.");
    expect(et.newsletter.bodyNoCode).toBe("Uued koolitused ja kasulikud mõtted.");
  });

  test("Russian", () => {
    expect(ru.mail.welcome.use).toBe("Введите код при регистрации или в корзине в поле «Промокод».");
    expect(ru.mail.welcome.value).toBe("Код даёт скидку {soodustus} на ваш первый курс.");
    expect(Object.keys(ru.mail.welcome)).not.toContain("invoice");
    expect(ru.mail.welcome.days.many).toBe("Код действует {n} дней.");
    expect(ru.newsletter.codeLine).toBe("Ваш приветственный код: {code}. Введите его при регистрации или в корзине в поле «Промокод».");
    expect(ru.newsletter.bodyNoCode).toBe("Новые курсы и полезные идеи.");
  });
});

describe("Russian typography in the new strings", () => {
  const strings: [string, string][] = [
    ["newsletter.sentTitle", ru.newsletter.sentTitle],
    ["newsletter.sentText", ru.newsletter.sentText],
    ["newsletter.popupSent", ru.newsletter.popupSent],
    ["newsletter.unsubscribedTitle", ru.newsletter.unsubscribedTitle],
    ["newsletter.unsubscribedText", ru.newsletter.unsubscribedText],
    ["mail.welcome.unsubscribe", ru.mail.welcome.unsubscribe],
    ["mail.welcome.use", ru.mail.welcome.use],
    ["mail.welcome.value", ru.mail.welcome.value],
    ["newsletter.codeLine", ru.newsletter.codeLine],
    ["newsletter.bodyNoCode", ru.newsletter.bodyNoCode],
    ["newsletter.unsubscribePage.heading", ru.newsletter.unsubscribePage.heading],
    ["newsletter.unsubscribePage.lead", ru.newsletter.unsubscribePage.lead],
    ["newsletter.unsubscribePage.button", ru.newsletter.unsubscribePage.button],
  ];

  test("no one-letter preposition (в, с, к, о, у) is followed by an ordinary space: it takes a no-break space", () => {
    for (const [key, text] of strings) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });
});
