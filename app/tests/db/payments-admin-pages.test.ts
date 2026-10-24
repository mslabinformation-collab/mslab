import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courses, payments } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { adminEt } from "@/i18n/dict/admin";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// The admin's Maksed page, the online payments in a registration's drawer and the Õpilased drawer, rendered from a real (PGlite) database
// to HTML: Maria's words (Eest, Makseviis, Estonian statuses, "Pangalink · Swedbank" and never Montonio's code), "Kontrolli Montonios" on
// the rows she must look at, and the old "E-õppe ostud lisanduvad koos maksetega." note gone. The drawer's dialog and the server
// actions are stand-ins (they need a browser or a request); everything else is the real page.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
// (the list's toolbar is a client component that reads the router and the address, which a page rendered to HTML here has not got)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/registreerimised",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children) };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

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

/** The opening tag of one payment's table row (its class says whether it is tinted). */
const trOf = (html: string, reference: string) => {
  const at = html.indexOf(`data-payment="${reference}"`);
  expect(at, reference).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<tr", at), html.indexOf(">", at) + 1);
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

test("Maksed: Maria's heading (shared with Arved), lead and the six column heads; newest first; the search; the tabs", async () => {
  const html = await render(PaymentsPage);
  expect(html).toContain("<h1");
  expect(html).toContain(">Maksed ja arved</h1>");
  expect(html).toContain("Montonio ja raamatupidamine");
  expect(html).toContain("Tagastused tehakse Montonio halduses");
  expect(html).not.toContain("töölaual");
  for (const head of ["Kuupäev", "Maksja", "Eest", "Summa", "Staatus", "Montonio id"]) expect(html, head).toContain(`<th scope="col">${head}</th>`);
  // the kind is under „Eest“ and the way it was paid under the sum: no columns of their own (A6)
  expect(html).not.toMatch(/<th[^>]*>(Liik|Makseviis|Mis|Viis)<\/th>/);
  expect(html).not.toContain('data-label="Makseviis"');
  expect(html).toContain("Makseid: 6");
  expect(refs(html)).toEqual([refsOf.refunded, refsOf.pending, refsOf.voided, refsOf.ecourse, refsOf.balance, refsOf.prepayment]);
  // the tabs „Maksed“ | „Arved“ (README A6), each its own page; Maksed is the current one; the header button „Arved“ is gone
  const tabs = /<nav[^>]*aria-label="([^"]*)"[^>]*data-tab-pills[^>]*>([\s\S]*?)<\/nav>/.exec(html)!;
  expect(tabs[1]).toBe("Maksed ja arved");
  expect([...tabs[2].matchAll(/<a [^>]*>/g)].map((m) => [/href="([^"]*)"/.exec(m[0])![1], /aria-current="([^"]*)"/.exec(m[0])?.[1] ?? null])).toEqual([
    ["/admin/maksed", "page"],
    ["/admin/arved", null],
  ]);
  expect(html).not.toContain("data-payments-invoices");
  // the search field (S3-m): name, e-mail and Montonio id
  expect(html).toMatch(/<input[^>]*type="search"[^>]*placeholder="Otsi nime, e-posti või Montonio id järgi"/);
});

test("Maksed: the filter pills in Maria's words with their counts, each with its own address; the current one marked", async () => {
  const html = await render(PaymentsPage, { staatus: "kontroll" });
  const nav = /<nav[^>]*data-list-pill-row[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
  const pills = [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => [m[2], m[1], m[3]]);
  // (the counts are the rows each pill shows: Kõik 6; Makstud 2; Pooleli 1; Ebaõnnestunud 0, the voided one is under Ootel kontrollil; Tagastatud 1; Ootel kontrollil 2)
  expect(pills).toEqual([
    ["Kõik", "/admin/maksed", "6"],
    ["Makstud", "/admin/maksed?staatus=makstud", "2"],
    ["Pooleli", "/admin/maksed?staatus=pooleli", "1"],
    ["Ebaõnnestunud", "/admin/maksed?staatus=ebaonnestunud", "0"],
    ["Tagastatud", "/admin/maksed?staatus=tagastatud", "1"],
    ["Ootel kontrollil", "/admin/maksed?staatus=kontroll", "2"],
  ]);
  expect(nav).toMatch(/aria-current="true"[^>]*>Ootel kontrollil</);
  // B14: the held one and the one the bank voided after it was paid, newest first (by the day it was paid)
  expect(refs(html)).toEqual([refsOf.voided, refsOf.balance]);
  expect(refs(await render(PaymentsPage, { staatus: "makstud" }))).toEqual([refsOf.ecourse, refsOf.prepayment]);
  expect(refs(await render(PaymentsPage, { staatus: "ebaonnestunud" }))).toEqual([]); // (the voided one moved to „Ootel kontrollil“: this one was paid)
  expect(await render(PaymentsPage, { staatus: "ebaonnestunud" })).toContain("Selle valikuga makseid pole.");
  expect(refs(await render(PaymentsPage, { staatus: "tagastatud" }))).toEqual([refsOf.refunded]);
  expect(refs(await render(PaymentsPage, { staatus: "midagi-muud", leht: "x" }))).toHaveLength(6); // an unknown filter is "Kõik", an unknown page is page 1
  for (const own of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(refs(await render(PaymentsPage, { staatus: own })), own).toHaveLength(6); // not a name of the object's prototype
});

test("Maksed: a search narrows the rows and every pill's count together, and the pills and the pager keep it", async () => {
  // Kati's two (the prepayment and the held balance) and the e-course purchase: "kati@"
  const html = await render(PaymentsPage, { otsi: "KATI@example" });
  expect(refs(html)).toEqual([refsOf.ecourse, refsOf.balance, refsOf.prepayment]);
  expect(html).toContain("Makseid: 3");
  const nav = /<nav[^>]*data-list-pill-row[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
  const pills = [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => [m[2], m[1], m[3]]);
  expect(pills).toEqual([
    ["Kõik", "/admin/maksed?otsi=KATI%40example", "3"],
    ["Makstud", "/admin/maksed?otsi=KATI%40example&amp;staatus=makstud", "2"],
    ["Pooleli", "/admin/maksed?otsi=KATI%40example&amp;staatus=pooleli", "0"],
    ["Ebaõnnestunud", "/admin/maksed?otsi=KATI%40example&amp;staatus=ebaonnestunud", "0"],
    ["Tagastatud", "/admin/maksed?otsi=KATI%40example&amp;staatus=tagastatud", "0"],
    ["Ootel kontrollil", "/admin/maksed?otsi=KATI%40example&amp;staatus=kontroll", "1"],
  ]);
  // by the Montonio id (whole or in part, any case) and by Maria's reference
  expect(refs(await render(PaymentsPage, { otsi: "uuid-prepayment-0001" }))).toEqual([refsOf.prepayment]);
  expect(refs(await render(PaymentsPage, { otsi: "UUID-VOIDED" }))).toEqual([refsOf.voided]);
  expect(refs(await render(PaymentsPage, { otsi: refsOf.ecourse }))).toEqual([refsOf.ecourse]);
  // a name in Cyrillic or Latin, a pill and a search together
  expect(refs(await render(PaymentsPage, { otsi: "liis", staatus: "kontroll" }))).toEqual([refsOf.voided]);
  expect(refs(await render(PaymentsPage, { otsi: "liis", staatus: "makstud" }))).toEqual([]);
  // nothing found: the search is named, and the way back is there
  const none = await render(PaymentsPage, { otsi: "ei-leia-midagi" });
  expect(none).toContain("„ei-leia-midagi“ järgi makseid ei leitud.");
  expect(none).toContain("Tühjenda otsing ja filtrid");
  expect(none).toContain('href="/admin/maksed"');
  // a wildcard is a letter
  expect(refs(await render(PaymentsPage, { otsi: "%" }))).toEqual([]);
});

test("Maksed: each row leads somewhere — the registration's drawer, or the student for an e-course payment; a payer with neither is plain text", async () => {
  const html = await render(PaymentsPage);
  const prepayment = row(html, refsOf.prepayment);
  expect(prepayment).toContain(`href="/admin/registreerimised?id=${ids.registration}"`);
  expect(prepayment).not.toContain("/admin/opilased");
  expect(prepayment).toContain('aria-label="Ava Kati Tamm"');
  expect(prepayment).toContain("Ava registreering →"); // (the phone card says where the row leads: the Part 2 phone frame)
  expect(prepayment).toContain("kati@example.com");
  expect(prepayment).toContain("Kulmumeistri baaskoolitus");
  expect(prepayment).toContain("14.11.2026"); // the session's day
  expect(prepayment).toContain("Ettemaks");
  expect(prepayment).toContain("175 €");
  expect(row(html, refsOf.balance)).toContain("Ülejäänud");
  expect(row(html, refsOf.balance)).toContain(`href="/admin/registreerimised?id=${ids.registration}"`);
  const ecourse = row(html, refsOf.ecourse);
  expect(ecourse).toContain(`href="/admin/opilased?id=${ids.kati}"`);
  expect(ecourse).not.toContain("/admin/registreerimised");
  expect(ecourse).toContain("Ava õpilane →");
  expect(ecourse).toContain("Kulmumeistri e-koolitus");
  expect(ecourse).toContain("E-koolitus");
  expect(ecourse).toContain("190 €");
  // a payment of a registration that has no account: the registration, and the address still a mail link
  const lonely = row(html, refsOf.voided);
  expect(lonely).toContain("Liis Mets");
  expect(lonely).toContain(`href="/admin/registreerimised?id=${ids.lonely}"`);
  expect(lonely).not.toContain("/admin/opilased");
  expect(lonely).toContain('href="mailto:liis@example.com"');
  // each row's name is the one link that takes the whole row (ListRows): a link of the shared list's name class
  expect((html.match(/<a [^>]*aria-label="Ava [^"]*"/g) ?? []).length).toBe(6);
});

test("Maksed: a payment with neither a registration nor a student (its rows were deleted) has the name as plain text and no link to follow", async () => {
  const own = await makeTestDb();
  const was = state.db;
  state.db = own;
  try {
    const [orphan] = await own
      .insert(payments)
      .values({ reference: "MSLAB-M902", kind: "ecourse", courseId: null, clientId: null, registrationId: null, email: "gert@example.com", name: "Gert Eemal", amountCents: 19000, status: "paid", paidAt: at(1), createdAt: at(1), providerUuid: null })
      .returning();
    const html = await render(PaymentsPage);
    const r = row(html, orphan.reference);
    expect(r).toContain("Gert Eemal");
    expect(r).not.toMatch(/href="\/admin\/(opilased|registreerimised)/);
    expect(r).not.toContain("aria-label=\"Ava ");
    expect(r).not.toContain("Ava õpilane");
    expect(r).toContain(adminEt.payments.courseGone);
    // and no Montonio id yet: nothing to open or copy
    expect(r).not.toContain("data-montonio-link");
    expect(/data-label="Montonio id"[^>]*>([^<]*)</.exec(r)![1]).toBe("—");
  } finally {
    state.db = was;
  }
});

test("Maksed: the Montonio id is „Montonios ↗“ — a link to the Partner System (a new tab) that copies the order id; the id is in its title, never as text", async () => {
  const html = await render(PaymentsPage);
  const link = (reference: string) => /<a [^>]*data-montonio-link[^>]*>/.exec(row(html, reference))![0];
  const prepayment = link(refsOf.prepayment);
  expect(prepayment).toContain('href="https://sandbox-partner.montonio.com"'); // (no live keys here)
  expect(prepayment).toContain('target="_blank"');
  expect(prepayment).toContain('rel="noopener"');
  expect(prepayment).toContain('title="uuid-prepayment-0001"');
  // its name for a screen reader: the visible words and the payer's (the page has one such link a row)
  expect(prepayment).toContain('aria-label="Montonios ↗ — Kati Tamm"');
  expect([...html.matchAll(/<a [^>]*data-montonio-link[^>]*aria-label="([^"]*)"|<a [^>]*aria-label="([^"]*)"[^>]*data-montonio-link/g)].map((m) => m[1] ?? m[2]).sort()).toEqual(
    ["Juhan Kask", "Kati Tamm", "Kati Tamm", "Kati Tamm", "Liis Mets", "Mari Kask"].map((n) => `Montonios ↗ — ${n}`),
  );
  expect(row(html, refsOf.prepayment)).toMatch(/data-label="Montonio id"[^>]*>[\s\S]*Montonios <span aria-hidden="true">↗<\/span>/);
  expect(row(html, refsOf.prepayment)).toContain('role="status"');
  // the order's id is no longer text on the page (the title and the clipboard have it)
  expect(html).not.toMatch(/>uuid-[a-z]+-\d+</);
  expect((html.match(/data-montonio-link/g) ?? []).length).toBe(6);
  expect(html).not.toContain("kopeeritud"); // (said by the browser after a press, never drawn before)
});

test("Maksed: while the live keys are in use the link is to the live Partner System", async () => {
  vi.stubEnv("MONTONIO_ENV", "live");
  try {
    const html = await render(PaymentsPage);
    expect(html).toContain('href="https://partner.montonio.com"');
    expect(html).not.toContain("sandbox-partner");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Maksed: the sum with the way it was paid under it, in Maria's Estonian — 'Pangalink · Swedbank', 'Kaart', 'Apple Pay' — never Montonio's code; none before the bank said anything", async () => {
  const html = await render(PaymentsPage);
  const method = (reference: string) => /data-payment-method[^>]*>([^<]*)</.exec(row(html, reference))?.[1] ?? null;
  expect(method(refsOf.prepayment)).toBe("Pangalink · Swedbank");
  expect(method(refsOf.balance)).toBe("Kaart");
  expect(method(refsOf.ecourse)).toBe("Apple Pay");
  expect(method(refsOf.voided)).toBe("Pangalink · Lõuna Pank");
  expect(method(refsOf.pending)).toBeNull();
  expect(/data-label="Summa"[^>]*>([\s\S]*?)<\/td>/.exec(row(html, refsOf.prepayment))![1]).toContain("175 €");
  // the phone card's meta line says it too: the day and month, the course, the way it was paid
  expect(/data-payment-meta[^>]*>([^<]*)</.exec(row(html, refsOf.prepayment))![1]).toBe("09.10 · Kulmumeistri baaskoolitus · Pangalink · Swedbank");
  expect(/data-payment-meta[^>]*>([^<]*)</.exec(row(html, refsOf.pending))![1]).toBe("09.10 · Kulmumeistri baaskoolitus");
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

test("Maksed: a held payment with a reason says it (P-8) in place of 'Kontrolli Montonios'; a replaced order is 'Asendatud', shown under 'Kõik' only, and needs no check", async () => {
  const own = await makeTestDb();
  const was = state.db;
  state.db = own;
  try {
    const c = await contactCourse(own);
    const reg = await registrationOn(own, c);
    const double = await pendingPayment(own, reg, {}, at(1));
    await own.update(payments).set({ status: "held", paidAt: at(1), checkReason: "double", method: "paymentInitiation", bank: "Swedbank" }).where(eq(payments.id, double.id));
    const plain = await pendingPayment(own, reg, { kind: "balance" }, at(2));
    await own.update(payments).set({ status: "held", paidAt: at(2) }).where(eq(payments.id, plain.id));
    const old = await pendingPayment(own, reg, { kind: "balance" }, at(3));
    await own.update(payments).set({ status: "replaced", method: "hirePurchase" }).where(eq(payments.id, old.id));
    const all = await render(PaymentsPage);
    const check = (reference: string) => /data-payment-check[^>]*>([^<]*)</.exec(row(all, reference))?.[1] ?? null;
    expect(check(double.reference)).toBe("Topeltmakse — tagasta");
    expect(check(plain.reference)).toBe("Kontrolli Montonios");
    // the replaced order: its own tag, no check, and only under „Kõik“; the pills still add up to what they show (it is in none of them)
    expect(refs(all)).toEqual([old.reference, plain.reference, double.reference]);
    expect(check(old.reference)).toBeNull();
    expect(/data-label="Staatus"[^>]*>([\s\S]*?)<\/td>/.exec(row(all, old.reference))![1].replace(/<[^>]*>/g, "")).toBe("Asendatud");
    const nav = /<nav[^>]*data-list-pill-row[^>]*>([\s\S]*?)<\/nav>/.exec(all)![1];
    expect([...nav.matchAll(/>([^<]*)<span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(["Kõik 3", "Makstud 0", "Pooleli 0", "Ebaõnnestunud 0", "Tagastatud 0", "Ootel kontrollil 2"]);
    for (const staatus of ["makstud", "pooleli", "ebaonnestunud", "tagastatud"]) expect(refs(await render(PaymentsPage, { staatus })), staatus).not.toContain(old.reference);
    expect(refs(await render(PaymentsPage, { staatus: "kontroll" }))).toEqual([plain.reference, double.reference]);
    // the row is tinted for the two to check, not for the replaced one
    for (const p of [double, plain]) expect(trOf(all, p.reference), p.reference).toMatch(/class="[^"]*check/);
    expect(trOf(all, old.reference)).not.toMatch(/check/);
  } finally {
    state.db = was;
  }
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

test("Registreerimised: the registration's drawer lists its online payments in the Raha card (date, amount, kind, method, status); the typed amount form is gone (B4)", async () => {
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
  // B4: money is added with „Lisa laekumine“, never typed as a total
  expect(html).not.toContain("Laekunud summa (€)");
  expect(html).not.toContain("data-payment-form");
  // in the Raha card, after the money (Task 5: „{laekunud} / {hind} laekunud“), before „Lisa laekumine“
  const card = html.slice(html.indexOf("data-money-card"));
  expect(html.indexOf("data-money-card")).toBeGreaterThan(-1);
  expect(card.indexOf("data-registration-payments")).toBeGreaterThan(card.indexOf("data-paid="));
  expect(card.indexOf("data-registration-payments")).toBeLessThan(card.indexOf("data-add-payment"));
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
  expect(html).toContain("data-registration-detail");
  expect(html).not.toContain("data-registration-payments");
  const e = await render(RegistrationsPage, { vorm: "e" });
  expect(e).not.toContain("data-e-note");
  expect(e).not.toContain("lisanduvad koos maksetega");
  expect(e).toContain("Registreerimisi: ");
});

test("Õpilased drawer: 'Maksed' lists hers — her own and her registration's — with the course; an access a payment opened says 'Avas veebimakse'", async () => {
  const detail = (await clientDetail(db, ids.kati))!;
  const html = renderToStaticMarkup(ClientDetailView({ detail, ecourses: await listEcourses(db), now: at(10) }));
  // „Maksed“ is a folded row of the drawer: its summary says how many and the sum paid (the paid ones: the money in, not the held or voided), what is inside is the lines
  const at0 = html.indexOf("data-client-payments");
  const folded = html.slice(html.lastIndexOf("<details", at0), html.indexOf("</details>", at0));
  const block = folded.slice(folded.indexOf("data-client-payments"));
  const paid = detail.payments.filter((p) => p.status === "paid").reduce((sum, p) => sum + p.amountCents, 0);
  expect(folded).toContain(">Maksed</span>");
  expect(/data-fold-summary="">([^<]*)</.exec(folded)![1]).toBe(`3 · ${formatEUR(paid, "et")}`);
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
