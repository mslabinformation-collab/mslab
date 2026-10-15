import { describe, expect, test } from "vitest";
import { completionMail, ecourseUrl, practicalUrl, testUrl, type CompletionMailInput, type CompletionMailKind } from "@/server/account-mail";

// The e-course completion's mails to the student (spec §6): each kind's subject, line and button in the account's language, the page the
// button opens, how many points to fix, no login code, and never a note, an answer or a photo (the function is not even given one: the mail
// carries the link only).

const BASE = "https://mslab.example";
const input = (over: Partial<CompletionMailInput> = {}): CompletionMailInput => ({
  siteUrl: `${BASE}/`,
  email: "kati@example.com",
  name: "Kati Tamm",
  locale: "et",
  slug: "kulmude-e-kursus",
  course: { et: "Kulmude e-kursus", ru: "Онлайн-курс по бровям" },
  kind: "assessed",
  ...over,
});
const KINDS: CompletionMailKind[] = ["assessed", "completed", "testPassed", "testFix", "reopened", "protocol", "protocolAgain"];

describe("the links", () => {
  test("the e-course's page, its test and its practical work, in the account's language; the slug in the path, never a query", () => {
    expect(ecourseUrl(`${BASE}/`, "et", "kulmud")).toBe(`${BASE}/konto/kursus/kulmud`);
    expect(testUrl(BASE, "et", "kulmud")).toBe(`${BASE}/konto/kursus/kulmud/test`);
    expect(practicalUrl(BASE, "et", "kulmud")).toBe(`${BASE}/konto/kursus/kulmud/praktiline`);
    expect(testUrl(BASE, "ru", "kulmud")).toBe(`${BASE}/ru/konto/kursus/kulmud/test`);
    expect(practicalUrl(BASE, "ru", "kulmud")).toBe(`${BASE}/ru/konto/kursus/kulmud/praktiline`);
    for (const url of [ecourseUrl(BASE, "et", "x"), testUrl(BASE, "ru", "x"), practicalUrl(BASE, "et", "x")]) expect(url).not.toContain("?");
  });
});

describe("completionMail (Estonian)", () => {
  test("assessed: the subject, the line, the course with how many points to fix, 'Vaata hinnangut' to the practical work", () => {
    const m = completionMail(input({ fixCount: 2 }));
    const link = `${BASE}/konto/kursus/kulmude-e-kursus/praktiline`;
    expect([m.to, m.subject]).toEqual(["kati@example.com", "Sinu praktiline töö on hinnatud"]);
    expect(m.text).toBe(
      [
        "Tere, Kati!", "",
        "Maria on sinu praktilise töö üle vaadanud. Paranda märgitud punktid: lisa neile uued fotod ja saada töö uuesti.", "",
        "Kulmude e-kursus", "Parandamist vajavaid punkte: 2", "",
        "Vaata hinnangut:", link, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain(">Vaata hinnangut</a>");
    expect(m.html).toContain("<div>Parandamist vajavaid punkte: 2</div>");
    expect(m.html).toContain('<html lang="et">');
    expect(completionMail(input()).text).not.toContain("Parandamist vajavaid"); // no count given: no line
    expect(completionMail(input({ fixCount: 0 })).text).not.toContain("Parandamist vajavaid");
    expect(completionMail(input({ kind: "completed", fixCount: 2 })).text).not.toContain("Parandamist vajavaid"); // only an assessment says it
  });

  test("completed: the course in the subject; the practical work for a course with points, the e-course's page for one without", () => {
    const withPoints = completionMail(input({ kind: "completed", hasPoints: true }));
    expect(withPoints.subject).toBe("Palju õnne! Koolitus „Kulmude e-kursus“ on lõpetatud");
    expect(withPoints.text).toContain("Oled kõik koolituse sammud läbinud.");
    expect(withPoints.text).toContain(`Vaata koolitust:\n${BASE}/konto/kursus/kulmude-e-kursus/praktiline`);
    const lessonsOnly = completionMail(input({ kind: "completed" }));
    expect(lessonsOnly.text).toContain(`\n${BASE}/konto/kursus/kulmude-e-kursus\n`);
    expect(lessonsOnly.html).toContain(`href="${BASE}/konto/kursus/kulmude-e-kursus" style="display:inline-block;`); // the button
    expect(lessonsOnly.html).toContain(">Vaata koolitust</a>");
    expect(completionMail(input({ kind: "completed", hasPoints: false })).text).toContain(`${BASE}/konto/kursus/kulmude-e-kursus\n`);
    // a subject is one line, whatever the title holds
    expect(completionMail(input({ kind: "completed", course: { et: "Kulmud\n  ja   ripsmed" } })).subject).toBe("Palju õnne! Koolitus „Kulmud ja ripsmed“ on lõpetatud");
  });

  test("completed: one more line, 'Kinnita oma nimi ja laadi tunnistus alla:' with the e-course's page, where the certificate is (phase 3d); a link, never an attachment; no other kind has it", () => {
    const page = `${BASE}/konto/kursus/kulmude-e-kursus`;
    const withPoints = completionMail(input({ kind: "completed", hasPoints: true }));
    expect(withPoints.text).toBe(
      [
        "Tere, Kati!", "",
        "Oled kõik koolituse sammud läbinud.", "",
        "Kulmude e-kursus", "",
        "Vaata koolitust:", `${page}/praktiline`, "",
        "Kinnita oma nimi ja laadi tunnistus alla:", page, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(withPoints.html).toContain(`Kinnita oma nimi ja laadi tunnistus alla:<br><a href="${page}"`);
    expect((withPoints.html!.match(/mso-padding-alt/g) ?? []).length).toBe(1); // still one button: the line is a text link
    expect(withPoints).not.toHaveProperty("attachments");
    for (const kind of KINDS.filter((k) => k !== "completed")) expect(completionMail(input({ kind })).text, kind).not.toContain("tunnistus");
    expect(completionMail(input({ kind: "completed", locale: "ru" })).text).toContain(`Подтвердите своё имя и скачайте сертификат:\n${BASE}/ru/konto/kursus/kulmude-e-kursus\n`);
  });

  test("M-2: a course without points (the button's page is the certificate's): the line above the button, the address written once, in the text and the HTML", async () => {
    const page = `${BASE}/konto/kursus/kulmude-e-kursus`;
    const m = completionMail(input({ kind: "completed" }));
    expect(m.text).toBe(
      [
        "Tere, Kati!", "",
        "Oled kõik koolituse sammud läbinud.", "",
        "Kulmude e-kursus", "",
        "Kinnita oma nimi ja laadi tunnistus alla:", page, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    const html = m.html!;
    expect(html.split(`>${page}</a>`).length - 1).toBe(1); // written out once, under the button
    expect(html.split(`href="${page}"`).length - 1).toBe(2); // the button and the address under it, nothing more
    expect(html.indexOf("Kinnita oma nimi ja laadi tunnistus alla:")).toBeGreaterThan(html.indexOf("Kulmude e-kursus"));
    expect(html.indexOf("Kinnita oma nimi ja laadi tunnistus alla:")).toBeLessThan(html.indexOf(">Vaata koolitust</a>"));
    expect((html.match(/mso-padding-alt/g) ?? []).length).toBe(1); // one button
    const ru = completionMail(input({ kind: "completed", locale: "ru" }));
    expect(ru.text.split(`${BASE}/ru/konto/kursus/kulmude-e-kursus`).length - 1).toBe(1);
    expect(ru.html!.indexOf("Подтвердите своё имя и скачайте сертификат:")).toBeLessThan(ru.html!.indexOf(">Открыть обучение</a>"));
  });

  test("I-1: an access that is not active as the mail is built: the certificate line goes to the dashboard (/konto), whose card has the name form; an active one's to the course page", async () => {
    for (const hasPoints of [true, false]) {
      const ended = completionMail(input({ kind: "completed", hasPoints, accessActive: false }));
      expect(ended.text, `points ${hasPoints}`).toContain(`Kinnita oma nimi ja laadi tunnistus alla:\n${BASE}/konto\n`);
      expect(ended.html, `points ${hasPoints}`).toContain(`Kinnita oma nimi ja laadi tunnistus alla:<br><a href="${BASE}/konto"`);
      const active = completionMail(input({ kind: "completed", hasPoints, accessActive: true }));
      expect(active.text, `points ${hasPoints}`).toContain(`Kinnita oma nimi ja laadi tunnistus alla:\n${BASE}/konto/kursus/kulmude-e-kursus\n`);
    }
    // the button is the course's as before; the line under it is the dashboard, so both are written out
    const ended = completionMail(input({ kind: "completed", accessActive: false }));
    expect(ended.text).toContain(`Vaata koolitust:\n${BASE}/konto/kursus/kulmude-e-kursus\n\nKinnita oma nimi ja laadi tunnistus alla:\n${BASE}/konto\n\nMS LAB Koolituskeskus`);
    expect(completionMail(input({ kind: "completed", locale: "ru", accessActive: false })).text).toContain(`Подтвердите своё имя и скачайте сертификат:\n${BASE}/ru/konto\n`);
    // only "completed" has the line, whatever the access
    for (const kind of KINDS.filter((k) => k !== "completed")) expect(completionMail(input({ kind, accessActive: false })).text, kind).not.toContain("/konto\n");
  });

  test("testPassed, testFix and reopened: the spec's subjects; the practical work after a passed test, the test otherwise", () => {
    const passed = completionMail(input({ kind: "testPassed" }));
    expect(passed.subject).toBe("Test on sooritatud");
    expect(passed.text).toContain(`Praktiline töö on nüüd avatud.\n\nKulmude e-kursus\n\nAva praktiline töö:\n${BASE}/konto/kursus/kulmude-e-kursus/praktiline`);
    const fix = completionMail(input({ kind: "testFix" }));
    expect(fix.subject).toBe("Vaata üle oma testi vastused");
    expect(fix.text).toContain(`Ava test:\n${BASE}/konto/kursus/kulmude-e-kursus/test`);
    const reopened = completionMail(input({ kind: "reopened" }));
    expect(reopened.subject).toBe("Test on sinu jaoks uuesti avatud");
    expect(reopened.text).toContain(`Ava test:\n${BASE}/konto/kursus/kulmude-e-kursus/test`);
    expect(reopened.html).toContain(">Ava test</a>");
  });

  test("protocol and protocolAgain: the protocol mail's own texts, to the practical page (Maria's notes only)", () => {
    const first = completionMail(input({ kind: "protocol" }));
    expect(first.subject).toBe("Sinu koolituse protokoll on valmis");
    expect(first.text).toContain(`Sinu koolituse protokoll on valmis.\n\nKulmude e-kursus\n\nVaata protokolli:\n${BASE}/konto/kursus/kulmude-e-kursus/praktiline`);
    const again = completionMail(input({ kind: "protocolAgain" }));
    expect(again.subject).toBe("Sinu koolituse protokolli on uuendatud");
    expect(again.text).toContain("Sinu koolituse protokolli on uuendatud.");
  });

  test("every kind: one button and its link, no login code, no feedback line; the greeting without a name; every value escaped", () => {
    for (const kind of KINDS) {
      const m = completionMail(input({ kind, fixCount: 1, hasPoints: true }));
      expect((m.html!.match(/mso-padding-alt/g) ?? []).length, kind).toBe(1);
      expect(m.text, kind).not.toContain("/api/konto/verify");
      expect(m.text, kind).not.toContain("sisselogimiskood");
      expect(m.text, kind).not.toContain("tagasiside");
      expect(m.text.endsWith("\n\nMS LAB Koolituskeskus"), kind).toBe(true);
    }
    const plain = completionMail(input({ kind: "testFix", name: "", course: { et: "<b>Kulmud</b> & ripsmed" } }));
    expect(plain.text.startsWith("Tere!\n\n")).toBe(true);
    expect(plain.html).toContain("&lt;b&gt;Kulmud&lt;/b&gt; &amp; ripsmed");
    expect(plain.html).not.toContain("<b>Kulmud");
  });
});

describe("Review Focus 5: a Russian-speaking student gets her mails in Russian", () => {
  test("each kind's Russian subject and button, the course's Russian title, the Russian pages", () => {
    const ru = (kind: CompletionMailKind, over: Partial<CompletionMailInput> = {}) => completionMail(input({ locale: "ru", kind, ...over }));
    const assessed = ru("assessed", { fixCount: 3 });
    expect(assessed.subject).toBe("Ваша практическая работа оценена");
    expect(assessed.text).toContain("Здравствуйте, Kati!");
    expect(assessed.text).toContain("Онлайн-курс по бровям\nПунктов на исправление: 3");
    expect(assessed.text).toContain(`Посмотреть оценку:\n${BASE}/ru/konto/kursus/kulmude-e-kursus/praktiline`);
    expect(assessed.html).toContain('<html lang="ru">');
    expect(assessed.text.endsWith("MS LAB Учебный центр")).toBe(true);
    expect(ru("completed", { hasPoints: true }).subject).toBe("Поздравляем! Обучение «Онлайн-курс по бровям» завершено");
    expect(ru("completed", { hasPoints: true }).text).toContain(`Открыть обучение:\n${BASE}/ru/konto/kursus/kulmude-e-kursus/praktiline\n`);
    expect(ru("completed").html).toContain(`href="${BASE}/ru/konto/kursus/kulmude-e-kursus" style="display:inline-block;`);
    const passed = ru("testPassed");
    expect(passed.subject).toBe("Тест сдан");
    expect(passed.text).toContain("Практическая работа теперь открыта.");
    expect(passed.text).toContain(`Открыть практическую работу:\n${BASE}/ru/konto/kursus/kulmude-e-kursus/praktiline`);
    expect(ru("testFix").subject).toBe("Проверьте свои ответы в тесте");
    expect(ru("testFix").text).toContain(`Открыть тест:\n${BASE}/ru/konto/kursus/kulmude-e-kursus/test`);
    expect(ru("reopened").subject).toBe("Тест снова открыт для вас");
    expect(ru("protocol").subject).toBe("Протокол вашего обучения готов");
    expect(ru("protocolAgain").text).toContain(`Посмотреть протокол:\n${BASE}/ru/konto/kursus/kulmude-e-kursus/praktiline`);
  });

  test("a course without a Russian title keeps Maria's Estonian one", () => {
    expect(completionMail(input({ locale: "ru", kind: "completed", course: { et: "Kulmude e-kursus" } })).subject).toBe("Поздравляем! Обучение «Kulmude e-kursus» завершено");
  });
});
