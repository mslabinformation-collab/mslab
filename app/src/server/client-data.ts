import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { CourseCardData } from "@/components/site/CourseCard";
import { courseCardData } from "@/components/site/course-card-data";
import type { Db } from "@/db/client";
import { listPublishedCourses, listUpcomingSessions, readSetting } from "@/db/queries/public";
import {
  clientFavourites, clientLoginTokens, clients, courseAccess, courses, courseSessions, pages, practicePackages, protocols, registrations, requests, subscribers,
  termsAcceptances,
} from "@/db/schema";
import { PREPAYMENT_KEY, parsePrepayment, resumeSlug, sortCards, type AccountCard, type EcourseCard, type PrepaymentInfo } from "@/domain/account-cards";
import { upcomingFrom } from "@/domain/calendar";
import { DEFAULT_TERMS_VERSION, TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { nextSessionByCourse } from "@/domain/home";
import type { CourseProgress } from "@/domain/lessons";
import { registrationPrice } from "@/domain/registration";
import { normalizeEmail } from "@/domain/email";
import type { I18n } from "@/i18n/field";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import { lockAddress } from "./client-auth";
import { courseOutline, ecourseProgress, progressActivity, type OutlineModule } from "./lesson-outline";
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
};

export type EcourseView = {
  course: { slug: string; title: I18n; modules: OutlineModule[] };
  access: { expiresAt: string };
  /**
   * `version`: the current terms version (send it back when accepting, so a student who saw the old text cannot accept a new one unseen).
   * `accepted`: nothing is left to accept: the client has accepted that version for this course, or there is no terms text (none stored,
   * or an empty one: nothing to read or agree to, so no notice and no acceptance recorded; when the admin saves a text, the version moves
   * and the notice shows). `text`: the terms text, only while `accepted` is false (so never null then).
   */
  terms: { version: string; accepted: boolean; text: I18n | null };
  /** "5 / 24 õppetundi tehtud" and where "Jätka" goes (domain/lessons.ts courseProgress). */
  progress: CourseProgress;
};

const iso = (d: Date): string => d.toISOString();

/** The version of the e-course terms: the settings key `courseTermsVersion` (an ISO time, set when the admin saves the terms text), "1" until then. */
export async function courseTermsVersion(db: Db): Promise<string> {
  const value = await readSetting(db, TERMS_VERSION_KEY);
  return typeof value === "string" && value.trim() ? value : DEFAULT_TERMS_VERSION;
}

// ---------- the dashboard ----------

/**
 * Six small queries, run together: registrations (with session and course), requests, e-course access, favourites, the client, the prepayment setting;
 * then, for each open e-course, its lessons (two queries each) and her last lesson activity (one query), for the cards' progress and the
 * "Pooleli" card (`resume`).
 */
export async function loadDashboard(db: Db, clientId: number, now: Date): Promise<Dashboard | null> {
  const [regRows, requestRows, accessRows, favourites, [client], prepayment] = await Promise.all([
    db
      .select({
        id: registrations.id,
        status: registrations.status,
        kind: registrations.kind,
        paymentChoice: registrations.paymentChoice,
        paidCents: registrations.paidCents,
        preferredPeriod: registrations.preferredPeriod,
        createdAt: registrations.createdAt,
        course: { slug: courses.slug, title: courses.title, type: courses.type, price: courses.price, priceGroup: courses.priceGroup, priceIndividual: courses.priceIndividual },
        startsAt: courseSessions.startsAt,
        city: courseSessions.city,
        venue: courseSessions.venue,
        sessionStatus: courseSessions.status,
        protocolSentAt: protocols.sentAt,
      })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
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
      .select({ courseId: courseAccess.courseId, grantedAt: courseAccess.grantedAt, expiresAt: courseAccess.expiresAt, revokedAt: courseAccess.revokedAt, slug: courses.slug, title: courses.title })
      .from(courseAccess)
      .innerJoin(courses, eq(courseAccess.courseId, courses.id))
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
  ]);
  if (!client) return null;

  const cards: AccountCard[] = [];
  for (const r of regRows) {
    const course = { slug: r.course.slug, title: r.course.title };
    if (r.startsAt === null) {
      cards.push({
        kind: "individual",
        registrationId: r.id,
        course,
        status: r.status,
        preferredPeriod: r.preferredPeriod,
        createdAt: iso(r.createdAt),
        ...(r.protocolSentAt ? { protocolSent: true } : {}),
      });
    } else {
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
      });
    }
  }
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
    const card: EcourseCard = { kind: "ecourse", course: { slug: a.slug, title: a.title }, grantedAt: iso(a.grantedAt), expiresAt: iso(a.expiresAt), revoked: a.revokedAt !== null };
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
  };
}

// ---------- an e-course ----------

/**
 * The e-course the client has access to right now (not revoked, not expired), or null. Whether the course is still published does not
 * matter: access is granted to the client and stays until it ends; only the favourites are limited to published courses.
 * Also the lesson endpoints' first check (lesson-data.ts).
 */
export async function activeAccess(db: Db, clientId: number, slug: string, now: Date) {
  const [row] = await db
    .select({ course: { id: courses.id, slug: courses.slug, title: courses.title }, expiresAt: courseAccess.expiresAt })
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
 * The terms notice of an e-course for this client: the current version, whether nothing is left to accept, and the text while
 * something is. The version is read BEFORE the text (see loadEcourse).
 */
export async function termsState(db: Db, clientId: number, courseId: number): Promise<EcourseView["terms"]> {
  const versionThenText = async () => {
    const current = await courseTermsVersion(db);
    return [current, await db.select({ body: pages.body }).from(pages).where(eq(pages.key, TERMS_PAGE_KEY)).limit(1)] as const;
  };
  const [[version, page], accepted] = await Promise.all([
    versionThenText(),
    db.select({ version: termsAcceptances.termsVersion }).from(termsAcceptances).where(and(eq(termsAcceptances.clientId, clientId), eq(termsAcceptances.courseId, courseId))),
  ]);
  const text = termsText(page[0]?.body);
  const isAccepted = text === null || accepted.some((row) => row.version === version);
  return { version, accepted: isAccepted, text: isAccepted ? null : text };
}

/**
 * The e-course page's data: null without active access (none, revoked or expired), with its modules, the visible lessons and their
 * states, and the counts. The terms notice shows while `terms.accepted` is false;
 * the page then sends back `terms.version` with the acceptance. The version is read BEFORE the text: an admin save that lands
 * in between then pairs the old version with the new text (the next visit shows the notice again), never a new version with
 * text the student did not see. The client's acceptances are read alongside.
 */
export async function loadEcourse(db: Db, clientId: number, slug: string, now: Date): Promise<EcourseView | null> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return null;
  const [terms, outline] = await Promise.all([termsState(db, clientId, access.course.id), courseOutline(db, access.course.id, clientId)]);
  return {
    course: { slug: access.course.slug, title: access.course.title, modules: outline.modules },
    access: { expiresAt: iso(access.expiresAt) },
    terms,
    progress: outline.progress,
  };
}

/**
 * Stores that the client accepted the terms `version` for the e-course.
 * - `"noAccess"`: no active access to that course (nothing is stored).
 * - `"stale"`: `version` is not the current terms version (the admin saved new terms after the page was loaded; nothing is stored), or there is no
 *   terms text any more (nothing to accept: nothing is stored, and the page, loaded again, finds the course open).
 * - `"accepted"`: stored (accepting twice is fine).
 */
export async function acceptTerms(db: Db, clientId: number, slug: string, version: string, now: Date): Promise<"accepted" | "noAccess" | "stale"> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return "noAccess";
  if (version !== (await courseTermsVersion(db))) return "stale";
  const [page] = await db.select({ body: pages.body }).from(pages).where(eq(pages.key, TERMS_PAGE_KEY)).limit(1);
  if (termsText(page?.body) === null) return "stale";
  await db.insert(termsAcceptances).values({ clientId, courseId: access.course.id, termsVersion: version, acceptedAt: now }).onConflictDoNothing();
  return "accepted";
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

/** Saves the client's name, phone and language. false when the client is gone. */
export async function updateProfile(db: Db, clientId: number, profile: { name: string; phone: string; locale: "et" | "ru" }): Promise<boolean> {
  const rows = await db.update(clients).set({ name: profile.name, phone: profile.phone, locale: profile.locale }).where(eq(clients.id, clientId)).returning();
  return rows.length > 0;
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
 * newsletter subscription of the address. Registrations and requests stay with Maria, their name and e-mail as given, only unlinked
 * (client_id null). Takes the address lock the logins take, so a login in flight finishes before this runs or finds nothing after it.
 * Returns the address and language the confirmation mail goes to; null when the client was already gone.
 */
export async function deleteClient(db: Db, clientId: number): Promise<{ email: string; locale: "et" | "ru" } | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!existing) return null;
    const address = normalizeEmail(existing.email);
    await lockAddress(tx as unknown as Db, address);
    const [row] = await tx.delete(clients).where(eq(clients.id, clientId)).returning(); // (returning(fields) has no common overload on the Db union)
    if (!row) return null;
    await tx.delete(clientLoginTokens).where(eq(clientLoginTokens.email, address));
    await tx.delete(subscribers).where(sql`lower(${subscribers.email}) = ${address}`);
    return { email: row.email, locale: row.locale };
  });
}
