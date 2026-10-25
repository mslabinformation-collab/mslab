import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, contracts, courseAccess, courses, courseSessions, registrations, termsAcceptances } from "@/db/schema";
import { linkClientRecords } from "@/server/client-auth";
import { makeTestDb } from "./helpers";

// The Õpilased drawer's „Lepingud“ (contracts Task 5, spec §4): the student's contracts from contractsOfClient, the contact course's and the e-course's, in
// place of the list of the e-course terms she accepted at the gate (which does not hold a purchaser, whose contract the purchase froze). Each row: the
// title, the day it was accepted, the way, „Asendatud {date}“ when superseded and „Laadi alla (PDF)“; a contact contract links to its registration's drawer,
// where Maria can send a copy or ask again, an e-course contract has no drawer of its own. Rendered from a real (PGlite) database to HTML; the server
// actions are stand-ins (they need a request).

vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: vi.fn() }));

import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-20T09:00:00Z");
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
const fieldsOf = (email: string, course: string) => ({ school: { company: "MS LAB OÜ", registryCode: "", address: "" }, student: { name: "Kati Tamm", email }, course, session: "", price: "", payment: "" });

let db: Db;
let veeb: { id: number };
let kontakt: { id: number; sessionId: number };

beforeEach(async () => {
  db = await makeTestDb();
  [veeb] = await db.insert(courses).values({ ...base, slug: "veeb", type: "e_learning", title: { et: "Veebikoolitus" } }).returning();
  const [k] = await db.insert(courses).values({ ...base, slug: "kontakt", type: "contact", title: { et: "Kulmude lamineerimine" }, priceGroup: 35000 }).returning();
  const [s] = await db.insert(courseSessions).values({ courseId: k.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" }).returning();
  kontakt = { id: k.id, sessionId: s.id };
});

const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
/** The HTML of the contracts row only: „Lepingud“ is a folded row (README A5), its summary — the title and how many — and what is inside. */
const section = (html: string) => {
  const at = html.indexOf("data-client-contracts");
  expect(at, "the contracts row").toBeGreaterThan(-1);
  const from = html.lastIndexOf("<details", at);
  const to = html.indexOf("</details>", at);
  return html.slice(from, to);
};
const row = (html: string, id: number) => {
  const from = html.indexOf(`data-client-contract="${id}"`);
  expect(from, `contract ${id}`).toBeGreaterThan(-1);
  const next = html.indexOf('data-client-contract="', from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("a student with no contract: the folded row „Lepingud“ counts 0 and says there are none yet; the old list of accepted terms is gone", async () => {
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  const html = await drawer(kati.id);
  expect(text(section(html))).toContain("Lepingud 0 ▸ Lepinguid veel pole.");
  expect(html).not.toContain("Tingimustega nõustumised");
  expect(html).not.toContain("data-client-terms");
});

test("her contracts newest acceptance first, the superseded one marked, each with its PDF; a contact contract links to its registration's drawer, an e-course contract to nothing", async () => {
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  const [other] = await db.insert(clients).values({ email: "other@example.test", name: "Other" }).returning();
  const [reg] = await db.insert(registrations).values({ courseId: kontakt.id, courseSessionId: kontakt.sessionId, kind: "group", name: "Kati Tamm", email: kati.email, clientId: kati.id, paymentChoice: "half" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: kati.id, courseId: veeb.id, grantedBy: "payment", expiresAt: new Date("2027-04-20T20:59:59.999Z") }).returning();
  const made = { locale: "et" as const, body: "Tekst.", version: "1" };
  const [oldContact, ecourse, currentContact, hers] = await db
    .insert(contracts)
    .values([
      { ...made, kind: "contact", clientId: kati.id, registrationId: reg.id, courseId: kontakt.id, title: "Kontaktkoolituse leping", fields: fieldsOf(kati.email, "Kulmude lamineerimine"), acceptedAt: new Date("2026-10-01T09:00:00Z"), acceptedVia: "form", supersededAt: new Date("2026-10-15T09:00:00Z") },
      { ...made, kind: "ecourse", clientId: kati.id, accessId: access.id, courseId: veeb.id, title: "E-koolituse leping", fields: fieldsOf(kati.email, "Veebikoolitus"), acceptedAt: new Date("2026-10-10T09:00:00Z"), acceptedVia: "purchase" },
      { ...made, kind: "contact", clientId: kati.id, registrationId: reg.id, courseId: kontakt.id, title: "Kontaktkoolituse leping", fields: fieldsOf(kati.email, "Kulmude lamineerimine"), acceptedAt: new Date("2026-10-15T09:00:00Z"), acceptedVia: "account" },
      { ...made, kind: "ecourse", clientId: other.id, courseId: veeb.id, title: "Teise leping", fields: fieldsOf(other.email, "Veebikoolitus"), acceptedAt: new Date("2026-10-12T09:00:00Z"), acceptedVia: "terms" },
    ])
    .returning();
  const html = section(await drawer(kati.id));
  // the newest acceptance first; another student's contract is not hers; the e-course purchaser is on the list although the gate never saw her
  expect([...html.matchAll(/data-client-contract="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([currentContact.id, ecourse.id, oldContact.id]);
  expect(html).not.toContain(`data-client-contract="${hers.id}"`);
  expect(text(html)).not.toContain("Teise leping");

  const current = row(html, currentContact.id);
  expect(text(current)).toContain("Kontaktkoolituse leping Kinnitatud 15.10.2026 · Õpilase konto");
  expect(current).toContain('data-contract-state="current"');
  expect(current).not.toContain("Asendatud");
  expect(current).toContain(`href="/api/admin/leping/${currentContact.id}"`);
  expect(current).toContain(`aria-label="Laadi alla (PDF): leping ${currentContact.id}"`);
  expect(text(current)).toContain("Laadi alla (PDF)");
  expect(current).toContain(`href="/admin/registreerimised?id=${reg.id}"`);
  expect(text(current)).toContain("Ava registreering");
  expect(text(current)).not.toContain("Ava registreerimine");

  const old = row(html, oldContact.id);
  expect(old).toContain('data-contract-state="superseded"');
  expect(text(old)).toContain("Asendatud 15.10.2026");
  expect(text(old)).toContain("Kinnitatud 01.10.2026 · Registreerimisvorm");
  expect(old).toContain(`href="/api/admin/leping/${oldContact.id}"`);

  const e = row(html, ecourse.id);
  expect(text(e)).toContain("E-koolituse leping Kinnitatud 10.10.2026 · E-koolituse ost");
  expect(e).toContain(`href="/api/admin/leping/${ecourse.id}"`);
  expect(e).not.toContain("/admin/registreerimised");
  expect(e).not.toContain("Asendatud");
});

test("ruling R14 (review I-1): a contract she accepted before her account existed is in her drawer once her registration is linked — the frozen row says no client", async () => {
  const [reg] = await db.insert(registrations).values({ courseId: kontakt.id, courseSessionId: kontakt.sessionId, kind: "group", name: "Kati Tamm", email: "kati@example.test", clientId: null, paymentChoice: "half" }).returning();
  const [c] = await db
    .insert(contracts)
    .values({ kind: "contact", clientId: null, registrationId: reg.id, courseId: kontakt.id, locale: "et", title: "Kontaktkoolituse leping", body: "Tekst.", version: "1", fields: fieldsOf("kati@example.test", "Kulmude lamineerimine"), acceptedAt: new Date("2026-10-01T09:00:00Z"), acceptedVia: "form" })
    .returning();
  // her account is made later (her first login, or Maria adds her), and her registrations are linked to it
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  expect(text(section(await drawer(kati.id)))).toContain("Lepinguid veel pole.");
  await linkClientRecords(db, kati.id, kati.email);
  const html = section(await drawer(kati.id));
  expect(html).toContain(`data-client-contract="${c.id}"`);
  expect(text(row(html, c.id))).toContain("Kontaktkoolituse leping Kinnitatud 01.10.2026 · Registreerimisvorm");
  expect(row(html, c.id)).toContain(`href="/api/admin/leping/${c.id}"`);
  expect(row(html, c.id)).toContain(`href="/admin/registreerimised?id=${reg.id}"`);
  // (the contract's own row was not touched by the link)
  expect((await db.select().from(contracts))[0].clientId).toBeNull();
});

test("ruling R14: a registration Maria re-links to another student takes its contract to that student's drawer only", async () => {
  const [a] = await db.insert(clients).values({ email: "a@example.test", name: "Anu" }).returning();
  const [b] = await db.insert(clients).values({ email: "b@example.test", name: "Bert" }).returning();
  const [reg] = await db.insert(registrations).values({ courseId: kontakt.id, courseSessionId: kontakt.sessionId, kind: "group", name: "Anu Aas", email: a.email, clientId: a.id, paymentChoice: "half" }).returning();
  const [c] = await db
    .insert(contracts)
    .values({ kind: "contact", clientId: a.id, registrationId: reg.id, courseId: kontakt.id, locale: "et", title: "Kontaktkoolituse leping", body: "Tekst.", version: "1", fields: fieldsOf(a.email, "Kulmude lamineerimine"), acceptedAt: new Date("2026-10-01T09:00:00Z"), acceptedVia: "form" })
    .returning();
  expect(section(await drawer(a.id))).toContain(`data-client-contract="${c.id}"`);
  await db.update(registrations).set({ clientId: b.id }).where(eq(registrations.id, reg.id));
  expect(text(section(await drawer(a.id)))).toContain("Lepinguid veel pole.");
  expect(section(await drawer(b.id))).toContain(`data-client-contract="${c.id}"`);
});

test("a contract whose registration is gone keeps its row and its PDF, with no link to a drawer; a contract with no title is named „Leping“", async () => {
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  const [c] = await db
    .insert(contracts)
    .values({ kind: "contact", clientId: kati.id, registrationId: null, courseId: kontakt.id, locale: "et", title: "", body: "Tekst.", version: "1", fields: fieldsOf(kati.email, "Kulmude lamineerimine"), acceptedAt: new Date("2026-10-01T09:00:00Z"), acceptedVia: "form" })
    .returning();
  const html = row(section(await drawer(kati.id)), c.id);
  expect(text(html)).toContain("Leping Kinnitatud 01.10.2026 · Registreerimisvorm");
  expect(html).toContain(`href="/api/admin/leping/${c.id}"`);
  expect(html).not.toContain("/admin/registreerimised");
});

test("the gate's old acceptances do not make a contract: a student who only has a terms acceptance sees no contract", async () => {
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
  await db.insert(termsAcceptances).values({ clientId: kati.id, courseId: veeb.id, termsVersion: "1", acceptedAt: new Date("2026-10-02T11:00:00Z") });
  const html = await drawer(kati.id);
  expect(text(section(html))).toContain("Lepinguid veel pole.");
});
