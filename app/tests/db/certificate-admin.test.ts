import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, clients, courseAccess } from "@/db/schema";
import { at, attempt, ecourse, LATER, practical, student, tabsOf, type Student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Maria's side of an issued certificate (phase 3d, spec §6, §9; Review Focus 5), rendered from a real (PGlite) database to HTML: the
// Õpilased drawer's line (before she confirms; its number and day, the name printed, Maria's download and "Paranda nimi"; a re-issue's day;
// an access an admin ended keeps the line and the download, marked, without "Paranda nimi"), the register /admin/tunnistused (newest first,
// 50 a page, the name to her drawer, each with its download, a re-issue and a revoked access marked) and Hindamine's way to it. The
// server actions are stand-ins (they need a browser or a request). The certificates are written straight to the database (their issue is
// Task 3's: tests/db/certificates.test.ts).

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test", adminName: () => "Maria" }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));

import AssessmentPage from "@/app/admin/(panel)/hindamine/page";
import CertificateRegisterPage from "@/app/admin/(panel)/tunnistused/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-20T09:00:00Z");

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
});

/** Her certificate "MS LAB 2026-<seq>", issued at `seq` o'clock (UTC) on 19.10.2026 unless `over` says otherwise. */
async function certificate(s: Student, seq: number, name: string, over: Partial<typeof certificates.$inferInsert> = {}) {
  const [row] = await db
    .insert(certificates)
    .values({
      accessId: s.access.id,
      number: `MS LAB 2026-${String(seq).padStart(2, "0")}`,
      year: 2026,
      seq,
      name,
      courseTitle: "Kulmumeistri e-koolitus",
      skills: ["Kulmude kuju"],
      volume: "",
      practicalLine: "Praktiline töö fotodel",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: at(seq),
      ...over,
    })
    .returning();
  return row;
}
const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
const register = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CertificateRegisterPage({ searchParams: Promise.resolve(search) }));
const rowIds = (html: string) => [...html.matchAll(/data-register-row="(\d+)"/g)].map((m) => Number(m[1]));
/** The HTML from `attribute="value"` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};

test("clientDetail: each access's certificate as the drawer shows it, with whether an admin ended the access; null before one", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toBeNull();
  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toEqual({
    id: c.id,
    number: "MS LAB 2026-03",
    name: "Kätlin Kask-Žukova",
    issuedAt: at(3).toISOString(),
    reissuedAt: null,
    revoked: false,
  });
  await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, kati.access.id));
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toMatchObject({ id: c.id, revoked: true });
});

test("the drawer: before she confirms, a line says so; after, the number and day, the name printed, Maria's download and 'Paranda nimi'; a re-issue's day", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  let row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("Tunnistus: õpilane pole veel nime kinnitanud");
  expect(row).not.toContain("data-certificate-admin-download");
  expect(row).not.toContain('data-reissue=""');

  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain(`data-access-certificate="${c.id}"`);
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026");
  expect(row).toContain("Nimi tunnistusel: Kätlin Kask-Žukova");
  expect(row).toContain(`href="/api/admin/tunnistus/${c.id}"`);
  expect(row).toContain("Laada alla");
  expect(row).toContain('data-reissue=""');
  expect(row).toContain("Paranda nimi");
  expect(row).not.toContain("ligipääs tühistatud");
  expect(row).not.toContain("pole veel nime kinnitanud");

  await db.update(certificates).set({ name: "Kätlin Kask", reissuedAt: new Date("2026-10-21T10:00:00Z") }).where(eq(certificates.id, c.id));
  row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("nimi parandatud 21.10.2026");
  expect(row).toContain("Nimi tunnistusel: Kätlin Kask");
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026"); // the number and the day stay
});

test("Review Focus 5: an access an admin ended keeps its certificate's line and Maria's download, marked 'ligipääs tühistatud', without 'Paranda nimi'; an ended one without a certificate says nothing of one", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8), revokedAt: NOW });
  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  const row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026");
  expect(row).toContain('data-certificate-revoked=""');
  expect(row).toContain("ligipääs tühistatud");
  expect(row).toContain(`href="/api/admin/tunnistus/${c.id}"`);
  expect(row).not.toContain('data-reissue=""');

  const liis = await student(db, course.id, "Liis", { completedAt: at(8), revokedAt: NOW });
  expect(part(await drawer(liis.client.id), "data-access", course.id)).not.toContain("data-access-certificate");
  const eve = await student(db, course.id, "Eve"); // not completed
  expect(part(await drawer(eve.client.id), "data-access", course.id)).not.toContain("data-access-certificate");
});

test("the register: number, name (to her drawer), course and issue day, newest first, each with its download; a re-issue's day and an ended access marked", async () => {
  const course = await ecourse(db, { test: null });
  const anu = await student(db, course.id, "Anu", { completedAt: at(8) });
  const eve = await student(db, course.id, "Eve", { completedAt: at(8) });
  const first = await certificate(anu, 1, "Anu Kask");
  const second = await certificate(eve, 2, "Eve Tamm", { reissuedAt: at(9) });
  await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, eve.access.id));
  const html = await register();
  expect(html).toContain("data-certificate-register");
  expect(rowIds(html)).toEqual([second.id, first.id]);
  expect(html).toContain("Tunnistusi: 2");
  const row = part(html, "data-register-row", second.id);
  for (const text of ["MS LAB 2026-02", "Eve Tamm", "Kulmumeistri e-koolitus", "19.10.2026", "nimi parandatud 19.10.2026", "ligipääs tühistatud"]) expect(row, text).toContain(text);
  expect(row).toContain(`href="/admin/opilased?id=${eve.client.id}"`);
  expect(row).toContain(`href="/api/admin/tunnistus/${second.id}"`);
  const other = part(html, "data-register-row", first.id);
  expect(other).not.toContain("ligipääs tühistatud");
  expect(other).not.toContain("parandatud");
  // the way back is the first tab (A4: „Ootab hindamist“ and „Tunnistused“ are on both pages; the back link „Hindamisse“ is gone)
  expect(tabsOf(html)).toEqual([
    { href: "/admin/hindamine", text: "Ootab hindamist 0", current: false },
    { href: "/admin/tunnistused", text: "Tunnistused", current: true },
  ]);
  expect(html).not.toContain("Hindamisse");
});

test("the register's first tab counts what waits in Hindamine, whatever the kind", async () => {
  const course = await ecourse(db);
  await practical(db, await student(db, course.id, "Anu"), 1, null, at(5));
  await attempt(db, await student(db, course.id, "Eve"), course.id, 1, "review", at(6));
  const gea = await student(db, course.id, "Gea");
  for (const n of [1, 2]) await attempt(db, gea, course.id, n, "failed", at(n), { correct: 0 });
  expect(tabsOf(await register())[0]).toEqual({ href: "/admin/hindamine", text: "Ootab hindamist 3", current: false });
});

test("the register: nothing issued says so; 50 a page, the pager to the next (?leht=2)", async () => {
  expect(await register()).toContain("Tunnistusi pole veel väljastatud.");
  const course = await ecourse(db, { test: null });
  const people = await db
    .insert(clients)
    .values(Array.from({ length: 51 }, (_, i) => ({ email: `s${i}@example.test`, name: `Õpilane ${i}` })))
    .returning();
  const accesses = await db
    .insert(courseAccess)
    .values(people.map((p) => ({ clientId: p.id, courseId: course.id, grantedBy: "maria@example.test", expiresAt: LATER, completedAt: at(1) })))
    .returning();
  await db.insert(certificates).values(
    accesses.map((a, i) => ({
      accessId: a.id,
      number: `MS LAB 2026-${String(i + 1).padStart(2, "0")}`,
      year: 2026,
      seq: i + 1,
      name: `Õpilane ${i}`,
      courseTitle: "Kulmumeistri e-koolitus",
      skills: [],
      volume: "",
      practicalLine: "Praktiline töö fotodel",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
    })),
  );
  const page1 = await register();
  expect(rowIds(page1)).toHaveLength(50);
  expect(page1).toContain('href="/admin/tunnistused?leht=2"');
  expect(page1).not.toContain("MS LAB 2026-01<"); // the oldest is on the next page
  const page2 = await register({ leht: "2" });
  expect(rowIds(page2)).toHaveLength(1);
  expect(page2).toContain("MS LAB 2026-01");
});

test("Hindamine links the register as its second tab „Tunnistused“, whether anything waits or not; the header button „Väljastatud tunnistused“ is gone", async () => {
  const html = renderToStaticMarkup(await AssessmentPage());
  expect(html).toContain("Hindamist ootavaid töid pole.");
  expect(tabsOf(html)).toEqual([
    { href: "/admin/hindamine", text: "Ootab hindamist 0", current: true },
    { href: "/admin/tunnistused", text: "Tunnistused", current: false },
  ]);
  expect(html).not.toContain("Väljastatud tunnistused");
  expect(html).not.toContain("data-to-register");
  const course = await ecourse(db);
  await practical(db, await student(db, course.id, "Anu"), 1, null, at(5));
  const waiting = renderToStaticMarkup(await AssessmentPage());
  expect(tabsOf(waiting)[1]).toEqual({ href: "/admin/tunnistused", text: "Tunnistused", current: false });
  expect(waiting).not.toContain("data-to-register");
});
