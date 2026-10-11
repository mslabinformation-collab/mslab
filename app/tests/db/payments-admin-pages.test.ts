import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courses, payments } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// The admin's Maksed page, the online payments in a registration's drawer and the Õpilased drawer, rendered from a real (PGlite) database
// to HTML: Maria's words (Eest, Makseviis, Estonian statuses, "Pangalink · Swedbank" and never Montonio's code), "Kontrolli Montonios" on
// the rows she must look at, and the old "E-õppe ostud lisanduvad koos maksetega." note gone. The shell, the drawer's dialog and the server
// actions are stand-ins (they need a browser or a request); everything else is the real page.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/data", () => ({ getAdminCounts: async () => ({}) }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children), useUnsavedInDrawer: () => {} };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), saveRegistrationPayment: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));

import PaymentsPage from "@/app/admin/(panel)/maksed/page";
import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail, listEcourses } from "@/server/admin-clients";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));
const render = async (page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }));
const refs = (html: string) => [...html.matchAll(/data-payment="(MSLAB-M\d+)"/g)].map((m) => m[1]);
/** The HTML of one payment's row or line, from its data-payment to the next one (or the end). */
const row = (html: string, reference: string) => {
  const from = html.indexOf(`data-payment="${reference}"`);
  expect(from, reference).toBeGreaterThan(-1);
  const next = html.indexOf('data-payment="', from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};

let db: Db;
let contact: Awaited<ReturnType<typeof contactCourse>>;
let ids: { registration: number; kati: number; lonely: number };
let refsOf: { prepayment: string; balance: string; ecourse: string; voided: string; pending: string; refunded: string };

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const c = (contact = await contactCourse(db));
  const [ecourse] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, price: 19000, accessMonths: 6, published: true })
    .returning();
  const [kati] = await db.insert(clients).values({ email: "kati@example.com", name: "Kati Tamm" }).returning();
  const r = await registrationOn(db, c, { clientId: kati.id });
  const lonelyReg = await registrationOn(db, c, { email: "liis@example.com", name: "Liis Mets" });

  // oldest first: the prepayment (Swedbank), the balance (held: a card paid, the amount did not match), the e-course (card), the lonely
  // payer's prepayment (voided after it was paid: Lõuna Pank), a pending one (no method yet) and a refunded one
  const a = await pendingPayment(db, r, {}, at(1));
  await db.update(payments).set({ status: "paid", paidAt: at(1), method: "paymentInitiation", bank: "Swedbank", providerUuid: "uuid-prepayment-0001" }).where(eq(payments.id, a.id));
  const b = await pendingPayment(db, r, { kind: "balance" }, at(2));
  await db.update(payments).set({ status: "held", paidAt: at(2), method: "cardPayments", providerUuid: "uuid-balance-0002" }).where(eq(payments.id, b.id));
  const [e] = await db
    .insert(payments)
    .values({ reference: "MSLAB-M900", kind: "ecourse", courseId: ecourse.id, clientId: kati.id, email: "kati@example.com", name: "Kati Tamm", amountCents: 19000, status: "paid", paidAt: at(3), createdAt: at(3), method: "applePay", providerUuid: "uuid-ecourse-0003" })
    .returning();
  const v = await pendingPayment(db, lonelyReg, {}, at(4));
  await db.update(payments).set({ status: "failed", paidAt: at(4), method: "paymentInitiation", bank: "Lõuna Pank", providerUuid: "uuid-voided-0004" }).where(eq(payments.id, v.id));
  const p = await pendingPayment(db, await registrationOn(db, c, { email: "mari@example.com", name: "Mari Kask" }), {}, at(5));
  const f = await pendingPayment(db, await registrationOn(db, c, { email: "juhan@example.com", name: "Juhan Kask" }), { kind: "balance" }, at(6));
  await db.update(payments).set({ status: "refunded", paidAt: at(6), method: "cardPayments" }).where(eq(payments.id, f.id));
  // the e-course purchase opened an access, which says who opened it
  await db.insert(courseAccess).values({ clientId: kati.id, courseId: ecourse.id, grantedBy: "payment", grantedAt: at(3), expiresAt: new Date("2027-04-09T20:59:59.999Z") });
  ids = { registration: r.id, kati: kati.id, lonely: lonelyReg.id };
  refsOf = { prepayment: a.reference, balance: b.reference, ecourse: e.reference, voided: v.reference, pending: p.reference, refunded: f.reference };
});

test("Maksed: Maria's heading, lead and column heads; newest first; the menu entry is the active one", async () => {
  const html = await render(PaymentsPage);
  expect(html).toContain('data-shell-active="payments"');
  expect(html).toContain("<h1");
  expect(html).toContain(">Maksed</h1>");
  expect(html).toContain("Tagastused tehakse Montonio halduses");
  expect(html).not.toContain("töölaual");
  for (const head of ["Kuupäev", "Maksja", "Eest", "Liik", "Summa", "Makseviis", "Staatus", "Montonio id"]) expect(html, head).toContain(`<th scope="col">${head}</th>`);
  expect(html).not.toMatch(/<th[^>]*>(Mis|Viis)<\/th>/);
  expect(html).toContain('data-label="Makseviis"');
  expect(html).not.toContain('data-label="Viis"');
  expect(html).toContain("Makseid: 6");
  expect(refs(html)).toEqual([refsOf.refunded, refsOf.pending, refsOf.voided, refsOf.ecourse, refsOf.balance, refsOf.prepayment]);
});

test("Maksed: the filter pills in Maria's words, each with its own address; the current one marked", async () => {
  const html = await render(PaymentsPage, { staatus: "kontroll" });
  const nav = /<nav[^>]*data-payment-filter[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
  const pills = [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]);
  expect(pills).toEqual([
    ["Kõik", "/admin/maksed"],
    ["Makstud", "/admin/maksed?staatus=makstud"],
    ["Pooleli", "/admin/maksed?staatus=pooleli"],
    ["Ebaõnnestunud", "/admin/maksed?staatus=ebaonnestunud"],
    ["Tagastatud", "/admin/maksed?staatus=tagastatud"],
    ["Ootel kontrollil", "/admin/maksed?staatus=kontroll"],
  ]);
  expect(nav).toMatch(/aria-current="true"[^>]*>Ootel kontrollil</);
  expect(refs(html)).toEqual([refsOf.balance]);
  expect(refs(await render(PaymentsPage, { staatus: "makstud" }))).toEqual([refsOf.ecourse, refsOf.prepayment]);
  expect(refs(await render(PaymentsPage, { staatus: "ebaonnestunud" }))).toEqual([refsOf.voided]);
  expect(refs(await render(PaymentsPage, { staatus: "tagastatud" }))).toEqual([refsOf.refunded]);
  expect(refs(await render(PaymentsPage, { staatus: "midagi-muud", leht: "x" }))).toHaveLength(6); // an unknown filter is "Kõik", an unknown page is page 1
  for (const own of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(refs(await render(PaymentsPage, { staatus: own })), own).toHaveLength(6); // not a name of the object's prototype
});

test("Maksed: the payer (a link to the student when the payment has one), what, kind, amount, Montonio id", async () => {
  const html = await render(PaymentsPage);
  const prepayment = row(html, refsOf.prepayment);
  expect(prepayment).toContain(`href="/admin/opilased?id=${ids.kati}"`);
  expect(prepayment).toContain("kati@example.com");
  expect(prepayment).toContain("Kulmumeistri baaskoolitus");
  expect(prepayment).toContain("14.11.2026"); // the session's day
  expect(prepayment).toContain("Ettemaks");
  expect(prepayment).toContain("175 €");
  expect(prepayment).toContain("uuid-prepayment-0001");
  expect(row(html, refsOf.balance)).toContain("Ülejäänud");
  const ecourse = row(html, refsOf.ecourse);
  expect(ecourse).toContain("Kulmumeistri e-koolitus");
  expect(ecourse).toContain("E-koolitus");
  expect(ecourse).toContain("190 €");
  // a payment without an account: the name is plain text, the address still a mail link
  const lonely = row(html, refsOf.voided);
  expect(lonely).toContain("Liis Mets");
  expect(lonely).not.toContain("/admin/opilased");
  expect(lonely).toContain('href="mailto:liis@example.com"');
});

test("Maksed: the method in Maria's Estonian — 'Pangalink · Swedbank', 'Kaart', 'Apple Pay' — never Montonio's code; '—' before the bank said anything", async () => {
  const html = await render(PaymentsPage);
  const method = (reference: string) => /data-label="Makseviis"[^>]*>([^<]*)</.exec(row(html, reference))![1];
  expect(method(refsOf.prepayment)).toBe("Pangalink · Swedbank");
  expect(method(refsOf.balance)).toBe("Kaart");
  expect(method(refsOf.ecourse)).toBe("Apple Pay");
  expect(method(refsOf.voided)).toBe("Pangalink · Lõuna Pank");
  expect(method(refsOf.pending)).toBe("—");
  expect(html).not.toMatch(/paymentInitiation|cardPayments|applePay/);
});

test("Maksed: statuses in Estonian; 'Kontrolli Montonios' on a held payment and one the bank voided after it was paid, and on no other", async () => {
  const html = await render(PaymentsPage);
  const status = (reference: string) => /data-label="Staatus"[^>]*>([\s\S]*?)<\/td>/.exec(row(html, reference))![1].replace(/<[^>]*>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "");
  expect(status(refsOf.prepayment)).toBe("Makstud");
  expect(status(refsOf.ecourse)).toBe("Makstud");
  expect(status(refsOf.pending)).toBe("Pooleli");
  expect(status(refsOf.refunded)).toBe("Tagastatud");
  expect(status(refsOf.balance)).toBe("Ootel kontrollil|Kontrolli Montonios");
  expect(status(refsOf.voided)).toBe("Tühistatud pangas|Kontrolli Montonios");
  expect((html.match(/data-payment-check/g) ?? []).length).toBe(2);
  expect(html).not.toMatch(/>(held|failed|refunded|pending|paid)</);
});

test("Maksed: 'Kuupäev' is the day it was paid (else the day it was started), and the list is newest first by that day", async () => {
  const own = await makeTestDb();
  const was = state.db;
  state.db = own;
  try {
    const r = await registrationOn(own, await contactCourse(own));
    // started on 1.10 and paid on 5.10; another started on 3.10 and still pending
    const paidLater = await pendingPayment(own, r, {}, new Date("2026-10-01T09:00:00Z"));
    await own.update(payments).set({ status: "paid", paidAt: new Date("2026-10-05T09:00:00Z") }).where(eq(payments.id, paidLater.id));
    const open = await pendingPayment(own, r, { kind: "balance" }, new Date("2026-10-03T09:00:00Z"));
    const html = await render(PaymentsPage);
    expect(refs(html)).toEqual([paidLater.reference, open.reference]);
    const day = (reference: string) => /data-label="Kuupäev"[^>]*>([\s\S]*?)<\/td>/.exec(row(html, reference))![1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(day(paidLater.reference)).toBe("05.10.2026 12:00"); // 09:00 UTC is 12:00 in Tallinn (summer time)
    expect(day(open.reference)).toBe("03.10.2026 12:00");
  } finally {
    state.db = was;
  }
});

test("Maksed: no payments yet, and a filter with none, each say so", async () => {
  const empty = await makeTestDb();
  const was = state.db;
  state.db = empty;
  try {
    expect(await render(PaymentsPage)).toContain("Makseid veel pole.");
    expect(await render(PaymentsPage, { staatus: "makstud" })).toContain("Selle valikuga makseid pole.");
  } finally {
    state.db = was;
  }
});

test("Registreerimised: the registration's drawer lists its online payments under 'Laekunud' (date, amount, kind, method, status); Maria's amount form stays", async () => {
  const html = await render(RegistrationsPage, { id: String(ids.registration) });
  const block = /<div[^>]*data-registration-payments[^>]*>([\s\S]*?)<\/ul>/.exec(html)![1];
  expect(block).toContain("Veebimaksed");
  expect(refs(block)).toEqual([refsOf.balance, refsOf.prepayment]); // its own two, newest first: not the e-course, not the others'
  const prepayment = row(block, refsOf.prepayment);
  expect(prepayment).toContain("09.10.2026");
  expect(prepayment).toContain("175 €");
  expect(prepayment).toContain("Ettemaks");
  expect(prepayment).toContain("Pangalink · Swedbank");
  expect(prepayment).toContain("Makstud");
  expect(prepayment).not.toContain("data-payment-check");
  const balance = row(block, refsOf.balance);
  expect(balance).toContain("Kaart");
  expect(balance).toContain("Ootel kontrollil");
  expect(balance).toContain("Kontrolli Montonios");
  expect(html).not.toMatch(/paymentInitiation|cardPayments/);
  expect(html).toContain("Laekunud summa (€)"); // Maria's own form
  expect(html.indexOf("data-registration-payments")).toBeGreaterThan(html.indexOf("Laekunud</dt>"));
});

test("Registreerimised: ?staatus= with a name of the object's prototype ('constructor', '__proto__' …) is the unfiltered list, not a 500", async () => {
  const count = (html: string) => /Registreerimisi: \d+/.exec(html)?.[0];
  const all = count(await render(RegistrationsPage));
  expect(all).toMatch(/Registreerimisi: [1-9]/);
  expect(count(await render(RegistrationsPage, { staatus: "midagi-muud" }))).toBe(all);
  for (const own of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) expect(count(await render(RegistrationsPage, { staatus: own })), own).toBe(all);
  expect(count(await render(RegistrationsPage, { staatus: "kinnitatud" }))).toBe("Registreerimisi: 0"); // (a real filter still filters: none is confirmed)
});

test("Registreerimised: no online payments, no block; and the old e-learning note is gone", async () => {
  const bare = await registrationOn(db, contact, { email: "bare@example.com", name: "Ilma Maksetaa" });
  const html = await render(RegistrationsPage, { id: String(bare.id) });
  expect(html).toContain("Laekunud summa (€)");
  expect(html).not.toContain("data-registration-payments");
  const e = await render(RegistrationsPage, { vorm: "e" });
  expect(e).not.toContain("data-e-note");
  expect(e).not.toContain("lisanduvad koos maksetega");
  expect(e).toContain("Registreerimisi: ");
});

test("Õpilased drawer: 'Maksed' lists hers — her own and her registration's — with the course; an access a payment opened says 'Avas veebimakse'", async () => {
  const detail = (await clientDetail(db, ids.kati))!;
  const html = renderToStaticMarkup(ClientDetailView({ detail, ecourses: await listEcourses(db), now: at(10) }));
  const block = /<section[^>]*data-client-payments[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
  expect(block).toContain(">Maksed</h3>");
  expect(refs(block)).toEqual([refsOf.ecourse, refsOf.balance, refsOf.prepayment]);
  const ecourse = row(block, refsOf.ecourse);
  expect(ecourse).toContain("190 €");
  expect(ecourse).toContain("E-koolitus");
  expect(ecourse).toContain("Kulmumeistri e-koolitus");
  expect(ecourse).toContain("Apple Pay");
  expect(row(block, refsOf.prepayment)).toContain("Pangalink · Swedbank");
  expect(row(block, refsOf.prepayment)).toContain("Kulmumeistri baaskoolitus");
  expect(row(block, refsOf.balance)).toContain("Kontrolli Montonios");
  expect(html).toContain("Avas veebimakse, 09.10.2026 13:03"); // 10:03 UTC is 13:03 in Tallinn (summer time)
  expect(html).not.toContain("Avas payment");
});

test("Õpilased drawer: a student without payments says so; an access an admin opened still names the admin", async () => {
  const [liis] = await db.insert(clients).values({ email: "teine@example.com" }).returning();
  const [ecourse] = await db.select().from(courses).where(eq(courses.slug, "kulmumeistri-e-koolitus"));
  await db.insert(courseAccess).values({ clientId: liis.id, courseId: ecourse.id, grantedBy: "maria@example.test", grantedAt: at(7), expiresAt: new Date("2027-04-09T20:59:59.999Z") });
  const html = renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, liis.id))!, ecourses: [], now: at(10) }));
  expect(html).toMatch(/data-client-payments[^>]*>[\s\S]*Makseid pole\./);
  expect(html).not.toContain("data-payment-lines");
  expect(html).toContain("Avas maria@example.test, ");
  expect(adminEt.payments.noneForClient).toBe("Makseid pole.");
});
