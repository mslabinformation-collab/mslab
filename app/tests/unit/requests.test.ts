import { describe, expect, test } from "vitest";
import { isInterest, KIND_TAB, REQUEST_TABS, replySubject, requestFactParts, requestFacts, TAB_KIND } from "@/domain/requests";
import { adminEt } from "@/i18n/dict/admin";
import { getDict } from "@/i18n/locales";

// Päringud (admin UX pass, README A7, piece 2 Task 15): the tabs and the kinds they hold, the facts line of a card (piece2-texts S3-j) and the subject
// of „Vasta e-kirjaga ↗“ (S3-k, an outgoing text: Estonian and Russian). Pure, so the browser can run them too.

describe("the tabs", () => {
  test("five tabs, each holding one kind of request, and the kinds map back", () => {
    expect(REQUEST_TABS).toEqual(["kontakt", "individuaal", "praktika", "ootenimekiri", "muutmine"]);
    expect(REQUEST_TABS.map((t) => TAB_KIND[t])).toEqual(["contact", "individual", "practice", "waitlist", "change_request"]);
    for (const tab of REQUEST_TABS) expect(KIND_TAB[TAB_KIND[tab]]).toBe(tab);
  });

  test("the e-learning interest is a Kontakt request with the purchase intent", () => {
    expect(isInterest("contact", { intent: "purchase", course: "e", email: "a@example.test" })).toBe(true);
    expect(isInterest("contact", { name: "A", message: "Tere" })).toBe(false);
    expect(isInterest("individual", { intent: "purchase" })).toBe(false);
  });
});

describe("requestFacts (S3-j)", () => {
  test("Individuaal: phone, course, period, and the two ticked wishes by their labels", () => {
    const payload = { name: "Jaan", email: "j@example.test", phone: "+372 5555 0102", course: "Kulmumeistri baaskoolitus", preferredPeriod: "Jaanuari teine pool", wantsModelHelp: true, wantsAccount: true, locale: "et", message: "Tere" };
    expect(requestFacts("individual", payload)).toBe("+372 5555 0102 · Kulmumeistri baaskoolitus · Soovitud periood: Jaanuari teine pool · Vajab abi modelli leidmisel · Soovib kontot");
  });

  test("Individuaal: empty parts are dropped, and a yes/no field shows its label only when ticked", () => {
    expect(requestFacts("individual", { phone: "5555", course: "Kulm", preferredPeriod: "", wantsModelHelp: false, wantsAccount: true, message: "" })).toBe("5555 · Kulm · Soovib kontot");
    expect(requestFacts("individual", { phone: "", course: "", wantsModelHelp: false, wantsAccount: false })).toBe("");
    expect(requestFacts("individual", { phone: "  ", course: "Kulm", preferredPeriod: "  " })).toBe("Kulm");
  });

  test("Praktika: phone, package, the course she took and her times, each with its label", () => {
    const payload = { package: "MINI", name: "Liis", email: "l@example.test", phone: "+372 5555 0103", course: "Kulmumeistri baaskoolitus", times: "Tööpäeviti pärast kella 17", locale: "et" };
    expect(requestFacts("practice", payload)).toBe("+372 5555 0103 · Pakett: MINI · Läbitud koolitus: Kulmumeistri baaskoolitus · Sobivad ajad: Tööpäeviti pärast kella 17");
    expect(requestFacts("practice", { package: "MAXI", phone: "5555", course: "", times: "" })).toBe("5555 · Pakett: MAXI");
  });

  test("Ootenimekiri: the course and the day, in Estonian time, with the city", () => {
    const payload = { session: 7, course: "Kulmumeistri baaskoolitus", name: "Ott", email: "o@example.test", locale: "et", startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu" };
    expect(requestFacts("waitlist", payload)).toBe("Kulmumeistri baaskoolitus · Toimumine: 14.11.2026 10:00, Pärnu");
    // a session without a city says only the day
    expect(requestFacts("waitlist", { ...payload, city: "" })).toBe("Kulmumeistri baaskoolitus · Toimumine: 14.11.2026 10:00");
  });

  test("Ootenimekiri: a session that is gone is named by its number", () => {
    expect(requestFacts("waitlist", { session: 7, course: "Kulm", name: "Ott" })).toBe("Kulm · Toimumine: toimumine #7");
  });

  test("Muutmine: the wish in words, then the course with its day and place (no time)", () => {
    const payload = { registrationId: 12, kind: "cancel", message: "Jään haigeks.", email: "k@example.test", course: "Kulmude lamineerimine", startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu" };
    expect(requestFacts("change_request", payload)).toBe("Soovib tühistada · Kulmude lamineerimine, 14.11.2026 Pärnu");
    expect(requestFacts("change_request", { ...payload, kind: "change" })).toBe("Soovib muuta aega · Kulmude lamineerimine, 14.11.2026 Pärnu");
    // an e-course or an individual registration has no day
    expect(requestFacts("change_request", { registrationId: 12, kind: "change", course: "Kulmu e-koolitus" })).toBe("Soovib muuta aega · Kulmu e-koolitus");
  });

  test("Muutmine: a registration that is gone is named by its number; a wish that is neither is left out", () => {
    expect(requestFacts("change_request", { registrationId: 12, kind: "cancel" })).toBe("Soovib tühistada · Registreerimine #12 (ei leitud)");
    expect(requestFacts("change_request", { registrationId: 12, kind: "other", course: "Kulm" })).toBe("Kulm");
  });

  test("Kontakt: nothing, unless the message is in Russian; the cart's interest says it was not bought", () => {
    expect(requestFacts("contact", { name: "Mari", message: "Tere", locale: "et" })).toBe("");
    expect(requestFacts("contact", { name: "Julia", message: "Здравствуйте!", locale: "ru" })).toBe("Vastus vene keeles");
    expect(requestFacts("contact", { course: "kulm", intent: "purchase", email: "r@example.test", locale: "et" })).toBe("Ostu ei lõpetanud · ostukorvist");
  });

  test("a Russian request starts with „Vastus vene keeles“, whatever its kind", () => {
    expect(requestFacts("contact", { course: "kulm", intent: "purchase", email: "r@example.test", locale: "ru" })).toBe("Vastus vene keeles · Ostu ei lõpetanud · ostukorvist");
    expect(requestFacts("individual", { phone: "5555", course: "Kulm", locale: "ru" })).toBe("Vastus vene keeles · 5555 · Kulm");
    expect(requestFacts("practice", { package: "MINI", locale: "ru" })).toBe("Vastus vene keeles · Pakett: MINI");
  });

  test("the words are the dictionary's", () => {
    const t = adminEt.requests;
    expect([t.facts.russian, t.facts.cart, t.fields.period, t.fields.modelHelp, t.fields.account, t.fields.package, t.fields.completedCourse, t.fields.times, t.fields.session]).toEqual([
      "Vastus vene keeles",
      "Ostu ei lõpetanud · ostukorvist",
      "Soovitud periood",
      "Vajab abi modelli leidmisel",
      "Soovib kontot",
      "Pakett",
      "Läbitud koolitus",
      "Sobivad ajad",
      "Toimumine",
    ]);
  });
});

describe("requestFactParts: the facts line as parts, the phone one a `tel:` link", () => {
  test("the line is the parts' texts joined with „ · “ (requestFacts is exactly that)", () => {
    const payload = { phone: "+372 5555 0102", course: "Kulmumeistri baaskoolitus", preferredPeriod: "Jaanuari teine pool", wantsModelHelp: true, wantsAccount: false, locale: "ru" };
    const parts = requestFactParts("individual", payload);
    expect(parts.map((p) => p.text)).toEqual(["Vastus vene keeles", "+372 5555 0102", "Kulmumeistri baaskoolitus", "Soovitud periood: Jaanuari teine pool", "Vajab abi modelli leidmisel"]);
    expect(parts.map((p) => p.text).join(" · ")).toBe(requestFacts("individual", payload));
  });

  test("Individuaal and Praktika: the phone part carries the number as a tel: target (digits and a leading +), no other part does", () => {
    const individual = requestFactParts("individual", { phone: "+372 5555 0102", course: "Kulm" });
    expect(individual).toEqual([{ text: "+372 5555 0102", tel: "+37255550102" }, { text: "Kulm" }]);
    const practice = requestFactParts("practice", { phone: "5555-0103 (õhtul)", package: "MINI" });
    expect(practice).toEqual([{ text: "5555-0103 (õhtul)", tel: "55550103" }, { text: "Pakett: MINI" }]);
  });

  test("a phone with no digits is text only; the Russian marker leads and is no link", () => {
    expect(requestFactParts("individual", { phone: "ei ole", course: "Kulm", locale: "ru" })).toEqual([{ text: "Vastus vene keeles" }, { text: "ei ole" }, { text: "Kulm" }]);
  });

  test("the kinds with no phone have no link", () => {
    expect(requestFactParts("waitlist", { session: 7, course: "Kulm", startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu" }).some((p) => p.tel)).toBe(false);
    expect(requestFactParts("change_request", { registrationId: 12, kind: "cancel", course: "Kulm" }).some((p) => p.tel)).toBe(false);
    expect(requestFactParts("contact", { name: "Mari", message: "Tere", phone: "5555 0102" })).toEqual([]);
  });
});

describe("replySubject (S3-k)", () => {
  test("Estonian: „Vastus sinu päringule — {title}“", () => {
    expect(replySubject("et", "Kulmumeistri baaskoolitus")).toBe("Vastus sinu päringule — Kulmumeistri baaskoolitus");
  });

  test("Russian: „Ответ на ваш запрос — {title}“", () => {
    expect(replySubject("ru", "Базовый курс")).toBe("Ответ на ваш запрос — Базовый курс");
  });

  test("a request that names no course or package says „MS LAB“, in both languages", () => {
    expect(replySubject("et", "")).toBe("Vastus sinu päringule — MS LAB");
    expect(replySubject("ru", "")).toBe("Ответ на ваш запрос — MS LAB");
    expect(replySubject("et", "  \n ")).toBe("Vastus sinu päringule — MS LAB");
  });

  test("a title with line breaks is one line (a subject is)", () => {
    expect(replySubject("et", "Kulmu\nmeister \r\n baas")).toBe("Vastus sinu päringule — Kulmu meister baas");
  });

  test("the words live with the other outgoing texts, Estonian and Russian", () => {
    expect(getDict("et").account.mail.reply.subject).toBe("Vastus sinu päringule — {title}");
    expect(getDict("ru").account.mail.reply.subject).toBe("Ответ на ваш запрос — {title}");
    // (next to „Päring on vastu võetud — {title}“, which the same people get when they send the request)
    expect(getDict("et").account.mail.confirm.subjectRequest).toBe("Päring on vastu võetud — {title}");
  });
});
