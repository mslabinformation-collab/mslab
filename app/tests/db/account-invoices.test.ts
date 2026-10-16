import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { insertPayment } from "@/db/queries/payments";
import * as schema from "@/db/schema";
import { clients, clientSessions, courseAccess, courses, courseSessions, invoices, payments, registrations, type Invoice, type Registration } from "@/db/schema";
import type { AccountCard, ContactCard, EcourseCard, IndividualCard } from "@/domain/account-cards";
import { handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import { renderInvoice } from "@/server/invoice-pdf";
import { cancelInvoice, createInvoice, invoiceForAdmin, invoiceForPaidPayment, markInvoicePaid, undoInvoicePaid, unpaidInvoiceOf } from "@/server/invoices";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// The student's side of the invoices (invoices Task 6; spec §4) against a real (PGlite) database:
// - the dashboard carries her invoices on the card they belong to (a contact course's registration, an individual one's, an e-course), in one
//   query however many cards there are; a cancelled one, another client's and an orphan are not on any card;
// - an unpaid invoice carries the bank details and the reference frozen on it, and the card's `openInvoice` is the one „Maksa" charges
//   (server/invoices.ts unpaidInvoiceOf, which the start and the /maksa page ask) — also when the registration has two;
// - R14: an unpaid invoice whose online payment is paid already (its catch-up pending) reads „Tasutud", is nothing to pay and is marked
//   `awaitingCatchUp` (its PDF would still read unpaid: the card offers no download for it);
// - GET /api/konto/arve/<id>: the PDF as a download, hers only, 404 for every other id, 10 an hour (a 404 counts), a render that fails is 500.
// The rules of the reads are tests/db/invoices.test.ts's. The PDF renderer is the real one, wrapped so a test can make a render fail.

vi.mock("@/server/invoice-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/invoice-pdf")>();
  return { ...real, renderInvoice: vi.fn(real.renderInvoice) };
});

/** 16.10.2026 12:00 in Tallinn (summer time, UTC+3). */
const NOW = new Date("2026-10-16T09:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

let db: Db;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  vi.mocked(renderInvoice).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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

/** A client with one live session. `renewing`: the session was last renewed two days ago, so the next request renews it. */
async function student(email: string, name: string, renewing = false) {
  const [client] = await db.insert(clients).values({ email, name }).returning();
  const raw = newToken();
  const expiresAt = new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS - (renewing ? 2 * DAY : 0));
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt });
  return { id: client.id, raw, cookie: `__Host-mslab_client=${raw}` };
}

const call = async (cookie: string | null, method: string, path: string, d: AccountDeps = deps()) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method, headers: cookie ? { cookie } : {} }), d))!;

/** Seaded's seller card and the bank details filled in. */
const ready = async () => {
  await setSetting(db, "invoice", SELLER);
  await setSetting(db, "prepayment", BANK);
};

/** Maria's request to pay (Maksmiseks) of `kind` on `r`. */
async function request(r: Registration, kind: "prepayment" | "full" | "balance", now = NOW): Promise<Invoice> {
  const made = await createInvoice(db, r.id, { kind, mode: "request" }, now);
  if (!made.ok) throw new Error(`request: ${made.error}`);
  return made.invoice;
}

/** A receipt (Juba tasutud) of `kind` on `r`, paid on 10.10. */
async function receipt(r: Registration, kind: "prepayment" | "full" | "balance", now = NOW): Promise<Invoice> {
  const made = await createInvoice(db, r.id, { kind, mode: "receipt", paidAt: new Date("2026-10-10T08:00:00Z"), method: "bank" }, now);
  if (!made.ok) throw new Error(`receipt: ${made.error}`);
  return made.invoice;
}

/** An e-course (95 €) and a purchase of it by `clientId`, paid, with its invoice born paid. */
async function boughtEcourse(clientId: number, over: { slug?: string; at?: Date } = {}) {
  const slug = over.slug ?? "kulmud-e";
  const existing = (await db.select().from(courses).where(eq(courses.slug, slug)))[0];
  const course =
    existing ??
    (await db.insert(courses).values({ slug, type: "e_learning", level: "basic", title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true }).returning())[0];
  const at = over.at ?? new Date("2026-10-15T09:00:00Z");
  const p = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId, email: "kati@example.test", name: "Kati Kask", locale: "et", amountCents: 9500 }, at, "MSLAB-M");
  const invoice = await db.transaction(async (tx) => {
    const [paid] = await tx.update(payments).set({ status: "paid", paidAt: at, updatedAt: at }).where(eq(payments.id, p.id)).returning();
    return invoiceForPaidPayment(tx, paid, at);
  });
  return { course, payment: p, invoice: invoice! };
}

const cards = async (clientId: number) => (await loadDashboard(db, clientId, NOW))!.cards;
const contactCard = (all: AccountCard[], registrationId: number) => all.find((c): c is ContactCard => c.kind === "contact" && c.registrationId === registrationId)!;

describe("loadDashboard: her invoices on the card they belong to", () => {
  test("a contact card carries its invoices, oldest first, with their states; an unpaid one the bank details and reference frozen on it; `openInvoice` is the unpaid one", async () => {
    await ready();
    const c = await contactCourse(db);
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: "kati@example.test" });
    const first = await receipt(r, "prepayment", new Date("2026-10-11T09:00:00Z"));
    const rest = await request(r, "balance", new Date("2026-10-12T09:00:00Z"));
    const card = contactCard(await cards(kati.id), r.id);
    expect(card.invoices).toEqual([
      { id: first.id, number: "MSL2026-001", amountCents: 17500, status: "paid", dueAt: null, paidAt: "2026-10-10T08:00:00.000Z", transfer: null },
      {
        id: rest.id,
        number: "MSL2026-002",
        amountCents: 17500,
        status: "unpaid",
        dueAt: rest.dueAt!.toISOString(),
        paidAt: null,
        transfer: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", reference: `MSLAB-${r.id}` },
      },
    ]);
    expect(card.openInvoice).toEqual({ id: rest.id, kind: "balance", amountCents: 17500 });
  });

  test("the bank details are the ones frozen on the invoice: Ettemaksu juhised changed later does not change an issued invoice's card", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    await request(r, "prepayment");
    await setSetting(db, "prepayment", { ...BANK, iban: "EE471000001020145685", bank: "LHV", receiver: "Uus OÜ" });
    expect(contactCard(await cards(kati.id), r.id).invoices![0].transfer).toMatchObject({ receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank" });
  });

  test("a card with no invoice has no `invoices` and no `openInvoice` (the cards stay as they were); a paid one alone leaves `openInvoice` out", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const a = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const before = contactCard(await cards(kati.id), a.id);
    expect("invoices" in before || "openInvoice" in before).toBe(false);
    await receipt(a, "full");
    const after = contactCard(await cards(kati.id), a.id);
    expect(after.invoices).toHaveLength(1);
    expect("openInvoice" in after).toBe(false);
  });

  test("two unpaid invoices of one registration: `openInvoice` is the latest, the one unpaidInvoiceOf gives „Maksa\" (the start and the /maksa page)", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const first = await request(r, "prepayment", new Date("2026-10-11T09:00:00Z"));
    await cancelInvoice(db, first.id, NOW);
    const full = await request(r, "full", new Date("2026-10-12T09:00:00Z"));
    // (a prepayment and a whole sum exclude each other; the second unpaid one is made by hand, as an older backup of the series would hold)
    const [other] = await db.insert(invoices).values({ ...full, id: undefined, number: "MSL2026-009", seq: 9, kind: "balance", amountCents: 100, issuedAt: new Date("2026-10-13T09:00:00Z"), createdAt: undefined }).returning();
    const open = (await unpaidInvoiceOf(db, r.id))!;
    expect(open.id).toBe(other.id);
    expect(contactCard(await cards(kati.id), r.id).openInvoice).toEqual({ id: open.id, kind: "balance", amountCents: 100 });
    expect(contactCard(await cards(kati.id), r.id).invoices!.map((i) => i.id)).toEqual([full.id, other.id]); // the cancelled one is not hers to see
  });

  test("a cancelled invoice is hidden, and is not `openInvoice` either", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const inv = await request(r, "prepayment");
    expect(contactCard(await cards(kati.id), r.id).openInvoice).toMatchObject({ id: inv.id });
    await cancelInvoice(db, inv.id, NOW);
    const card = contactCard(await cards(kati.id), r.id);
    expect("invoices" in card || "openInvoice" in card).toBe(false);
  });

  test("only hers: another client's invoice, on her address's registration that is not linked to her, is on no card of hers", async () => {
    await ready();
    const c = await contactCourse(db);
    const kati = await student("kati@example.test", "Kati Kask");
    const mari = await student("mari@example.test", "Mari Maasikas");
    const hers = await registrationOn(db, c, { clientId: kati.id });
    const maris = await registrationOn(db, c, { clientId: mari.id, email: "mari@example.test", name: "Mari Maasikas" });
    const unlinked = await registrationOn(db, c, { email: "kati@example.test" });
    await request(hers, "prepayment");
    await request(maris, "prepayment");
    await request(unlinked, "prepayment");
    expect((await cards(kati.id)).map((card) => (card.kind === "contact" ? [card.registrationId, (card.invoices ?? []).length] : null))).toEqual([[hers.id, 1]]);
    expect((await cards(mari.id)).map((card) => (card.kind === "contact" ? [card.registrationId, (card.invoices ?? []).length] : null))).toEqual([[maris.id, 1]]);
  });

  test("an individual course's registration (no session) shows its invoices too, with no `openInvoice`: there is no „Maksa\" on it", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const c = await contactCourse(db);
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c, { clientId: kati.id, kind: "individual", courseSessionId: null, paymentChoice: "full" });
    const inv = await request(r, "full");
    const card = (await cards(kati.id)).find((x): x is IndividualCard => x.kind === "individual")!;
    expect(card.invoices).toEqual([expect.objectContaining({ id: inv.id, number: "MSL2026-001", amountCents: 45000, status: "unpaid" })]);
    expect("openInvoice" in card).toBe(false);
  });

  test("an e-course card carries the invoices of its purchases (an e-course bought twice has two); another e-course's are not on it", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const one = await boughtEcourse(kati.id);
    const two = await boughtEcourse(kati.id, { at: new Date("2026-10-16T08:00:00Z") });
    const other = await boughtEcourse(kati.id, { slug: "varvid-e" });
    for (const bought of [one, other]) await db.insert(courseAccess).values({ clientId: kati.id, courseId: bought.course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY) });
    const ecourses = (await cards(kati.id)).filter((x): x is EcourseCard => x.kind === "ecourse");
    expect(ecourses).toHaveLength(2);
    const kulmud = ecourses.find((x) => x.course.slug === "kulmud-e")!;
    const varvid = ecourses.find((x) => x.course.slug === "varvid-e")!;
    expect(kulmud.invoices).toEqual([
      { id: one.invoice.id, number: one.invoice.number, amountCents: 9500, status: "paid", dueAt: null, paidAt: "2026-10-15T09:00:00.000Z", transfer: null },
      { id: two.invoice.id, number: two.invoice.number, amountCents: 9500, status: "paid", dueAt: null, paidAt: "2026-10-16T08:00:00.000Z", transfer: null },
    ]);
    expect(varvid.invoices!.map((i) => i.id)).toEqual([other.invoice.id]);
  });

  test("one query for all the invoices, however many cards there are (no N+1)", async () => {
    const log: string[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    db = logged;
    await ready();
    const c = await contactCourse(db);
    const kati = await student("kati@example.test", "Kati Kask");
    for (let i = 0; i < 4; i++) await request(await registrationOn(db, c, { clientId: kati.id }), "prepayment");
    await boughtEcourse(kati.id);
    log.length = 0;
    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.cards.filter((x) => x.kind === "contact")).toHaveLength(4);
    expect(log.filter((q) => /from "invoices"/.test(q))).toHaveLength(1);
  });

  test("R14: an unpaid invoice whose online payment is paid already (its catch-up pending) reads „Tasutud\", offers no bank details and is not `openInvoice`; the server agrees: nothing to charge", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const inv = await request(r, "prepayment");
    const p = await insertPayment(db, { kind: "prepayment", registrationId: r.id, courseId: r.courseId, clientId: kati.id, email: r.email, name: r.name, locale: "et", amountCents: 17500, invoiceId: inv.id }, NOW, "MSLAB-M");
    // pending: still to pay online
    expect(contactCard(await cards(kati.id), r.id)).toMatchObject({ openInvoice: { id: inv.id }, invoices: [{ id: inv.id, status: "unpaid", transfer: expect.anything() }] });
    await db.update(payments).set({ status: "paid", paidAt: new Date("2026-10-16T08:30:00Z") }).where(eq(payments.id, p.id));
    const card = contactCard(await cards(kati.id), r.id);
    expect(card.invoices).toEqual([{ id: inv.id, number: "MSL2026-001", amountCents: 17500, status: "paid", dueAt: inv.dueAt!.toISOString(), paidAt: null, transfer: null, awaitingCatchUp: true }]);
    expect("openInvoice" in card).toBe(false);
    expect(await unpaidInvoiceOf(db, r.id)).toBeNull();
    // the row itself is untouched: Maria's catch-up pays it (and its PDF reads as the row does until then, so the card offers none: awaitingCatchUp)
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ status: "unpaid", paidAt: null });
  });

  test("R14: a failed or pending payment does not make it paid: only a paid one", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const inv = await request(r, "prepayment");
    const p = await insertPayment(db, { kind: "prepayment", registrationId: r.id, courseId: r.courseId, clientId: kati.id, email: r.email, name: r.name, locale: "et", amountCents: 17500, invoiceId: inv.id }, NOW, "MSLAB-M");
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, p.id));
    expect(contactCard(await cards(kati.id), r.id)).toMatchObject({ openInvoice: { id: inv.id }, invoices: [{ status: "unpaid" }] });
  });
});

describe("loadDashboard: the final review's wave (m1, m8, I3)", () => {
  test("m1: a paid payment started for an invoice but invoiced by its own (R7: Maria marked it meanwhile, then undid her mark) leaves the invoice an ordinary unpaid one: bank details and `openInvoice` (openInvoiceOf, in step with unpaidInvoiceOf)", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, await contactCourse(db), { clientId: kati.id });
    const inv = await request(r, "prepayment");
    const p = await insertPayment(db, { kind: "prepayment", registrationId: r.id, courseId: r.courseId, clientId: kati.id, email: r.email, name: r.name, locale: "et", amountCents: 17500, invoiceId: inv.id }, NOW, "MSLAB-M");
    expect(await markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)).toMatchObject({ ok: true });
    const own = await db.transaction(async (tx) => {
      const [paid] = await tx.update(payments).set({ status: "paid", paidAt: NOW, updatedAt: NOW }).where(eq(payments.id, p.id)).returning();
      return invoiceForPaidPayment(tx, paid, NOW);
    });
    expect(own).toMatchObject({ paymentId: p.id, status: "paid" });
    expect(await undoInvoicePaid(db, inv.id, NOW)).toMatchObject({ ok: true, invoice: { status: "unpaid" } });
    const card = contactCard(await cards(kati.id), r.id);
    expect(card.invoices!.map((i) => [i.id, i.status, i.transfer !== null, "awaitingCatchUp" in i])).toEqual([[inv.id, "unpaid", true, false], [own!.id, "paid", false, false]]);
    expect(card.openInvoice).toEqual({ id: inv.id, kind: "prepayment", amountCents: 17500 });
    expect((await unpaidInvoiceOf(db, r.id))?.id).toBe(inv.id);
  });

  test("m8: a cancelled registration's unpaid invoice is still on its card („Tasumata“, until Maria cancels it, spec §9) but invites no payment: no bank details, no `openInvoice`; nor one whose session was called off", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { clientId: kati.id });
    const inv = await request(r, "prepayment");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, r.id));
    const card = contactCard(await cards(kati.id), r.id);
    expect(card.invoices).toEqual([expect.objectContaining({ id: inv.id, status: "unpaid", transfer: null })]);
    expect("openInvoice" in card).toBe(false);
    // the session called off, the registration as it was
    await db.update(registrations).set({ status: "awaiting_prepayment" }).where(eq(registrations.id, r.id));
    await db.update(courseSessions).set({ status: "cancelled" }).where(eq(courseSessions.id, c.session.id));
    const offCard = contactCard(await cards(kati.id), r.id);
    expect(offCard.invoices).toEqual([expect.objectContaining({ id: inv.id, status: "unpaid", transfer: null })]);
    expect("openInvoice" in offCard).toBe(false);
    // a registration that is not cancelled keeps both
    await db.update(courseSessions).set({ status: "scheduled" }).where(eq(courseSessions.id, c.session.id));
    expect(contactCard(await cards(kati.id), r.id)).toMatchObject({ openInvoice: { id: inv.id }, invoices: [{ transfer: expect.objectContaining({ iban: BANK.iban }) }] });
  });

  test("I3: a paid invoice whose payment was refunded or voided is `refunded` on her card, its PDF still hers; one whose payment stays paid is not", async () => {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const one = await boughtEcourse(kati.id);
    const two = await boughtEcourse(kati.id, { at: new Date("2026-10-16T08:00:00Z") });
    await db.insert(courseAccess).values({ clientId: kati.id, courseId: one.course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY) });
    await db.update(payments).set({ status: "refunded" }).where(eq(payments.id, one.payment.id));
    const card = (await cards(kati.id)).find((x): x is EcourseCard => x.kind === "ecourse")!;
    expect(card.invoices!.map((i) => [i.id, i.status, i.refunded ?? false])).toEqual([[one.invoice.id, "paid", true], [two.invoice.id, "paid", false]]);
    expect((await call(kati.cookie, "GET", `/arve/${one.invoice.id}`)).status).toBe(200);
    // voided: failed with its paid_at
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, two.payment.id));
    const after = (await cards(kati.id)).find((x): x is EcourseCard => x.kind === "ecourse")!;
    expect(after.invoices!.map((i) => i.refunded ?? false)).toEqual([true, true]);
  });
});

describe("GET /api/konto/arve/:id", () => {
  /** Kati with an unpaid invoice (MSL2026-001) on her registration. */
  async function world(renewing = false) {
    await ready();
    const kati = await student("kati@example.test", "Kati Kask", renewing);
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { clientId: kati.id });
    const inv = await request(r, "prepayment");
    return { kati, c, r, inv };
  }

  test("her invoice as a PDF download: the type, the file name by its number, private and never cached, nosniff; the bytes are a PDF; a renewed session's cookies go with it", async () => {
    const w = await world(true);
    const res = await call(w.kati.cookie, "GET", `/arve/${w.inv.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-arve-MSL2026-001.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.getSetCookie()).toEqual(sessionCookies(w.kati.raw));
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).subarray(0, 5))).toBe("%PDF-");
    expect(vi.mocked(renderInvoice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderInvoice).mock.calls[0][0]).toMatchObject({ number: "MSL2026-001", status: "unpaid", amountCents: 17500 });
  });

  test("a paid invoice and an e-course's (hers by the payment's client) download too", async () => {
    const w = await world();
    const paid = await receipt(await registrationOn(db, w.c, { clientId: w.kati.id }), "full");
    const bought = await boughtEcourse(w.kati.id);
    for (const [inv, status] of [[paid, "paid"], [bought.invoice, "paid"]] as const) {
      const res = await call(w.kati.cookie, "GET", `/arve/${inv.id}`);
      expect([res.status, res.headers.get("content-disposition")]).toEqual([200, `attachment; filename="MS-LAB-arve-${inv.number}.pdf"`]);
      expect(vi.mocked(renderInvoice).mock.lastCall![0]).toMatchObject({ number: inv.number, status });
    }
    expect(vi.mocked(renderInvoice).mock.lastCall![0]).toMatchObject({ kind: "ecourse", paidMethod: "montonio" });
  });

  test("every other id is 404 JSON { ok: false }: another client's, a cancelled one, an unknown, a malformed one; no session is 401", async () => {
    const w = await world();
    const mari = await student("mari@example.test", "Mari Maasikas");
    const maris = await registrationOn(db, w.c, { clientId: mari.id, email: "mari@example.test", name: "Mari Maasikas" });
    const hers = await request(maris, "prepayment"); // (Mari's)
    for (const path of [`/arve/${hers.id}`, `/arve/${w.inv.id + 100}`, "/arve/abc", "/arve/0", "/arve/-1", "/arve/1.5", "/arve/01"]) {
      const res = await call(w.kati.cookie, "GET", path);
      expect([path, res.status, await res.json()], path).toEqual([path, 404, { ok: false }]);
    }
    await cancelInvoice(db, w.inv.id, NOW);
    expect((await call(w.kati.cookie, "GET", `/arve/${w.inv.id}`)).status).toBe(404);
    expect((await call(null, "GET", `/arve/${w.inv.id}`)).status).toBe(401);
    expect(vi.mocked(renderInvoice)).not.toHaveBeenCalled();
  });

  test("10 an hour per student, a 404 counts too (ids cannot be probed): after 10 unknown ids her own invoice is 429, and nothing was rendered", async () => {
    const w = await world();
    for (let i = 1; i <= 10; i++) expect((await call(w.kati.cookie, "GET", `/arve/${w.inv.id + i}`)).status, `probe ${i}`).toBe(404);
    const res = await call(w.kati.cookie, "GET", `/arve/${w.inv.id}`);
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
    expect(vi.mocked(renderInvoice)).not.toHaveBeenCalled();
  });

  test("a render that fails is 500 JSON { ok: false, error: 'server' }, private, no PDF; the log has the invoice's id and the error's class only", async () => {
    const w = await world();
    vi.mocked(console.error).mockClear();
    vi.mocked(renderInvoice).mockRejectedValueOnce(new TypeError("boom: Kati Kask, kati@example.test"));
    const res = await call(w.kati.cookie, "GET", `/arve/${w.inv.id}`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(vi.mocked(console.error).mock.calls.map((c) => c.join(" "))).toEqual([`[invoices] ${w.inv.id}: the student's download failed: TypeError`]);
    expect((await call(w.kati.cookie, "GET", `/arve/${w.inv.id}`)).status).toBe(200); // the next try renders
  });

  test("only GET: the other methods on the path are 404", async () => {
    const w = await world();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await call(w.kati.cookie, method, `/arve/${w.inv.id}`)).status, method).toBe(404);
  });
});
