import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { courseSeeds, pageSeeds } from "../../src/db/seed-data";
import { TERMS_PAGE_KEY } from "../../src/domain/course-terms";
import { revalidateLocalPages } from "./prod-build";
import { assertLocalDatabases, isLocalDbUrl } from "./local-db";
import { PROD_BUILD, TARGET } from "./target";

// Test-owned seat fixtures for the calendar e2e tests. The seed never contains registrations (the real database will
// hold real ones), so the "full" and "few" seat states are produced here: global-setup inserts confirmed registrations
// into the LOCAL dev database only, global-teardown removes them again. Every row carries FIXTURE_NOTE.
//
// The two sessions are chosen so that no other test depends on their seats:
// - full: Kulmude LAMI, Pärnu (the course's later date; the Tartu one stays open);
// - few:  Lash Lift BOTOX, Viljandi (2 seats left — still bookable, so the course page's radio tests are unaffected).

const baseURL = TARGET;

/** Fixtures are applied only when the tests run against a local server (the default `npm run dev`). */
export const LOCAL_FIXTURES = !baseURL || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseURL);

export const FIXTURE_NOTE = "e2e-fixture:seats";
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mslab";

export const FIXTURES = {
  full: { slug: "kulmude-lami", city: "Pärnu", leave: 0 },
  few: { slug: "lash-lift-botox", city: "Viljandi", leave: 2 },
} as const;

/**
 * Fixtures and test rows are written to and deleted from a local database only, never a shared one (local-db.ts).
 * Against the local production build, closing a connection also marks the cached pages stale (prod-build.ts): what
 * was written here must show on the next page view, as it does under `next dev`. `marksPages: false` for rows no public page
 * shows (the account tests' clients, access, terms): a mark makes every page render again, which the cache tests running
 * beside them have to wait out, so it is not made for nothing.
 */
const connect = (marksPages = true) => {
  if (!isLocalDbUrl(DB_URL)) assertLocalDatabases([{ source: "E2E_DATABASE_URL", url: DB_URL }]);
  const sql = postgres(DB_URL, { max: 1, connect_timeout: 20, onnotice: () => {} });
  if (!PROD_BUILD || !marksPages) return sql;
  const end = sql.end.bind(sql);
  return Object.assign(sql, { end: async (...args: Parameters<typeof end>) => { await end(...args); revalidateLocalPages(); } });
};

/** Removes this suite's rows; returns how many are left afterwards (0 when clean). */
async function clear(sql: postgres.Sql): Promise<number> {
  await sql`delete from registrations where note = ${FIXTURE_NOTE}`;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations where note = ${FIXTURE_NOTE}`;
  return n;
}

export async function applySeatFixtures(): Promise<void> {
  const sql = connect();
  try {
    await clear(sql); // leftovers of an interrupted run
    for (const f of Object.values(FIXTURES)) {
      const [s] = await sql<{ id: number; courseId: number; capacity: number; confirmed: number }[]>`
        select s.id, s.course_id as "courseId", s.capacity,
               (select count(*)::int from registrations r where r.course_session_id = s.id and r.status = 'confirmed') as confirmed
        from course_sessions s join courses c on c.id = s.course_id
        where c.slug = ${f.slug} and s.city = ${f.city} and s.status = 'scheduled'
        order by s.starts_at limit 1`;
      if (!s) throw new Error(`e2e fixtures: no scheduled ${f.slug} session in ${f.city} — is the local DB seeded?`);
      const missing = Math.max(0, s.capacity - f.leave - s.confirmed);
      for (let i = 0; i < missing; i++) {
        await sql`insert into registrations (course_id, course_session_id, kind, name, email, payment_choice, status, note)
                  values (${s.courseId}, ${s.id}, 'group', 'E2E fixture', 'e2e-fixture@example.com', 'full', 'confirmed', ${FIXTURE_NOTE})`;
      }
    }
  } finally {
    await sql.end();
  }
}

export async function removeSeatFixtures(): Promise<void> {
  const sql = connect();
  try {
    const left = await clear(sql);
    if (left !== 0) throw new Error(`e2e fixtures: ${left} fixture registrations are still in the database`);
  } finally {
    await sql.end();
  }
}

// ---------- the e-course terms page ----------
// The seed gained the `course_terms` page in phase 2a. A local database seeded before that has no such row (the admin's Seaded
// editor and the e-course notice read it), so every run first adds it, with the seed's text, when it is missing (the seed's own
// rule: rows that exist are never touched). Only the LOCAL database, like every fixture here.

/** Adds the seed's `course_terms` page to the local database when it has none; true when it was added. */
export async function ensureCourseTermsPage(): Promise<boolean> {
  const seed = pageSeeds.find((p) => p.key === TERMS_PAGE_KEY);
  if (!seed) throw new Error("e2e fixtures: the seed has no course_terms page");
  const sql = connect();
  try {
    const added = await sql`
      insert into pages (key, title, body) values (${seed.key}, ${sql.json(seed.title as never)}, ${sql.json(seed.body as never)})
      on conflict (key) do nothing returning key`;
    return added.length > 0;
  } finally {
    await sql.end();
  }
}

// ---------- sample session dates ----------
// The seed dates the sample sessions relative to the day it runs (src/db/seed-dates.ts). A local database seeded weeks
// ago would by now have sessions in the past (the calendar hides them), so every run first moves the LOCAL database's
// sample sessions onto today's schedule; the tests' expected dates come from the same schedule (seed-sessions.ts).
// A sample session is found by its course, city and venue (the seed's), in date order within each such group.

/** Puts the local database's sample sessions on today's schedule; returns how many rows were moved. */
export async function scheduleSampleSessions(): Promise<number> {
  const sql = connect();
  try {
    let moved = 0;
    for (const course of courseSeeds) {
      const groups = new Map<string, { city: string; venue: string; starts: Date[] }>();
      for (const s of course.sessions ?? []) {
        const key = JSON.stringify([s.city, s.venue ?? ""]);
        const group = groups.get(key) ?? { city: s.city, venue: s.venue ?? "", starts: [] };
        group.starts.push(s.startsAt);
        groups.set(key, group);
      }
      for (const { city, venue, starts } of groups.values()) {
        const rows = await sql<{ id: number; startsAt: Date }[]>`
          select s.id, s.starts_at as "startsAt" from course_sessions s join courses c on c.id = s.course_id
          where c.slug = ${course.slug} and s.city = ${city} and s.venue = ${venue} order by s.starts_at, s.id`;
        const wanted = [...starts].sort((a, b) => a.getTime() - b.getTime());
        for (const [i, row] of rows.slice(0, wanted.length).entries()) {
          if (row.startsAt.getTime() === wanted[i].getTime()) continue;
          await sql`update course_sessions set starts_at = ${wanted[i]} where id = ${row.id}`;
          moved++;
        }
      }
    }
    return moved;
  } finally {
    await sql.end();
  }
}

// ---------- rows the form tests create ----------
// Every e-mail a test submits is `e2e-form-…@example.com` (see testEmail); the tests read the stored rows back from the
// local database, and global-setup / global-teardown delete them.

export const TEST_EMAIL_PATTERN = "e2e-form-%@example.com";

/** A unique address for one submission: e2e-form-<label>-<project>-<time><random>@example.com (lowercase). */
export function testEmail(label: string, project: string): string {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `e2e-form-${label}-${project}-${unique}@example.com`.toLowerCase();
}

/** Deletes the form tests' rows; returns how many are left (0 when clean). */
export async function removeFormRows(): Promise<number> {
  const sql = connect();
  try {
    await sql`delete from registrations where email like ${TEST_EMAIL_PATTERN}`;
    await sql`delete from requests where payload->>'email' like ${TEST_EMAIL_PATTERN}`;
    await sql`delete from subscribers where email like ${TEST_EMAIL_PATTERN}`;
    await sql`delete from payments where email like ${TEST_EMAIL_PATTERN}`;
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from registrations where email like ${TEST_EMAIL_PATTERN})
           + (select count(*) from requests where payload->>'email' like ${TEST_EMAIL_PATTERN})
           + (select count(*) from subscribers where email like ${TEST_EMAIL_PATTERN})
           + (select count(*) from payments where email like ${TEST_EMAIL_PATTERN})::int as n`;
    return Number(n);
  } finally {
    await sql.end();
  }
}

export type StoredRegistration = { kind: string; status: string; paidCents: number; paymentChoice: string; wantsModelHelp: boolean; locale: string; course: string; sessionId: number | null };
export type StoredRequest = { kind: string; payload: Record<string, unknown> };
export type StoredSubscriber = { email: string; locale: string; confirmed: boolean; token: string };

/** The registrations stored for one test address. */
export async function storedRegistrations(email: string): Promise<StoredRegistration[]> {
  const sql = connect();
  try {
    return await sql<StoredRegistration[]>`
      select r.kind, r.status, r.paid_cents as "paidCents", r.payment_choice as "paymentChoice",
             r.wants_model_help as "wantsModelHelp", r.locale, c.slug as course, r.course_session_id as "sessionId"
      from registrations r join courses c on c.id = r.course_id where r.email = ${email} order by r.id`;
  } finally {
    await sql.end();
  }
}

/** The requests stored for one test address. */
export async function storedRequests(email: string): Promise<StoredRequest[]> {
  const sql = connect();
  try {
    return await sql<StoredRequest[]>`select kind, payload from requests where payload->>'email' = ${email} order by id`;
  } finally {
    await sql.end();
  }
}

/** The newsletter subscriber of one test address, if any. */
export async function storedSubscriber(email: string): Promise<StoredSubscriber | null> {
  const sql = connect();
  try {
    const [row] = await sql<StoredSubscriber[]>`select email, locale, confirmed_at is not null as confirmed, token from subscribers where email = ${email}`;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

/** The online payments of one test address (phase 2b), oldest first. */
export async function storedPayments(email: string): Promise<{ kind: string; status: string; amountCents: number }[]> {
  const sql = connect(false);
  try {
    return await sql<{ kind: string; status: string; amountCents: number }[]>`select kind, status, amount_cents as "amountCents" from payments where email = ${email} order by id`;
  } finally {
    await sql.end();
  }
}

/** Does a registration of this test address hold a seat right now (a live seat_hold_until, phase 2b)? */
export async function storedHold(email: string): Promise<boolean> {
  const sql = connect(false);
  try {
    const [{ held }] = await sql<{ held: boolean }[]>`select exists (select 1 from registrations where email = ${email} and seat_hold_until > now()) as held`;
    return held;
  } finally {
    await sql.end();
  }
}

// ---------- admin sign-in rows ----------
// Signing in needs an allow-listed address, so these tests sign in as the real admins on the LOCAL dev database (nothing is
// e-mailed: there is no RESEND_API_KEY, and the request answer carries a devLink). Each test deletes exactly the token and
// session rows it created (found by the hash of the link token / session cookie), so a session of a developer who is
// signed in to the dev server at the same time is untouched. Addresses outside the allow-list are `e2e-auth-…@example.com`.

export const AUTH_TEST_EMAIL_PATTERN = "e2e-auth-%@example.com";

/** A unique address for a test that must NOT be allowed to sign in. */
export function authTestEmail(project: string): string {
  return `e2e-auth-${project}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`.toLowerCase();
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Deletes the token rows and session rows of the given raw values (and every row of an e2e-auth address). */
export async function removeAdminRows(rows: { tokens?: Iterable<string>; sessions?: Iterable<string> } = {}): Promise<number> {
  const sql = connect();
  try {
    for (const t of rows.tokens ?? []) await sql`delete from auth_tokens where hash = ${sha256Hex(t)}`;
    for (const s of rows.sessions ?? []) await sql`delete from admin_sessions where id_hash = ${sha256Hex(s)}`;
    await sql`delete from auth_tokens where email like ${AUTH_TEST_EMAIL_PATTERN}`;
    await sql`delete from admin_sessions where email like ${AUTH_TEST_EMAIL_PATTERN}`;
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from auth_tokens where email like ${AUTH_TEST_EMAIL_PATTERN})
           + (select count(*) from admin_sessions where email like ${AUTH_TEST_EMAIL_PATTERN})::int as n`;
    return Number(n);
  } finally {
    await sql.end();
  }
}

/** The token rows stored for one address. */
export async function storedAuthTokens(email: string): Promise<{ used: boolean }[]> {
  const sql = connect();
  try {
    return await sql<{ used: boolean }[]>`select used_at is not null as used from auth_tokens where email = ${email}`;
  } finally {
    await sql.end();
  }
}

/** Is there a session row for this raw session id? */
export async function sessionExists(rawSession: string): Promise<boolean> {
  const sql = connect();
  try {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from admin_sessions where id_hash = ${sha256Hex(rawSession)}`;
    return n > 0;
  } finally {
    await sql.end();
  }
}

/** Makes a login token expire a minute ago (the 15 minutes cannot be waited out). */
export async function expireAuthToken(rawToken: string): Promise<void> {
  const sql = connect();
  try {
    await sql`update auth_tokens set expires_at = now() - interval '1 minute' where hash = ${sha256Hex(rawToken)}`;
  } finally {
    await sql.end();
  }
}

// ---------- client account rows (account-login.spec.ts, account-dashboard.spec.ts) ----------
// The account tests sign in as `e2e-client-<label>-<project>@example.test` (tests/e2e/account.ts clientEmail): a sample
// address, never mailed. Each test starts by removing its own address's rows (a retry starts clean), and global-setup /
// global-teardown remove every one of them: the clients (their sessions, favourites and access go with them), the login
// tokens, which are kept by address, and what the dashboard tests made for them: registrations and requests with the
// address (the change requests the app stores carry it too), and their own course `e2e-konto-<label>-<project>`, which
// is not published, so its seats never show on a public page (its sessions go with it).

export const CLIENT_EMAIL_PATTERN = "e2e-client-%@example.test";
export const ACCOUNT_COURSE_PREFIX = "e2e-konto-";

/** The dashboard tests' course of one test address: e2e-client-dash-mobile@example.test → e2e-konto-dash-mobile. */
export function accountCourseSlug(email: string): string {
  return ACCOUNT_COURSE_PREFIX + email.slice("e2e-client-".length, email.indexOf("@"));
}

/** Deletes the account rows of one test address, or of all of them; returns how many are left (0 when clean). */
export async function removeClientRows(email?: string): Promise<number> {
  const match = email ?? CLIENT_EMAIL_PATTERN;
  const courses = email ? accountCourseSlug(email) : `${ACCOUNT_COURSE_PREFIX}%`;
  const sql = connect(false); // clients and their unpublished courses: no public page shows them
  try {
    await sql`delete from registrations where email like ${match} or course_id in (select id from courses where slug like ${courses})`;
    await sql`delete from requests where payload->>'email' like ${match}`;
    await sql`delete from courses where slug like ${courses}`; // on delete cascade: its sessions
    await sql`delete from client_login_tokens where email like ${match}`;
    await sql`delete from subscribers where email like ${match}`; // "Saada mulle uudiskirja" in Minu andmed
    await sql`delete from clients where email like ${match}`; // on delete cascade: sessions, favourites, access, terms
    await sql`delete from payments where email like ${match}`; // the online payments of the test address (phase 2b)
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from client_login_tokens where email like ${match})
           + (select count(*) from subscribers where email like ${match})
           + (select count(*) from clients where email like ${match})
           + (select count(*) from payments where email like ${match})
           + (select count(*) from registrations where email like ${match})
           + (select count(*) from requests where payload->>'email' like ${match})
           + (select count(*) from courses where slug like ${courses})::int as n`;
    return Number(n);
  } finally {
    await sql.end();
  }
}

/**
 * How long a test waits for a lock other tests hold (holdLocalLock): three minutes, room for a queue of several whole tests (the
 * e-course and lesson tests of both projects hold the course terms for a whole test each). Every caller adds it to its own timeout.
 */
export const LOCK_WAIT_MS = 180_000;
/** Postgres's error code for a lock not granted within lock_timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Holds a lock that every worker process shares (a Postgres advisory lock on a connection of its own) until the returned
 * function is called; a crashed worker's connection closes, and the lock with it. For a test that changes a shared row
 * other tests of the same kind read (the dashboard's prepayment setting, the e-course terms): the desktop and phone projects
 * run side by side.
 *
 * The lock is asked for with pg_advisory_lock, so the waiting tests are served in Postgres's own queue, first come first served
 * (asking again and again with pg_try_advisory_lock let a test wait in vain while the tests of another file took the lock back
 * at once, one after the other). The wait is `waitMs` at most (LOCK_WAIT_MS: lock_timeout on this connection), then Postgres drops
 * the request and this fails saying so: a wait that has given up is never granted the lock later. A caller whose own timeout is
 * shorter than `waitMs` should lengthen it (test.setTimeout); a test that fails anyway ends its worker, and the connection
 * with the lock or the request goes with it.
 */
export async function holdLocalLock(name: string, waitMs = LOCK_WAIT_MS): Promise<() => Promise<void>> {
  const sql = connect(false); // a lock changes no public page (one connection: the lock, the timeout and the unlock share it)
  try {
    await sql`select set_config('lock_timeout', ${`${Math.max(1, Math.round(waitMs))}ms`}, false)`;
    await sql`select pg_advisory_lock(hashtext(${name}))`;
  } catch (e) {
    await sql.end();
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE)
      throw new Error(`e2e: the lock "${name}" was not free within ${Math.round(waitMs / 1000)} s: another test holds it, or a worker that died has not let go yet`);
    throw e;
  }
  return async () => {
    try {
      await sql`select pg_advisory_unlock(hashtext(${name}))`;
    } finally {
      await sql.end();
    }
  };
}

// ---------- admin inbox fixtures ----------
// The admin inbox tests need registrations, requests and subscribers to look at. Each test inserts its own set, tagged
// with a unique `tag` (in every e-mail address and in the course slug), and deletes it afterwards; global-setup and
// global-teardown remove leftovers by pattern. The registration belongs to a fixture course that is NOT published, with
// its own session, so confirming it never changes the seats a public page shows.

export const ADMIN_FIXTURE_EMAIL_PATTERN = "e2e-admin-%@example.com";
export const ADMIN_FIXTURE_SLUG_PATTERN = "e2e-admin-%";

export type AdminFixtures = {
  tag: string;
  course: { id: number; slug: string; title: string };
  session: { id: number };
  registration: { id: number; name: string; email: string };
  contact: { id: number; name: string };
  interest: { id: number; email: string };
  individual: { id: number; name: string };
  practice: { id: number; name: string };
  waitlist: { id: number; name: string };
  subscribers: { confirmed: string; pending: string };
};

/**
 * Inserts one test's rows (see above). Group price 350 €, so 50% = 175 €. `extraSubscribers`: that many more
 * unconfirmed subscribers (for the page-by-page list).
 */
export async function insertAdminFixtures(project: string, opts: { extraSubscribers?: number } = {}): Promise<AdminFixtures> {
  const tag = `${project}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const email = (label: string) => `e2e-admin-${label}-${tag}@example.com`;
  const sql = connect();
  try {
    const slug = `e2e-admin-${tag}`;
    const title = `E2E haldus ${tag}`;
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published)
      values (${slug}, 'contact', 'basic', ${sql.json({ et: title })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 35000, 45000, false)
      returning id`;
    const [session] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, date_trunc('day', now()) + interval '60 days 10 hours', 'Pärnu', 'E2E saal', 4) returning id`;
    const regName = `E2E Registreerija ${tag}`;
    const [registration] = await sql<{ id: number }[]>`
      insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, wants_model_help, wants_account, status)
      values (${course.id}, ${session.id}, 'group', ${regName}, ${email("reg")}, '+372 5555 0101', 'half', true, false, 'awaiting_prepayment')
      returning id`;
    // sql.json: a JSON string cast to jsonb would be stored as one jsonb *string*, which payload->>'…' cannot read.
    const request = async (kind: string, payload: Record<string, string | number | boolean>) => {
      const [row] = await sql<{ id: number }[]>`insert into requests (kind, payload) values (${kind}, ${sql.json(payload)}) returning id`;
      return row.id;
    };
    const names = { contact: `E2E Kontakt ${tag}`, individual: `E2E Individuaal ${tag}`, practice: `E2E Praktika ${tag}`, waitlist: `E2E Ootaja ${tag}` };
    const contact = await request("contact", { name: names.contact, email: email("contact"), message: "Tere! Kas jaanuaris on veel kohti?", locale: "et" });
    const interest = await request("contact", { course: "kulmumeistri-e-koolitus", intent: "purchase", email: email("interest"), locale: "ru" });
    const individual = await request("individual", {
      course: slug,
      courseId: course.id,
      name: names.individual,
      email: email("individual"),
      phone: "+372 5555 0102",
      wantsModelHelp: false,
      wantsAccount: true,
      locale: "et",
      preferredPeriod: "Jaanuari teine pool",
      message: "",
    });
    const practice = await request("practice", {
      package: "MINI",
      name: names.practice,
      email: email("practice"),
      phone: "+372 5555 0103",
      course: "Kulmumeistri baaskoolitus",
      times: "Tööpäeviti pärast kella 17",
      locale: "et",
    });
    const waitlist = await request("waitlist", { session: session.id, course: slug, name: names.waitlist, email: email("waitlist"), locale: "et" });
    const subscribers = { confirmed: email("sub-ok"), pending: email("sub-wait") };
    await sql`insert into subscribers (email, locale, token, consent_at, confirmed_at)
              values (${subscribers.confirmed}, 'et', ${`e2e-admin-token-ok-${tag}`}, now() - interval '2 days', now() - interval '1 day')`;
    // A formula-like value in a column the export writes: the CSV must defuse it.
    await sql`insert into subscribers (email, locale, token) values (${subscribers.pending}, '=1+1', ${`e2e-admin-token-wait-${tag}`})`;
    for (let i = 0; i < (opts.extraSubscribers ?? 0); i++)
      await sql`insert into subscribers (email, locale, token, consent_at)
                values (${email(`bulk${i}`)}, 'et', ${`e2e-admin-token-bulk${i}-${tag}`}, now() - interval '3 days')`;
    return {
      tag,
      course: { id: course.id, slug, title },
      session: { id: session.id },
      registration: { id: registration.id, name: regName, email: email("reg") },
      contact: { id: contact, name: names.contact },
      interest: { id: interest, email: email("interest") },
      individual: { id: individual, name: names.individual },
      practice: { id: practice, name: names.practice },
      waitlist: { id: waitlist, name: names.waitlist },
      subscribers,
    };
  } finally {
    await sql.end();
  }
}

/** Deletes the admin fixture rows of one tag, or all of them; returns how many are left (0 when clean). */
export async function removeAdminFixtures(tag?: string): Promise<number> {
  const mails = tag ? `e2e-admin-%-${tag}@example.com` : ADMIN_FIXTURE_EMAIL_PATTERN;
  const slugs = tag ? `e2e-admin-${tag}` : ADMIN_FIXTURE_SLUG_PATTERN;
  const sql = connect();
  try {
    await sql`delete from registrations where email like ${mails} or course_id in (select id from courses where slug like ${slugs})`;
    // Matched on the whole payload text, so a payload stored the wrong way (one jsonb string) is found too.
    const inPayload = `%${mails}%`;
    await sql`delete from requests where payload::text like ${inPayload}`;
    await sql`delete from subscribers where email like ${mails}`;
    await sql`delete from courses where slug like ${slugs}`; // its sessions go with it (on delete cascade)
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from registrations where email like ${mails})
           + (select count(*) from requests where payload::text like ${inPayload})
           + (select count(*) from subscribers where email like ${mails})
           + (select count(*) from courses where slug like ${slugs})::int as n`;
    return Number(n);
  } finally {
    await sql.end();
  }
}

/** A fixture registration as stored. */
export async function storedAdminRegistration(id: number): Promise<{ status: string; paidCents: number; note: string }> {
  const sql = connect();
  try {
    const [row] = await sql<{ status: string; paidCents: number; note: string }[]>`
      select status, paid_cents as "paidCents", note from registrations where id = ${id}`;
    return row;
  } finally {
    await sql.end();
  }
}

/** Another admin (another tab) changes a fixture registration's status behind the open page. */
export async function setStoredStatus(id: number, status: "awaiting_prepayment" | "confirmed" | "cancelled"): Promise<void> {
  const sql = connect();
  try {
    await sql`update registrations set status = ${status} where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/** A fixture request disappears behind the open page (to make "Märgi tehtuks" fail). */
export async function deleteStoredRequest(id: number): Promise<void> {
  const sql = connect();
  try {
    await sql`delete from requests where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/** Is this request marked handled? */
export async function requestHandled(id: number): Promise<boolean> {
  const sql = connect();
  try {
    const [row] = await sql<{ handled: boolean }[]>`select handled from requests where id = ${id}`;
    return row.handled;
  } finally {
    await sql.end();
  }
}

// ---------- content editor rows (admin-edit.spec.ts) ----------
// The content tests change real seed courses (a title, a badge, the gallery, the order) and add sessions to a seed
// course, then put everything back. They run after all other tests (playwright.config.ts), so no other test sees the
// changes. Before a course is changed its row and images are written to a snapshot file outside the project; the test
// restores it and deletes the file, and global-setup restores any snapshot an interrupted run left behind. Sessions the
// tests add have a city starting with "E2E "; the course "Lisa koolitus" creates has a slug starting with "e2e-uus-".

export const EDIT_CITY_PREFIX = "E2E ";
export const NEW_COURSE_SLUG_PREFIX = "e2e-uus-";
const EDIT_EMAIL_PATTERN = "e2e-edit-%@example.com";
const SNAPSHOT_DIR = join(tmpdir(), "mslab-e2e-course-snapshots");

const JSON_COLUMNS = ["title", "summary", "body", "outcomes", "includes", "duration_label", "next_discount", "badge", "recommendation_ids"] as const;
const PLAIN_COLUMNS = ["slug", "type", "level", "language", "price", "price_group", "price_individual", "access_months", "video_count", "published", "sort", "is_sample", "updated_at"] as const;

type CourseSnapshot = { id: number; row: Record<string, unknown>; images: { key: string; alt: unknown; sort: number }[] };

async function readSnapshot(sql: postgres.Sql, slug: string): Promise<CourseSnapshot> {
  const [row] = await sql`select * from courses where slug = ${slug}`;
  if (!row) throw new Error(`e2e: course ${slug} not found — is the local DB seeded?`);
  const images = await sql<{ key: string; alt: unknown; sort: number }[]>`select key, alt, sort from course_images where course_id = ${row.id} order by sort, id`;
  return { id: row.id as number, row: Object.fromEntries([...JSON_COLUMNS, ...PLAIN_COLUMNS].map((c) => [c, row[c]])), images: [...images] };
}

async function writeBack(sql: postgres.Sql, s: CourseSnapshot): Promise<void> {
  await sql.begin(async (tx) => {
    const values: Record<string, unknown> = {};
    for (const c of PLAIN_COLUMNS) values[c] = c === "updated_at" ? new Date(s.row[c] as string) : s.row[c];
    // tx.json: a JSON string cast to jsonb would be stored as one jsonb *string* (see insertAdminFixtures)
    for (const c of JSON_COLUMNS) values[c] = s.row[c] === null ? null : tx.json(s.row[c] as postgres.JSONValue);
    await tx`update courses set ${tx(values as Record<string, postgres.ParameterOrJSON<never>>)} where id = ${s.id}`;
    await tx`delete from course_images where course_id = ${s.id}`;
    for (const img of s.images)
      await tx`insert into course_images (course_id, key, alt, sort) values (${s.id}, ${img.key}, ${img.alt === null ? null : tx.json(img.alt as postgres.JSONValue)}, ${img.sort})`;
  });
}

const snapshotFile = (id: number) => join(SNAPSHOT_DIR, `course-${id}.json`);

/** Saves a seed course (row + images) before a test changes it; returns its id. Call restoreCourse(id) afterwards. */
export async function snapshotCourse(slug: string): Promise<number> {
  const sql = connect();
  try {
    const s = await readSnapshot(sql, slug);
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    if (!existsSync(snapshotFile(s.id))) writeFileSync(snapshotFile(s.id), JSON.stringify(s));
    return s.id;
  } finally {
    await sql.end();
  }
}

/** Puts a snapshotted course back exactly as it was and deletes its snapshot file. */
export async function restoreCourse(id: number): Promise<void> {
  const file = snapshotFile(id);
  if (!existsSync(file)) return;
  const sql = connect();
  try {
    await writeBack(sql, JSON.parse(readFileSync(file, "utf8")) as CourseSnapshot);
    rmSync(file);
  } finally {
    await sql.end();
  }
}

/** Restores every course a run left changed (global-setup / global-teardown); returns how many there were. */
export async function restoreLeftoverCourses(): Promise<number> {
  if (!existsSync(SNAPSHOT_DIR)) return 0;
  const files = readdirSync(SNAPSHOT_DIR).filter((f) => /^course-\d+\.json$/.test(f));
  for (const f of files) await restoreCourse(Number(f.match(/\d+/)![0]));
  return files.length;
}

export type StoredCourse = { id: number; title: { et: string; ru?: string }; badge: { label: string; bg: string; fg: string } | null; sort: number; updatedAt: Date; images: string[] };

/** The course as stored, for assertions. */
export async function storedCourse(slug: string): Promise<StoredCourse> {
  const sql = connect();
  try {
    const [c] = await sql<Omit<StoredCourse, "images">[]>`select id, title, badge, sort, updated_at as "updatedAt" from courses where slug = ${slug}`;
    const images = await sql<{ key: string }[]>`select key from course_images where course_id = ${c.id} order by sort, id`;
    return { ...c, images: images.map((i) => i.key) };
  } finally {
    await sql.end();
  }
}

/** The slugs of all courses in their order. */
export async function courseOrder(): Promise<string[]> {
  const sql = connect();
  try {
    return (await sql<{ slug: string }[]>`select slug from courses order by sort, id`).map((r) => r.slug);
  } finally {
    await sql.end();
  }
}

/** Saves the sort of every course; the returned function puts it back. */
export async function snapshotOrder(): Promise<() => Promise<void>> {
  const sql = connect();
  let rows: { id: number; sort: number }[];
  try {
    rows = [...(await sql<{ id: number; sort: number }[]>`select id, sort from courses`)];
  } finally {
    await sql.end();
  }
  return async () => {
    const back = connect();
    try {
      for (const r of rows) await back`update courses set sort = ${r.sort} where id = ${r.id}`;
    } finally {
      await back.end();
    }
  };
}

/** A session a test added (found by its city), or null. */
export async function storedSession(city: string): Promise<{ id: number; capacity: number; status: string; startsAt: Date; venue: string } | null> {
  const sql = connect();
  try {
    const [row] = await sql<{ id: number; capacity: number; status: string; startsAt: Date; venue: string }[]>`
      select id, capacity, status, starts_at as "startsAt", venue from course_sessions where city = ${city}`;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

/** A registration on a test session (so that it cannot be deleted). */
export async function registerOnSession(sessionId: number, project: string): Promise<void> {
  const sql = connect();
  try {
    await sql`insert into registrations (course_id, course_session_id, kind, name, email, payment_choice, status)
              select course_id, id, 'group', 'E2E Registreerija', ${`e2e-edit-${project}-${Date.now().toString(36)}@example.com`}, 'half', 'awaiting_prepayment'
              from course_sessions where id = ${sessionId}`;
  } finally {
    await sql.end();
  }
}

/** A session for a test, written directly (city "E2E <project> …"); returns its id. */
export async function insertEditSession(slug: string, city: string): Promise<number> {
  const sql = connect();
  try {
    const [row] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      select id, date_trunc('day', now()) + interval '200 days 10 hours', ${city}, 'E2E saal', 4 from courses where slug = ${slug}
      returning id`;
    return row.id;
  } finally {
    await sql.end();
  }
}

/**
 * Deletes the sessions (with their registrations) and the new course the content tests made — of one project
 * ("chromium-edit" and "mobile-edit" run side by side), or all — and returns how many are left.
 */
export async function removeEditRows(project?: string): Promise<number> {
  const sql = connect();
  const city = `${EDIT_CITY_PREFIX}${project ?? ""}%`;
  const slug = `${NEW_COURSE_SLUG_PREFIX}${project ?? ""}%`;
  const emails = project ? `e2e-edit-${project}-%@example.com` : EDIT_EMAIL_PATTERN;
  try {
    await sql`delete from registrations where email like ${emails}
              or course_session_id in (select id from course_sessions where city like ${city})
              or course_id in (select id from courses where slug like ${slug})`;
    await sql`delete from course_sessions where city like ${city}`;
    await sql`delete from courses where slug like ${slug}`;
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from course_sessions where city like ${city})
           + (select count(*) from courses where slug like ${slug})
           + (select count(*) from registrations where email like ${emails})::int as n`;
    return Number(n);
  } finally {
    await sql.end();
  }
}

// ---------- site content rows (admin-site.spec.ts) ----------
// The site editors' tests change shared content: a practice package, the hero slides, the FAQ, text pages, settings, the
// campaign, the trainer's works. Before a test changes rows, they are written to a snapshot file (rows-<table>-<key>.json,
// next to the course snapshots); the test puts them back and deletes the file, and global-setup / global-teardown restore
// any snapshot an interrupted run left. The two edit projects run side by side, so each test changes rows the other
// project's tests do not touch (MAXI vs MINI, hero slides vs FAQ, …): a snapshot is by key, not of a whole table, where
// both projects use the same table. Posts the tests create have a slug starting with "e2e-uudis-<project>-".

export const POST_SLUG_PREFIX = "e2e-uudis-";

type RowMatch = { column: string; value: string | number } | null;
type RowsSnapshot = { table: string; match: RowMatch; rows: Record<string, unknown>[] };

const SNAPSHOT_TABLES = ["practice_packages", "hero_slides", "faq", "pages", "settings", "campaign", "gallery_items"] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];
const rowsFile = (table: string, match: RowMatch) => join(SNAPSHOT_DIR, `rows-${table}-${match ? `${match.column}-${String(match.value).replace(/[^a-z0-9_-]/gi, "_")}` : "all"}.json`);

/** Column name → data type of a table (jsonb and timestamps need their own handling when written back). */
async function columnTypes(sql: postgres.Sql, table: string): Promise<Record<string, string>> {
  const cols = await sql<{ column_name: string; data_type: string }[]>`select column_name, data_type from information_schema.columns where table_name = ${table}`;
  return Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
}

/** Saves rows (all of a table, or those where column = value) before a test changes them; returns the restore function. */
export async function snapshotRows(table: SnapshotTable, match: RowMatch = null, opts: { marksPages?: boolean } = {}): Promise<() => Promise<void>> {
  if (!SNAPSHOT_TABLES.includes(table)) throw new Error(`e2e: no snapshots of ${table}`);
  const marksPages = opts.marksPages !== false;
  const sql = connect(marksPages);
  try {
    const rows = match ? await sql`select * from ${sql(table)} where ${sql(match.column)} = ${match.value}` : await sql`select * from ${sql(table)}`;
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const file = rowsFile(table, match);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ table, match, rows: [...rows] } satisfies RowsSnapshot));
    return () => restoreRows(file, marksPages);
  } finally {
    await sql.end();
  }
}

/** Writes a rows snapshot back (the matching rows are replaced by the saved ones) and deletes its file. */
async function restoreRows(file: string, marksPages = true): Promise<void> {
  if (!existsSync(file)) return;
  const s = JSON.parse(readFileSync(file, "utf8")) as RowsSnapshot;
  if (!SNAPSHOT_TABLES.includes(s.table as SnapshotTable)) throw new Error(`e2e: bad snapshot ${file}`);
  const sql = connect(marksPages);
  try {
    const types = await columnTypes(sql, s.table);
    await sql.begin(async (tx) => {
      if (s.match) await tx`delete from ${tx(s.table)} where ${tx(s.match.column)} = ${s.match.value}`;
      else await tx`delete from ${tx(s.table)}`;
      for (const row of s.rows) {
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          const type = types[k] ?? "";
          values[k] = v === null ? null : type === "jsonb" ? tx.json(v as postgres.JSONValue) : type.startsWith("timestamp") ? new Date(v as string) : v;
        }
        await tx`insert into ${tx(s.table)} ${tx(values as Record<string, postgres.ParameterOrJSON<never>>)}`;
      }
    });
    rmSync(file);
  } finally {
    await sql.end();
  }
}

/** Restores every rows snapshot a run left behind (global-setup / global-teardown); returns how many there were. */
export async function restoreLeftoverRows(): Promise<number> {
  if (!existsSync(SNAPSHOT_DIR)) return 0;
  const files = readdirSync(SNAPSHOT_DIR).filter((f) => /^rows-.+\.json$/.test(f));
  for (const f of files) await restoreRows(join(SNAPSHOT_DIR, f));
  return files.length;
}

/**
 * Deletes the posts the site editor tests made (of one project, or all); returns how many are left. Not part of
 * removeEditRows: admin-edit.spec.ts and admin-site.spec.ts run side by side, and each cleans up only its own rows.
 */
export async function removePostRows(project?: string): Promise<number> {
  const sql = connect();
  const slugs = `${POST_SLUG_PREFIX}${project ?? ""}%`;
  try {
    await sql`delete from posts where slug like ${slugs}`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from posts where slug like ${slugs}`;
    return n;
  } finally {
    await sql.end();
  }
}

/**
 * Runs SQL on the local test database (a change "made elsewhere" behind an open editor). `marksPages: false` when no public page
 * shows what is written (see connect).
 */
export async function onLocalDb<T>(work: (sql: postgres.Sql) => Promise<T>, opts: { marksPages?: boolean } = {}): Promise<T> {
  const sql = connect(opts.marksPages !== false);
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}
