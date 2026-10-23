import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { getDict, type Locale } from "@/i18n/locales";

// Päringud (admin UX pass, README A7, piece 2 Task 15): the tabs and the kinds of request they hold, the muted facts line of a card (piece2-texts S3-j)
// and the subject of „Vasta e-kirjaga ↗“ (S3-k). Pure and import-light, so the browser can run it too (tests/unit/old-safari.test.ts lists it): no
// database, no React, no regular expression with a lookbehind.

/** The kinds of request the requests table holds (db/schema.ts request_kind). */
export type RequestKind = "contact" | "individual" | "practice" | "waitlist" | "change_request";

/**
 * The tabs of Päringud, in the order they are drawn (?liik=): „Kontakt“ holds the contact messages and the e-learning purchase interest (a contact request
 * with the intent `purchase`, tagged „E-õppe huvi“); „Muutmine“ a student's wish to cancel or move a registration, sent from her account page.
 */
export const REQUEST_TABS = ["kontakt", "individuaal", "praktika", "ootenimekiri", "muutmine"] as const;
export type TabKey = (typeof REQUEST_TABS)[number];

export const TAB_KIND: Record<TabKey, RequestKind> = { kontakt: "contact", individuaal: "individual", praktika: "practice", ootenimekiri: "waitlist", muutmine: "change_request" };
export const KIND_TAB: Record<RequestKind, TabKey> = { contact: "kontakt", individual: "individuaal", practice: "praktika", waitlist: "ootenimekiri", change_request: "muutmine" };

/** What a request stores (db/schema.ts requests.payload). */
export type RequestPayload = Record<string, string | boolean | number>;

/** The cart's „let me know“ for an e-course: a contact request that names a course and has the intent `purchase`. */
export const isInterest = (kind: RequestKind, payload: RequestPayload): boolean => kind === "contact" && payload.intent === "purchase";

/** A stored value as one line of text: a string with its white space folded, a number as it is, anything else nothing. */
const line = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : "");

/** The day and place of a session as the facts name them: „14.11.2026 10:00, Pärnu“ (`time`: with the hour) or „14.11.2026 Pärnu“ (the Muutmine form). */
function when(startsAt: string, city: string, time: boolean): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return "";
  if (time) return [`${formatDate(d, "et")} ${formatTime(d, "et")}`, city].filter(Boolean).join(", ");
  return [formatDate(d, "et"), city].filter(Boolean).join(" ");
}

/**
 * The one muted line under a card's message (README A7, piece2-texts S3-j): what the card's header (the name, „{date} · {lang} · {email}“) and its message do not
 * say. Parts are joined with „ · “, empty parts are dropped, a yes/no field is its label only when it is ticked, and a Russian request starts with „Vastus
 * vene keeles“. "" when there is nothing to say (then the card has no such line).
 *
 * `payload` is what the request stores, with what the page looked up put beside it, because the stored value is an id or a slug: `course` is the
 * course's title (a practice request's `course` is free text and stays as she wrote it), and for a waitlist entry or a change request `startsAt` (ISO) and
 * `city` are the session's, or the registration's session. A change request has no `locale` of its own: the page puts the registration's there.
 *
 * - Individuaal: telefon · koolitus · Soovitud periood: … · Vajab abi modelli leidmisel · Soovib kontot
 * - Praktika: telefon · Pakett: … · Läbitud koolitus: … · Sobivad ajad: …
 * - Ootenimekiri: koolitus · Toimumine: 14.11.2026 10:00, Pärnu
 * - Muutmine: Soovib tühistada | Soovib muuta aega · koolitus, 14.11.2026 Pärnu
 * - Kontakt: nothing; the e-learning interest: Ostu ei lõpetanud · ostukorvist
 */
export function requestFacts(kind: RequestKind, payload: RequestPayload): string {
  const t = adminEt.requests;
  const labelled = (label: string, value: string) => (value ? fill(t.fact, { label, value }) : "");
  const ticked = (v: unknown, label: string) => (v === true ? label : "");
  const russian = payload.locale === "ru" ? t.facts.russian : "";
  const startsAt = line(payload.startsAt);
  const city = line(payload.city);
  let parts: string[] = [];
  switch (kind) {
    case "individual":
      parts = [
        line(payload.phone),
        line(payload.course),
        labelled(t.fields.period, line(payload.preferredPeriod)),
        ticked(payload.wantsModelHelp, t.fields.modelHelp),
        ticked(payload.wantsAccount, t.fields.account),
      ];
      break;
    case "practice":
      parts = [
        line(payload.phone),
        labelled(t.fields.package, line(payload.package)),
        labelled(t.fields.completedCourse, line(payload.course)),
        labelled(t.fields.times, line(payload.times)),
      ];
      break;
    case "waitlist": {
      const day = startsAt ? when(startsAt, city, true) : line(payload.session) ? fill(t.unknownSession, { id: line(payload.session) }) : "";
      parts = [line(payload.course), labelled(t.fields.session, day)];
      break;
    }
    case "change_request": {
      const wish = payload.kind === "cancel" || payload.kind === "change" ? t.wish[payload.kind] : "";
      const course = line(payload.course);
      const day = startsAt ? when(startsAt, city, false) : "";
      // (a registration that is gone: its number is all there is to name)
      const what = course ? [course, day].filter(Boolean).join(", ") : fill(t.unknownRegistration, { id: line(payload.registrationId) || "?" });
      parts = [wish, what];
      break;
    }
    case "contact":
      parts = [isInterest(kind, payload) ? t.facts.cart : ""];
      break;
  }
  return [russian, ...parts].filter(Boolean).join(" · ");
}

/**
 * The subject of Maria's reply (README A7 „Vasta e-kirjaga ↗“, piece2-texts S3-k): „Vastus sinu päringule — {title}“, in Russian „Ответ на ваш запрос — {title}“,
 * in the language the request was sent in. `title` is the course or the practice package it named; a request that names none (a plain message) says „MS LAB“.
 * One line: a subject has no line breaks.
 */
export function replySubject(locale: Locale, title: string): string {
  const t = getDict(locale).account.mail.reply;
  const one = title.replace(/\s+/g, " ").trim();
  return fill(t.subject, { title: one || t.brand });
}
