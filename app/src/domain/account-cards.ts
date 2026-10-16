import { upcomingFrom } from "@/domain/calendar";
import type { InvoiceKind, InvoiceStatus } from "@/domain/invoice";
import { formatEUR } from "@/domain/money";
import { prepaymentDue, type RegStatus } from "@/domain/registration";
import { pick, type I18n } from "@/i18n/field";
import { formatDate, formatTime } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";

// The client dashboard's cards and the one sentence each says about what to do next (spec 2.1 rule 5: one plain sentence
// plus at most one button). Pure: no database, no React. server/client-data.ts builds the cards (loadDashboard) and the
// components and the admin's read-only view render them; every date is an ISO string, so a card is exactly what the
// JSON endpoint sends and nothing needs converting on the way.

/** Where students pay the prepayment (settings key "prepayment", the admin's "Ettemaksu juhised"). */
export type PrepaymentInfo = { receiver: string; iban: string; bank: string; referencePrefix: string };

/** The settings key of the prepayment instructions (admin "Ettemaksu juhised"). */
export const PREPAYMENT_KEY = "prepayment";

/** The prepayment setting as the cards and e-mails use it: strings only; null when it is missing, not an object or every field is empty. */
export function parsePrepayment(value: unknown): PrepaymentInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const field = (key: string) => (typeof v[key] === "string" ? (v[key] as string).trim() : "");
  const info = { receiver: field("receiver"), iban: field("iban"), bank: field("bank"), referencePrefix: field("referencePrefix") };
  return Object.values(info).some(Boolean) ? info : null;
}

export type CourseRef = { slug: string; title: I18n };
export type SessionRef = { startsAt: string; city: string; venue: string };
/** A date on the calendar; `cancelled` is true when Maria called the training off. */
export type CalendarSession = SessionRef & { cancelled: boolean };

/**
 * An unpaid invoice's bank details as they were frozen on it (invoices.seller: the receiver, the IBAN and the bank of Ettemaksu juhised at its
 * creation) and its payment reference (invoices.reference; empty when there is none to print). The instructions' rows, without the prefix.
 */
export type InvoiceTransfer = { receiver: string; iban: string; bank: string; reference: string };

/**
 * One of her invoices on a course card (invoices Task 6, spec §4; server/client-data.ts loadDashboard): never a cancelled one. `status` is what
 * the student is told: an unpaid invoice whose online payment is paid already (R14: the money is in, the catch-up is pending) is sent as "paid"
 * (with `paidAt` null until the catch-up gives it one). `transfer` is set for an unpaid invoice that has bank details, else null.
 */
export type CardInvoice = {
  id: number;
  number: string;
  amountCents: number;
  status: Exclude<InvoiceStatus, "cancelled">;
  dueAt: string | null;
  paidAt: string | null;
  transfer: InvoiceTransfer | null;
};

/**
 * The invoice „Maksa" charges on a registration (invoices D5; server/invoices.ts unpaidInvoiceOf, the one the start and the /maksa page ask):
 * its latest unpaid one that is not paid online already. The card asks domain/payments.ts payableDue with it, as the server does.
 */
export type OpenInvoice = { id: number; kind: InvoiceKind; amountCents: number };

/** A contact-course registration for one session. */
export type ContactCard = {
  kind: "contact";
  registrationId: number;
  course: CourseRef;
  session: CalendarSession;
  status: RegStatus;
  paymentChoice: "full" | "half";
  /** What the registration is measured against (domain/registration.ts registrationPrice), cents; null when the course has no such price. */
  priceCents: number | null;
  paidCents: number;
  createdAt: string;
  /** Maria has sent this registration's protocol (phase protocols, spec §5): the card offers "Vaata protokolli". Absent until then. */
  protocolSent?: boolean;
  /** Her invoices of this registration, the oldest first (invoices Task 6); absent without one, so the cards of a student with none are as they were. */
  invoices?: CardInvoice[];
  /** The unpaid invoice „Maksa" charges instead of what is due (OpenInvoice); absent without one. */
  openInvoice?: OpenInvoice | null;
};

/** A registration without a session (an individual course): Maria agrees the time with the student. */
export type IndividualCard = {
  kind: "individual";
  registrationId: number;
  course: CourseRef;
  status: RegStatus;
  preferredPeriod: string;
  createdAt: string;
  /** Maria has sent this registration's protocol (phase protocols, spec §5): the card offers "Vaata protokolli". Absent until then. */
  protocolSent?: boolean;
  /** Her invoices of this registration (invoices Task 6), as a contact card's; no „Maksa" on this card, so no open one. Absent without one. */
  invoices?: CardInvoice[];
};

/** An individual-course or practice request. `title` is the course or the practice package (null when it is gone). */
export type RequestCard = {
  kind: "request";
  requestId: number;
  requestKind: "individual" | "practice";
  title: I18n | null;
  /** What was asked for, short: the preferred period (individual) or the times (practice). */
  detail: string;
  handled: boolean;
  createdAt: string;
};

export type WaitlistCard = {
  kind: "waitlist";
  requestId: number;
  course: CourseRef | null;
  session: CalendarSession | null;
  /** Maria has dealt with the entry (the admin's "Käsitletud"). */
  handled: boolean;
  createdAt: string;
};

/**
 * An open e-course's lessons for the student (phase 2c; visible lessons only): how many are done of how many, and the next one to open
 * (the first open lesson not done, with its module's title), null when every lesson is done.
 */
export type EcourseProgress = { done: number; total: number; next: { lessonId: number; title: I18n; moduleTitle: I18n } | null };

export type EcourseCard = {
  kind: "ecourse";
  course: CourseRef;
  grantedAt: string;
  expiresAt: string;
  revoked: boolean;
  /** Present for an active access: its lessons (null without visible lessons); absent for an access that has ended. */
  progress?: EcourseProgress | null;
  /**
   * When the course was completed (e-course completion, spec §4.1: course_access.completed_at, ISO), null before. Present on every card
   * loadDashboard makes, also after the access ended: the card says "Lõpetatud {date}". Optional so cards built elsewhere keep compiling.
   */
  completedAt?: string | null;
  /**
   * Her certificate's id (phase 3d, spec §5): null without one, and for a revoked access (Maria revoked it: it is hers no more). Present on
   * every card loadDashboard makes. An ended access's card links GET /api/konto/tunnistus/<id> ("Laadi tunnistus alla"), the one way back to
   * it once the course page has closed. Optional so cards built elsewhere keep compiling.
   */
  certificateId?: number | null;
  /** Her invoices of this course's purchases, the oldest first (invoices Task 6): each is born paid. Absent without one. */
  invoices?: CardInvoice[];
};

export type AccountCard = ContactCard | IndividualCard | RequestCard | WaitlistCard | EcourseCard;

/** A feedback form that is open and has no answer (phase protocols, spec §7): the dashboard's "Kuidas koolitus läks?" card. */
export type FeedbackPrompt = { registrationId: number; course: CourseRef };

export type NextStepKey =
  | "cancelled"
  | "done"
  | "pay"
  | "invoice"
  | "confirming"
  | "confirmedRest"
  | "confirmed"
  | "individualPending"
  | "requestNew"
  | "requestDone"
  | "waitlist"
  | "accessEnded"
  | "openCourse";

export type NextStepAction =
  | { kind: "none" }
  | { kind: "pay"; registrationId: number }
  | { kind: "changeRequest"; registrationId: number }
  | { kind: "openCourse"; slug: string };

/** `key` is the sentence in the dictionary (`account.next.<key>`), `vars` fill its {placeholders}, `action` is the card's one button. */
export type NextStep = { key: NextStepKey; vars: Record<string, string>; action: NextStepAction };

/**
 * Prepayment instructions can be followed when they name at least the receiver and the IBAN (the bank and the reference
 * prefix are optional); anything less, and Maria sends an invoice instead.
 */
export function hasPrepayment(pay: PrepaymentInfo | null): pay is PrepaymentInfo {
  return !!pay && pay.receiver.trim() !== "" && pay.iban.trim() !== "";
}

const NONE: NextStepAction = { kind: "none" };
const step = (key: NextStepKey, vars: Record<string, string> = {}, action: NextStepAction = NONE): NextStep => ({ key, vars, action });

/** The session has begun: the same "upcoming" as the calendar and booking (calendar.ts upcomingFrom), so a card turns "done" when its date leaves them. */
const begun = (startsAt: string, now: Date): boolean => new Date(startsAt) < upcomingFrom(now);

function contactStep(card: ContactCard, now: Date, pay: PrepaymentInfo | null, locale: Locale, online: boolean): NextStep {
  if (card.status === "cancelled" || card.session.cancelled) return step("cancelled");
  if (begun(card.session.startsAt, now)) return step("done");
  const rest = card.priceCents === null ? 0 : card.priceCents - card.paidCents;
  if (card.status === "awaiting_prepayment") {
    // Without a price the amount cannot be told: Maria's invoice says it.
    if (card.priceCents === null) return step("invoice");
    const due = prepaymentDue(card.priceCents, card.paymentChoice) - card.paidCents;
    // Paid enough already (the admin has not confirmed yet): nothing is left to pay.
    if (due <= 0) return step("confirming");
    // phase 2b: with online payments the amount can be paid by "Maksa" even when Maria has no transfer instructions in Seaded
    return hasPrepayment(pay) || online ? step("pay", { amount: formatEUR(due, locale) }, { kind: "pay", registrationId: card.registrationId }) : step("invoice");
  }
  const change: NextStepAction = { kind: "changeRequest", registrationId: card.registrationId };
  if (rest > 0) return step("confirmedRest", { rest: formatEUR(rest, locale) }, change);
  // the date, time and place are on the card's own line (cardWhen): the sentence does not repeat them
  return step("confirmed", {}, change);
}

/**
 * The sentence and the button of a card. Dates and times are Estonian time and amounts are euros, formatted for `locale`
 * (the formatters of src/i18n/format.ts and domain/money.ts), so the caller only puts the vars into the dictionary text.
 * `pay` is the admin's prepayment setting (null, or without a receiver or an IBAN: Maria sends an invoice). `online`: online payments are on
 * (phase 2b, Dashboard.payOnline): an unpaid card is "pay" (its "Maksa {summa}") even without the transfer instructions.
 */
export function nextStep(card: AccountCard, now: Date, pay: PrepaymentInfo | null, locale: Locale = "et", online = false): NextStep {
  switch (card.kind) {
    case "contact":
      return contactStep(card, now, pay, locale, online);
    case "individual":
      return card.status === "cancelled" ? step("cancelled") : step("individualPending");
    case "request":
      return step(card.handled ? "requestDone" : "requestNew");
    case "waitlist":
      // a called-off date ends the wait; an entry Maria has dealt with is answered
      if (card.session?.cancelled) return step("cancelled");
      return step(card.handled ? "requestDone" : "waitlist");
    case "ecourse": {
      const expiresAt = new Date(card.expiresAt);
      if (card.revoked || expiresAt <= now) return step("accessEnded");
      return step("openCourse", { date: formatDate(expiresAt, locale) }, { kind: "openCourse", slug: card.course.slug });
    }
  }
}

/** Over for the student: a past or cancelled training, a handled request, a waitlist date that has passed, ended access. */
export function isPastCard(card: AccountCard, now: Date): boolean {
  switch (card.kind) {
    case "contact":
      return card.status === "cancelled" || card.session.cancelled || begun(card.session.startsAt, now);
    case "individual":
      return card.status === "cancelled";
    case "request":
      return card.handled;
    case "waitlist":
      return card.handled || (card.session !== null && (card.session.cancelled || begun(card.session.startsAt, now)));
    case "ecourse":
      return card.revoked || new Date(card.expiresAt) <= now;
  }
}

/** The start of the session a card is about (a contact registration, a waitlist entry with a date); null for a card without a date. */
function sessionTime(card: AccountCard): number | null {
  switch (card.kind) {
    case "contact":
      return new Date(card.session.startsAt).getTime();
    case "waitlist":
      return card.session ? new Date(card.session.startsAt).getTime() : null;
    default:
      return null;
  }
}

/** When a card was made or granted: what a card without a date is placed by. */
function madeTime(card: AccountCard): number {
  return new Date(card.kind === "ecourse" ? card.grantedAt : card.createdAt).getTime();
}

/** A stable key of a card (the id of its registration, request or course) for lists. */
export function cardKey(card: AccountCard): string {
  switch (card.kind) {
    case "contact":
    case "individual":
      return `registration-${card.registrationId}`;
    case "request":
    case "waitlist":
      return `request-${card.requestId}`;
    case "ecourse":
      return `course-${card.course.slug}`;
  }
}

/** Numeric-aware, so "registration-9" comes before "registration-10". */
const byKey = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * The order of the dashboard:
 * - open cards first, then the over ones (isPastCard);
 * - open cards with a date (a booked or waitlisted session) by that date, the soonest first;
 * - then the open cards without a date (an individual registration, a request, an e-course) by when they were made or granted, the newest first;
 * - over cards, all together, the most recent first (a session's date, else when it was made or granted).
 * Equal times keep a fixed order (by key). Does not change `cards`.
 */
export function sortCards(cards: AccountCard[], now: Date): AccountCard[] {
  return cards
    .map((card) => ({ card, past: isPastCard(card, now), session: sessionTime(card), made: madeTime(card), key: cardKey(card) }))
    .sort((a, b) => {
      if (a.past !== b.past) return a.past ? 1 : -1;
      if (a.past) return (b.session ?? b.made) - (a.session ?? a.made) || byKey(a.key, b.key);
      if (a.session !== null && b.session !== null) return a.session - b.session || byKey(a.key, b.key);
      if (a.session !== null || b.session !== null) return a.session !== null ? -1 : 1;
      return b.made - a.made || byKey(a.key, b.key);
    })
    .map((x) => x.card);
}

/**
 * Which e-course the dark "Pooleli" card at the top of "Minu koolitused" is for (spec 4). Of her open e-courses with a lesson left
 * (an active access, and a progress with a next lesson), the one she did something in last. `activity` maps a course slug to the time
 * in ms of her last lesson row write. With no activity in any of them, the first such course in the cards' order: the card then
 * says "Alusta". null: none — every course finished, none with lessons, none open.
 */
export function resumeSlug(cards: readonly AccountCard[], activity: ReadonlyMap<string, number>, now: Date): string | null {
  let best: { slug: string; at: number } | null = null;
  for (const card of cards) {
    if (card.kind !== "ecourse" || isPastCard(card, now) || !card.progress?.next) continue;
    const at = activity.get(card.course.slug) ?? -Infinity;
    if (best === null || at > best.at) best = { slug: card.course.slug, at };
  }
  return best?.slug ?? null;
}

// ---------- for the dashboard's view (components/account) ----------

/** The greeting's name: the first word of the client's name ("Kati Tamm" → "Kati"); "" without a name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** An IBAN without spaces, in capitals: what is stored (Seaded) and what "Kopeeri" copies. */
export const compactIban = (iban: string): string => iban.replace(/\s+/g, "").toUpperCase();

/** An IBAN as people read it, in groups of four: "EE38 2200 2210 2014 5685". */
export const groupIban = (iban: string): string => compactIban(iban).replace(/(.{4})(?=.)/g, "$1 ");

/** The payment's explanation on the prepayment instructions: the admin's prefix and the registration number ("MSLAB-" + 42). */
export function paymentReference(pay: PrepaymentInfo, registrationId: number): string {
  return `${pay.referencePrefix.trim()}${registrationId}`;
}

/** The invoices on a card: a registration's or an e-course's own; none for a request or a waitlist entry. */
export function cardInvoices(card: AccountCard): CardInvoice[] {
  return card.kind === "contact" || card.kind === "individual" || card.kind === "ecourse" ? (card.invoices ?? []) : [];
}

/** The names a card uses when its course or practice package is gone (account.dashboard.untitled). */
export type UntitledTexts = { individual: string; practice: string; course: string };

/** The card's title: the course, the practice package; a plain name when it is gone. */
export function cardTitle(card: AccountCard, locale: Locale, untitled: UntitledTexts): string {
  switch (card.kind) {
    case "contact":
    case "individual":
    case "ecourse":
      return pick(card.course.title, locale);
    case "request":
      return card.title ? pick(card.title, locale) : untitled[card.requestKind];
    case "waitlist":
      return card.course ? pick(card.course.title, locale) : untitled.course;
  }
}

/**
 * The card's line about when and where: a session's "14.11.2026 · 10:00" (Estonian time) and "Pärnu, MS LAB stuudio"; an
 * individual registration's preferred period or a request's times as `time`; null for an e-course (its sentence says it).
 */
export function cardWhen(card: AccountCard, locale: Locale): { time: string; place: string } | null {
  const session = card.kind === "contact" || card.kind === "waitlist" ? card.session : null;
  if (session) {
    const start = new Date(session.startsAt);
    return { time: `${formatDate(start, locale)} · ${formatTime(start, locale)}`, place: [session.city, session.venue].filter(Boolean).join(", ") };
  }
  if (card.kind === "individual" && card.preferredPeriod.trim()) return { time: card.preferredPeriod.trim(), place: "" };
  if (card.kind === "request" && card.detail.trim()) return { time: card.detail.trim(), place: "" };
  return null;
}

/** The small tag on a card: what kind of thing it is (an individual registration is a contact course too). */
export type CardTag = "contact" | "ecourse" | "request" | "waitlist";

export function cardTag(card: AccountCard): CardTag {
  switch (card.kind) {
    case "contact":
    case "individual":
      return "contact";
    case "ecourse":
      return "ecourse";
    case "request":
      return "request";
    case "waitlist":
      return "waitlist";
  }
}

export type CardFilter = "all" | "upcoming" | "past";

/** The cards a filter chip shows (Kõik / Tulevased / Möödunud), in the order given. */
export function filterCards(cards: AccountCard[], filter: CardFilter, now: Date): AccountCard[] {
  if (filter === "all") return cards;
  return cards.filter((card) => isPastCard(card, now) === (filter === "past"));
}

/**
 * The chips are shown only when they can change what is seen: two or more cards, of which some are still ahead and some
 * are over. With only upcoming (or only past) cards one of the chips would show everything and the other nothing.
 */
export function showFilters(cards: AccountCard[], now: Date): boolean {
  if (cards.length < 2) return false;
  const past = cards.filter((card) => isPastCard(card, now)).length;
  return past > 0 && past < cards.length;
}
