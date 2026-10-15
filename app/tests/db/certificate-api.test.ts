import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, clients, clientSessions, courseAccess, courseModules, courses, lessonProgress, lessons } from "@/db/schema";
import { handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { issueCertificate } from "@/server/certificates";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard, loadEcourse } from "@/server/client-data";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The certificate's two endpoints of the account API (phase 3d, spec §5) against a real (PGlite) database:
// - POST /kursus/<slug>/tunnistus makes it once, with the name she confirmed (200, then 409 "already" with the same one), with its refusals
//   and its limit;
// - GET /tunnistus/<id> answers with the PDF as a download named by its number: hers only, also after her access has ended, never once it
//   is revoked (Review Focus 5);
// - the e-course page's data and the dashboard card carry it.
// The issue's own rules are server/certificates.ts's (tests/db/certificates.test.ts).

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const ISSUE = "/kursus/veebikursus/tunnistus";

let db: Db;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The account API's dependencies: an empty store (the certificate reads none), `later` dropping its tasks (nothing is mailed here). */
const deps = (over: Partial<AccountDeps> = {}): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
  files: fakeMediaStore(),
  ...over,
});

/** A client named `name` with one live session. `renewing`: the session was last renewed two days ago, so the next request renews it. */
async function student(email: string, name: string, renewing = false) {
  const [client] = await db.insert(clients).values({ email, name }).returning();
  const raw = newToken();
  const expiresAt = new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS - (renewing ? 2 * DAY : 0));
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt });
  return { id: client.id, raw, cookie: `__Host-mslab_client=${raw}` };
}

/**
 * The e-course "veebikursus" (one text lesson, two "Mida õpid" lines). Kati Kask has six months of access, which she completed yesterday
 * (`over` changes it), and the lesson done. `grant` gives another student the same.
 */
async function world(over: Partial<typeof courseAccess.$inferInsert> = {}, renewing = false) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500, outcomes: [{ et: "Kulmude kuju" }, { et: "Värvimine" }] })
    .returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Teooria" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Tekst" }, kind: "text" }).returning();
  const grant = async (clientId: number, access: Partial<typeof courseAccess.$inferInsert> = {}) => {
    const [a] = await db
      .insert(courseAccess)
      .values({ clientId, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), completedAt: new Date(NOW.getTime() - DAY), ...access })
      .returning();
    await db.insert(lessonProgress).values({ clientId, lessonId: lesson.id, doneAt: NOW });
    return a;
  };
  const kati = await student("kati@example.test", "Kati Kask", renewing);
  const access = await grant(kati.id, over);
  return { course, kati, access, grant };
}

const call = async (cookie: string | null, method: string, path: string, body?: unknown, d: AccountDeps = deps()) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, {
      method,
      headers: cookie ? { cookie } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    d,
  ))!;
/** Her certificate made through the API: its id. */
const issue = async (cookie: string) => ((await (await call(cookie, "POST", ISSUE, { name: "Kati Kask" })).json()) as { certificate: { id: number } }).certificate.id;

describe("POST /kursus/:slug/tunnistus", () => {
  test("her name confirmed: 200 with the certificate (private, never cached); asked again, 409 'already' with the same one", async () => {
    const w = await world();
    const res = await call(w.kati.cookie, "POST", ISSUE, { name: "  Kati   Kask " });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { ok: boolean; certificate: unknown };
    expect(body).toEqual({ ok: true, certificate: { id: expect.any(Number), number: "MS LAB 2026-01", name: "Kati Kask", issuedAt: NOW.toISOString(), reissuedAt: null } });
    const again = await call(w.kati.cookie, "POST", ISSUE, { name: "Katrin Kask" });
    expect([again.status, await again.json()]).toEqual([409, { ok: false, error: "already", certificate: body.certificate }]);
    expect(await db.select().from(certificates)).toHaveLength(1);
  });

  test("the refusals: the name rules (400 with the reason, nothing stored), not completed (409), revoked or not hers (404); the path is never read as a lesson; no session (401)", async () => {
    const w = await world();
    // Cyrillic is refused like a digit: the script font has no Cyrillic, so she writes her name in Latin letters as in her passport
    for (const [name, reason] of [["Kati 2", "letters"], ["Катя Каск", "letters"], ["A".repeat(81), "length"], ["", "length"]] as const) {
      const res = await call(w.kati.cookie, "POST", ISSUE, { name });
      expect([res.status, await res.json()], name).toEqual([400, { ok: false, error: "name", reason }]);
    }
    // a body that is no { name } (not JSON, no string, longer than 1024 characters) is an empty name
    for (const body of ["x", { name: 7 }, {}, { name: "A".repeat(1100) }]) {
      const res = await call(w.kati.cookie, "POST", ISSUE, body);
      expect([res.status, await res.json()], JSON.stringify(body).slice(0, 40)).toEqual([400, { ok: false, error: "name", reason: "length" }]);
    }
    expect(await db.select().from(certificates)).toEqual([]);
    const mari = await student("mari@example.test", "Mari Maasikas");
    await w.grant(mari.id, { completedAt: null });
    const open = await call(mari.cookie, "POST", ISSUE, { name: "Mari Maasikas" });
    expect([open.status, await open.json()]).toEqual([409, { ok: false, error: "notCompleted" }]);
    const liis = await student("liis@example.test", "Liis Lill");
    await w.grant(liis.id, { revokedAt: NOW });
    expect((await call(liis.cookie, "POST", ISSUE, { name: "Liis Lill" })).status).toBe(404);
    const none = await student("none@example.test", "Keegi Teine");
    expect((await call(none.cookie, "POST", ISSUE, { name: "Keegi Teine" })).status).toBe(404);
    expect((await call(w.kati.cookie, "POST", "/kursus/pole-olemas/tunnistus", { name: "Kati Kask" })).status).toBe(404);
    // the certificate's path is its own: another method never reaches the lesson paths
    for (const method of ["GET", "DELETE"]) {
      const res = await call(w.kati.cookie, method, ISSUE);
      expect([res.status, await res.json()], method).toEqual([404, { ok: false }]);
    }
    expect((await call(null, "POST", ISSUE, { name: "Kati Kask" })).status).toBe(401);
    expect(await db.select().from(certificates)).toEqual([]);
  });

  test("10 an hour per student; the 11th is 429 before anything is made", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await call(w.kati.cookie, "POST", ISSUE, { name: "Kati 2" })).status, `try ${i + 1}`).toBe(400);
    const res = await call(w.kati.cookie, "POST", ISSUE, { name: "Kati Kask" });
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
    expect(await db.select().from(certificates)).toEqual([]);
  });
});

describe("GET /tunnistus/:id", () => {
  test("her certificate as a PDF download: the type, the file name by its number, private and never cached, nosniff; the bytes are a PDF; a renewed session's cookies go with it", async () => {
    const w = await world({}, true);
    const made = await issueCertificate(db, w.kati.id, "veebikursus", "Kati Kask", NOW);
    const id = (made as { certificate: { id: number } }).certificate.id;
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-tunnistus-2026-01.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.getSetCookie()).toEqual(sessionCookies(w.kati.raw));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  });

  test("after her access has ended the certificate is still hers; 10 downloads an hour, the 11th is 429", async () => {
    const w = await world({ expiresAt: new Date(NOW.getTime() - DAY) });
    const made = await issueCertificate(db, w.kati.id, "veebikursus", "Kati Kask", NOW); // an ended access issues too: she completed it
    const id = (made as { certificate: { id: number } }).certificate.id;
    for (let i = 0; i < 10; i++) expect((await call(w.kati.cookie, "GET", `/tunnistus/${id}`)).status, `download ${i + 1}`).toBe(200);
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
  });

  test("Review Focus 5: revoked after the certificate was made: her download is 404 and her card loses the link; another student's or an unknown id is 404 too", async () => {
    const w = await world();
    const id = await issue(w.kati.cookie);
    for (const path of [`/tunnistus/${id + 1}`, "/tunnistus/abc", "/tunnistus/0"]) expect((await call(w.kati.cookie, "GET", path)).status, path).toBe(404);
    const mari = await student("mari@example.test", "Mari Maasikas");
    expect((await call(mari.cookie, "GET", `/tunnistus/${id}`)).status).toBe(404); // never another student's
    expect((await call(null, "GET", `/tunnistus/${id}`)).status).toBe(401);
    const card = async () => (await loadDashboard(db, w.kati.id, NOW))!.cards.find((c) => c.kind === "ecourse");
    expect(await card()).toMatchObject({ certificateId: id });
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect([res.status, await res.json()]).toEqual([404, { ok: false }]);
    expect(await card()).toMatchObject({ revoked: true, certificateId: null });
    expect(await db.select().from(certificates)).toHaveLength(1); // still Maria's: her register and her drawer show it
  });
});

describe("the e-course page and the dashboard carry it", () => {
  test("loadEcourse: before the completion nothing for the row; once completed her account's name for the field; after the issue its view, in GET /kursus/:slug too", async () => {
    const w = await world({ completedAt: null });
    expect((await loadEcourse(db, w.kati.id, "veebikursus", NOW))!.completion).toMatchObject({ completedAt: null, certificate: null, certificateName: "" });
    await db.update(courseAccess).set({ completedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect((await loadEcourse(db, w.kati.id, "veebikursus", NOW))!.completion).toMatchObject({ completedAt: NOW.toISOString(), certificate: null, certificateName: "Kati Kask" });
    const made = (await (await call(w.kati.cookie, "POST", ISSUE, { name: "Kati Kask" })).json()) as { certificate: unknown };
    const page = (await (await call(w.kati.cookie, "GET", "/kursus/veebikursus")).json()) as { completion: unknown };
    expect(page.completion).toMatchObject({ certificate: made.certificate, certificateName: "Kati Kask" });
  });

  test("loadDashboard: the card's certificateId, null before, its id after, still there once the access has ended", async () => {
    const w = await world();
    const card = async (now = NOW) => (await loadDashboard(db, w.kati.id, now))!.cards[0];
    expect(await card()).toMatchObject({ kind: "ecourse", certificateId: null });
    const id = await issue(w.kati.cookie);
    expect(await card()).toMatchObject({ certificateId: id });
    expect(await card(new Date(NOW.getTime() + 200 * DAY))).toMatchObject({ certificateId: id }); // ended: the card's way back to it
  });
});
