import { randomBytes, randomInt } from "node:crypto";
import type { Page } from "@playwright/test";
import { accountCourseSlug, holdLocalLock, onLocalDb, sha256Hex, snapshotRows } from "./fixtures";
import { LOCAL_URL, PROD_BUILD, TARGET } from "./target";
import { expect } from "./test";

/** The local database for rows no public page shows (clients, logins, access, terms): writing them does not make every cached page render again (fixtures.ts connect). */
const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

// Signing in to the client account in the e2e tests (local dev server or the local production build only).
//
// Every address is `e2e-client-<label>-<project>@example.test` (clientEmail): a sample address, so nothing is ever mailed,
// and global-setup / global-teardown remove its rows (fixtures.ts removeClientRows). A login row is what
// server/client-auth.ts issueClientLogin stores: the SHA-256 of a random link token, the SHA-256 of `${hash}:${code}` for
// the 6-digit code, the address and 30 minutes.

/** A client login's lifetime (server/client-auth.ts LOGIN_TTL_MS). */
const LOGIN_TTL_MS = 30 * 60_000;

/** The test address of one test: e2e-client-<label>-<project>@example.test (lowercase). */
export function clientEmail(label: string, project: string): string {
  return `e2e-client-${label}-${project}@example.test`.toLowerCase();
}

/** Stores a live login for `email` (in the LOCAL database) with this link token and code, as issueClientLogin would. */
async function storeLogin(email: string, token: string, code: string): Promise<void> {
  const hash = sha256Hex(token);
  await localDb(
    (sql) => sql`insert into client_login_tokens (hash, code_hash, email, expires_at)
                 values (${hash}, ${sha256Hex(`${hash}:${code}`)}, ${email}, ${new Date(Date.now() + LOGIN_TTL_MS)})`,
  );
}

const sixDigits = () => String(randomInt(1_000_000)).padStart(6, "0");

/**
 * Signs `page` in as `email` through the login link: a login stored straight in the local database, then the app's own
 * /api/konto/verify uses it, starts the session (ending any other of this client: one device only) and opens /konto.
 * The same against `next dev` and the local production build (which never hands out a code or link).
 */
export async function signInAsClient(page: Page, email: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await storeLogin(email, token, sixDigits());
  await page.goto(`/api/konto/verify?t=${token}`);
  await expect(page).toHaveURL(/\/konto$/);
  expect((await page.context().cookies()).some((c) => c.name === "__Host-mslab_client"), "session cookie").toBe(true);
}

/**
 * A code that signs `email` in, for the code-entry tests. Against `next dev` it is the `devCode` of a POST /api/konto/login
 * (asked as a visitor of its own: the login limit counts 10 per visitor IP in 10 minutes). The production build never
 * returns one, so there a live login with a code chosen here is stored (the code of the form's own login stays unknown;
 * every live login of the address is tried).
 */
export async function knownLoginCode(email: string): Promise<string> {
  if (PROD_BUILD) {
    const code = sixDigits();
    await storeLogin(email, randomBytes(32).toString("base64url"), code);
    return code;
  }
  const res = await fetch(`${TARGET || LOCAL_URL}/api/konto/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `e2e-code-${Date.now().toString(36)}${randomBytes(3).toString("hex")}` },
    body: JSON.stringify({ email, locale: "et" }),
  });
  expect(res.status, "POST /api/konto/login").toBe(200);
  const { devCode } = (await res.json()) as { devCode?: string };
  expect(devCode, "devCode in the local answer (at most 3 live logins per address)").toMatch(/^\d{6}$/);
  return devCode!;
}

/** Makes every live login of `email` expire a minute ago (the 30 minutes cannot be waited out). */
export async function expireLogins(email: string): Promise<void> {
  await localDb((sql) => sql`update client_login_tokens set expires_at = now() - interval '1 minute' where email = ${email} and used_at is null`);
}

// ---------- the dashboard's rows (account-dashboard.spec.ts) ----------

export type AccountCardKind = "awaiting" | "confirmed" | "confirmed2" | "cancelled" | "practice" | "waitlist" | "ecourse";

export type AccountFixtures = {
  clientId: number;
  /** The test's own course: not published, group price 350 € (so half is 175 €). */
  course: { id: number; slug: string; title: string };
  /** Its one session, about 40 days ahead. */
  session: { id: number; startsAt: Date; city: string };
  registrations: Partial<Record<"awaiting" | "confirmed" | "confirmed2" | "cancelled", number>>;
  requests: Partial<Record<"practice" | "waitlist", number>>;
  /** The published seed e-course the access is to; `expiresAt` when access was granted. */
  ecourse: { slug: string; title: string; expiresAt?: Date };
};

/** The seed e-course the dashboard tests grant access to (access rows change no public page). */
const ECOURSE_SLUG = "kulmumeistri-e-koolitus";

/**
 * A client with the given cards, written straight to the LOCAL database and linked to the client (as a login would link
 * them by e-mail):
 * - awaiting: a group registration, 50 % chosen, nothing paid (→ "tasu ettemaks 175 €" or "Maria saadab sulle arve");
 * - confirmed (and confirmed2, a second one): paid in full, ahead (→ "Koht on kinnitatud." and "Tühista või muuda aega");
 * - cancelled: a cancelled registration (over);
 * - practice: a MINI practice request; waitlist: a waitlist entry for the session;
 * - ecourse: six months of access to the seed e-course (→ "Ava koolitus").
 * The registrations are on the test's own unpublished course (removeClientRows deletes it), so no public seat count moves.
 */
export async function insertAccountFixtures(
  email: string,
  opts: { name?: string; locale?: "et" | "ru"; cards?: AccountCardKind[] } = {},
): Promise<AccountFixtures> {
  const cards = new Set(opts.cards ?? []);
  const slug = accountCourseSlug(email);
  const title = "Kulmude lamineerimine";
  return localDb(async (sql) => {
    const [client] = await sql<{ id: number }[]>`
      insert into clients (email, name, locale) values (${email}, ${opts.name ?? ""}, ${opts.locale ?? "et"}) returning id`;
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published)
      values (${slug}, 'contact', 'basic', ${sql.json({ et: title, ru: "Ламинирование бровей" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 35000, 45000, false)
      returning id`;
    const [session] = await sql<{ id: number; startsAt: Date }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, date_trunc('day', now()) + interval '40 days 8 hours', 'Pärnu', 'MS LAB stuudio', 6)
      returning id, starts_at as "startsAt"`;
    const registration = async (status: string, choice: string, paid: number) => {
      const [row] = await sql<{ id: number }[]>`
        insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status, paid_cents, client_id)
        values (${course.id}, ${session.id}, 'group', ${opts.name || "E2E Õpilane"}, ${email}, '+372 5555 0101', ${choice}, ${status}, ${paid}, ${client.id})
        returning id`;
      return row.id;
    };
    const request = async (kind: string, payload: Record<string, string | number>) => {
      const [row] = await sql<{ id: number }[]>`insert into requests (kind, payload, client_id) values (${kind}, ${sql.json(payload)}, ${client.id}) returning id`;
      return row.id;
    };
    const out: AccountFixtures = {
      clientId: client.id,
      course: { id: course.id, slug, title },
      session: { id: session.id, startsAt: session.startsAt, city: "Pärnu" },
      registrations: {},
      requests: {},
      ecourse: { slug: ECOURSE_SLUG, title: "Kulmumeistri e-koolitus" },
    };
    if (cards.has("awaiting")) out.registrations.awaiting = await registration("awaiting_prepayment", "half", 0);
    if (cards.has("confirmed")) out.registrations.confirmed = await registration("confirmed", "full", 35000);
    if (cards.has("confirmed2")) out.registrations.confirmed2 = await registration("confirmed", "full", 35000);
    if (cards.has("cancelled")) out.registrations.cancelled = await registration("cancelled", "full", 0);
    const name = opts.name || "E2E Õpilane";
    if (cards.has("practice"))
      out.requests.practice = await request("practice", { package: "MINI", name, email, phone: "+372 5555 0101", course: "Kulmumeistri baaskoolitus", times: "Tööpäeviti pärast kella 17", locale: "et" });
    if (cards.has("waitlist")) out.requests.waitlist = await request("waitlist", { session: session.id, course: slug, name, email, locale: "et" });
    if (cards.has("ecourse")) {
      const [access] = await sql<{ expiresAt: Date }[]>`
        insert into course_access (client_id, course_id, granted_by, expires_at)
        select ${client.id}, id, 'e2e', now() + interval '6 months' from courses where slug = ${ECOURSE_SLUG}
        returning expires_at as "expiresAt"`;
      out.ecourse.expiresAt = access.expiresAt;
    }
    return out;
  });
}

/** The prepayment instructions the dashboard tests set (settings key "prepayment"; sample values). */
export const TEST_PREPAYMENT = { receiver: "MS LAB OÜ", iban: "EE38 2200 2210 2014 5685", bank: "Swedbank", referencePrefix: "MSLAB-" };

/** Sets (or, with null, removes) the prepayment instructions in the LOCAL database. */
export async function setPrepayment(value: typeof TEST_PREPAYMENT | null): Promise<void> {
  await localDb(async (sql) => {
    await sql`delete from settings where key = 'prepayment'`;
    if (value) await sql`insert into settings (key, value) values ('prepayment', ${sql.json(value)})`;
  });
}

/** The change requests stored for a client. */
export async function storedChangeRequests(clientId: number): Promise<{ payload: Record<string, unknown> }[]> {
  return localDb((sql) => sql<{ payload: Record<string, unknown> }[]>`select payload from requests where kind = 'change_request' and client_id = ${clientId} order by id`);
}

// ---------- the e-course page and its terms (account-ecourse.spec.ts) ----------

/** The seed e-course (published) the e-course tests open and the cache spec asks for. */
export const SEED_ECOURSE_SLUG = ECOURSE_SLUG;

export type EcourseFixture = {
  clientId: number;
  slug: string;
  title: { et: string; ru: string };
  modules: { et: string; ru: string }[];
  /** When the access ends (six months ahead), null without access. */
  expiresAt: Date | null;
};

/**
 * A client (written straight to the LOCAL database) with six months of access to an e-course, or, with `access: false`, none:
 * - the seed e-course `kulmumeistri-e-koolitus` (published; access rows change no public page), or
 * - `own: true`: the test's own e-course `e2e-konto-<label>-<project>`, not published (removeClientRows deletes it), with two modules.
 */
export async function insertEcourseAccess(email: string, opts: { own?: boolean; access?: boolean; locale?: "et" | "ru"; name?: string } = {}): Promise<EcourseFixture> {
  return localDb(async (sql) => {
    const [client] = await sql<{ id: number }[]>`insert into clients (email, name, locale) values (${email}, ${opts.name ?? ""}, ${opts.locale ?? "et"}) returning id`;
    let slug = ECOURSE_SLUG;
    if (opts.own) {
      slug = accountCourseSlug(email);
      await sql`
        insert into courses (slug, type, level, title, summary, body, price, access_months, published)
        values (${slug}, 'e_learning', 'basic', ${sql.json({ et: "E2E e-koolitus", ru: "E2E онлайн-курс" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false)`;
      const [own] = await sql<{ id: number }[]>`select id from courses where slug = ${slug}`;
      await sql`insert into course_modules (course_id, position, title) values
                (${own.id}, 1, ${sql.json({ et: "Sissejuhatus", ru: "Введение" })}), (${own.id}, 2, ${sql.json({ et: "Praktika", ru: "Практика" })})`;
    }
    const [course] = await sql<{ id: number; title: { et: string; ru?: string } }[]>`select id, title from courses where slug = ${slug}`;
    const modules = await sql<{ title: { et: string; ru?: string } }[]>`select title from course_modules where course_id = ${course.id} order by position, id`;
    let expiresAt: Date | null = null;
    if (opts.access !== false) {
      const [access] = await sql<{ expiresAt: Date }[]>`
        insert into course_access (client_id, course_id, granted_by, expires_at) values (${client.id}, ${course.id}, 'e2e', now() + interval '6 months')
        returning expires_at as "expiresAt"`;
      expiresAt = access.expiresAt;
    }
    return {
      clientId: client.id,
      slug,
      title: { et: course.title.et, ru: course.title.ru ?? course.title.et },
      modules: modules.map(({ title: m }) => ({ et: m.et, ru: m.ru ?? m.et })),
      expiresAt,
    };
  });
}

/** The terms the e-course tests start from (ET and RU, two paragraphs in Estonian). */
export const E2E_TERMS = { et: "E2E tingimused: ligipääs on isiklik.\n\nÄra jaga seda teistega.", ru: "E2E условия: доступ личный.\n\nНе передавайте его другим." };

const TERMS_LOCK = "e2e-course-terms";
let termsStamp = 0;

/**
 * Writes the terms like an admin's save would, but straight to the LOCAL database: the `course_terms` page text, and the version
 * (settings `courseTermsVersion`) as the time of the save; `version: null` leaves the key out (the version reads as "1").
 * Returns the version stored (a new, never repeated ISO time unless asked for another).
 */
export async function setTerms(body: { et: string; ru?: string }, version: string | null | undefined = undefined): Promise<string | null> {
  const stored = version === undefined ? new Date(Date.now() + ++termsStamp).toISOString() : version;
  await localDb(async (sql) => {
    await sql`
      insert into pages (key, title, body) values ('course_terms', ${sql.json({ et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" })}, ${sql.json(body)})
      on conflict (key) do update set body = excluded.body`;
    await sql`delete from settings where key = 'courseTermsVersion'`;
    if (stored !== null) await sql`insert into settings (key, value) values ('courseTermsVersion', ${sql.json(stored)})`;
  });
  return stored;
}

/** Takes the terms page out (no text stored: nothing to accept); takeTerms puts the original back afterwards. */
export async function removeTermsPage(): Promise<void> {
  await localDb((sql) => sql`delete from pages where key = 'course_terms'`);
}

/** The version the students are asked about now: the stored settings value, "1" when there is none. */
export async function currentTermsVersion(): Promise<string> {
  const [row] = await localDb((sql) => sql<{ value: unknown }[]>`select value from settings where key = 'courseTermsVersion'`);
  return typeof row?.value === "string" && row.value ? row.value : "1";
}

/** The terms a client has accepted: course slug and version, oldest first. */
export async function storedAcceptances(clientId: number): Promise<{ slug: string; version: string }[]> {
  return localDb(
    (sql) => sql<{ slug: string; version: string }[]>`
      select c.slug, t.terms_version as version from terms_acceptances t join courses c on c.id = t.course_id where t.client_id = ${clientId} order by t.accepted_at, t.terms_version`,
  );
}

/**
 * Takes the terms for one test. The terms text and version are shared by every client of the site, and the desktop and phone runs
 * go side by side, so they take turns (a Postgres advisory lock). The page and the version are snapshotted, set to E2E_TERMS with no
 * version ("1"), and put back by the function this returns (which also gives the lock back).
 */
export async function takeTerms(): Promise<() => Promise<void>> {
  const unlock = await holdLocalLock(TERMS_LOCK);
  try {
    const restorePage = await snapshotRows("pages", { column: "key", value: "course_terms" }, { marksPages: false });
    const restoreVersion = await snapshotRows("settings", { column: "key", value: "courseTermsVersion" }, { marksPages: false });
    await setTerms(E2E_TERMS, null);
    return async () => {
      try {
        await restorePage();
        await restoreVersion();
      } finally {
        await unlock();
      }
    };
  } catch (e) {
    await unlock();
    throw e;
  }
}

// ---------- favourites and my details (account-favourites.spec.ts, account-details.spec.ts) ----------

/** Published seed courses the favourites tests heart (a heart changes no public page). */
export const SEED_FAVOURITES = { lami: { slug: "kulmude-lami", title: "Kulmude LAMI" }, botox: { slug: "lash-lift-botox", title: "Lash Lift BOTOX baaskoolitus" } };

/** A client of its own (written straight to the LOCAL database) with no cards; its id. */
export async function insertClient(email: string, opts: { name?: string; phone?: string; locale?: "et" | "ru" } = {}): Promise<number> {
  const [row] = await localDb(
    (sql) => sql<{ id: number }[]>`insert into clients (email, name, phone, locale) values (${email}, ${opts.name ?? ""}, ${opts.phone ?? ""}, ${opts.locale ?? "et"}) returning id`,
  );
  return row.id;
}

/** Hearts these courses for the client, the first one first (so the last one is the newest). */
export async function addFavourites(clientId: number, slugs: string[]): Promise<void> {
  await localDb(async (sql) => {
    for (const [i, slug] of slugs.entries())
      await sql`insert into client_favourites (client_id, course_id, created_at)
                select ${clientId}, id, now() - ${`${slugs.length - i} minutes`}::interval from courses where slug = ${slug}`;
  });
}

/** The client's favourites as stored, newest first. */
export async function storedFavourites(clientId: number): Promise<string[]> {
  const rows = await localDb(
    (sql) => sql<{ slug: string }[]>`select c.slug from client_favourites f join courses c on c.id = f.course_id where f.client_id = ${clientId} order by f.created_at desc, c.slug`,
  );
  return rows.map((r) => r.slug);
}

/** The client row of an address (null when there is none). */
export async function storedClient(email: string): Promise<{ id: number; name: string; phone: string; locale: string } | null> {
  const [row] = await localDb((sql) => sql<{ id: number; name: string; phone: string; locale: string }[]>`select id, name, phone, locale from clients where email = ${email}`);
  return row ?? null;
}

/** The access of an address to an e-course (null when there is none): who gave it, whether an admin ended it, and until when (phase 2b: "payment"). */
export async function storedAccess(email: string, slug: string): Promise<{ grantedBy: string; revoked: boolean; expiresAt: Date } | null> {
  const [row] = await localDb(
    (sql) => sql<{ grantedBy: string; revoked: boolean; expiresAt: Date }[]>`
      select a.granted_by as "grantedBy", a.revoked_at is not null as revoked, a.expires_at as "expiresAt"
        from course_access a join clients c on c.id = a.client_id join courses k on k.id = a.course_id
       where c.email = ${email} and k.slug = ${slug}`,
  );
  return row ?? null;
}

/** The stored password of an address (phase 2c): the scrypt hash and the time of its last change; both null without one. */
export async function storedPassword(email: string): Promise<{ hash: string | null; changedAt: Date | null }> {
  const [row] = await localDb(
    (sql) => sql<{ hash: string | null; changedAt: Date | null }[]>`select password_hash as hash, password_changed_at as "changedAt" from clients where email = ${email}`,
  );
  return row ?? { hash: null, changedAt: null };
}

/** The newsletter row of an address (any case), or null. */
export async function storedNewsletter(email: string): Promise<{ email: string; confirmed: boolean; clientId: number | null } | null> {
  const [row] = await localDb(
    (sql) => sql<{ email: string; confirmed: boolean; clientId: number | null }[]>`
      select email, confirmed_at is not null as confirmed, client_id as "clientId" from subscribers where lower(email) = ${email.toLowerCase()}`,
  );
  return row ?? null;
}

/** Ends every open session of the client as another device's login would (the browser keeps its cookies: its next request is a 401). */
export async function endClientSessions(clientId: number): Promise<void> {
  await localDb((sql) => sql`update client_sessions set ended_at = now(), end_reason = 'replaced' where client_id = ${clientId} and ended_at is null`);
}

/** A registration as Maria keeps it: its client link and address (null when it is gone). */
export async function storedRegistration(id: number): Promise<{ clientId: number | null; email: string; name: string } | null> {
  const [row] = await localDb((sql) => sql<{ clientId: number | null; email: string; name: string }[]>`select client_id as "clientId", email, name from registrations where id = ${id}`);
  return row ?? null;
}

/** The password lock's counter of an address (phase 2c: rl:pw-mail:<sha256 of the address>, 15 minutes) cleared, so a test starts without one. */
export async function clearPasswordLock(email: string): Promise<void> {
  await localDb((sql) => sql`delete from kv_entries where key = ${`rl:pw-mail:${sha256Hex(email.trim().toLowerCase())}`}`);
}
