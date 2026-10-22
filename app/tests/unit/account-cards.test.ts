import { describe, expect, test } from "vitest";
import {
  cardKey, cardTag, cardTitle, cardWhen, filterCards, firstName, hasPrepayment, isPastCard, nextStep, paymentReference, resumeSlug, showFilters, sortCards,
  type AccountCard, type ContactCard, type EcourseCard, type EcourseProgress, type IndividualCard, type PrepaymentInfo, type RequestCard, type WaitlistCard,
} from "@/domain/account-cards";
import { fill } from "@/i18n/format";
import { getDict } from "@/i18n/locales";

// The next-step sentence of every card state (spec 2.1 rule 5). NOW is a Saturday in Estonian summer time; the sessions
// are in November, in winter time (UTC+2), so 08:00 UTC is 10:00 on the card.

const NOW = new Date("2026-10-03T10:00:00Z");
const FUTURE = "2026-11-14T08:00:00.000Z"; // 14.11 at 10:00 Estonian time
const PAST = "2026-09-20T07:00:00.000Z";
const PAY: PrepaymentInfo = { receiver: "MS LAB OÜ", iban: "EE00 0000 0000 0000 0000", bank: "Pank", referencePrefix: "MS" };

const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };

const contact = (over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId: 7, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "Salong", cancelled: false },
  status: "awaiting_prepayment", paymentChoice: "full", priceCents: 35000, paidCents: 0, createdAt: "2026-10-01T09:00:00.000Z", ...over,
});
const individual = (over: Partial<IndividualCard> = {}): IndividualCard => ({
  kind: "individual", registrationId: 8, course, status: "awaiting_prepayment", preferredPeriod: "november", createdAt: "2026-10-01T09:00:00.000Z", ...over,
});
const request = (over: Partial<RequestCard> = {}): RequestCard => ({
  kind: "request", requestId: 3, requestKind: "practice", title: { et: "MINI" }, detail: "E, K", handled: false, createdAt: "2026-10-01T09:00:00.000Z", ...over,
});
const waitlist = (over: Partial<WaitlistCard> = {}): WaitlistCard => ({
  kind: "waitlist", requestId: 4, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false }, handled: false, createdAt: "2026-10-01T09:00:00.000Z", ...over,
});
const ecourse = (over: Partial<EcourseCard> = {}): EcourseCard => ({
  kind: "ecourse", course, grantedAt: "2026-09-22T09:00:00.000Z", expiresAt: "2027-03-22T09:00:00.000Z", revoked: false, ...over,
});

describe("nextStep: one sentence and at most one button for every state of a card", () => {
  test("contact, cancelled: nothing to do", () => {
    expect(nextStep(contact({ status: "cancelled" }), NOW, PAY)).toEqual({ key: "cancelled", vars: {}, action: { kind: "none" } });
  });

  test("contact, session started: done (the date is gone from the calendar at the same instant)", () => {
    expect(nextStep(contact({ status: "confirmed", session: { startsAt: PAST, city: "Pärnu", venue: "", cancelled: false } }), NOW, PAY)).toEqual({
      key: "done", vars: {}, action: { kind: "none" },
    });
    // a session that starts exactly now has begun (calendar.ts upcomingFrom); one a millisecond later has not
    const atNow = { startsAt: NOW.toISOString(), city: "Pärnu", venue: "", cancelled: false };
    expect(nextStep(contact({ session: atNow }), NOW, PAY).key).toBe("done");
    expect(nextStep(contact({ session: { ...atNow, startsAt: new Date(NOW.getTime() + 1).toISOString() } }), NOW, PAY).key).toBe("pay");
  });

  test("contact, a training Maria called off is cancelled too, whatever the registration says", () => {
    expect(nextStep(contact({ status: "confirmed", session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: true } }), NOW, PAY).key).toBe("cancelled");
  });

  test("contact, awaiting, prepayment info set: pay, with the amount and the pay button", () => {
    expect(nextStep(contact(), NOW, PAY)).toEqual({
      key: "pay", vars: { amount: "350 €" }, action: { kind: "pay", registrationId: 7 },
    });
  });

  test("the amount is the prepayment minus what was paid: half is rounded up to the cent", () => {
    expect(nextStep(contact({ paymentChoice: "half", priceCents: 35001 }), NOW, PAY).vars).toEqual({ amount: "175,01 €" });
    expect(nextStep(contact({ paymentChoice: "half", priceCents: 35001, paidCents: 1000 }), NOW, PAY).vars).toEqual({ amount: "165,01 €" });
    expect(nextStep(contact({ paymentChoice: "full", paidCents: 10000 }), NOW, PAY).vars).toEqual({ amount: "250 €" });
    // Järelmaks (Inbank) is the whole price (instalments spec D3), as „100% kohe“ is
    expect(nextStep(contact({ paymentChoice: "financing", priceCents: 35001 }), NOW, PAY).vars).toEqual({ amount: "350,01 €" });
  });

  test("contact, awaiting, no usable prepayment info: invoice (none, every field empty, or no receiver or no IBAN)", () => {
    const want = { key: "invoice", vars: {}, action: { kind: "none" } };
    expect(nextStep(contact(), NOW, null)).toEqual(want);
    expect(nextStep(contact(), NOW, { receiver: "", iban: " ", bank: "", referencePrefix: "" })).toEqual(want);
    // a setting filled in only partly cannot be followed: Maria sends an invoice
    expect(nextStep(contact(), NOW, { receiver: "", iban: "", bank: "Swedbank", referencePrefix: "" })).toEqual(want);
    expect(nextStep(contact(), NOW, { ...PAY, iban: "" })).toEqual(want);
    expect(nextStep(contact(), NOW, { ...PAY, receiver: " " })).toEqual(want);
    // receiver and IBAN are enough
    expect(nextStep(contact(), NOW, { receiver: "MS LAB OÜ", iban: "EE00", bank: "", referencePrefix: "" }).key).toBe("pay");
  });

  test("contact, awaiting, no price to measure by: invoice, whatever the instructions say", () => {
    expect(nextStep(contact({ priceCents: null }), NOW, PAY).key).toBe("invoice");
  });

  test("contact, awaiting but the prepayment is already in: nothing to pay, Maria confirms", () => {
    expect(nextStep(contact({ paymentChoice: "half", paidCents: 17500 }), NOW, PAY)).toEqual({ key: "confirming", vars: {}, action: { kind: "none" } });
  });

  test("contact, confirmed, something left to pay: the rest on the training day, and the change button", () => {
    expect(nextStep(contact({ status: "confirmed", paidCents: 17500 }), NOW, PAY)).toEqual({
      key: "confirmedRest", vars: { rest: "175 €" }, action: { kind: "changeRequest", registrationId: 7 },
    });
  });

  test("contact, confirmed, paid in full: confirmed (the card's own line says when and where), and the change button", () => {
    expect(nextStep(contact({ status: "confirmed", paidCents: 35000 }), NOW, PAY)).toEqual({
      key: "confirmed", vars: {}, action: { kind: "changeRequest", registrationId: 7 },
    });
    // paid more than the price (a correction in the admin) is still "in full"; a course without a price has no rest
    expect(nextStep(contact({ status: "confirmed", paidCents: 40000 }), NOW, PAY).key).toBe("confirmed");
    expect(nextStep(contact({ status: "confirmed", priceCents: null }), NOW, PAY).key).toBe("confirmed");
  });

  test("cardWhen: the session's date and time in Estonian time (summer UTC+3, winter UTC+2) and its place", () => {
    const summer = contact({ status: "confirmed", paidCents: 35000, session: { startsAt: "2027-06-05T07:00:00.000Z", city: "Tartu", venue: "", cancelled: false } });
    expect(cardWhen(summer, "et")).toEqual({ time: "05.06.2027 · 10:00", place: "Tartu" });
    expect(cardWhen(contact({ session: { startsAt: FUTURE, city: "Pärnu", venue: "Salong", cancelled: false } }), "ru")).toEqual({ time: "14.11.2026 · 10:00", place: "Pärnu, Salong" });
    expect(cardWhen(waitlist(), "et")).toEqual({ time: "14.11.2026 · 10:00", place: "Pärnu" });
    expect(cardWhen(waitlist({ session: null }), "et")).toBeNull();
    expect(cardWhen(individual(), "et")).toEqual({ time: "november", place: "" });
    expect(cardWhen(individual({ preferredPeriod: " " }), "et")).toBeNull();
    expect(cardWhen(request(), "et")).toEqual({ time: "E, K", place: "" });
    expect(cardWhen(request({ detail: "" }), "et")).toBeNull();
    expect(cardWhen(ecourse(), "et")).toBeNull();
  });

  test("cardTitle: the course or the package in the page's language; a plain name when it is gone", () => {
    const untitled = { individual: "Individuaalkoolitus", practice: "Praktika", course: "Koolitus" };
    expect(cardTitle(contact(), "ru", untitled)).toBe("Ламинирование бровей");
    expect(cardTitle(ecourse(), "et", untitled)).toBe("Kulmude lamineerimine");
    expect(cardTitle(request(), "ru", untitled)).toBe("MINI"); // no Russian name: the Estonian one
    expect(cardTitle(request({ title: null }), "et", untitled)).toBe("Praktika");
    expect(cardTitle(request({ title: null, requestKind: "individual" }), "et", untitled)).toBe("Individuaalkoolitus");
    expect(cardTitle(waitlist({ course: null }), "et", untitled)).toBe("Koolitus");
  });

  test("individual (a registration without a session): Maria agrees the time", () => {
    const want = { key: "individualPending", vars: {}, action: { kind: "none" } };
    expect(nextStep(individual(), NOW, PAY)).toEqual(want);
    expect(nextStep(individual({ status: "confirmed" }), NOW, null)).toEqual(want);
  });

  test("individual, cancelled: cancelled (Maria is not about to call)", () => {
    expect(nextStep(individual({ status: "cancelled" }), NOW, PAY).key).toBe("cancelled");
  });

  test("request: sent, then answered", () => {
    expect(nextStep(request({ handled: false }), NOW, PAY)).toEqual({ key: "requestNew", vars: {}, action: { kind: "none" } });
    expect(nextStep(request({ handled: true }), NOW, PAY)).toEqual({ key: "requestDone", vars: {}, action: { kind: "none" } });
  });

  test("waitlist: we tell you when a place is free", () => {
    expect(nextStep(waitlist(), NOW, PAY)).toEqual({ key: "waitlist", vars: {}, action: { kind: "none" } });
    expect(nextStep(waitlist({ course: null, session: null }), NOW, null).key).toBe("waitlist");
  });

  test("waitlist, handled by Maria: answered; the date called off: cancelled, handled or not", () => {
    const called = { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: true };
    expect(nextStep(waitlist({ handled: true }), NOW, PAY)).toEqual({ key: "requestDone", vars: {}, action: { kind: "none" } });
    expect(nextStep(waitlist({ session: called }), NOW, PAY)).toEqual({ key: "cancelled", vars: {}, action: { kind: "none" } });
    expect(nextStep(waitlist({ session: called, handled: true }), NOW, PAY).key).toBe("cancelled");
    expect(nextStep(waitlist({ session: null, handled: true }), NOW, PAY).key).toBe("requestDone");
  });

  test("e-course, active: access until a date, and the open button", () => {
    expect(nextStep(ecourse(), NOW, PAY)).toEqual({
      key: "openCourse", vars: { date: "22.03.2027" }, action: { kind: "openCourse", slug: "kulmude-lami" },
    });
  });

  test("e-course, expired or revoked: access ended, no button", () => {
    const ended = { key: "accessEnded", vars: {}, action: { kind: "none" } };
    expect(nextStep(ecourse({ expiresAt: "2026-10-03T09:59:59.000Z" }), NOW, PAY)).toEqual(ended);
    expect(nextStep(ecourse({ expiresAt: NOW.toISOString() }), NOW, PAY)).toEqual(ended); // until, not including, the moment
    expect(nextStep(ecourse({ revoked: true }), NOW, PAY)).toEqual(ended);
  });

  test("with online payments (phase 2b) an unpaid card is 'pay' even without the transfer instructions; without them, and offline, Maria's invoice", () => {
    const unpaid = contact({ paymentChoice: "half" });
    expect(nextStep(unpaid, NOW, null).key).toBe("invoice");
    expect(nextStep(unpaid, NOW, null, "et", true)).toEqual({ key: "pay", vars: { amount: "175 €" }, action: { kind: "pay", registrationId: 7 } });
    expect(nextStep(unpaid, NOW, PAY, "et", true).key).toBe("pay");
  });
});

describe("nextStep formats the vars for the locale it is given", () => {
  test("Russian: the same dates, times and euro amounts (the formatters of the site), and Estonian is the default", () => {
    const paid = contact({ status: "confirmed", paidCents: 17500 });
    const full = contact({ status: "confirmed", paidCents: 35000 });
    expect(nextStep(paid, NOW, PAY, "ru").vars).toEqual({ rest: "175 €" });
    expect(nextStep(full, NOW, PAY, "ru").vars).toEqual({});
    expect(nextStep(ecourse(), NOW, PAY, "ru").vars).toEqual({ date: "22.03.2027" });
    expect(nextStep(full, NOW, PAY)).toEqual(nextStep(full, NOW, PAY, "et"));
  });

  test("every state's vars are exactly the placeholders of its dictionary sentence, in both languages", () => {
    const cards: AccountCard[] = [
      contact({ status: "cancelled" }), contact({ session: { startsAt: PAST, city: "x", venue: "", cancelled: false } }), contact(), contact({ priceCents: null }),
      contact({ paidCents: 35000 }), contact({ status: "confirmed", paidCents: 100 }), contact({ status: "confirmed", paidCents: 35000 }),
      individual(), request(), request({ handled: true }), waitlist(), waitlist({ handled: true }), ecourse(), ecourse({ revoked: true }),
    ];
    const keys = new Set<string>();
    for (const locale of ["et", "ru"] as const) {
      const sentences = getDict(locale).account.next as Record<string, string>;
      for (const card of cards) {
        const { key, vars } = nextStep(card, NOW, PAY, locale);
        keys.add(key);
        const placeholders = [...sentences[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(Object.keys(vars).sort(), `${locale} ${key}`).toEqual(placeholders);
        expect(fill(sentences[key], vars), `${locale} ${key}`).not.toMatch(/[{}]/);
      }
    }
    expect([...keys].sort()).toEqual(Object.keys(getDict("et").account.next).sort()); // every sentence in the dictionary is reachable
  });
});

describe("hasPrepayment", () => {
  test("the receiver and the IBAN are both needed; the bank and the prefix are not", () => {
    expect(hasPrepayment(null)).toBe(false);
    expect(hasPrepayment({ receiver: "", iban: "  ", bank: "", referencePrefix: "" })).toBe(false);
    expect(hasPrepayment({ receiver: "", iban: "EE00", bank: "", referencePrefix: "" })).toBe(false);
    expect(hasPrepayment({ receiver: "MS LAB OÜ", iban: "", bank: "Swedbank", referencePrefix: "MS" })).toBe(false);
    expect(hasPrepayment({ receiver: "", iban: "", bank: "Swedbank", referencePrefix: "" })).toBe(false);
    expect(hasPrepayment({ receiver: "MS LAB OÜ", iban: "EE00", bank: "", referencePrefix: "" })).toBe(true);
    expect(hasPrepayment(PAY)).toBe(true);
  });
});

describe("isPastCard and sortCards", () => {
  const session = (startsAt: string, cancelled = false) => ({ startsAt, city: "Pärnu", venue: "", cancelled });

  test("what is over for the student", () => {
    expect(isPastCard(contact(), NOW)).toBe(false);
    expect(isPastCard(contact({ session: session(PAST) }), NOW)).toBe(true);
    expect(isPastCard(contact({ status: "cancelled" }), NOW)).toBe(true);
    expect(isPastCard(contact({ session: session(FUTURE, true) }), NOW)).toBe(true);
    expect(isPastCard(individual(), NOW)).toBe(false);
    expect(isPastCard(individual({ status: "cancelled" }), NOW)).toBe(true);
    expect(isPastCard(request(), NOW)).toBe(false);
    expect(isPastCard(request({ handled: true }), NOW)).toBe(true);
    expect(isPastCard(waitlist(), NOW)).toBe(false);
    expect(isPastCard(waitlist({ session: session(PAST) }), NOW)).toBe(true);
    expect(isPastCard(waitlist({ session: session(FUTURE, true) }), NOW)).toBe(true);
    expect(isPastCard(waitlist({ handled: true }), NOW)).toBe(true);
    expect(isPastCard(waitlist({ session: null }), NOW)).toBe(false);
    expect(isPastCard(ecourse(), NOW)).toBe(false);
    expect(isPastCard(ecourse({ revoked: true }), NOW)).toBe(true);
    expect(isPastCard(ecourse({ expiresAt: PAST }), NOW)).toBe(true);
  });

  test("open cards by date, the soonest first, then the open cards without a date, the newest first; over cards last, the most recent first; the input is left alone", () => {
    const later = contact({ registrationId: 1, session: session("2026-12-01T08:00:00.000Z") });
    const sooner = contact({ registrationId: 2, session: session("2026-11-01T08:00:00.000Z") });
    const pastRecent = contact({ registrationId: 3, session: session("2026-09-25T08:00:00.000Z") });
    const pastOld = contact({ registrationId: 4, session: session("2026-06-01T08:00:00.000Z") });
    const cancelled = contact({ registrationId: 5, status: "cancelled", session: session("2027-01-10T08:00:00.000Z") });
    const req = request({ requestId: 9, createdAt: "2026-10-02T08:00:00.000Z" });
    const course = ecourse({ grantedAt: "2026-09-30T08:00:00.000Z" });
    const pending = individual({ registrationId: 10, createdAt: "2026-10-01T08:00:00.000Z" });
    const input = [pastOld, req, cancelled, later, pastRecent, pending, course, sooner];
    const copy = [...input];
    expect(sortCards(input, NOW).map(cardKey)).toEqual([
      "registration-2", // open, with a date: 1 Nov
      "registration-1", // open, with a date: 1 Dec
      "request-9", // open, no date: made 2 Oct
      "registration-10", // open, no date: made 1 Oct
      "course-kulmude-lami", // open, no date: granted 30 Sep
      "registration-5", // over: cancelled, its date (10 Jan) is the latest
      "registration-3", // over: 25 Sep
      "registration-4", // over: 1 Jun
    ]);
    expect(input).toEqual(copy);
  });

  test("a waitlist entry with a date is placed among the dated cards; without one, among the undated", () => {
    const booked = contact({ registrationId: 1, session: session("2026-11-10T08:00:00.000Z") });
    const waiting = waitlist({ requestId: 2, session: session("2026-11-05T08:00:00.000Z") });
    const undated = waitlist({ requestId: 3, session: null, createdAt: "2026-10-02T08:00:00.000Z" });
    const old = request({ requestId: 4, createdAt: "2026-09-01T08:00:00.000Z" });
    expect(sortCards([old, undated, booked, waiting], NOW).map(cardKey)).toEqual(["request-2", "registration-1", "request-3", "request-4"]);
  });

  test("an over card without a date is placed by when it was made or granted, among the dated ones by their date", () => {
    const pastSession = contact({ registrationId: 1, session: session("2026-09-20T08:00:00.000Z") });
    const handled = request({ requestId: 2, handled: true, createdAt: "2026-09-28T08:00:00.000Z" });
    const ended = ecourse({ revoked: true, grantedAt: "2026-09-01T08:00:00.000Z" });
    expect(sortCards([ended, pastSession, handled], NOW).map(cardKey)).toEqual(["request-2", "registration-1", "course-kulmude-lami"]);
  });

  test("equal times keep a fixed order, whatever the input order (numbers by value)", () => {
    const cards = [request({ requestId: 9 }), request({ requestId: 10 }), contact({ registrationId: 2 }), contact({ registrationId: 11 })];
    const keys = sortCards(cards, NOW).map(cardKey);
    expect(keys).toEqual(["registration-2", "registration-11", "request-9", "request-10"]);
    expect(sortCards([...cards].reverse(), NOW).map(cardKey)).toEqual(keys);
  });

  test("cardKey tells registrations, requests and courses apart", () => {
    expect(cardKey(contact())).toBe("registration-7");
    expect(cardKey(individual())).toBe("registration-8");
    expect(cardKey(request())).toBe("request-3");
    expect(cardKey(waitlist())).toBe("request-4");
    expect(cardKey(ecourse())).toBe("course-kulmude-lami");
  });
});

describe("the dashboard's view helpers", () => {
  test("firstName: the first word of the name, nothing without one", () => {
    expect(firstName("Kati Tamm")).toBe("Kati");
    expect(firstName("  Anna-Liisa   Mets ")).toBe("Anna-Liisa");
    expect(firstName("")).toBe("");
    expect(firstName("   ")).toBe("");
  });

  test("paymentReference: the admin's prefix and the registration number", () => {
    expect(paymentReference(PAY, 42)).toBe("MS42");
    expect(paymentReference({ ...PAY, referencePrefix: " MSLAB-" }, 7)).toBe("MSLAB-7");
    expect(paymentReference({ ...PAY, referencePrefix: "" }, 7)).toBe("7");
  });

  test("cardTag: an individual registration is a contact course too", () => {
    expect([contact(), individual(), ecourse(), request(), waitlist()].map(cardTag)).toEqual(["contact", "contact", "ecourse", "request", "waitlist"]);
  });

  test("filterCards: Kõik keeps everything in its order, Tulevased the open cards, Möödunud the over ones", () => {
    const over = contact({ registrationId: 1, status: "cancelled" });
    const ahead = contact({ registrationId: 2 });
    const answered = request({ handled: true });
    const cards = [ahead, over, answered, ecourse()];
    expect(filterCards(cards, "all", NOW)).toBe(cards);
    expect(filterCards(cards, "upcoming", NOW).map(cardKey)).toEqual(["registration-2", "course-kulmude-lami"]);
    expect(filterCards(cards, "past", NOW).map(cardKey)).toEqual(["registration-1", "request-3"]);
  });

  test("showFilters: only when two or more cards are partly ahead and partly over", () => {
    const over = contact({ registrationId: 1, status: "cancelled" });
    expect(showFilters([], NOW)).toBe(false);
    expect(showFilters([contact()], NOW)).toBe(false);
    expect(showFilters([contact(), ecourse()], NOW)).toBe(false); // all ahead: Möödunud would show nothing
    expect(showFilters([over, request({ handled: true })], NOW)).toBe(false); // all over
    expect(showFilters([contact(), over], NOW)).toBe(true);
  });
});

describe("resumeSlug: the e-course of the 'Pooleli' card (phase 2c)", () => {
  const NOW_D = new Date("2026-10-08T10:00:00.000Z");
  const progress = (done: number, total: number): EcourseProgress => ({ done, total, next: done < total ? { lessonId: done + 1, title: { et: `L${done + 1}` }, moduleTitle: { et: "M" } } : null });
  const card = (slug: string, p: EcourseProgress | null | undefined, over: Record<string, unknown> = {}) =>
    ({ kind: "ecourse", course: { slug, title: { et: slug } }, grantedAt: "2026-10-01T09:00:00.000Z", expiresAt: "2027-04-01T09:00:00.000Z", revoked: false, progress: p, ...over }) as AccountCard;

  test("the open, unfinished e-course she did something in last", () => {
    const cards = [card("a", progress(1, 3)), card("b", progress(2, 5))];
    expect(resumeSlug(cards, new Map([["a", 100], ["b", 200]]), NOW_D)).toBe("b");
    expect(resumeSlug(cards, new Map([["a", 300], ["b", 200]]), NOW_D)).toBe("a");
  });

  test("with no activity in any of them: the first such course in the cards' order (it says 'Alusta')", () => {
    expect(resumeSlug([card("a", progress(0, 3)), card("b", progress(0, 2))], new Map(), NOW_D)).toBe("a");
    expect(resumeSlug([card("a", progress(0, 3)), card("b", progress(1, 2))], new Map([["b", 5]]), NOW_D)).toBe("b");
  });

  test("none for a finished course, one without lessons, an ended access, or none at all", () => {
    expect(resumeSlug([card("a", progress(3, 3))], new Map([["a", 1]]), NOW_D)).toBeNull();
    expect(resumeSlug([card("a", null), card("b", undefined)], new Map(), NOW_D)).toBeNull();
    expect(resumeSlug([card("a", progress(1, 3), { revoked: true })], new Map([["a", 1]]), NOW_D)).toBeNull();
    expect(resumeSlug([card("a", progress(1, 3), { expiresAt: "2026-10-01T00:00:00.000Z" })], new Map(), NOW_D)).toBeNull();
    expect(resumeSlug([], new Map(), NOW_D)).toBeNull();
  });
});
