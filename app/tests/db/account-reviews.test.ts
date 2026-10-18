import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseFeedback, courses, reviews } from "@/db/schema";
import type { ContactCard } from "@/domain/account-cards";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { revalidationTargets, type PublicChange } from "@/server/cache-targets";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { deleteClient, loadDashboard } from "@/server/client-data";
import type { Env } from "@/server/notify";
import { courseReviews, homeReviews } from "@/server/reviews";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";
import { protocolCourse, student } from "./protocols-fixtures";
import { contactStudent, graduate, NOW, RECOMMEND, studentOf, submit } from "./reviews-fixtures";

// The student's side of the reviews (student reviews, Task 3; spec D1, D3, D6): the e-course form by its slug and the consent in the contact and
// the e-course submit, the dashboard's e-course prompts and each card's `review`, „Võta luba tagasi“ (POST /arvustus/tagasi) and the public pages'
// refresh when a review goes, and the account deletion that takes the reviews with it (Review Focus 1 and 4).

const SITE = "https://mslab.example";
const E_SLUG = "kulmud-e";
let db: Db;
let env: Env;
/** Every public change the routes announced, in order. */
let changes: PublicChange[];
beforeEach(async () => {
  db = await makeTestDb();
  env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE };
  changes = [];
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function deps(over: Partial<AccountDeps> = {}) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: AccountDeps = { db, env, now: NOW, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false, changed: (change) => void changes.push(change), ...over };
  return { d, queued: () => tasks.length };
}
async function cookieOf(clientId: number): Promise<string> {
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return `__Host-mslab_client=${raw}`;
}
const call = async (d: AccountDeps, cookie: string, path: string, body?: unknown) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) }),
    d,
  ))!;
const answer = async (res: Response) => [res.status, await res.json()];
const reviewRows = () => db.select().from(reviews);
const feedbackRows = () => db.select().from(courseFeedback);
const ANSWERS = { score: 9, recommend: RECOMMEND };

describe("the e-course form, by its slug", () => {
  test("GET ?kursus=: the course, whether she answered and the name to offer; before the course is completed, for another client's access, a contact course's slug, an unknown one, or id and kursus together: 404", async () => {
    const kati = await graduate(db);
    const cookie = await cookieOf(kati.client.id);
    expect(await answer(await call(deps().d, cookie, `/tagasiside?kursus=${E_SLUG}`))).toEqual([
      200,
      { ok: true, course: { slug: E_SLUG, title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } }, sent: false, shownName: "Kati K." },
    ]);
    const mari = await contactStudent(db);
    for (const query of [`kursus=${mari.course.slug}`, "kursus=olematu", "kursus=", `kursus=${E_SLUG}&id=${mari.registration.id}`, `id=${mari.registration.id}`]) {
      expect((await call(deps().d, cookie, `/tagasiside?${query}`)).status, query).toBe(404);
    }
    const other = await cookieOf(mari.client.id);
    expect((await call(deps().d, other, `/tagasiside?kursus=${E_SLUG}`)).status).toBe(404);
    await db.update(courseAccess).set({ completedAt: null }).where(eq(courseAccess.id, kati.access.id));
    expect((await call(deps().d, cookie, `/tagasiside?kursus=${E_SLUG}`)).status).toBe(404);
  });

  test("POST { kursus, consent }: the answers and a pending review of the recommend answer in her language; Maria is told after the response; a second one is 409 and makes no second review", async () => {
    const kati = await graduate(db);
    const cookie = await cookieOf(kati.client.id);
    const { d, queued } = deps();
    expect(await answer(await call(d, cookie, "/tagasiside", { kursus: E_SLUG, locale: "ru", answers: ANSWERS, consent: { name: "  Kati   K. " } }))).toEqual([200, { ok: true }]);
    expect(await feedbackRows()).toMatchObject([{ accessId: kati.access.id, registrationId: null, locale: "ru" }]);
    expect(await reviewRows()).toMatchObject([{ kind: "student", status: "pending", name: "Kati K.", text: RECOMMEND, locale: "ru", courseId: kati.course.id, featured: false }]);
    expect(queued()).toBe(1);
    expect(await answer(await call(d, cookie, "/tagasiside", { kursus: E_SLUG, locale: "et", answers: { score: 3, recommend: "Teine kord" }, consent: { name: "Kati K." } }))).toEqual([409, { ok: false, error: "sent" }]);
    expect(await reviewRows()).toHaveLength(1);
    expect(queued()).toBe(1);
    expect(changes).toEqual([]); // a pending review shows nowhere: nothing to refresh
  });

  test("consent: null, or none sent: the answers only, no review (an answer given without the tick never becomes one)", async () => {
    const kati = await graduate(db);
    const cookie = await cookieOf(kati.client.id);
    expect(await answer(await call(deps().d, cookie, "/tagasiside", { kursus: E_SLUG, locale: "et", answers: ANSWERS, consent: null }))).toEqual([200, { ok: true }]);
    expect(await feedbackRows()).toHaveLength(1);
    expect(await reviewRows()).toEqual([]);
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp" });
    expect((await call(deps().d, await cookieOf(liis.client.id), "/tagasiside", { kursus: "ripsmed-e", locale: "et", answers: ANSWERS })).status).toBe(200);
    expect(await reviewRows()).toEqual([]);
  });

  test("the tick with no recommend text is 400 consentText, with no name or a name over 40 characters 400 consentName; nothing is stored and the form is still open", async () => {
    const kati = await graduate(db);
    const cookie = await cookieOf(kati.client.id);
    const post = (answers: unknown, consent: unknown) => call(deps().d, cookie, "/tagasiside", { kursus: E_SLUG, locale: "et", answers, consent });
    expect(await answer(await post({ score: 9 }, { name: "Kati K." }))).toEqual([400, { ok: false, error: "consentText" }]);
    expect(await answer(await post({ score: 9, recommend: "   " }, { name: "Kati K." }))).toEqual([400, { ok: false, error: "consentText" }]);
    expect(await answer(await post(ANSWERS, { name: "" }))).toEqual([400, { ok: false, error: "consentName" }]);
    expect(await answer(await post(ANSWERS, { name: "   " }))).toEqual([400, { ok: false, error: "consentName" }]);
    expect(await answer(await post(ANSWERS, { name: "K".repeat(41) }))).toEqual([400, { ok: false, error: "consentName" }]);
    expect(await feedbackRows()).toEqual([]);
    expect(await reviewRows()).toEqual([]);
    expect((await call(deps().d, cookie, `/tagasiside?kursus=${E_SLUG}`)).status).toBe(200);
    expect(await answer(await post(ANSWERS, { name: "K".repeat(40) }))).toEqual([200, { ok: true }]); // 40 is the limit
  });

  test("a consent that is no { name } (a string, a number for the name, an array) and a target that is none or two are 400 and name the field", async () => {
    const kati = await graduate(db);
    const cookie = await cookieOf(kati.client.id);
    const post = (body: Record<string, unknown>) => call(deps().d, cookie, "/tagasiside", { locale: "et", answers: ANSWERS, ...body });
    expect(await answer(await post({ kursus: E_SLUG, consent: "yes" }))).toEqual([400, { ok: false, error: "consent" }]);
    expect(await answer(await post({ kursus: E_SLUG, consent: { name: 5 } }))).toEqual([400, { ok: false, error: "consent" }]);
    expect(await answer(await post({ kursus: E_SLUG, consent: [] }))).toEqual([400, { ok: false, error: "consent" }]);
    expect(await answer(await post({ consent: null }))).toEqual([400, { ok: false, error: "target" }]);
    expect(await answer(await post({ id: 1, kursus: E_SLUG, consent: null }))).toEqual([400, { ok: false, error: "target" }]);
    expect(await answer(await post({ id: "x", consent: null }))).toEqual([400, { ok: false, error: "id" }]);
    expect(await answer(await post({ kursus: "", consent: null }))).toEqual([400, { ok: false, error: "kursus" }]);
    expect(await answer(await post({ registrationId: 1, consent: null }))).toEqual([400, { ok: false, error: "target" }]);
    expect(await feedbackRows()).toEqual([]);
  });

  test("another client's course, a course not completed, a revoked access: 404, nothing stored", async () => {
    const kati = await graduate(db);
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp", completed: false });
    const mari = await graduate(db, { slug: "varvid-e", email: "mari@example.test", name: "Mari Maasikas", revoked: true });
    const body = (kursus: string) => ({ kursus, locale: "et", answers: ANSWERS, consent: { name: "X." } });
    expect(await answer(await call(deps().d, await cookieOf(kati.client.id), "/tagasiside", body("ripsmed-e")))).toEqual([404, { ok: false, error: "registration" }]);
    expect((await call(deps().d, await cookieOf(liis.client.id), "/tagasiside", body("ripsmed-e"))).status).toBe(404);
    expect((await call(deps().d, await cookieOf(mari.client.id), "/tagasiside", body("varvid-e"))).status).toBe(404);
    expect(await feedbackRows()).toEqual([]);
  });

  test("a contact course: { id, consent } makes the review too, { registrationId } is no longer the key", async () => {
    const mari = await contactStudent(db);
    const cookie = await cookieOf(mari.client.id);
    const id = mari.registration.id;
    expect((await call(deps().d, cookie, "/tagasiside", { registrationId: id, locale: "et", answers: ANSWERS, consent: null })).status).toBe(400);
    expect(await answer(await call(deps().d, cookie, "/tagasiside", { id, locale: "et", answers: ANSWERS, consent: { name: "Mari M." } }))).toEqual([200, { ok: true }]);
    expect(await reviewRows()).toMatchObject([{ kind: "student", status: "pending", name: "Mari M.", text: RECOMMEND }]);
  });

  test("'Ei soovi' by the slug: the e-course's card is gone for good; not hers or not completed: 404; the limit is the feedback's", async () => {
    const kati = await graduate(db);
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp", completed: false });
    const cookie = await cookieOf(kati.client.id);
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback).toEqual([{ target: { courseSlug: E_SLUG }, course: { slug: E_SLUG, title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } } }]);
    expect((await call(deps().d, cookie, "/tagasiside/peida", { kursus: "ripsmed-e" })).status).toBe(404);
    expect((await call(deps().d, await cookieOf(liis.client.id), "/tagasiside/peida", { kursus: "ripsmed-e" })).status).toBe(404);
    expect(await answer(await call(deps().d, cookie, "/tagasiside/peida", { kursus: E_SLUG }))).toEqual([200, { ok: true }]);
    expect(await feedbackRows()).toMatchObject([{ accessId: kati.access.id, submittedAt: null }]);
    expect(await reviewRows()).toEqual([]);
    expect(await loadDashboard(db, kati.client.id, NOW)).not.toHaveProperty("feedback");
    // she may still answer, from the mail's or the page's address
    expect((await call(deps().d, cookie, "/tagasiside", { kursus: E_SLUG, locale: "et", answers: ANSWERS, consent: null })).status).toBe(200);
  });
});

describe("the dashboard", () => {
  test("a completed e-course with no feedback row is a prompt; not completed, revoked, answered or dismissed: none; the contact one has its registration as the target", async () => {
    const kati = await graduate(db);
    const course = { slug: E_SLUG, title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } };
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback).toEqual([{ target: { courseSlug: E_SLUG }, course }]);
    await db.update(courseAccess).set({ completedAt: null }).where(eq(courseAccess.id, kati.access.id));
    expect(await loadDashboard(db, kati.client.id, NOW)).not.toHaveProperty("feedback");
    await db.update(courseAccess).set({ completedAt: new Date("2026-10-10T09:00:00Z"), revokedAt: new Date("2026-10-11T09:00:00Z") }).where(eq(courseAccess.id, kati.access.id));
    expect(await loadDashboard(db, kati.client.id, NOW)).not.toHaveProperty("feedback");
    await db.update(courseAccess).set({ revokedAt: null }).where(eq(courseAccess.id, kati.access.id));
    await submit(db, kati.client.id, { courseSlug: E_SLUG }, null);
    expect(await loadDashboard(db, kati.client.id, NOW)).not.toHaveProperty("feedback");
    await db.delete(courseFeedback);
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback).toHaveLength(1);
    await db.insert(courseFeedback).values({ accessId: kati.access.id, dismissedAt: NOW });
    expect(await loadDashboard(db, kati.client.id, NOW)).not.toHaveProperty("feedback");
    const mari = await contactStudent(db);
    expect((await loadDashboard(db, mari.client.id, NOW))!.feedback).toEqual([{ target: { registrationId: mari.registration.id }, course: { slug: mari.course.slug, title: mari.course.title } }]);
  });

  test("an access that has ended (expires_at past) but was completed still asks", async () => {
    const kati = await graduate(db);
    await db.update(courseAccess).set({ expiresAt: new Date("2026-10-11T00:00:00Z") }).where(eq(courseAccess.id, kati.access.id));
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback).toHaveLength(1);
  });

  test("a contact course and an e-course together: one list, the latest first", async () => {
    const kati = await graduate(db);
    const { course, session } = await protocolCourse(db);
    const registration = await student(db, course, session, "Kati Kask", { clientId: kati.client.id, email: "kati@example.test" });
    // the course day 12.10 is later than the e-course's completion on 10.10
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback!.map((p) => ("registrationId" in p.target ? p.target.registrationId : p.target.courseSlug))).toEqual([registration.id, E_SLUG]);
    await db.update(courseAccess).set({ completedAt: new Date("2026-10-12T20:00:00Z") }).where(eq(courseAccess.id, kati.access.id));
    expect((await loadDashboard(db, kati.client.id, NOW))!.feedback!.map((p) => ("registrationId" in p.target ? p.target.registrationId : p.target.courseSlug))).toEqual([E_SLUG, registration.id]);
  });

  test("each contact and e-course card has `review`: { id } while her review exists, else null; never another student's, never a manual one", async () => {
    const kati = await graduate(db);
    const { course, session } = await protocolCourse(db);
    const registration = await student(db, course, session, "Kati Kask", { clientId: kati.client.id, email: "kati@example.test" });
    const mari = await studentOf(db, course, session, "Mari Maasikas");
    const cards = async (clientId: number) => {
      const all = (await loadDashboard(db, clientId, NOW))!.cards;
      return { contact: all.find((c): c is ContactCard => c.kind === "contact"), ecourse: all.find((c) => c.kind === "ecourse") };
    };
    expect(await cards(kati.client.id)).toMatchObject({ contact: { review: null }, ecourse: { review: null } });
    // Mari consents; Kati answers the contact form without the tick and the e-course form with it
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    await db.insert(reviews).values({ courseId: course.id, feedbackId: null, kind: "manual", text: "Käsitsi lisatud", name: "Anu A.", locale: "et", writtenAt: NOW, status: "published", note: "paberil" });
    await submit(db, kati.client.id, { registrationId: registration.id }, null);
    await submit(db, kati.client.id, { courseSlug: E_SLUG }, { name: "Kati K." });
    const [katiReview] = await db.select().from(reviews).where(eq(reviews.courseId, kati.course.id));
    expect(await cards(kati.client.id)).toMatchObject({ contact: { review: null }, ecourse: { review: { id: katiReview.id } } });
    const [marisReview] = await db.select().from(reviews).where(eq(reviews.feedbackId, (await feedbackRows()).find((f) => f.registrationId === mari.registration.id)!.id));
    expect((await cards(mari.client.id)).contact).toMatchObject({ review: { id: marisReview.id } });
    expect(Object.keys((await cards(mari.client.id)).contact!.review!)).toEqual(["id"]); // nothing of Maria's choices
    // a published or hidden review is still hers to take back: the card does not say which it is
    await db.update(reviews).set({ status: "hidden" }).where(eq(reviews.id, marisReview.id));
    expect((await cards(mari.client.id)).contact).toMatchObject({ review: { id: marisReview.id } });
    // Kati's contact answer, given later with the tick, is a review too
    await db.delete(courseFeedback).where(eq(courseFeedback.registrationId, registration.id));
    await submit(db, kati.client.id, { registrationId: registration.id }, { name: "Kati K." });
    expect((await cards(kati.client.id)).contact).toMatchObject({ review: { id: expect.any(Number) } });
  });
});

describe("„Võta luba tagasi“: POST /arvustus/tagasi", () => {
  /** Mari's published, featured review of the contact course, and Kati's of the e-course. */
  async function published() {
    const mari = await contactStudent(db);
    const kati = await graduate(db);
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    await submit(db, kati.client.id, { courseSlug: E_SLUG }, { name: "Kati K." });
    await db.update(reviews).set({ status: "published", featured: true, decidedAt: NOW });
    const rows = await reviewRows();
    return { mari, kati, marisReview: rows.find((r) => r.courseId === mari.course.id)!, katisReview: rows.find((r) => r.courseId === kati.course.id)! };
  }

  test("Review Focus 1: a published, featured review of a contact course: the row is gone, her answers stay, the course's pages and the home page are refreshed, and no public read lists it", async () => {
    const { mari, marisReview } = await published();
    const q = db;
    expect((await courseReviews(q, mari.course.id)).map((r) => r.name)).toEqual(["Mari M."]);
    expect((await homeReviews(q)).map((r) => r.name).sort()).toEqual(["Kati K.", "Mari M."]);
    const { d } = deps();
    expect(await answer(await call(d, await cookieOf(mari.client.id), "/arvustus/tagasi", { reviewId: marisReview.id }))).toEqual([200, { ok: true }]);
    expect((await reviewRows()).map((r) => r.name)).toEqual(["Kati K."]);
    expect(await feedbackRows()).toHaveLength(2); // her answers stay with Maria
    expect(changes).toEqual([{ kind: "reviews", course: "kulmude-lami" }]);
    expect(revalidationTargets(changes[0]).map((t) => t.path)).toEqual(["/et/koolitused/kulmude-lami", "/ru/koolitused/kulmude-lami", "/[locale]/(site)"]);
    expect(await courseReviews(q, mari.course.id)).toEqual([]);
    expect((await homeReviews(q)).map((r) => r.name)).toEqual(["Kati K."]);
  });

  test("an e-course's review: the same, with the e-course's slug", async () => {
    const { kati, katisReview } = await published();
    expect(await answer(await call(deps().d, await cookieOf(kati.client.id), "/arvustus/tagasi", { reviewId: katisReview.id }))).toEqual([200, { ok: true }]);
    expect(changes).toEqual([{ kind: "reviews", course: E_SLUG }]);
    expect((await reviewRows()).map((r) => r.name)).toEqual(["Mari M."]);
  });

  test("a pending or hidden review is deleted too; the refresh is announced for each (the status is Maria's, the student does not know it)", async () => {
    const { mari, marisReview } = await published();
    await db.update(reviews).set({ status: "pending", featured: false }).where(eq(reviews.id, marisReview.id));
    expect((await call(deps().d, await cookieOf(mari.client.id), "/arvustus/tagasi", { reviewId: marisReview.id })).status).toBe(200);
    expect(changes).toHaveLength(1);
  });

  test("not hers (another student's, a manual one, one that does not exist, one already withdrawn): 404 and nothing changes, nothing is refreshed", async () => {
    const { mari, kati, marisReview, katisReview } = await published();
    const [manual] = await db.insert(reviews).values({ courseId: mari.course.id, feedbackId: null, kind: "manual", text: "Käsitsi", name: "Anu A.", locale: "et", writtenAt: NOW, status: "published", note: "paberil" }).returning();
    const press = async (clientId: number, reviewId: number) => answer(await call(deps().d, await cookieOf(clientId), "/arvustus/tagasi", { reviewId }));
    expect(await press(kati.client.id, marisReview.id)).toEqual([404, { ok: false, error: "review" }]);
    expect(await press(mari.client.id, katisReview.id)).toEqual([404, { ok: false, error: "review" }]);
    expect((await press(mari.client.id, manual.id))[0]).toBe(404);
    expect((await press(kati.client.id, manual.id))[0]).toBe(404);
    expect((await press(mari.client.id, 999_999))[0]).toBe(404);
    expect(await reviewRows()).toHaveLength(3);
    expect(changes).toEqual([]);
    expect((await press(mari.client.id, marisReview.id))[0]).toBe(200);
    expect((await press(mari.client.id, marisReview.id))[0]).toBe(404); // a second press (another tab) finds it gone
    expect(changes).toHaveLength(1);
  });

  test("a body that is no { reviewId } is 400 and names the field; signed out is 401; a review id from another client's cookie is not told apart from none", async () => {
    const { mari } = await published();
    const cookie = await cookieOf(mari.client.id);
    for (const body of [{}, { reviewId: "7" }, { reviewId: 0 }, { reviewId: 1.5 }, { reviewId: -1 }, { reviewId: null }, { id: 1 }]) {
      expect(await answer(await call(deps().d, cookie, "/arvustus/tagasi", body)), JSON.stringify(body)).toEqual([400, { ok: false, error: "reviewId" }]);
    }
    expect((await call(deps().d, "", "/arvustus/tagasi", { reviewId: 1 })).status).toBe(401);
    expect(await reviewRows()).toHaveLength(2);
  });

  test("it shares the feedback's limit of ten an hour: after ten, 429 and the review stays", async () => {
    const { mari, marisReview } = await published();
    const cookie = await cookieOf(mari.client.id);
    const { d } = deps();
    for (let i = 0; i < 10; i++) expect((await call(d, cookie, "/tagasiside/peida", { id: mari.registration.id })).status).toBe(200);
    expect(await answer(await call(d, cookie, "/arvustus/tagasi", { reviewId: marisReview.id }))).toEqual([429, { ok: false, error: "rate" }]);
    expect(await reviewRows()).toHaveLength(2);
    expect(changes).toEqual([]);
  });

  test("a refresh that fails does not undo the withdrawal or fail the answer; with no refresh given (a test, a script) it answers the same; the log has ids only", async () => {
    const { mari, kati, marisReview, katisReview } = await published();
    const failing = deps({ changed: () => Promise.reject(new Error("no cache")) });
    expect((await call(failing.d, await cookieOf(mari.client.id), "/arvustus/tagasi", { reviewId: marisReview.id })).status).toBe(200);
    expect((await reviewRows()).map((r) => r.id)).toEqual([katisReview.id]);
    const bare = deps({ changed: undefined });
    expect((await call(bare.d, await cookieOf(kati.client.id), "/arvustus/tagasi", { reviewId: katisReview.id })).status).toBe(200);
    expect(await reviewRows()).toEqual([]);
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).toContain(`review ${marisReview.id}: withdrawn`);
    for (const secret of ["Mari", "Kati", RECOMMEND]) expect(logged, secret).not.toContain(secret);
  });
});

describe("Review Focus 4: she deletes her account", () => {
  /** Kati: a contact registration with a published review and an e-course with a featured one; Mari has a published review on the contact course. */
  async function everything() {
    const kati = await graduate(db);
    const { course, session } = await protocolCourse(db);
    const registration = await student(db, course, session, "Kati Kask", { clientId: kati.client.id, email: "kati@example.test" });
    const mari = await studentOf(db, course, session, "Mari Maasikas");
    await submit(db, kati.client.id, { registrationId: registration.id }, { name: "Kati K." });
    await submit(db, kati.client.id, { courseSlug: E_SLUG }, { name: "Kati K." });
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    await db.update(reviews).set({ status: "published", decidedAt: NOW });
    await db.update(reviews).set({ featured: true }).where(eq(reviews.courseId, kati.course.id));
    return { kati, mari, course, session, registration };
  }

  test("deleteClient names the courses of her reviews, once each, and the reviews go with her answers; another student's stay", async () => {
    const { kati, mari, course } = await everything();
    expect(await reviewRows()).toHaveLength(3);
    const gone = await deleteClient(db, kati.client.id);
    expect(gone).toMatchObject({ email: "kati@example.test" });
    expect([...gone!.reviewCourses].sort()).toEqual([E_SLUG, "kulmude-lami"]);
    expect(await reviewRows()).toMatchObject([{ name: "Mari M.", courseId: course.id }]);
    expect(await feedbackRows()).toMatchObject([{ registrationId: mari.registration.id }]);
    expect(await courseReviews(db, course.id)).toHaveLength(1);
    expect(await homeReviews(db)).toEqual([]); // the featured one was Kati's e-course review
  });

  test("two registrations of one course with a review each: the course once; no review, no course", async () => {
    const { kati, course, session } = await everything();
    const again = await student(db, course, session, "Kati Kask", { clientId: kati.client.id, email: "kati@example.test" });
    await submit(db, kati.client.id, { registrationId: again.id }, { name: "Kati K." });
    const gone = await deleteClient(db, kati.client.id);
    expect([...gone!.reviewCourses].sort()).toEqual([E_SLUG, "kulmude-lami"]);
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp" });
    await submit(db, liis.client.id, { courseSlug: "ripsmed-e" }, null); // answered without the tick: no review
    expect(await deleteClient(db, liis.client.id)).toMatchObject({ reviewCourses: [] });
  });

  test("POST /kustuta: the public pages of each course with a review are refreshed after the commit, once each; the answer is 200", async () => {
    const { kati } = await everything();
    // (what the refresh finds in the database when it runs: the reviews are gone already)
    const seen: number[] = [];
    const { d } = deps({ changed: async (change) => { changes.push(change); seen.push((await reviewRows()).filter((r) => r.name === "Kati K.").length); } });
    expect(await answer(await call(d, await cookieOf(kati.client.id), "/kustuta", { confirm: true }))).toEqual([200, { ok: true }]);
    expect(changes.map((c) => (c.kind === "reviews" ? c.course : c.kind)).sort()).toEqual([E_SLUG, "kulmude-lami"]);
    expect(seen).toEqual([0, 0]);
    expect(await reviewRows()).toHaveLength(1);
  });

  test("an account with no review refreshes nothing; a refresh that fails does not fail the deletion", async () => {
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp" });
    expect((await call(deps().d, await cookieOf(liis.client.id), "/kustuta", { confirm: true })).status).toBe(200);
    expect(changes).toEqual([]);
    const { kati } = await everything();
    const failing = deps({ changed: () => { throw new Error("no cache"); } });
    expect((await call(failing.d, await cookieOf(kati.client.id), "/kustuta", { confirm: true })).status).toBe(200);
    expect(await db.select().from(clients).where(eq(clients.id, kati.client.id))).toEqual([]);
    expect(await db.select({ id: courses.id }).from(courses)).toHaveLength(3); // (the courses stay)
  });
});
