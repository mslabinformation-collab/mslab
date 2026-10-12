import { describe, expect, test } from "vitest";
import { feedbackUrl, protocolMail, protocolUrl, verifyLink, type ProtocolMailInput } from "@/server/account-mail";

// The protocol's mails (spec §6): the first send's and the re-send's, in the registration's language, with a live login in the button or
// without one, and never a note of the protocol (the function is not even given one: the mail carries the link only).

const BASE = "https://mslab.example";
const TOKEN = "tok-en_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const input = (over: Partial<ProtocolMailInput> = {}): ProtocolMailInput => ({
  siteUrl: BASE,
  email: "kati@example.com",
  name: "Kati Tamm",
  locale: "et",
  registrationId: 42,
  course: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" },
  session: { startsAt: new Date("2026-10-12T07:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" },
  again: false,
  login: { token: TOKEN, code: "864209" }, // (a code the token does not hold)
  ...over,
});

describe("protocolMail", () => {
  test("the first send: the subject, the course with its day and place, 'Vaata protokolli' with the login that opens it, the feedback line", () => {
    const m = protocolMail(input());
    const login = verifyLink(BASE, TOKEN, "et", 42);
    expect(login).toBe(`${BASE}/api/konto/verify?t=${TOKEN}&p=42`);
    expect([m.to, m.subject]).toEqual(["kati@example.com", "Sinu koolituse protokoll on valmis"]);
    expect(m.text).toBe(
      [
        "Tere, Kati!", "",
        "Sinu koolituse protokoll on valmis.", "",
        "Kulmude lamineerimine", "12.10.2026 · 10:00", "Pärnu, MS LAB stuudio", "",
        "Vaata protokolli:", login, "",
        "Sinu sisselogimiskood:", "", "864209", "",
        "Kood ja nupp kehtivad 30 minutit. Hiljem leiad protokolli Minu koolituste lehelt.", "",
        "Kui nupp ei tööta, sisesta kood siin:", `${BASE}/konto/sisene#email=kati%40example.com&kood=1`, "",
        "Soovi korral jäta meile tagasisidet:", `${BASE}/konto/tagasiside#id=42`, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(m.html).toContain(`href="${login.replace(/&/g, "&amp;")}"`);
    expect(m.html).toContain(">Vaata protokolli</a>");
    expect(m.html).toContain(`href="${BASE}/konto/tagasiside#id=42"`);
    expect(m.html).toContain(">Soovi korral jäta meile tagasisidet</a>");
    // the code under the button, as ecourseOpenMail has it (an owner default), with the way to type it on the login page
    expect(m.html).toContain("864209");
    expect(m.html).toContain(`href="${BASE}/konto/sisene#email=kati%40example.com&amp;kood=1"`);
    expect(m.html!.indexOf(">Vaata protokolli</a>")).toBeLessThan(m.html!.indexOf("864209"));
  });

  test("the re-send says 'uuendatud' and has no feedback line", () => {
    const m = protocolMail(input({ again: true }));
    expect(m.subject).toBe("Sinu koolituse protokolli on uuendatud");
    expect(m.text).toContain("Sinu koolituse protokolli on uuendatud.");
    expect(m.text).not.toContain("tagasiside");
    expect(m.html).not.toContain("tagasiside");
  });

  test("without a login (she has 3 live ones): the button opens the page, which asks her to sign in; no 30-minute line", () => {
    const m = protocolMail(input({ login: null }));
    expect(protocolUrl(BASE, "et", 42)).toBe(`${BASE}/konto/protokoll#id=42`);
    expect(m.text).toContain(`Vaata protokolli:\n${BASE}/konto/protokoll#id=42`);
    expect(m.text).not.toContain("30 minutit");
    expect(m.text).not.toContain("sisselogimiskood");
  });

  test("Review Focus 5: Russian for a Russian registration: the texts, the course's Russian title and the Russian pages", () => {
    const m = protocolMail(input({ locale: "ru" }));
    expect(m.subject).toBe("Протокол вашего обучения готов");
    expect(m.text).toContain("Ламинирование бровей");
    expect(m.text).toContain(`${BASE}/api/konto/verify?t=${TOKEN}&l=ru&p=42`);
    expect(m.text).toContain(`По желанию оставьте нам отзыв:\n${feedbackUrl(BASE, "ru", 42)}`);
    expect(feedbackUrl(BASE, "ru", 42)).toBe(`${BASE}/ru/konto/tagasiside#id=42`);
    expect(m.html).toContain('<html lang="ru">');
    expect(protocolMail(input({ locale: "ru", again: true })).subject).toBe("Протокол вашего обучения обновлён");
  });

  test("an individual course has no day in the box; every value is escaped", () => {
    const m = protocolMail(input({ session: null, course: { et: "<b>Kulmud</b> & ripsmed" }, name: "" }));
    expect(m.text).toContain("Tere!\n\nSinu koolituse protokoll on valmis.\n\n<b>Kulmud</b> & ripsmed\n\nVaata protokolli:");
    expect(m.html).toContain("&lt;b&gt;Kulmud&lt;/b&gt; &amp; ripsmed");
    expect(m.html).not.toContain("<b>Kulmud");
  });
});
