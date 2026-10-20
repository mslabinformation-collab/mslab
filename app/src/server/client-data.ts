import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { CourseCardData } from "@/components/site/CourseCard";
import { courseCardData } from "@/components/site/course-card-data";
import type { Db, Q } from "@/db/client";
import { listPublishedCourses, listUpcomingSessions, readSetting } from "@/db/queries/public";
import {
  certificates, clientFavourites, clientLoginTokens, clients, contracts, courseAccess, courseFeedback, courses, courseSessions, pages, practicePackages, protocols, registrations,
  requests, subscribers, termsAcceptances, type Contract,
} from "@/db/schema";
import {
  PREPAYMENT_KEY, parsePrepayment, resumeSlug, sortCards, type AccountCard, type CardContract, type CardInvoice, type EcourseCard, type FeedbackPrompt, type OpenInvoice, type PrepaymentInfo, type ReviewRef,
} from "@/domain/account-cards";
import { upcomingFrom } from "@/domain/calendar";
import type { CourseSteps } from "@/domain/completion";
import { contractValues, fillContract, type ContractValues } from "@/domain/contract";
import { DEFAULT_TERMS_VERSION, TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { nextSessionByCourse } from "@/domain/home";
import type { CourseProgress } from "@/domain/lessons";
import { feedbackOpenFor } from "@/domain/protocols";
import { registrationPrice } from "@/domain/registration";
import { normalizeEmail } from "@/domain/email";
import type { I18n } from "@/i18n/field";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import { certificateOfAccess, type CertificateView } from "./certificates";
import { lockAddress } from "./client-auth";
import { gateName } from "./account-input";
import { accessFor, completeIfDone, isActive, loadSteps, lockAccess } from "./completion";
import {
  accessContractFields, contractForAccess, contractForRegistration, contractTemplate, contractTemplates, currentContractsOfClient, registrationContractFields, shownVersionHolds,
} from "./contracts";
import { invoicesOfClient, type StudentInvoice } from "./invoices";
import { courseOutline, ecourseProgress, progressActivity, type OutlineModule } from "./lesson-outline";
import { logFailure } from "./log";
import { practicalKeys } from "./practical";
import { reviewCourseSlugs, reviewsOfClient } from "./reviews";
import { newToken } from "./token";

// What a signed-in client sees and may change, for the JSON endpoints under /api/konto (account-api.ts) and the admin's
// read-only "view as client" (loadDashboard). Every function takes the client's id from the verified session, never from the
// request, and scopes every read and write to it: a registration, request, favourite or access row of another client is
// never read, changed or reported to exist.

/** At most this much of a request's text goes onto its card ("what was asked"). */
const DETAIL_MAX = 200;

export type ClientProfile = {
  email: string;
  name: string;
  phone: string;
  locale: "et" | "ru";
  newsletter: boolean;
  /** When her password was last set or changed (ISO); null without one (phase 2c). Never the hash. */
  passwordSetAt: string | null;
};

export type Dashboard = {
  client: ClientProfile;
  cards: AccountCard[];
  /** Slugs of the published courses the client has hearted. */
  favourites: string[];
  /** Where to pay; null when the admin has not filled it in (the cards then say Maria sends an invoice). */
  prepayment: PrepaymentInfo | null;
  /** The slug of the e-course the "Pooleli" card is for (domain/account-cards.ts resumeSlug); null: no card. */
  resume: string | null;
  /**
   * Online payments are on (phase 2b): the cards offer "Maksa {summa}" / "Maksa ülejäänud {summa}". Set by the account API (account-api.ts
   * dashboard), never by loadDashboard: the admin's read-only view shows the cards without it.
   */
  payOnline?: boolean;
  /** The feedback forms open for her and not answered or dismissed (phase protocols, spec §7), the latest first; absent when there is none. */
  feedback?: FeedbackPrompt[];
};

export type EcourseView = {
  course: { slug: string; title: I18n; modules: OutlineModule[] };
  access: { expiresAt: string };
  /**
   * `version`: the current terms version (send it back when accepting, so a student who saw the old text cannot accept a new one unseen).
   * `accepted`: nothing is left to accept: the client has accepted that version for this course, or there is no terms text (none stored,
   * or an empty one: nothing to read or agree to, so no notice and no acceptance recorded; when the admin saves a text, the version moves
   * and the notice shows): then nothing else. While `accepted` is false, the gate's contract (GateTerms).
   */
  terms: { version: string; accepted: true; text: null } | GateTerms;
  /** "5 / 24 õppetundi tehtud" and where "Jätka" goes (domain/lessons.ts courseProgress). */
  progress: CourseProgress;
  /**
   * "Lõpetamine" (e-course completion, spec §4.1): the path's steps (server/completion.ts loadSteps), and `protocolSent`: an e-course
   * without points whose notes-only protocol Maria has sent (spec §4.3 last bullet: the block links to it, "Vaata protokolli").
   * "Tunnistus" (phase 3d, spec §5), read once the course is completed: `certificate` is its view (null before it is issued), and
   * `certificateName` her account's name, the first value of "Nimi tunnistusel". Before the completion they are null and "".
   */
  completion: CourseSteps & { protocolSent: boolean; certificate: CertificateView | null; certificateName: string };
};

/** One page language's contract at the terms gate: its title and its text. */
export type GateText = { title: string; body: string };

/**
 * The terms gate still to pass (contracts, D1; rulings R18, R19). `text`: the contract as acceptTerms freezes it on a page in that language
 * (contracts.ts contractForAccess via "terms": the e-course template in that language, filled with the access's fields), the title and the text, so
 * the student reads exactly what she accepts. `askName`: her account has no name (empty after trimming: one Maria added by e-mail only, „Lisa
 * õpilane“), so the gate asks for it, and fills {nimi} as she types: per language the template unfilled and the values of every placeholder but
 * {nimi} (whose value is empty there), the one-pass fill (domain/contract.ts fillContract) the server runs again with the name she sends. null:
 * her account has a name, which `text` holds.
 */
export type GateTerms = {
  version: string;
  accepted: false;
  text: Record<"et" | "ru", GateText>;
  askName: Record<"et" | "ru", { template: GateText; values: ContractValues }> | null;
};

const iso = (d: Date): string => d.toISOString();

/**
 * An invoice as her card shows it (invoices Task 6, spec §4; domain/account-cards.ts CardInvoice). An unpaid invoice carries the receiver, IBAN
 * and bank frozen on it and its reference, when it has a receiver and an IBAN to pay to, and while it may be paid (`payable`: not on a
 * cancelled registration or a called-off session, whose invoice stays unpaid until Maria cancels it, spec §9, but invites no payment: the final
 * review's m8). An unpaid one whose online payment is paid already (R14: `paidOnline`, its catch-up pending) is shown as paid, with no bank
 * details: the money is in, and the start will not charge it again (invoices.ts unpaidInvoiceOf). Its PDF reads as the row does, unpaid, until
 * Maria's catch-up pays it, so it is marked `awaitingCatchUp` and the card offers no download for it. A paid one whose payment was refunded or
 * voided is marked `refunded` („Tagastatud“, I3).
 */
function cardInvoice(inv: StudentInvoice, payable: boolean): CardInvoice | null {
  if (inv.status === "cancelled") return null; // void: not hers to see (invoices.ts ofClient leaves it out already)
  const unpaid = inv.status === "unpaid" && !inv.paidOnline;
  const { receiver, iban, bank } = inv.seller;
  return {
    id: inv.id,
    number: inv.number,
    amountCents: inv.amountCents,
    status: unpaid ? "unpaid" : "paid",
    dueAt: inv.dueAt ? iso(inv.dueAt) : null,
    paidAt: inv.paidAt ? iso(inv.paidAt) : null,
    transfer: unpaid && payable && receiver.trim() !== "" && iban.trim() !== "" ? { receiver, iban, bank, reference: inv.reference } : null,
    ...(inv.status === "unpaid" && !unpaid ? { awaitingCatchUp: true as const } : {}),
    ...(inv.refunded ? { refunded: true as const } : {}),
  };
}

/** The invoice „Maksa" charges among a registration's (oldest first): the latest unpaid one not paid online already — invoices.ts unpaidInvoiceOf's rule over rows already read. */
function openInvoiceOf(list: StudentInvoice[]): OpenInvoice | null {
  const open = list.findLast((i) => i.status === "unpaid" && !i.paidOnline);
  return open ? { id: open.id, kind: open.kind, amountCents: open.amountCents } : null;
}

/** `list` grouped by `key`, each group in the order given; an invoice with no key is left out. */
function groupInvoices(list: StudentInvoice[], key: (inv: StudentInvoice) => number | null): Map<number, StudentInvoice[]> {
  const groups = new Map<number, StudentInvoice[]>();
  for (const inv of list) {
    const k = key(inv);
    if (k !== null) groups.set(k, [...(groups.get(k) ?? []), inv]);
  }
  return groups;
}

/** The version of the e-course terms: the settings key `courseTermsVersion` (an ISO time, set when the admin saves the terms text), "1" until then. */
export async function courseTermsVersion(db: Q): Promise<string> {
  const value = await readSetting(db, TERMS_VERSION_KEY);
  return typeof value === "string" && value.trim() ? value : DEFAULT_TERMS_VERSION;
}

// ---------- the dashboard ----------

/**
 * Nine small queries, run together: registrations (with session and course), requests, e-course access, favourites, the client, the prepayment
 * setting, her invoices (invoices.ts invoicesOfClient: one query, grouped here onto the registration's or the e-course's card, none per
 * card), her current contracts (contracts.ts currentContractsOfClient: one query, ruling R14's owner, grouped the same way) and her reviews
 * (reviews.ts reviewsOfClient: one query, grouped onto the registration's or the e-course's card as its `review`); then, for each
 * open e-course, its lessons (two queries each) and her last lesson activity (one query), for the cards' progress and the "Pooleli" card (`resume`).
 */
export async function loadDashboard(db: Db, clientId: number, now: Date): Promise<Dashboard | null> {
  const [regRows, requestRows, accessRows, favourites, [client], prepayment, invoiceRows, contractRows, reviewRows] = await Promise.all([
    db
      .select({
        id: registrations.id,
        status: registrations.status,
        kind: registrations.kind,
        paymentChoice: registrations.paymentChoice,
        paidCents: registrations.paidCents,
        preferredPeriod: registrations.preferredPeriod,
        createdAt: registrations.createdAt,
        contractRequestedAt: registrations.contractRequestedAt,
        course: { slug: courses.slug, title: courses.title, type: courses.type, price: courses.price, priceGroup: courses.priceGroup, priceIndividual: courses.priceIndividual },
        startsAt: courseSessions.startsAt,
        city: courseSessions.city,
        venue: courseSessions.venue,
        sessionStatus: courseSessions.status,
        protocolSentAt: protocols.sentAt,
        feedbackId: courseFeedback.id,
      })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
      .leftJoin(courseFeedback, eq(courseFeedback.registrationId, registrations.id))
      .where(eq(registrations.clientId, clientId)),
    // Individual and practice requests and waitlist entries; the payload's course (a slug), package (a code) and session (an id,
    // read only when it is all digits, so a odd value cannot fail the query) point at what the card names. A practice request's
    // own "course" field is free text, so only individual and waitlist rows are matched against courses.
    db
      .select({
        id: requests.id,
        kind: requests.kind,
        handled: requests.handled,
        createdAt: requests.createdAt,
        detail: sql<string | null>`coalesce(${requests.payload}->>'preferredPeriod', ${requests.payload}->>'times')`,
        courseSlug: courses.slug,
        courseTitle: courses.title,
        packageName: practicePackages.name,
        startsAt: courseSessions.startsAt,
        city: courseSessions.city,
        venue: courseSessions.venue,
        sessionStatus: courseSessions.status,
      })
      .from(requests)
      .leftJoin(courses, and(inArray(requests.kind, ["individual", "waitlist"]), eq(courses.slug, sql`${requests.payload}->>'course'`)))
      .leftJoin(practicePackages, and(eq(requests.kind, "practice"), eq(practicePackages.code, sql`${requests.payload}->>'package'`)))
      .leftJoin(
        courseSessions,
        and(
          eq(requests.kind, "waitlist"),
          eq(courseSessions.id, sql`case when ${requests.payload}->>'session' ~ '^[0-9]{1,9}$' then (${requests.payload}->>'session')::int end`),
        ),
      )
      .where(and(eq(requests.clientId, clientId), inArray(requests.kind, ["individual", "practice", "waitlist"]))),
    db
      .select({
        id: courseAccess.id,
        courseId: courseAccess.courseId,
        grantedAt: courseAccess.grantedAt,
        expiresAt: courseAccess.expiresAt,
        revokedAt: courseAccess.revokedAt,
        completedAt: courseAccess.completedAt,
        certificateId: certificates.id,
        slug: courses.slug,
        title: courses.title,
        feedbackId: courseFeedback.id,
      })
      .from(courseAccess)
      .innerJoin(courses, eq(courseAccess.courseId, courses.id))
      .leftJoin(certificates, eq(certificates.accessId, courseAccess.id))
      .leftJoin(courseFeedback, eq(courseFeedback.accessId, courseAccess.id))
      .where(eq(courseAccess.clientId, clientId)),
    favouriteSlugs(db, clientId),
    db
      .select({
        email: clients.email,
        name: clients.name,
        phone: clients.phone,
        locale: clients.locale,
        // a confirmed subscriber of the account's address (rows may hold the address in any case). Written out: in a single-table query
        // Drizzle prints a column without its table, which inside the subquery would be the subscriber's own column.
        newsletter: sql<boolean>`exists (select 1 from subscribers s where lower(s.email) = clients.email and s.confirmed_at is not null)`,
        // whether there is a password, and when it was set: the hash itself is never selected
        hasPassword: sql<boolean>`${clients.passwordHash} is not null`,
        passwordChangedAt: clients.passwordChangedAt,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1),
    readSetting(db, PREPAYMENT_KEY),
    invoicesOfClient(db, clientId),
    currentContractsOfClient(db, clientId),
    reviewsOfClient(db, clientId),
  ]);
  if (!client) return null;

  // her invoices on the card they belong to: a registration's, and an e-course's by its course (a purchase's invoice has no registration)
  const ofRegistration = groupInvoices(invoiceRows, (i) => i.registrationId);
  const ofCourse = groupInvoices(invoiceRows, (i) => (i.registrationId === null && i.kind === "ecourse" ? i.courseId : null));
  const invoicesOn = (list: StudentInvoice[] = [], payable = true) => {
    const shown = list.flatMap((i) => cardInvoice(i, payable) ?? []);
    return shown.length ? { invoices: shown } : {};
  };

  // her current contracts on the card they belong to: a registration's, and an e-course's by its access (ruling R14: the owner is read, one query)
  const contractOfRegistration = new Map<number, CardContract>();
  const contractOfAccess = new Map<number, CardContract>();
  for (const c of contractRows) {
    const on = { id: c.id, acceptedAt: iso(c.acceptedAt) };
    if (c.registrationId !== null) contractOfRegistration.set(c.registrationId, on);
    else if (c.accessId !== null) contractOfAccess.set(c.accessId, on);
  }

  // her reviews on the card they belong to (student reviews, D6): a registration's, and an e-course's by its access; only the id, never the status
  const reviewOfRegistration = new Map<number, ReviewRef>();
  const reviewOfAccess = new Map<number, ReviewRef>();
  for (const review of reviewRows) {
    if (review.registrationId !== null) reviewOfRegistration.set(review.registrationId, { id: review.id });
    else if (review.accessId !== null) reviewOfAccess.set(review.accessId, { id: review.id });
  }

  const cards: AccountCard[] = [];
  for (const r of regRows) {
    const course = { slug: r.course.slug, title: r.course.title };
    const mine = ofRegistration.get(r.id);
    // a cancelled registration, or one whose session was called off, pays nothing (m8): its unpaid invoice shows, without bank details or „Maksa“
    const payable = r.status !== "cancelled" && r.sessionStatus !== "cancelled";
    if (r.startsAt === null) {
      cards.push({
        kind: "individual",
        registrationId: r.id,
        course,
        status: r.status,
        preferredPeriod: r.preferredPeriod,
        createdAt: iso(r.createdAt),
        ...(r.protocolSentAt ? { protocolSent: true } : {}),
        ...invoicesOn(mine, payable),
        review: reviewOfRegistration.get(r.id) ?? null,
      });
    } else {
      const open = mine && payable ? openInvoiceOf(mine) : null;
      cards.push({
        kind: "contact",
        registrationId: r.id,
        course,
        session: { startsAt: iso(r.startsAt), city: r.city ?? "", venue: r.venue ?? "", cancelled: r.sessionStatus === "cancelled" },
        status: r.status,
        paymentChoice: r.paymentChoice,
        priceCents: registrationPrice(r.course, r.kind),
        paidCents: r.paidCents,
        createdAt: iso(r.createdAt),
        ...(r.protocolSentAt ? { protocolSent: true } : {}),
        ...invoicesOn(mine, payable),
        ...(open ? { openInvoice: open } : {}),
        contract: contractOfRegistration.get(r.id) ?? null,
        // Maria's open ask (D4) on a registration that can still be confirmed (the route's rule: a group one, not cancelled)
        contractRequested: r.contractRequestedAt !== null && r.kind === "group" && r.status !== "cancelled",
        review: reviewOfRegistration.get(r.id) ?? null,
      });
    }
  }
  // the feedback forms' cards (phase protocols, spec §7; student reviews, D3): a contact course's registration whose form is open and has no row yet,
  // and an e-course she has completed (not revoked, ended or not) and has no row for; the latest first, by the course day or the day it was completed
  const feedback: FeedbackPrompt[] = [
    ...regRows
      .filter((r) => r.course.type === "contact" && r.feedbackId === null && feedbackOpenFor(r, now))
      .map((r) => ({ at: (r.startsAt ?? r.createdAt).getTime(), order: r.id, prompt: { target: { registrationId: r.id }, course: { slug: r.course.slug, title: r.course.title } } })),
    ...accessRows
      .filter((a) => a.completedAt !== null && a.revokedAt === null && a.feedbackId === null)
      .map((a) => ({ at: a.completedAt?.getTime() ?? 0, order: a.id, prompt: { target: { courseSlug: a.slug }, course: { slug: a.slug, title: a.title } } })),
  ]
    .sort((a, b) => b.at - a.at || b.order - a.order)
    .map((p): FeedbackPrompt => p.prompt);
  for (const r of requestRows) {
    if (r.kind === "waitlist") {
      cards.push({
        kind: "waitlist",
        requestId: r.id,
        course: r.courseSlug !== null && r.courseTitle !== null ? { slug: r.courseSlug, title: r.courseTitle } : null,
        session: r.startsAt !== null ? { startsAt: iso(r.startsAt), city: r.city ?? "", venue: r.venue ?? "", cancelled: r.sessionStatus === "cancelled" } : null,
        handled: r.handled,
        createdAt: iso(r.createdAt),
      });
    } else {
      cards.push({
        kind: "request",
        requestId: r.id,
        requestKind: r.kind === "practice" ? "practice" : "individual",
        title: r.kind === "practice" ? r.packageName : r.courseTitle,
        detail: (r.detail ?? "").slice(0, DETAIL_MAX),
        handled: r.handled,
        createdAt: iso(r.createdAt),
      });
    }
  }
  // each open e-course's lessons (visible ones only), and when she last did anything in each course's lessons (phase 2c)
  const open = accessRows.filter((a) => a.revokedAt === null && a.expiresAt > now);
  const [outlines, activity] = await Promise.all([Promise.all(open.map((a) => courseOutline(db, a.courseId, clientId))), progressActivity(db, clientId)]);
  const progressOf = new Map(open.map((a, i) => [a.slug, ecourseProgress(outlines[i])]));
  for (const a of accessRows) {
    const card: EcourseCard = {
      kind: "ecourse",
      course: { slug: a.slug, title: a.title },
      grantedAt: iso(a.grantedAt),
      expiresAt: iso(a.expiresAt),
      revoked: a.revokedAt !== null,
      completedAt: a.completedAt ? iso(a.completedAt) : null,
      // the certificate (phase 3d): its id while the access is not revoked, so an ended access's card links it; a revoked one's never
      certificateId: a.revokedAt === null ? a.certificateId : null,
      ...invoicesOn(ofCourse.get(a.courseId)),
      contract: contractOfAccess.get(a.id) ?? null,
      contractRequested: false, // (Maria asks about a contact registration only)
      review: reviewOfAccess.get(a.id) ?? null,
    };
    if (progressOf.has(a.slug)) card.progress = progressOf.get(a.slug) ?? null;
    cards.push(card);
  }
  const sorted = sortCards(cards, now);
  const lastAt = new Map(open.flatMap((a) => {
    const at = activity.get(a.courseId);
    return at ? [[a.slug, at.getTime()] as const] : [];
  }));

  return {
    client: {
      email: client.email, name: client.name, phone: client.phone, locale: client.locale, newsletter: client.newsletter,
      passwordSetAt: client.hasPassword && client.passwordChangedAt ? iso(client.passwordChangedAt) : null,
    },
    cards: sorted,
    favourites,
    prepayment: parsePrepayment(prepayment),
    resume: resumeSlug(sorted, lastAt, now),
    ...(feedback.length ? { feedback } : {}),
  };
}

// ---------- an e-course ----------

/**
 * The e-course the client has access to right now (not revoked, not expired), or null. Whether the course is still published does not
 * matter: access is granted to the client and stays until it ends; only the favourites are limited to published courses.
 * Also the lesson endpoints' first check (lesson-data.ts), whose write may complete the access by its `id` (e-course completion).
 */
export async function activeAccess(db: Db, clientId: number, slug: string, now: Date) {
  const [row] = await db
    .select({ id: courseAccess.id, course: { id: courses.id, slug: courses.slug, title: courses.title }, expiresAt: courseAccess.expiresAt })
    .from(courseAccess)
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(and(eq(courseAccess.clientId, clientId), eq(courses.slug, slug), isNull(courseAccess.revokedAt), gt(courseAccess.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * The terms text as stored, or null when there is none to accept: no page row, a page whose Estonian text is empty (the Estonian text is
 * the one the others fall back to), or a stored body that is not an { et, ru? } of strings (the column is jsonb, so a row written by hand
 * or an old one can hold anything): never an error for the student, who then has nothing to accept.
 */
export function termsText(body: unknown): I18n | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { et, ru } = body as { et?: unknown; ru?: unknown };
  if (typeof et !== "string" || !et.trim()) return null;
  if (ru !== undefined && ru !== null && typeof ru !== "string") return null;
  return ru === undefined || ru === null ? { et } : { et, ru };
}

/**
 * The terms notice of an e-course for this client: the current version, whether nothing is left to accept, and while something is, the gate's
 * contract (GateTerms). The version is read BEFORE the text (see loadEcourse): the contract's text is read after it, so a save of Maria's in
 * between pairs the old version with the new text, which acceptTerms refuses as stale. Accepted: an acceptance of that version, or a current
 * contract of her access to the course of that version (contracts, D1: the cart's box, frozen when the purchase was paid, is the acceptance; she
 * is not asked twice), or no text at all.
 */
export async function termsState(db: Db, clientId: number, courseId: number): Promise<EcourseView["terms"]> {
  const versionThenText = async () => {
    const current = await courseTermsVersion(db);
    return [current, await db.select({ body: pages.body }).from(pages).where(eq(pages.key, TERMS_PAGE_KEY)).limit(1)] as const;
  };
  const [[version, page], accepted, contracted] = await Promise.all([
    versionThenText(),
    db.select({ version: termsAcceptances.termsVersion }).from(termsAcceptances).where(and(eq(termsAcceptances.clientId, clientId), eq(termsAcceptances.courseId, courseId))),
    db
      .select({ version: contracts.version })
      .from(contracts)
      .innerJoin(courseAccess, eq(contracts.accessId, courseAccess.id))
      .where(and(eq(courseAccess.clientId, clientId), eq(courseAccess.courseId, courseId), isNull(contracts.supersededAt))),
  ]);
  const text = termsText(page[0]?.body);
  if (text === null || accepted.some((row) => row.version === version) || contracted.some((row) => row.version === version)) return { version, accepted: true, text: null };
  // (no access row any more, gone between the reads: still not accepted, never open for lack of a text; accepting then finds no access)
  const none = { title: "", body: "" };
  return { version, accepted: false, ...((await gateContract(db, clientId, courseId)) ?? { text: { et: none, ru: none }, askName: null }) };
}

/**
 * The terms gate's contract (rulings R18, R19; GateTerms): in each page language the e-course template acceptTerms freezes there
 * (contracts.ts contractTemplates: one read of the text), filled with the access's fields as contractForAccess fills it via "terms"
 * (accessContractFields: her account's name and address, the course, no price), and, while her account has no name, the template and the values
 * the gate fills {nimi} from as she types. null: no access row.
 */
async function gateContract(db: Db, clientId: number, courseId: number): Promise<Pick<GateTerms, "text" | "askName"> | null> {
  const [[access], templates] = await Promise.all([
    db.select({ id: courseAccess.id }).from(courseAccess).where(and(eq(courseAccess.clientId, clientId), eq(courseAccess.courseId, courseId))).limit(1),
    contractTemplates(db, "ecourse"),
  ]);
  if (!access) return null;
  const parts = async (l: "et" | "ru") => {
    const template = templates[l];
    const fields = await accessContractFields(db, access.id, null, template.locale);
    if (!fields) return null;
    // a name of blanks is no name: the gate asks for one, and until she types it {nimi} is empty
    const values = contractValues(fields, "");
    return { template: { title: template.title, body: template.body }, values: values.nimi.trim() ? values : { ...values, nimi: "" } };
  };
  const [et, ru] = await Promise.all([parts("et"), parts("ru")]);
  if (!et || !ru) return null;
  const filled = ({ template, values }: { template: GateText; values: ContractValues }): GateText => ({ title: fillContract(template.title, values), body: fillContract(template.body, values) });
  return { text: { et: filled(et), ru: filled(ru) }, askName: et.values.nimi === "" ? { et, ru } : null };
}

/**
 * completeIfDone for the student's page load: a check that fails is logged by the access's id and the page shows as it was (false), so a
 * read never fails for the sake of a heal; the next load tries again.
 */
async function completeOnLoad(db: Db, accessId: number, now: Date): Promise<boolean> {
  try {
    return await completeIfDone(db, accessId, now);
  } catch (e) {
    logFailure(`[completion] access ${accessId}: the check failed`, e); // ids only
    return false;
  }
}

/**
 * The e-course page's data: null without active access (none, revoked or expired: the access row is read in any state,
 * server/completion.ts accessFor, and must be active, isActive), with its modules, the visible lessons and their states, the counts, and
 * the path's steps ("Lõpetamine", e-course completion). The terms notice shows while `terms.accepted` is false;
 * the page then sends back `terms.version` with the acceptance. The version is read BEFORE the text: an admin save that lands
 * in between then pairs the old version with the new text (the next visit shows the notice again), never a new version with
 * text the student did not see. The client's acceptances are read alongside. Once the course is completed, its certificate and her
 * account's name are read for the "Tunnistus" row (phase 3d); before, nothing is read for it.
 *
 * `onCompleted` is given by the student's own page (account-api.ts) and by nobody else (Maria's read-only view only reads): the load then
 * completes an access whose steps are all done and `completed_at` is still null (completeIfDone, before the steps are read: the view shows
 * it done), and calls `onCompleted(accessId)` once, for the call that set it, so the handler queues the "completed" mail. It heals the
 * accesses whose steps were done before the completion existed, and a check that failed once after a lesson write.
 */
export async function loadEcourse(db: Db, clientId: number, slug: string, now: Date, onCompleted?: (accessId: number) => void): Promise<EcourseView | null> {
  let access = await accessFor(db, clientId, slug);
  if (!access || !isActive(access, now)) return null;
  if (onCompleted && access.completedAt === null && (await completeOnLoad(db, access.id, now))) {
    access = { ...access, completedAt: now };
    onCompleted(access.id);
  }
  const completed = access.completedAt !== null;
  const [terms, outline, steps, sent, certificate, certificateName] = await Promise.all([
    termsState(db, clientId, access.course.id),
    courseOutline(db, access.course.id, clientId),
    loadSteps(db, access),
    // a notes-only protocol of this access that Maria has sent (only read for a course without points, but one small read either way)
    db.select({ id: protocols.id }).from(protocols).where(and(eq(protocols.accessId, access.id), isNotNull(protocols.sentAt))).limit(1),
    // "Tunnistus" (phase 3d): only a completed course has the row
    completed ? certificateOfAccess(db, access.id) : null,
    completed ? db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1).then(([c]) => c?.name ?? "") : "",
  ]);
  return {
    course: { slug: access.course.slug, title: access.course.title, modules: outline.modules },
    access: { expiresAt: iso(access.expiresAt) },
    terms,
    progress: outline.progress,
    completion: { ...steps, protocolSent: steps.practical === null && sent.length > 0, certificate, certificateName },
  };
}

/**
 * Stores that the client accepted the terms `version` for the e-course, and freezes the access's contract with it (contracts, D1, §4: the
 * gate's box is the acceptance, `terms`): the current e-course text in `opts.locale` (the language of the page she accepted it on; her account's
 * without it, D6), filled with her account's name and address and the course, no price. Both in one transaction, the access row's lock taken
 * first (completion.ts lockAccess; contractForAccess takes it again), after the address lock when her account has no name (below); a contract of
 * this version she has already (an acceptance before, the purchase's) makes no second one.
 * `opts.onContract` is told the contract it froze (none when it made none), so the caller mails it.
 *
 * An account with no name (empty after trimming; ruling R19) gives hers here: `opts.name`, the gate's field „Nimi“, taken on one line and within
 * Minu andmed's limit (account-input.ts gateName). It is the contract's {nimi} and its student's name in „Pooled“ (what the gate filled as she
 * typed), and it is saved as her account's name in the same transaction, under the access's lock, only while that is still empty: a name she
 * saved in Minu andmed meanwhile is never overwritten. An account with a name sends none, and one sent anyway is ignored.
 * - `"noAccess"`: no active access to that course (nothing is stored).
 * - `"stale"`: `version` is not the current terms version (the admin saved new terms after the page was loaded; nothing is stored), or there is no
 *   terms text any more (nothing to accept: nothing is stored, and the page, loaded again, finds the course open). The version is read again
 *   after the text the contract freezes: a save that lands in between is stale too, so a contract never holds a text the page did not show.
 * - `"name"`: her account has no name and `opts.name` gives none (missing, blank, too long, or text the database cannot hold): nothing is stored.
 * - `"accepted"`: stored (accepting twice is fine).
 */
export async function acceptTerms(
  db: Db,
  clientId: number,
  slug: string,
  version: string,
  now: Date,
  opts: { locale?: "et" | "ru"; name?: string; onContract?: (contract: Contract) => void } = {},
): Promise<"accepted" | "noAccess" | "stale" | "name"> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return "noAccess";
  if (version !== (await courseTermsVersion(db))) return "stale";
  const [page] = await db.select({ body: pages.body }).from(pages).where(eq(pages.key, TERMS_PAGE_KEY)).limit(1);
  if (termsText(page?.body) === null) return "stale";
  const locale = opts.locale ?? (await clientLocale(db, clientId));
  const done = await db.transaction(async (tx): Promise<{ result: "accepted" | "noAccess" | "stale" | "name"; contract: Contract | null }> => {
    const t = tx as unknown as Db;
    const [client] = await tx.select({ name: clients.name, email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) return { result: "noAccess", contract: null };
    const nameless = client.name.trim() === "";
    // R19: the account's name is written below, so the address lock comes first, before the access row: the order of settle's grant and of the
    // account's deletion, which write the client and her access under it (contracts.ts, the locks). An account with a name writes no name.
    if (nameless) await lockAddress(t, normalizeEmail(client.email));
    // the access's row lock, held from here: the name is saved under it (contractForAccess takes it again, at no cost)
    if (!(await lockAccess(t, access.id))) return { result: "noAccess", contract: null };
    // the text she accepts: its version is read before it (contractTemplate), and again after it (a save between the two: stale)
    const template = await contractTemplate(tx, "ecourse", locale);
    if (template.version !== version || (await courseTermsVersion(tx)) !== version) return { result: "stale", contract: null };
    const name = nameless ? gateName(opts.name) : null;
    if (nameless && !name) return { result: "name", contract: null };
    const found = await accessContractFields(tx, access.id, null, template.locale);
    if (!found) return { result: "noAccess", contract: null };
    let fields = found;
    if (name) {
      // saved only while the account's name is still empty (never over one she saved in Minu andmed meanwhile); the contract names her as she typed
      await tx.update(clients).set({ name }).where(and(eq(clients.id, clientId), sql`btrim(${clients.name}) = ''`));
      fields = { ...found, student: { ...found.student, name } };
    }
    const contract = await contractForAccess(tx, { accessId: access.id, clientId, courseId: access.course.id, snapshotOrTemplate: template, fields, via: "terms", now });
    await tx.insert(termsAcceptances).values({ clientId, courseId: access.course.id, termsVersion: version, acceptedAt: now }).onConflictDoNothing();
    return { result: "accepted", contract };
  });
  if (done.contract) opts.onContract?.(done.contract);
  return done.result;
}

/** The account's language (D6: the contract's when the page's is not known), Estonian for none. */
async function clientLocale(db: Db, clientId: number): Promise<"et" | "ru"> {
  const [row] = await db.select({ locale: clients.locale }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return row?.locale === "ru" ? "ru" : "et";
}

// ---------- the contract Maria asked her to confirm ----------

/**
 * Her registration `registrationId` that Maria has asked her to confirm the contract of (contracts, D4): hers by the live link
 * (`registrations.client_id`, ruling R14), a group registration, not cancelled. `"gone"`: it is not that (another's, an individual or an unknown
 * one, a cancelled one); `"nothing"`: it is, and Maria's ask is not open (`contract_requested_at` is null: never asked, or answered). `lock`
 * reads it FOR UPDATE, the first lock of „Kinnitan“ (ruling R3), so the ask is read as the lock gives it: a second tap that waited for the first
 * finds it answered.
 */
async function askedRegistration(q: Q, clientId: number, registrationId: number, lock: boolean): Promise<{ courseId: number } | "gone" | "nothing"> {
  const query = q
    .select({ kind: registrations.kind, status: registrations.status, courseId: registrations.courseId, askedAt: registrations.contractRequestedAt })
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId)));
  const [r] = lock ? await query.for("update") : await query;
  if (!r || r.kind !== "group" || r.status === "cancelled") return "gone";
  return r.askedAt === null ? "nothing" : { courseId: r.courseId };
}

/** The text „Kinnita leping“ shows: the current contact contract filled with her registration, in the language it is in, and its version. */
export type ContractToAccept = { title: string; body: string; version: string; locale: "et" | "ru" };

/**
 * GET /api/konto/leping-tekst/<registrationId>: the current contract text of her registration, filled as „Kinnitan“ will freeze it (the same
 * template and fields, contracts.ts registrationContractFields), for the page's language `pageLocale` (D6: Russian when the page is Russian and a
 * Russian text exists, else Estonian; `locale` of the answer is the language the text is in). With no `pageLocale` it is her account's, the very
 * fallback acceptContract takes, so the text shown and the text frozen are always in one language (the version is one per kind, not per language).
 * null unless Maria's ask is open on her own, not cancelled, group registration (askedRegistration): nothing else is shown, and not another's.
 */
export async function contractToAccept(db: Db, clientId: number, registrationId: number, pageLocale?: "et" | "ru"): Promise<ContractToAccept | null> {
  if (typeof (await askedRegistration(db, clientId, registrationId, false)) === "string") return null;
  const locale = pageLocale ?? (await clientLocale(db, clientId));
  const made = await registrationContractFields(db, registrationId, locale);
  if (!made) return null;
  const values = contractValues(made.fields, made.prepaymentText);
  return { title: fillContract(made.template.title, values), body: fillContract(made.template.body, values), version: made.template.version, locale: made.template.locale };
}

/**
 * POST /api/konto/leping, „Kinnitan“ (contracts, D4; ruling R3): she accepts the current contract text of a registration Maria asked her to
 * confirm, `via: "account"`. All in ONE transaction, the registration's row lock first (askedRegistration, FOR UPDATE; contractForRegistration
 * takes the same lock again), the ask read inside it: the new contract supersedes the old one, `contract_requested_at` is cleared with it
 * (contractForRegistration), and a failure of any part undoes all of it. The text is the current one in `input.locale` (the language of the page
 * she accepts it on, D6; her account's without it), read with its version first.
 * - `"notFound"`: not her registration, not a group one, cancelled, or gone (nothing is written).
 * - `"nothing"`: there is no open ask — never made, or answered already (a second tap, another device): nothing is written, no second contract.
 * - `"stale"`: `input.version` is not the current text's (Maria saved a new text after the page was loaded, or the page sent none; ruling R6, as
 *   acceptTerms): nothing is written, and the page reads the text again.
 * - `"accepted"`: done. `opts.onContract` is told the new contract after the commit, so the caller mails it.
 */
export async function acceptContract(
  db: Db,
  clientId: number,
  input: { registrationId: number; version?: string; locale?: "et" | "ru" },
  now: Date,
  opts: { onContract?: (contract: Contract) => void } = {},
): Promise<"accepted" | "notFound" | "nothing" | "stale"> {
  const locale = input.locale ?? (await clientLocale(db, clientId));
  const done = await db.transaction(async (tx): Promise<{ result: "accepted" | "notFound" | "nothing" | "stale"; contract: Contract | null }> => {
    const asked = await askedRegistration(tx, clientId, input.registrationId, true);
    if (asked === "gone") return { result: "notFound", contract: null };
    if (asked === "nothing") return { result: "nothing", contract: null };
    const made = await registrationContractFields(tx, input.registrationId, locale);
    if (!made) return { result: "notFound", contract: null };
    // the version she saw is the current one now, read before the text and again after it (shownVersionHolds); a missing version is a mismatch
    if (!(await shownVersionHolds(tx, "contact", locale, made.template, input.version))) return { result: "stale", contract: null };
    const contract = await contractForRegistration(tx, {
      registrationId: input.registrationId,
      clientId,
      courseId: asked.courseId,
      template: made.template,
      fields: made.fields,
      prepaymentText: made.prepaymentText,
      via: "account",
      now,
    });
    return { result: "accepted", contract };
  });
  if (done.contract) opts.onContract?.(done.contract);
  return done.result;
}

// ---------- favourites ----------

/** The client's favourites that are published courses, newest first. */
export async function favouriteSlugs(db: Db, clientId: number): Promise<string[]> {
  const rows = await db
    .select({ slug: courses.slug })
    .from(clientFavourites)
    .innerJoin(courses, eq(clientFavourites.courseId, courses.id))
    .where(and(eq(clientFavourites.clientId, clientId), eq(courses.published, true)))
    .orderBy(desc(clientFavourites.createdAt), courses.sort, courses.id);
  return rows.map((r) => r.slug);
}

/** One course of the Lemmikud tab: its slug (what ♡ sends) and the public catalogue's card for it, in the page's language. */
export type FavouriteCard = { slug: string; card: CourseCardData };

/** The Lemmikud tab: the cards, newest favourite first, and their slugs (`favourites`, as every favourites answer has them). */
export type FavouriteCards = { favourites: string[]; cards: FavouriteCard[] };

/**
 * The client's published favourites as the catalogue shows them (components/site/course-card-data.ts: photo, badge, chips, the next
 * date and city or "Veebis · alusta kohe", the price), from the catalogue's own queries narrowed to these courses. In `locale`, with
 * links to that language's course pages. The cards are built here, per request and per client, never cached: the Lemmikud page
 * itself is the static shell.
 */
export async function loadFavouriteCards(db: Db, clientId: number, locale: Locale, now: Date): Promise<FavouriteCards> {
  const slugs = await favouriteSlugs(db, clientId);
  if (slugs.length === 0) return { favourites: [], cards: [] };
  const [list, sessions] = await Promise.all([listPublishedCourses(db, { slugs }), listUpcomingSessions(db, upcomingFrom(now), { slugs })]);
  const next = nextSessionByCourse(sessions);
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const bySlug = new Map(list.map((c) => [c.slug, c]));
  const cards = slugs.flatMap((slug) => {
    const course = bySlug.get(slug);
    return course ? [{ slug, card: courseCardData(course, next.get(course.id), locale, d, to) }] : [];
  });
  // a course unpublished between the two reads has no card: it is not listed either
  return { favourites: cards.map((c) => c.slug), cards };
}

/**
 * Hearts or un-hearts a course; the client's favourites afterwards. null when `on` names a course that does not exist or is not
 * published (taking a heart off any course is always fine).
 */
export async function setFavourite(db: Db, clientId: number, slug: string, on: boolean): Promise<string[] | null> {
  const [course] = await db.select({ id: courses.id, published: courses.published }).from(courses).where(eq(courses.slug, slug)).limit(1);
  if (on) {
    if (!course?.published) return null;
    await db.insert(clientFavourites).values({ clientId, courseId: course.id }).onConflictDoNothing();
  } else if (course) {
    await db.delete(clientFavourites).where(and(eq(clientFavourites.clientId, clientId), eq(clientFavourites.courseId, course.id)));
  }
  return favouriteSlugs(db, clientId);
}

/** Adds the browser's favourites to the account: unknown or unpublished slugs and ones already there are ignored. The favourites afterwards. */
export async function mergeFavourites(db: Db, clientId: number, slugs: string[]): Promise<string[]> {
  const wanted = [...new Set(slugs)];
  if (wanted.length) {
    const found = await db.select({ id: courses.id }).from(courses).where(and(inArray(courses.slug, wanted), eq(courses.published, true)));
    if (found.length) await db.insert(clientFavourites).values(found.map((c) => ({ clientId, courseId: c.id }))).onConflictDoNothing();
  }
  return favouriteSlugs(db, clientId);
}

// ---------- profile and newsletter ----------

/**
 * Saves the client's name, phone and language. false when the client is gone. A change of language moves her newsletter with it: the subscriber
 * rows linked to her account (`client_id`) take the new language, in the same transaction, so that a campaign reaches her in the language she
 * now reads the site in.
 */
export async function updateProfile(db: Db, clientId: number, profile: { name: string; phone: string; locale: "et" | "ru" }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ locale: clients.locale }).from(clients).where(eq(clients.id, clientId)).for("update");
    if (!before) return false;
    await tx.update(clients).set({ name: profile.name, phone: profile.phone, locale: profile.locale }).where(eq(clients.id, clientId));
    if (before.locale !== profile.locale) await tx.update(subscribers).set({ locale: profile.locale }).where(eq(subscribers.clientId, clientId));
    return true;
  });
}

/**
 * Newsletter on: the account's address becomes a confirmed subscriber (the login proved the address, so no confirmation mail), an
 * address already waiting for confirmation is confirmed now. Off: the subscriber row of the address is deleted. false when the client is gone.
 */
export async function setNewsletter(db: Db, clientId: number, on: boolean, now: Date): Promise<boolean> {
  const [client] = await db.select({ email: clients.email, locale: clients.locale }).from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return false;
  const address = normalizeEmail(client.email);
  const sameAddress = sql`lower(${subscribers.email}) = ${address}`;
  if (!on) {
    await db.delete(subscribers).where(sameAddress);
    return true;
  }
  const [existing] = await db.select({ id: subscribers.id, confirmedAt: subscribers.confirmedAt }).from(subscribers).where(sameAddress).limit(1);
  if (existing) {
    await db.update(subscribers).set({ clientId, confirmedAt: existing.confirmedAt ?? now }).where(eq(subscribers.id, existing.id));
  } else {
    await db.insert(subscribers).values({ email: address, locale: client.locale, token: newToken(), consentAt: now, confirmedAt: now, clientId }).onConflictDoNothing();
  }
  return true;
}

// ---------- change requests ----------

/** What Maria's message about a change request names (messages.ts changeRequestSummary). */
export type ChangeRequestInfo = {
  registrationId: number;
  course: string;
  session: { startsAt: Date; city: string; venue: string } | null;
  name: string;
  email: string;
  phone: string;
  locale: "et" | "ru";
};

/**
 * Records a wish to cancel or change the date of one of the client's registrations as a `change_request` for the admin's inbox. Nothing
 * on the registration changes. false (nothing stored) when the registration is not this client's, is cancelled, belongs to a training
 * that has begun or was called off (the card has no button then), or there is no such client.
 */
export async function createChangeRequest(
  db: Db,
  clientId: number,
  registrationId: number,
  kind: "cancel" | "change",
  message: string,
  now: Date,
): Promise<ChangeRequestInfo | false> {
  const [row] = await db
    .select({
      status: registrations.status,
      sessionStatus: courseSessions.status,
      name: registrations.name,
      phone: registrations.phone,
      title: courses.title,
      startsAt: courseSessions.startsAt,
      city: courseSessions.city,
      venue: courseSessions.venue,
      email: clients.email,
      clientName: clients.name,
      clientPhone: clients.phone,
      locale: clients.locale,
    })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .innerJoin(clients, eq(clients.id, registrations.clientId))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId)))
    .limit(1);
  if (!row || row.status === "cancelled" || row.sessionStatus === "cancelled") return false;
  if (row.startsAt && row.startsAt < upcomingFrom(now)) return false;
  await db.insert(requests).values({ kind: "change_request", payload: { registrationId, kind, message, email: row.email }, clientId });
  return {
    registrationId,
    course: row.title.et,
    session: row.startsAt ? { startsAt: row.startsAt, city: row.city ?? "", venue: row.venue ?? "" } : null,
    name: row.name || row.clientName,
    email: row.email,
    phone: row.phone || row.clientPhone,
    locale: row.locale,
  };
}

// ---------- deleting the account ----------

/**
 * Deletes the client with its sessions, favourites, terms acceptances and course access, the login codes and links still waiting for its
 * address (they are keyed by address, so no cascade reaches them; a live one would otherwise sign in again and re-create the account), and the
 * newsletter subscription of the address. Her protocols and her course feedback go too (phase protocols, spec §3): those of the registrations linked to her.
 * Her reviews (student reviews, D6) go with that feedback, by cascade. The slugs of their courses are listed first, each list read after the lock of its
 * registrations or accesses (so an answer committed while this waits is in it), so that the caller refreshes those courses' pages and the home page once
 * this has committed (account-api.ts deleteAccount).
 * Registrations and requests stay with Maria, their name and e-mail as given, only unlinked
 * (client_id null). Takes the address lock the logins take, so a login in flight finishes before this runs or finds nothing after it.
 * Then her registrations, FOR UPDATE, before their protocols and feedback: the order a send takes (the address, the registration, the protocol), so a send or a
 * feedback answer on one of them finishes first, or finds it no longer hers after.
 * Her e-course work (e-course completion, spec §3.5): the access rows, the attempts, the access protocols and their photo rows go by cascade.
 * Her access rows are locked first (the order a photo upload takes: the access, then its protocol), then her photo files are listed: an
 * upload in flight is either in the list or, after this commit, finds the access gone and removes its own files. The caller removes the
 * listed files from the store after the commit (account-api.ts deleteAccount).
 * Returns the address and language the confirmation mail goes to, the photo files to remove, and the slugs of the courses whose reviews went (sorted, once
 * each); null when the client was already gone.
 */
export async function deleteClient(db: Db, clientId: number): Promise<{ email: string; locale: "et" | "ru"; photoKeys: string[]; reviewCourses: string[] } | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!existing) return null;
    const address = normalizeEmail(existing.email);
    await lockAddress(tx as unknown as Db, address);
    // her protocols and feedback (phase protocols): the registrations themselves stay with Maria, unlinked below (ON DELETE SET NULL)
    const mine = (await tx.select({ id: registrations.id }).from(registrations).where(eq(registrations.clientId, clientId)).for("update")).map((r) => r.id);
    // the courses of her reviews on these registrations, before their feedback goes (and the reviews with it)
    const contactReviews = await reviewCourseSlugs(tx, { registrationIds: mine, accessIds: [] });
    if (mine.length > 0) {
      await tx.delete(protocols).where(inArray(protocols.registrationId, mine));
      await tx.delete(courseFeedback).where(inArray(courseFeedback.registrationId, mine));
    }
    // her practical work's photo files (e-course completion): listed under her access rows' lock, removed by the caller after the commit
    const accessIds = (await tx.select({ id: courseAccess.id }).from(courseAccess).where(eq(courseAccess.clientId, clientId)).for("update")).map((a) => a.id);
    // (the e-courses' reviews go with the clients row, by cascade: the access, its feedback, the review)
    const ecourseReviews = await reviewCourseSlugs(tx, { registrationIds: [], accessIds });
    const reviewCourses = [...new Set([...contactReviews, ...ecourseReviews])].sort();
    const photoKeys = await practicalKeys(tx as unknown as Db, clientId);
    const [row] = await tx.delete(clients).where(eq(clients.id, clientId)).returning(); // (returning(fields) has no common overload on the Db union)
    if (!row) return null;
    await tx.delete(clientLoginTokens).where(eq(clientLoginTokens.email, address));
    await tx.delete(subscribers).where(sql`lower(${subscribers.email}) = ${address}`);
    return { email: row.email, locale: row.locale, photoKeys, reviewCourses };
  });
}
