import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { contractView, type ContractView } from "@/components/admin/contract-view";
import type { Db } from "@/db/client";
import { listRegistrations, paged, type Paged, type RegistrationRow } from "@/db/queries/admin";
import { clientNameSql } from "@/db/queries/client-name";
import { listPaymentsOf, type PaymentRow } from "@/db/queries/payments";
import { feedbackOf, type FeedbackRow } from "@/db/queries/protocols";
import { certificates, clients, courseAccess, courses, lessonProgress, practicePackages, protocols, registrations, requests, testAttempts } from "@/db/schema";
import { accessState, defaultExpiryDate, endOfDayTallinn, extendByMonths, grantExpiry, isExtension, type AccessState } from "@/domain/client-access";
import { percentOf, type CourseSteps } from "@/domain/completion";
import { isEmail, normalizeEmail } from "@/domain/email";
import { containsPattern, PAGE_SIZE, parsePage, parseSearch } from "@/domain/paging";
import type { ReviewStatus } from "@/domain/review";
import { registrationHeading } from "@/domain/registration-card";
import { phoneQuery } from "@/domain/search";
import { pick, type I18n } from "@/i18n/field";
import { getDict } from "@/i18n/locales";
import { parseRowId } from "@/lib/row-id";
import { linkClientRecords, lockAddress } from "./client-auth";
import { viewOf, type CertificateView } from "./certificates";
import { loadSteps } from "./completion";
import { contractsOfClient } from "./contracts";
import { field } from "./edit-check";
import { courseOutline } from "./lesson-outline";
import { newsletterState, type NewsletterState } from "./newsletter";
import { reviewsOfFeedback } from "./reviews";

// The admin's Õpilased (students): the list, one student's drawer, adding a student by e-mail, and e-course access
// ("Ava ligipääs" / "Lõpeta ligipääs"). Callers have already checked the admin session (server/actions/admin-clients.ts
// wraps each form in adminAction; the pages call requireAdmin); these take a Db and run without Next.js
// (tests/db/admin-clients.test.ts).
//
// A student's NAME as the admin sees it: the name in the account (Minu andmed), or else the name on her latest
// registration (most students never fill in Minu andmed), or nothing. Her number of COURSES: her registrations that are
// not cancelled plus her e-course accesses that an admin has not ended (one that ran out still counts: she took that
// course). Her drawer lists them all, cancelled and ended ones too.

export type ClientFilter = "all" | "e" | "k";
export type ClientListRow = { id: number; email: string; name: string; createdAt: Date; courses: number };

// Written out with the table's name: in a single-table query Drizzle prints a column without its table, which inside these
// subqueries would be the subquery's own column (registrations.id, not the client's).
// (NAME is db/queries/client-name.ts clientNameSql with no fallback; Hindamine's queries give the address.)
const NAME = clientNameSql(sql`''`);
const COURSES = sql<number>`((select count(*) from registrations r where r.client_id = clients.id and r.status <> 'cancelled') + (select count(*) from course_access a where a.client_id = clients.id and a.revoked_at is null))::int`;
const HAS_ACCESS = sql`exists (select 1 from course_access a where a.client_id = clients.id)`;
const HAS_CONTACT = sql`exists (select 1 from registrations r join courses c on c.id = r.course_id where r.client_id = clients.id and c.type = 'contact')`;

/**
 * The search of the list (B7): the e-mail or the name holds the text (ILIKE, `%` `_` `\` escaped: containsPattern), or the phone's digits hold the
 * text's digits (domain/search.ts: from 3 digits, so „+372 5123 4567“ finds a number stored as „51234567“ or „5123-4567“).
 */
function searchOf(q: string) {
  if (!q) return undefined;
  const text = containsPattern(q);
  const phone = phoneQuery(q);
  return or(
    sql`clients.email ilike ${text}`,
    sql`${NAME} ilike ${text}`,
    phone ? sql`regexp_replace(clients.phone, '[^0-9]', '', 'g') like ${phone}` : undefined,
  );
}

function clientWhere(filter: ClientFilter, q: string) {
  return and(filter === "e" ? HAS_ACCESS : filter === "k" ? HAS_CONTACT : undefined, searchOf(q));
}

/** The counts on the list's form pills (README A5): everybody, those with an e-course access, those with a registration on a contact course — all under the search `q`, whichever form is chosen. */
export type ClientCounts = { all: number; e: number; k: number };

export async function clientCounts(db: Db, q: string): Promise<ClientCounts> {
  const [row] = await db
    .select({ all: sql<number>`count(*)::int`, e: sql<number>`(count(*) filter (where ${HAS_ACCESS}))::int`, k: sql<number>`(count(*) filter (where ${HAS_CONTACT}))::int` })
    .from(clients)
    .where(searchOf(q));
  return { all: Number(row.all), e: Number(row.e), k: Number(row.k) };
}

/**
 * Where the drawer of a student just added opens (README A5: „Lisa õpilane“ keeps the list it was added from): the list's own address `back`
 * (`vorm`, `otsi`, `leht` — the form, the search and the page; anything else in it is dropped) with the student's `id`, in the order the page writes them.
 */
export function openStudentHref(back: string | null | undefined, id: number): string {
  const from = new URLSearchParams(back ?? "");
  const q = new URLSearchParams();
  const vorm = from.get("vorm");
  if (vorm === "e" || vorm === "k") q.set("vorm", vorm);
  const otsi = parseSearch(from.get("otsi") ?? undefined);
  if (otsi) q.set("otsi", otsi);
  const leht = parsePage(from.get("leht") ?? undefined);
  if (leht > 1) q.set("leht", String(leht));
  q.set("id", String(id));
  return `/admin/opilased?${q.toString()}`;
}

/**
 * One page of the students, newest first. `filter`: "e" those with any e-course access, "k" those with a registration on
 * a contact course, "all" everybody. `q`: a part of the name or the e-mail, any case, taken literally.
 */
export async function listClients(db: Db, opts: { filter: ClientFilter; q: string; page: number }, size: number = PAGE_SIZE): Promise<Paged<ClientListRow>> {
  const where = clientWhere(opts.filter, opts.q);
  return paged(
    opts.page,
    size,
    async () => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(clients).where(where);
      return Number(n);
    },
    (range) =>
      db
        .select({ id: clients.id, email: clients.email, name: NAME, createdAt: clients.createdAt, courses: COURSES })
        .from(clients)
        .where(where)
        .orderBy(desc(clients.createdAt), desc(clients.id))
        .limit(range.limit)
        .offset(range.offset),
  );
}

// ---------- one student ----------

export type ClientAccessRow = {
  id: number;
  courseId: number;
  title: I18n;
  slug: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** The day the course was completed (never cleared, also when the access ended or ran out): „Läbitud {date}“. */
  completedAt: Date | null;
  state: AccessState;
  /** Her lessons of this e-course: done of total (hidden lessons not counted), as the course page counts them. */
  progress: { done: number; total: number };
  /** The first lesson she cannot open yet ("Ava järgmine õppetund"), or null when none is locked. */
  nextLocked: { id: number; title: I18n } | null;
  /** Her steps of the e-course (e-course completion, spec §5.5): lessons, test, practical work, completion — as her own page shows them. */
  steps: CourseSteps;
  /** The protocol of this access (her practical work and Maria's notes), or null before its first save or photo ("Lisa protokoll"). */
  protocolId: number | null;
  /**
   * Her newest test attempt's score (rounded down; the step line's "(85 %)"), or null before her first attempt and for an attempt without choice
   * questions (only open answers: no score to show, where percentOf would say 100 before Maria has read anything).
   */
  testPercent: number | null;
  /** She has made an attempt at the course's test ("Testi katsed"). */
  hasAttempts: boolean;
  /** Her newest test attempt whose open answers wait for Maria's review (/admin/hindamine/test?id=), or null: „Hinda“. */
  waitingAttemptId: number | null;
  /**
   * Her certificate of this e-course (phase 3d, spec §6), or null before she has confirmed her name; `revoked`: an admin ended the access, so
   * she can no longer download it (Maria still can, Review Focus 5).
   */
  certificate: (CertificateView & { revoked: boolean }) | null;
};
/** One of her registrations in the drawer: a contact course's carries its course day's protocol ("Lisa protokoll" / "Ava protokoll", spec §5.5). */
export type ClientRegistrationRow = RegistrationRow & { protocolId: number | null; contact: boolean };
/**
 * One of her requests as Päringud names it: `interest` (a contact request from the e-learning cart: "E-õppe huvi"), `wish`
 * (a change request: cancel or change), and `subject`: what it is about, in Estonian — the course (individual, waitlist,
 * e-learning interest), the practice package, or the registration a change request is about ("Kulmude lamineerimine —
 * 14.11.2026 · 10:00"); null for a plain message.
 */
export type ClientRequestRow = {
  id: number;
  kind: (typeof requests.$inferSelect)["kind"];
  handled: boolean;
  createdAt: Date;
  interest: boolean;
  wish: "cancel" | "change" | null;
  subject: string | null;
};
/**
 * One of her answers to the course feedback form with what became of her permission to publish it (student reviews, Task 4): `review` is the review it
 * gave rise to — its status and whether it is on the home page — or null when she did not allow publishing (it never became a review).
 */
export type ClientFeedbackRow = FeedbackRow & { review: { id: number; status: ReviewStatus; featured: boolean } | null };
export type ClientDetail = {
  client: { id: number; email: string; name: string; ownName: string; phone: string; locale: "et" | "ru"; createdAt: Date };
  registrations: ClientRegistrationRow[];
  requests: ClientRequestRow[];
  access: ClientAccessRow[];
  /** Her contracts (contracts Task 5), the contact course's and the e-course's, the newest acceptance first, the superseded ones too (the text itself is in the PDF). */
  contracts: ContractView[];
  /** Her address's newsletter (phase 2c): confirmed, waiting for its confirmation, or none. */
  newsletter: NewsletterState;
  /** Her online payments (phase 2b), newest first. */
  payments: PaymentRow[];
  /** Her answers to the course feedback form (phase protocols, spec §7; the e-courses' too), newest first, each with its review. */
  feedback: ClientFeedbackRow[];
};

/** A certificate row as the drawer shows it (server/certificates.ts viewOf), with whether an admin ended her access. */
const certificateView = (c: { id: number; number: string; name: string; issuedAt: Date; reissuedAt: Date | null } | undefined, revoked: boolean): ClientAccessRow["certificate"] =>
  c ? { ...viewOf(c), revoked } : null;

/** Everything the student's drawer shows, or null when there is no such student. Newest first in every list. */
export async function clientDetail(db: Db, id: number, now: Date = new Date()): Promise<ClientDetail | null> {
  const [[client], regs, reqs, access, contractRows, payments, feedback] = await Promise.all([
    db
      .select({ id: clients.id, email: clients.email, name: NAME, ownName: clients.name, phone: clients.phone, locale: clients.locale, createdAt: clients.createdAt })
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1),
    listRegistrations(db, { clientId: id }),
    db.select().from(requests).where(eq(requests.clientId, id)).orderBy(desc(requests.createdAt), desc(requests.id)),
    db
      .select({
        id: courseAccess.id,
        courseId: courseAccess.courseId,
        title: courses.title,
        slug: courses.slug,
        grantedBy: courseAccess.grantedBy,
        grantedAt: courseAccess.grantedAt,
        expiresAt: courseAccess.expiresAt,
        revokedAt: courseAccess.revokedAt,
        extraTries: courseAccess.extraTries,
        completedAt: courseAccess.completedAt,
      })
      .from(courseAccess)
      .innerJoin(courses, eq(courseAccess.courseId, courses.id))
      .where(eq(courseAccess.clientId, id))
      .orderBy(desc(courseAccess.grantedAt), desc(courseAccess.id)),
    contractsOfClient(db, id),
    listPaymentsOf(db, { clientId: id }),
    feedbackOf(db, { clientId: id }),
  ]);
  if (!client) return null;
  const [newsletter, reviewOf] = await Promise.all([newsletterState(db, client.email), reviewsOfFeedback(db, feedback.map((f) => f.id))]);
  // each e-course's lessons for her: done of total, and the first lesson she cannot open yet ("Ava järgmine õppetund"); and (e-course
  // completion, spec §5.5) each access's steps as her own page reads them, the protocols of her accesses and registrations, her attempts
  const [outlines, steps, accessProtocols, registrationProtocols, attempts, issued] = await Promise.all([
    Promise.all(access.map((a) => courseOutline(db, a.courseId, id))),
    Promise.all(
      access.map((a) =>
        loadSteps(db, { id: a.id, clientId: id, courseId: a.courseId, expiresAt: a.expiresAt, revokedAt: a.revokedAt, extraTries: a.extraTries, completedAt: a.completedAt }),
      ),
    ),
    access.length ? db.select({ id: protocols.id, accessId: protocols.accessId }).from(protocols).where(inArray(protocols.accessId, access.map((a) => a.id))) : [],
    regs.length ? db.select({ id: protocols.id, registrationId: protocols.registrationId }).from(protocols).where(inArray(protocols.registrationId, regs.map((r) => r.id))) : [],
    db
      .select({ id: testAttempts.id, courseId: testAttempts.courseId, number: testAttempts.number, correct: testAttempts.correct, total: testAttempts.total, status: testAttempts.status })
      .from(testAttempts)
      .where(eq(testAttempts.clientId, id)),
    // her certificates (phase 3d): at most one per access
    access.length
      ? db
          .select({ id: certificates.id, accessId: certificates.accessId, number: certificates.number, name: certificates.name, issuedAt: certificates.issuedAt, reissuedAt: certificates.reissuedAt })
          .from(certificates)
          .where(inArray(certificates.accessId, access.map((a) => a.id)))
      : [],
  ]);
  const accessProtocol = new Map(accessProtocols.map((p) => [p.accessId, p.id]));
  const registrationProtocol = new Map(registrationProtocols.map((p) => [p.registrationId, p.id]));
  const certificateOf = new Map(issued.map((c) => [c.accessId, c]));
  // her newest attempt at each course's test: its score is the step line's (none for an attempt of open answers only)
  const newest = new Map<number, { number: number; percent: number | null }>();
  for (const t of attempts) if ((newest.get(t.courseId)?.number ?? 0) < t.number) newest.set(t.courseId, { number: t.number, percent: t.total > 0 ? percentOf(t.correct, t.total) : null });
  // the newest attempt of each course whose open answers wait for Maria
  const waiting = new Map<number, { id: number; number: number }>();
  for (const t of attempts) if (t.status === "review" && (waiting.get(t.courseId)?.number ?? 0) < t.number) waiting.set(t.courseId, { id: t.id, number: t.number });
  return {
    client,
    registrations: regs.map((r) => ({ ...r, protocolId: registrationProtocol.get(r.id) ?? null, contact: r.course.type === "contact" })),
    requests: await requestRows(db, reqs),
    access: access.map((a, i) => {
      const locked = outlines[i].lessons.find((l) => l.state === "locked");
      return {
        ...a,
        state: accessState(a, now),
        progress: { done: outlines[i].progress.done, total: outlines[i].progress.total },
        nextLocked: locked ? { id: locked.id, title: locked.title } : null,
        steps: steps[i],
        protocolId: accessProtocol.get(a.id) ?? null,
        testPercent: newest.get(a.courseId)?.percent ?? null,
        hasAttempts: newest.has(a.courseId),
        waitingAttemptId: waiting.get(a.courseId)?.id ?? null,
        certificate: certificateView(certificateOf.get(a.id), a.revokedAt !== null),
      };
    }),
    contracts: contractRows.map(contractView),
    newsletter,
    payments,
    feedback: feedback.map((f) => ({ ...f, review: reviewOf.get(f.id) ?? null })),
  };
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const regId = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2_147_483_647 ? v : null);

/** Her requests with what each is about (the courses, packages and registrations they name, read in three small queries). */
async function requestRows(db: Db, rows: (typeof requests.$inferSelect)[]): Promise<ClientRequestRow[]> {
  const only = <T>(list: (T | null)[]) => [...new Set(list.filter((x): x is T => x !== null))];
  const slugs = only(rows.filter((r) => r.kind !== "practice").map((r) => text(r.payload.course)));
  const codes = only(rows.filter((r) => r.kind === "practice").map((r) => text(r.payload.package)));
  const regIds = only(rows.filter((r) => r.kind === "change_request").map((r) => regId(r.payload.registrationId)));
  const [titles, packages, regs] = await Promise.all([
    slugs.length ? db.select({ slug: courses.slug, title: courses.title }).from(courses).where(inArray(courses.slug, slugs)) : [],
    codes.length ? db.select({ code: practicePackages.code, name: practicePackages.name }).from(practicePackages).where(inArray(practicePackages.code, codes)) : [],
    regIds.length ? listRegistrations(db, { ids: regIds }) : [],
  ]);
  const title = new Map(titles.map((c) => [c.slug, pick(c.title, "et")]));
  // "Mini praktika (MINI)"; a package named by its code is just "MINI"
  const pkg = new Map(packages.map((p) => [p.code, pick(p.name, "et").trim().toUpperCase() === p.code ? p.code : `${pick(p.name, "et")} (${p.code})`]));
  const reg = new Map(regs.map((r) => [r.id, r]));
  const untitled = getDict("et").account.dashboard.untitled;
  return rows.map((r) => {
    const wish = r.kind === "change_request" && (r.payload.kind === "cancel" || r.payload.kind === "change") ? r.payload.kind : null;
    let subject: string | null = null;
    if (r.kind === "practice") {
      const code = text(r.payload.package);
      subject = code ? (pkg.get(code) ?? code) : null;
    } else if (r.kind === "change_request") {
      const id = regId(r.payload.registrationId);
      const registration = id ? reg.get(id) : undefined;
      if (registration) {
        const h = registrationHeading(registration, untitled);
        subject = [h.title, h.time].filter(Boolean).join(" — ");
      }
    } else {
      const slug = text(r.payload.course);
      subject = slug ? (title.get(slug) ?? slug) : null;
    }
    return { id: r.id, kind: r.kind, handled: r.handled, createdAt: r.createdAt, interest: r.kind === "contact" && r.payload.intent === "purchase", wish, subject };
  });
}

/** A name for the admin's headings and the "view as" banner: the student's name (as in the list), or her e-mail. */
export async function clientLabel(db: Db, id: number): Promise<string | null> {
  const [row] = await db.select({ email: clients.email, name: NAME }).from(clients).where(eq(clients.id, id)).limit(1);
  return row ? row.name.trim() || row.email : null;
}

/** A student's name for the read-only course view's banner (as clientLabel) and her language (the page's), or null. */
export async function clientViewInfo(db: Db, id: number): Promise<{ label: string; locale: "et" | "ru" } | null> {
  const [row] = await db.select({ email: clients.email, name: NAME, locale: clients.locale }).from(clients).where(eq(clients.id, id)).limit(1);
  return row ? { label: row.name.trim() || row.email, locale: row.locale } : null;
}

export type EcourseOption = { id: number; title: I18n; published: boolean; accessMonths: number | null; until: string };

/** The e-courses access can be granted to (drafts too: a course bought before it is published), in the public order, each with its default expiry date. */
export async function listEcourses(db: Db, now: Date = new Date()): Promise<EcourseOption[]> {
  const rows = await db
    .select({ id: courses.id, title: courses.title, published: courses.published, accessMonths: courses.accessMonths })
    .from(courses)
    .where(eq(courses.type, "e_learning"))
    .orderBy(asc(courses.sort), asc(courses.id));
  return rows.map((c) => ({ ...c, until: defaultExpiryDate(now, c.accessMonths) }));
}

// ---------- the forms ----------

/** What a Õpilased form gets back. `id`: the student added (or found). */
export type ClientResult = { ok: true; id?: number } | { ok: false; error: "invalid" | "email" | "notFound" | "course" | "date" | "server" };

const fail = (error: Exclude<ClientResult, { ok: true }>["error"]): ClientResult => ({ ok: false, error });
/** An id from a form field, read like every id this app reads from text (lib/row-id.ts): digits only, no zero in front ("1e3", " 7", "007", "0x10" are refused). */
const idSchema = z.string().transform((raw, ctx) => {
  const id = parseRowId(raw);
  if (id === null) ctx.issues.push({ code: "custom", message: "not a row id", input: raw });
  return id ?? z.NEVER;
});

/**
 * "Lisa õpilane": the student of this address, created when there is none (no session, no e-mail sent), so an e-course
 * can be opened for someone who has never logged in (bought by bank transfer). Under the address lock the logins take
 * (client-auth.ts lockAddress), so a login at the same moment cannot create her twice. A new student's language is the one
 * she last used with that address: of her newest registration or request (an e-course buyer often has only the cart's
 * purchase request), else Estonian. Her earlier registrations, requests and newsletter row are linked to her as a login
 * would link them. On her first login the login finds her (not new) and links anything newer.
 */
export async function addClient(db: Db, raw: string): Promise<{ ok: true; id: number; created: boolean } | { ok: false; error: "email" }> {
  const address = normalizeEmail(raw);
  if (!isEmail(address)) return { ok: false, error: "email" };
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockAddress(t, address);
    const [existing] = await t.select({ id: clients.id }).from(clients).where(eq(clients.email, address)).limit(1);
    if (existing) return { ok: true as const, id: existing.id, created: false };
    const [[reg], [req]] = await Promise.all([
      t
        .select({ locale: registrations.locale, at: registrations.createdAt })
        .from(registrations)
        .where(sql`lower(${registrations.email}) = ${address}`)
        .orderBy(desc(registrations.createdAt), desc(registrations.id))
        .limit(1),
      t
        .select({ locale: sql<string>`${requests.payload}->>'locale'`, at: requests.createdAt })
        .from(requests)
        .where(and(sql`lower(${requests.payload}->>'email') = ${address}`, sql`${requests.payload}->>'locale' in ('et', 'ru')`))
        .orderBy(desc(requests.createdAt), desc(requests.id))
        .limit(1),
    ]);
    const newest = reg && req ? (req.at > reg.at ? req : reg) : (reg ?? req);
    const [row] = await t.insert(clients).values({ email: address, locale: newest?.locale === "ru" ? "ru" : "et" }).returning();
    await linkClientRecords(t, row.id, address);
    return { ok: true as const, id: row.id, created: true };
  });
}

/** Field: email. */
export async function addClientForm(db: Db, formData: FormData): Promise<ClientResult> {
  const result = await addClient(db, field(formData, "email") ?? "");
  return result.ok ? { ok: true, id: result.id } : fail("email");
}

/**
 * "Ava ligipääs": the student may open the e-course until the end of `until` (an Estonian date, today at the earliest).
 * One row per student and course: granting again (after it ran out or was ended) moves the expiry, clears the end and
 * records who granted it and when. Only e-learning courses, drafts included.
 */
export async function grantAccess(
  db: Db,
  input: { clientId: number; courseId: number; until: string; by: string; now: Date },
): Promise<ClientResult> {
  const expiresAt = grantExpiry(input.until, input.now);
  if (!expiresAt) return fail("date");
  const [[course], [client]] = await Promise.all([
    db.select({ type: courses.type }).from(courses).where(eq(courses.id, input.courseId)).limit(1),
    db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId)).limit(1),
  ]);
  if (!client) return fail("notFound");
  if (course?.type !== "e_learning") return fail("course");
  const values = { grantedBy: input.by, grantedAt: input.now, expiresAt, revokedAt: null };
  await db
    .insert(courseAccess)
    .values({ clientId: input.clientId, courseId: input.courseId, ...values })
    .onConflictDoUpdate({ target: [courseAccess.clientId, courseAccess.courseId], set: values });
  return { ok: true };
}

/** Fields: clientId, courseId, until (yyyy-mm-dd). `by`: the signed-in admin's e-mail. */
export async function grantAccessForm(db: Db, formData: FormData, by: string, now: Date): Promise<ClientResult> {
  const clientId = idSchema.safeParse(field(formData, "clientId"));
  if (!clientId.success) return fail("invalid");
  const courseId = idSchema.safeParse(field(formData, "courseId"));
  if (!courseId.success) return fail("course");
  return grantAccess(db, { clientId: clientId.data, courseId: courseId.data, until: (field(formData, "until") ?? "").trim(), by, now });
}

// ---------- „Pikenda“ (B12) ----------

/** What „Pikenda“ and its „Võta tagasi“ answer: the end replaced and the end now, or why nothing changed. */
export type ExtendResult = { ok: true; previous: Date; until: Date } | { ok: false; error: "notFound" | "revoked" | "stale" | "date" };

/**
 * The one write of „Pikenda“ and of its undo: the end moves from `expected` to `to` only if it is `expected` still, to the millisecond (a conditional UPDATE, so two
 * presses on one screen, or a second tab, cannot both win) and the access was not ended by an admin. Nothing else of the row changes: who granted
 * it and when (`grantAccess` would overwrite both and lift an end), the completion and the extra tries stay. A refused write says why by looking
 * at the row: gone, ended by an admin, or its end is not the one the screen showed.
 */
async function moveEnd(db: Db, accessId: number, to: Date, expected: Date): Promise<ExtendResult> {
  const [row] = await db
    .update(courseAccess)
    .set({ expiresAt: to })
    // (to the millisecond: a JS Date, and so the end the screen sent back, has no more; an end written by SQL — `now() + interval` — has microseconds)
    .where(and(eq(courseAccess.id, accessId), sql`date_trunc('milliseconds', ${courseAccess.expiresAt}) = ${expected.toISOString()}::timestamptz`, isNull(courseAccess.revokedAt)))
    .returning();
  if (row) return { ok: true, previous: expected, until: to };
  const [held] = await db.select({ revokedAt: courseAccess.revokedAt }).from(courseAccess).where(eq(courseAccess.id, accessId)).limit(1);
  return { ok: false, error: !held ? "notFound" : held.revokedAt ? "revoked" : "stale" };
}

/**
 * „Pikenda“ (README A5, B12): the access `accessId` is open until the end of `until` instead of `expected` — the end the drawer showed. `until` must
 * be a real extension (domain/client-access.ts isExtension: after the end of today and after the current end, within the grant form's 10 years),
 * else `date`. An access an admin ended is `revoked` (the „Ava ligipääs e-koolitusele“ row opens it again), one whose end is no longer `expected`
 * `stale`. Returns the end it replaced, for the undo.
 */
export async function extendAccess(db: Db, input: { accessId: number; until: Date; expected: Date }, now: Date): Promise<ExtendResult> {
  if (!isExtension(input.until, input.expected, now)) return { ok: false, error: "date" };
  return moveEnd(db, input.accessId, input.until, input.expected);
}

/**
 * „Võta tagasi“ after „Pikenda“: the end goes back to `previous`, but only while it is still `expected` — the end the extension set. If it moved since
 * (extended again, in another tab or by Maria), the undo would overwrite a newer change: `stale`, nothing written. `previous` may be in the past
 * (an access that had run out), so it has no date check of its own; an access ended meanwhile stays as it is (`revoked`).
 */
export async function undoExtendAccess(db: Db, input: { accessId: number; previous: Date; expected: Date }): Promise<ExtendResult> {
  return moveEnd(db, input.accessId, input.previous, input.expected);
}

const accessEnd = z.iso.datetime();
const extendRequest = z.object({
  accessId: z.number().int().positive().max(2_147_483_647),
  /** The end the drawer showed (the base of the months, and what the stored end must still be). */
  expected: accessEnd,
  months: z.union([z.literal(1), z.literal(3), z.literal(6)]).optional(),
  /** „Kuupäev…“: a day, yyyy-mm-dd (Estonian). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** The undo: the end to put back. */
  restore: accessEnd.optional(),
});

/** What the screen gets back: the ends as ISO strings (a Date is not for a server action's answer), or the refusal (`invalid`: not a request the drawer makes). */
export type ExtendAnswer = { ok: true; previous: string; until: string } | { ok: false; error: "notFound" | "revoked" | "stale" | "date" | "invalid" };

/**
 * The request the drawer makes, exactly one of `months` (1, 3 or 6: from the later of the end `expected` and today, domain/client-access.ts
 * extendByMonths), `date` („Kuupäev…“: to the end of that Estonian day) or `restore` (the undo of the extension that set `expected`). Anything
 * else is `invalid` and writes nothing.
 */
export async function extendAccessRequest(db: Db, raw: unknown, now: Date): Promise<ExtendAnswer> {
  const parsed = extendRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { accessId, months, date, restore } = parsed.data;
  if ([months, date, restore].filter((v) => v !== undefined).length !== 1) return { ok: false, error: "invalid" };
  const expected = new Date(parsed.data.expected);
  let result: ExtendResult;
  if (restore !== undefined) result = await undoExtendAccess(db, { accessId, previous: new Date(restore), expected });
  else {
    const until = months !== undefined ? extendByMonths(expected, now, months) : endOfDayTallinn(date!);
    result = until ? await extendAccess(db, { accessId, until, expected }, now) : { ok: false, error: "date" };
  }
  return result.ok ? { ok: true, previous: result.previous.toISOString(), until: result.until.toISOString() } : result;
}

/** "Lõpeta ligipääs": the access ends now (kept in the drawer as ended). Ending one already ended changes nothing. */
export async function revokeAccess(db: Db, input: { clientId: number; accessId: number; now: Date }): Promise<ClientResult> {
  const mine = and(eq(courseAccess.id, input.accessId), eq(courseAccess.clientId, input.clientId));
  const [row] = await db.update(courseAccess).set({ revokedAt: input.now }).where(and(mine, isNull(courseAccess.revokedAt))).returning();
  if (row) return { ok: true };
  const [exists] = await db.select({ id: courseAccess.id }).from(courseAccess).where(mine).limit(1);
  return exists ? { ok: true } : fail("notFound");
}

/** Fields: clientId, accessId. */
export async function revokeAccessForm(db: Db, formData: FormData, now: Date): Promise<ClientResult> {
  const clientId = idSchema.safeParse(field(formData, "clientId"));
  const accessId = idSchema.safeParse(field(formData, "accessId"));
  if (!clientId.success || !accessId.success) return fail("invalid");
  return revokeAccess(db, { clientId: clientId.data, accessId: accessId.data, now });
}

/**
 * "Ava järgmine õppetund" (spec 3a section 4): opens one lesson the student cannot open yet — the drawer's first locked lesson of that
 * e-course, sent back as `lessonId` — by recording the admin on her progress row (lesson_progress.unlocked_by). Only that lesson
 * opens, not the ones after it. Whether it is locked is decided by the student side's own rule (courseOutline, domain/lessons.ts
 * lessonStates), not a copy of it. A lesson that is open or done by now changes nothing (ok). notFound: no such student, no ACTIVE
 * access of hers to the course (none, ended by an admin, or run out: a row written then would silently apply after a later grant), or
 * not a visible lesson of the course; course: not an e-course. The course need not be published (access to a draft works).
 */
export async function unlockNext(db: Db, input: { clientId: number; courseId: number; lessonId: number; by: string; now: Date }): Promise<ClientResult> {
  const [[client], [course]] = await Promise.all([
    db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId)).limit(1),
    db.select({ type: courses.type }).from(courses).where(eq(courses.id, input.courseId)).limit(1),
  ]);
  if (!client) return fail("notFound");
  if (course?.type !== "e_learning") return fail("course");
  const [held] = await db
    .select({ expiresAt: courseAccess.expiresAt, revokedAt: courseAccess.revokedAt })
    .from(courseAccess)
    .where(and(eq(courseAccess.clientId, input.clientId), eq(courseAccess.courseId, input.courseId)))
    .limit(1);
  if (!held || accessState(held, input.now) !== "active") return fail("notFound");
  const target = (await courseOutline(db, input.courseId, input.clientId)).lessons.find((l) => l.id === input.lessonId);
  if (!target) return fail("notFound");
  if (target.state !== "locked") return { ok: true };
  await db
    .insert(lessonProgress)
    .values({ clientId: input.clientId, lessonId: input.lessonId, unlockedBy: input.by, updatedAt: input.now })
    .onConflictDoUpdate({ target: [lessonProgress.clientId, lessonProgress.lessonId], set: { unlockedBy: input.by, updatedAt: input.now } });
  return { ok: true };
}

/** Fields: clientId, courseId, lessonId. `by`: the signed-in admin's e-mail. */
export async function unlockNextForm(db: Db, formData: FormData, by: string, now: Date): Promise<ClientResult> {
  const clientId = idSchema.safeParse(field(formData, "clientId"));
  const courseId = idSchema.safeParse(field(formData, "courseId"));
  const lessonId = idSchema.safeParse(field(formData, "lessonId"));
  if (!clientId.success || !courseId.success || !lessonId.success) return fail("invalid");
  return unlockNext(db, { clientId: clientId.data, courseId: courseId.data, lessonId: lessonId.data, by, now });
}
