import { eq } from "drizzle-orm";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, kvEntries, newsletterCampaigns, newsletterDeliveries, subscribers } from "@/db/schema";
import { PgKv } from "@/server/kv";
import { PRESS_BUDGET_MS, SEND_GAP_MS } from "@/server/newsletter-campaigns";
import { NOTIFY_TIMEOUT_MS, RATE_LIMIT_RETRY_MS } from "@/server/notify";
import { makeTestDb } from "./helpers";

// Maria's „Uudiskiri“ page and the student's drawer on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's):
// the subscribers' view (piece 3b Task 7, README B5: the search by a part of an address, the pills „Kinnitatud“ / „Ootab kinnitust“ with their counts, the
// one „Laadi alla (CSV)“ of the current filter, and nothing of Resend: no sync, no counts, no marks on the rows), the
// „Kirjad“ view (piece 3b Task 6, README B5: the tabs „Tellijad“ | „Kirjad“, the list with „Uus kiri +“ and each letter's state line, the editor of the
// chosen one with its sends and the count on „Saada kõigile ({n})“, one going out with its progress, its failed and unknown counts and the refused mark, a
// sent one read-only), and the student's drawer (its newsletter line, no mark). The
// drawer's forms and the server actions are stand-ins (they need a browser or a request).

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/data", async () => {
  const { adminCounts } = await import("@/db/queries/admin");
  return { getAdminCounts: async (email: string) => adminCounts(state.db as Db, email, new Date()) };
});
vi.mock("@/server/actions/admin-newsletter", () => ({
  createDraftAction: vi.fn(),
  deleteDraftAction: vi.fn(),
  copyCampaignAction: vi.fn(),
  prepareSendAction: vi.fn(),
  startSendAction: vi.fn(),
  stopSendAction: vi.fn(),
  sendTestAction: vi.fn(),
}));
// (the toolbar reads the address from `nav`, as the browser would give it)
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/uudiskiri",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-reviews", () => ({ decideReviewAction: vi.fn(), undoDecisionAction: vi.fn(), setFeaturedAction: vi.fn(), saveManualReviewAction: vi.fn(), removeReviewAction: vi.fn(), undoRemoveReviewAction: vi.fn() }));

import * as page from "@/app/admin/(panel)/uudiskiri/page";
import NewsletterPage from "@/app/admin/(panel)/uudiskiri/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;

const render = async (search: Record<string, string> = {}) => {
  nav.search = new URLSearchParams(search).toString();
  return renderToStaticMarkup(await NewsletterPage({ searchParams: Promise.resolve(search) }));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

let n = 0;
/** A subscriber, confirmed an hour before NOW unless told otherwise. */
async function sub(email: string, o: Partial<typeof subscribers.$inferInsert> = {}) {
  const [r] = await db
    .insert(subscribers)
    .values({ email, locale: "et", token: `tok${++n}`, consentAt: at(-60), confirmedAt: at(-60), ...o })
    .returning();
  return r;
}

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  for (const table of [subscribers, clients, newsletterCampaigns, kvEntries]) await db.delete(table);
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The page for an address like „?otsi=kask&olek=ootab“, as a document. */
async function open(query: Record<string, string> = {}) {
  const document = new Window().document;
  document.body.innerHTML = await render(query);
  return document;
}
type Doc = Awaited<ReturnType<typeof open>>;
/** The addresses of the rows on the screen, in order. */
const shownRows = (doc: Doc) => [...doc.querySelectorAll("tr[data-subscriber] td:first-child")].map((e) => e.textContent!.trim());
/** The two pills under „Staatus“: their words and counts, where each goes, and which one is current. */
const statePills = (doc: Doc) => {
  const row = [...doc.querySelectorAll("nav[data-list-pill-row]")].find((n) => n.getAttribute("aria-label") === "Staatus");
  expect(row, "the pill row „Staatus“").toBeTruthy();
  return [...row!.querySelectorAll("a")].map((a) => ({ text: a.textContent!, href: a.getAttribute("href")!, current: a.getAttribute("aria-current") === "true" }));
};
const csvLink = (doc: Doc) => doc.querySelector("a[data-csv]")!;

describe("the subscribers' view", () => {
  test("the list, its count line, the search and the two pills; one „Laadi alla (CSV)“; nothing of Resend on it: no sync, no counts, no marks on the rows", async () => {
    const kati = await sub("kati@example.test");
    await sub("mari@example.test", { confirmedAt: null });
    const html = await render();
    expect(html).toContain(`data-subscriber="${kati.id}"`);
    expect(text(html)).toContain("kati@example.test");
    expect(text(html)).toContain("Tellijaid: 2, neist kinnitatud 1");
    for (const gone of ["data-newsletter-sync", "data-sync-", "data-subscriber-suppressed", "data-subscriber-rejected"]) expect(html, gone).not.toContain(gone);
    expect(text(html)).not.toMatch(/Resend/i);
    // the toolbar (P-13: the placeholder is the field's name)
    const doc = await open();
    const field = doc.querySelector('form[role="search"] input[type="search"]')!;
    expect(field.getAttribute("placeholder")).toBe("Otsi e-posti järgi");
    expect(field.getAttribute("aria-label")).toBe("Otsi e-posti järgi");
    // the two pills with their counts, drawn without „Kõik“ (piece3-texts §4); nothing chosen
    expect(statePills(doc)).toEqual([
      { text: "Kinnitatud1", href: "/admin/uudiskiri?olek=kinnitatud", current: false },
      { text: "Ootab kinnitust1", href: "/admin/uudiskiri?olek=ootab", current: false },
    ]);
    // one CSV button for the current filter replaces the two fixed ones
    expect(doc.querySelectorAll("a[data-csv]")).toHaveLength(1);
    expect(csvLink(doc).textContent!.trim()).toBe("Laadi alla (CSV)");
    expect(csvLink(doc).getAttribute("href")).toBe("/api/admin/subscribers.csv");
    expect(csvLink(doc).hasAttribute("download")).toBe(true);
    expect(text(html)).not.toMatch(/Lae alla/);
  });

  test("the search finds an address by a part of it; the pills' counts follow the search; the CSV button carries it", async () => {
    await sub("kati.kask@example.test");
    await sub("kaie@example.test", { confirmedAt: null });
    await sub("mari@sample.test");
    const doc = await open({ otsi: "ka" });
    expect(shownRows(doc)).toEqual(["kaie@example.test", "kati.kask@example.test"]);
    expect(doc.querySelector('input[type="search"]')!.getAttribute("value")).toBe("ka");
    expect(statePills(doc).map((p) => p.text)).toEqual(["Kinnitatud1", "Ootab kinnitust1"]);
    expect(text(doc.body.innerHTML)).toContain("Tellijaid: 2, neist kinnitatud 1");
    expect(csvLink(doc).getAttribute("href")).toBe("/api/admin/subscribers.csv?otsi=ka");
    // the pills keep the search; the part of an address needs no word of the address's own
    expect(statePills(doc).map((p) => p.href)).toEqual(["/admin/uudiskiri?otsi=ka&olek=kinnitatud", "/admin/uudiskiri?otsi=ka&olek=ootab"]);
    expect(shownRows(await open({ otsi: "SAMPLE" }))).toEqual(["mari@sample.test"]);
  });

  test("a pill shows its own rows and toggles off at a second press; the other keeps its count; the CSV button carries the state", async () => {
    await sub("kati@example.test", { consentAt: at(-10) });
    await sub("kaie@example.test", { confirmedAt: null, consentAt: at(-20) });
    await sub("mari@example.test", { confirmedAt: null, consentAt: at(-30) });
    const confirmed = await open({ olek: "kinnitatud" });
    expect(shownRows(confirmed)).toEqual(["kati@example.test"]);
    expect(statePills(confirmed)).toEqual([
      { text: "Kinnitatud1", href: "/admin/uudiskiri", current: true }, // (pressed again: the list as it was)
      { text: "Ootab kinnitust2", href: "/admin/uudiskiri?olek=ootab", current: false },
    ]);
    expect(csvLink(confirmed).getAttribute("href")).toBe("/api/admin/subscribers.csv?olek=kinnitatud");
    const pending = await open({ olek: "ootab", otsi: "ka" });
    expect(shownRows(pending)).toEqual(["kaie@example.test"]);
    expect(statePills(pending)).toEqual([
      { text: "Kinnitatud1", href: "/admin/uudiskiri?otsi=ka&olek=kinnitatud", current: false },
      { text: "Ootab kinnitust1", href: "/admin/uudiskiri?otsi=ka", current: true },
    ]);
    expect(csvLink(pending).getAttribute("href")).toBe("/api/admin/subscribers.csv?otsi=ka&olek=ootab");
    // an address that says something else (a word that is no state) is no state
    for (const olek of ["x", "constructor", "__proto__", "kinnitatud,ootab", ""]) {
      const doc = await open({ olek });
      expect(shownRows(doc), olek).toHaveLength(3);
      expect(statePills(doc).some((p) => p.current), olek).toBe(false);
      expect(csvLink(doc).getAttribute("href"), olek).toBe("/api/admin/subscribers.csv");
    }
  });

  test("the former „Lae alla kinnitatud (CSV)“ link, ?kinnitatud=1, still means the confirmed ones on the page and in the file", async () => {
    await sub("kati@example.test");
    await sub("mari@example.test", { confirmedAt: null });
    const doc = await open({ kinnitatud: "1" });
    expect(shownRows(doc)).toEqual(["kati@example.test"]);
    expect(csvLink(doc).getAttribute("href")).toBe("/api/admin/subscribers.csv?olek=kinnitatud");
  });

  test("R-h: the counts are the rows — every row, sample addresses too — whatever is chosen; a percent sign or an underscore in the search is itself", async () => {
    await sub("kati@example.test");
    await sub("mari@example.test", { confirmedAt: null });
    await sub("liis@sample.example.test");
    await sub("50%off@example.test");
    await sub("a_b@example.test", { confirmedAt: null });
    await sub("axb@example.test", { confirmedAt: null });
    const count = (doc: Doc, i: number) => Number(statePills(doc)[i].text.replace(/\D/g, ""));
    const none = await open();
    expect(shownRows(none)).toHaveLength(count(none, 0) + count(none, 1));
    expect(statePills(none).map((p) => p.text)).toEqual(["Kinnitatud3", "Ootab kinnitust3"]);
    for (const [query, state] of [
      [{ olek: "kinnitatud" }, 0],
      [{ olek: "ootab" }, 1],
      [{ otsi: "example.test", olek: "kinnitatud" }, 0],
      [{ otsi: "sample", olek: "ootab" }, 1],
    ] as const) {
      const doc = await open(query);
      expect(shownRows(doc), JSON.stringify(query)).toHaveLength(count(doc, state));
    }
    expect(shownRows(await open({ otsi: "%" }))).toEqual(["50%off@example.test"]);
    expect(shownRows(await open({ otsi: "_" }))).toEqual(["a_b@example.test"]);
    expect(shownRows(await open({ otsi: "a_b", olek: "ootab" }))).toEqual(["a_b@example.test"]);
    const percent = await open({ otsi: "%" });
    expect(statePills(percent).map((p) => p.text)).toEqual(["Kinnitatud1", "Ootab kinnitust0"]);
    expect(csvLink(percent).getAttribute("href")).toBe("/api/admin/subscribers.csv?otsi=%25");
  });

  test("the pager keeps the search and the state; a new search or pill starts at page 1", async () => {
    for (let i = 0; i < 52; i++) await sub(`s${String(i).padStart(2, "0")}@example.test`, { consentAt: at(-i - 1), confirmedAt: i % 2 === 0 ? at(-i - 1) : null });
    const doc = await open({ otsi: "example", olek: "kinnitatud" });
    expect(shownRows(doc)).toHaveLength(26);
    expect(doc.querySelector("[data-pager]")).toBeNull();
    const all = await open({ otsi: "example", leht: "2" });
    expect(shownRows(all)).toHaveLength(2);
    expect(statePills(all).map((p) => p.href)).toEqual(["/admin/uudiskiri?otsi=example&olek=kinnitatud", "/admin/uudiskiri?otsi=example&olek=ootab"]); // (no ?leht=)
    expect(all.querySelector('[data-pager] a[rel="prev"]')!.getAttribute("href")).toBe("/admin/uudiskiri?otsi=example");
    const first = await open({ otsi: "example" });
    expect(first.querySelector('[data-pager] a[rel="next"]')!.getAttribute("href")).toBe("/admin/uudiskiri?otsi=example&leht=2");
    const pendingPage = await open({ olek: "ootab" });
    expect(shownRows(pendingPage)).toHaveLength(26);
    const dense = await open({ otsi: "s", leht: "2" });
    expect(dense.querySelector('[data-pager] a[rel="prev"]')!.getAttribute("href")).toBe("/admin/uudiskiri?otsi=s");
  });

  test("an empty list says so and still renders the CSV button; a search with no hit and a state with none say so, with the way back (P-13, the shared lists texts)", async () => {
    const none = await open();
    expect(text(none.body.innerHTML)).toContain("Tellijaid veel pole.");
    expect(none.querySelector("[data-list-empty] a")).toBeNull(); // (nothing is chosen: nothing to clear)
    expect(csvLink(none).getAttribute("href")).toBe("/api/admin/subscribers.csv");
    expect(statePills(none).map((p) => p.text)).toEqual(["Kinnitatud0", "Ootab kinnitust0"]);
    await sub("kati@example.test");
    const nobody = await open({ otsi: "xyz" });
    expect(text(nobody.body.innerHTML)).toContain("„xyz“ järgi tellijaid ei leitud.");
    expect(nobody.querySelector("[data-list-empty] a")!.getAttribute("href")).toBe("/admin/uudiskiri");
    expect(nobody.querySelector("[data-list-empty] a")!.textContent).toBe("Tühjenda otsing ja filtrid");
    expect(csvLink(nobody).getAttribute("href")).toBe("/api/admin/subscribers.csv?otsi=xyz");
    const pending = await open({ olek: "ootab" });
    expect(text(pending.body.innerHTML)).toContain("Selle valikuga tellijaid pole.");
    expect(pending.querySelector("[data-list-empty] a")!.getAttribute("href")).toBe("/admin/uudiskiri");
  });

  test("120 seconds: „Saada kõigile“ is a server action of this page and runs the first batch (PRESS_BUDGET_MS, a send begun at its end included)", () => {
    expect((page as Record<string, unknown>).maxDuration).toBe(120);
    const oneSend = NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS; // a call, a 429, the one retry
    expect((PRESS_BUDGET_MS + SEND_GAP_MS + oneSend) / 1000).toBeLessThan(120 - 30); // (room for the queries and the database's own waits)
  });
});

describe("the „Kirjad“ view (?vaade=kampaaniad)", () => {
  const DRAFT = {
    name: "Oktoobri pakkumine",
    subject: { et: "Sügispakkumine", ru: "" },
    preheader: { et: "", ru: "" },
    body: { et: "Esimene lõik.", ru: "" },
  };
  const campaign = async (name: string, o: Partial<typeof newsletterCampaigns.$inferInsert> = {}) => {
    const [row] = await db.insert(newsletterCampaigns).values({ ...DRAFT, name, ...o }).returning();
    return row;
  };
  /** The tabs' links: each tab's label, its address and whether it is the current one (TabPills). */
  const tabs = (html: string) =>
    [...(html.match(/<nav[^>]*data-tab-pills=""[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/<a([^>]*)>([^<]*)/g)].map((m) => ({
      label: m[2],
      href: m[1].match(/href="([^"]*)"/)?.[1],
      current: m[1].includes('aria-current="page"'),
    }));

  test("the tabs „Tellijad“ | „Kirjad“ (TabPills; the address keeps ?vaade=kampaaniad); the letters' own heading „Kirjad“ without the CSV buttons or a lead; „Uus kiri +“", async () => {
    const subscribersView = await render();
    expect(tabs(subscribersView)).toEqual([
      { label: "Tellijad", href: "/admin/uudiskiri", current: true },
      { label: "Kirjad", href: "/admin/uudiskiri?vaade=kampaaniad", current: false },
    ]);
    const letters = await render({ vaade: "kampaaniad" });
    expect(tabs(letters)).toEqual([
      { label: "Tellijad", href: "/admin/uudiskiri", current: false },
      { label: "Kirjad", href: "/admin/uudiskiri?vaade=kampaaniad", current: true },
    ]);
    expect(letters).toContain(">Kirjad</h1>");
    expect(letters).not.toContain("data-csv");
    expect(letters).not.toContain("data-subscriber=");
    expect(letters).not.toContain("data-newsletter-views");
    expect(text(letters)).toContain("Kirju veel pole.");
    expect(letters).toMatch(/<button[^>]*data-campaign-new=""[^>]*>Uus kiri \+<\/button>/);
    // „Uus kiri +“ makes its draft at once: there is no address of an empty editor any more
    expect(letters).not.toContain("kampaania=uus");
    expect(text(letters)).not.toMatch(/Kampaania|kampaania/);
    // the old `uus` opens nothing (an old bookmark): the list
    const old = await render({ vaade: "kampaaniad", kampaania: "uus" });
    expect(old).not.toContain("data-campaign-form");
    expect(old).not.toContain("data-campaign-not-found");
  });

  test("admin polish F12: the tabs stand in one place in both views — the right end of the H1's row (the B5 frame's place), after „Laadi alla (CSV)“ in Tellijad, after ET | RU while a letter is open", async () => {
    const draft = await campaign("Proov");
    /** The heading's right side, what it holds in order (the tabs as „tabs“), and whether the H1 is the left side's. */
    const aside = async (search: Record<string, string>) => {
      const document = new Window().document;
      document.body.innerHTML = await render(search);
      const tabsNav = document.querySelector("nav[data-tab-pills]")!;
      const h1 = document.querySelector("h1")!;
      const heading = h1.parentElement!.parentElement!;
      const side = heading.lastElementChild!;
      return {
        tabsInSide: side.contains(tabsNav),
        last: side.lastElementChild!.contains(tabsNav),
        before: [...side.children].slice(0, -1).map((el) => (el.querySelector("a[data-csv]") ? "csv" : el.matches("[data-edit-lang-bar]") ? "langs" : el.tagName)),
      };
    };
    expect(await aside({})).toEqual({ tabsInSide: true, last: true, before: ["csv"] });
    expect(await aside({ vaade: "kampaaniad" })).toEqual({ tabsInSide: true, last: true, before: [] });
    expect(await aside({ vaade: "kampaaniad", kampaania: String(draft.id) })).toEqual({ tabsInSide: true, last: true, before: ["langs"] });
    // (no tab row of its own under the lead any more)
    const subscribersView = await render();
    expect(subscribersView.match(/data-tab-pills=""/g)).toHaveLength(1);
  });

  test("the list: drafts first, then the sent ones the newest first, each row a link of its name over its state line (P-13)", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-60), recipients: { et: 3, ru: 2 } });
    const draft = await campaign("Mustand", { updatedAt: at(-10) });
    const html = await render({ vaade: "kampaaniad" });
    const order = [...html.matchAll(/data-campaign-row="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([draft.id, sent.id]);
    expect(html).toContain(`href="/admin/uudiskiri?vaade=kampaaniad&amp;kampaania=${draft.id}"`);
    const row = (id: number) => text(html.match(new RegExp(`<li[^>]*data-campaign-row="${id}"[\\s\\S]*?</li>`))?.[0] ?? "");
    expect(row(draft.id)).toBe("Mustand Mustand · muudetud 19.10 12:50");
    expect(row(sent.id)).toBe("Saadetud Saadetud 19.10 · 5 tellijale");
    expect(html).toContain('data-campaign-status="draft"');
    expect(html).not.toContain("data-campaign-form"); // (none chosen)
  });

  test("a chosen draft opens its editor with its fields, the preview and its sends; an id that is not there says so", async () => {
    const draft = await campaign("Mustand");
    const html = await render({ vaade: "kampaaniad", kampaania: String(draft.id) });
    expect(html).toContain(`data-campaign-form="${draft.id}"`);
    expect(html).toContain('value="Mustand"');
    expect(html).toContain("data-campaign-preview");
    for (const shown of ["data-campaign-send", "data-test-send", "data-test-target", "data-campaign-delete", "data-save-status", "data-edit-lang-switch"]) expect(html, shown).toContain(shown);
    for (const absent of ["data-campaign-stop", "data-campaign-progress", "data-mark-not-sent", "data-send-missing", "data-save-bar", "data-campaign-save-first"]) expect(html, absent).not.toContain(absent);
    // the open row in the list
    const link = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]).find((a) => a.includes(`kampaania=${draft.id}"`));
    expect(link).toContain('aria-current="page"');
    const gone = await render({ vaade: "kampaaniad", kampaania: "999999" });
    expect(text(gone)).toContain("Seda kirja enam pole.");
    expect(gone).not.toContain("data-campaign-form");
  });

  test("B9, R-h: „Saada kõigile ({n})“ counts the confirmed subscribers a press would write now — never a sample address — and its hint says so", async () => {
    const draft = await campaign("Mustand");
    const search = { vaade: "kampaaniad", kampaania: String(draft.id) };
    expect(text(await render(search))).toContain("Kinnitatud tellijaid pole: kirja pole kellelegi saata.");
    await sub("kati@example.com");
    await sub("mari@example.com");
    await sub("olga@example.com", { locale: "ru" });
    await sub("ootab@example.com", { confirmedAt: null });
    await sub("naidis@example.test");
    const html = await render(search);
    expect(html).toMatch(/data-send-all="">Saada kõigile \(3\)</);
    expect(text(html)).toContain("2 eesti, 1 vene keeles · näidisaadressidele ei saadeta");
  });

  // The coming-soon gate (final review I1): the page reads SITE_GATE the way the middleware does (lib/site-gate.ts gateOn) and hands the editor the flag, so the
  // editor's confirmation and test result can say that the mail's links open „Tulekul“. The sends' section carries it as `data-gated`.
  test("the page tells the editor whether the coming-soon gate is on: SITE_GATE as the middleware reads it (unset, blank, 0, false, off, no: off; anything else: on)", async () => {
    const draft = await campaign("Mustand");
    const gated = async (value: string) => {
      vi.stubEnv("SITE_GATE", value);
      const html = await render({ vaade: "kampaaniad", kampaania: String(draft.id) });
      expect(html, `SITE_GATE=${JSON.stringify(value)}: the sends are there`).toContain("data-campaign-send");
      return /data-campaign-send="" data-gated=""/.test(html);
    };
    for (const on of ["1", "true", "on", " 1 ", "yes", "typo"]) expect(await gated(on), `SITE_GATE=${JSON.stringify(on)}`).toBe(true);
    for (const off of ["", "  ", "0", "false", "off", "no", "OFF"]) expect(await gated(off), `SITE_GATE=${JSON.stringify(off)}`).toBe(false);
    vi.stubEnv("SITE_GATE", undefined as unknown as string); // (unset)
    expect(await render({ vaade: "kampaaniad", kampaania: String(draft.id) })).not.toContain("data-gated");
  });

  /** The deliveries of a campaign: so many of each status (their addresses are made up; nothing is sent). */
  async function deliveries(campaignId: number, counts: Partial<Record<"sent" | "waiting" | "failed" | "unknown" | "skipped", number>>) {
    let k = 0;
    for (const [status, n] of Object.entries(counts) as ["sent" | "waiting" | "failed" | "unknown" | "skipped", number][]) {
      for (let i = 0; i < n; i++) {
        await db.insert(newsletterDeliveries).values({ campaignId, email: `k${campaignId}-${++k}@example.com`, locale: "et", token: `tok${campaignId}-${k}`, status, sentAt: status === "sent" ? NOW : null });
      }
    }
  }

  test("a sent campaign opens read-only: its line, „Kopeeri“, the preview, no field, no stop", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-60), recipients: { et: 3, ru: 0 } });
    await deliveries(sent.id, { sent: 3 });
    const html = await render({ vaade: "kampaaniad", kampaania: String(sent.id) });
    expect(html).toContain('data-campaign-sent="sent"');
    expect(text(html)).toContain("Saadetud 19.10.2026 12:00 · 3 tellijale");
    expect(html).toContain("data-campaign-copy");
    expect(html).toContain("data-campaign-preview");
    expect(html).not.toContain("data-campaign-form");
    for (const absent of ["data-campaign-stop", "data-campaign-progress", "data-campaign-failed", "data-campaign-unknown", "data-campaign-send"]) expect(html, absent).not.toContain(absent);
  });

  test("a sent campaign adds a failure count when there were failures, and the mails with no answer", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-60), recipients: { et: 3, ru: 0 } });
    await deliveries(sent.id, { sent: 3, failed: 2, unknown: 1, skipped: 4 });
    const html = text(await render({ vaade: "kampaaniad", kampaania: String(sent.id) }));
    expect(html).toContain("Saadetud 19.10.2026 12:00 · 3 tellijale");
    expect(html).toContain("Kiri ei läinud 2 aadressile: aadress ei sobinud.");
    expect(html).toContain("1 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
  });

  test("the list shows the state of each campaign and, for the one going out, its progress; the other rows keep their lines", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-120), recipients: { et: 4, ru: 0 } });
    const draft = await campaign("Mustand");
    const going = await campaign("Pooleli", { status: "sending", updatedAt: at(-30), recipients: { et: 4, ru: 2 } });
    await deliveries(going.id, { sent: 3, waiting: 2, failed: 1 });
    const list = await render({ vaade: "kampaaniad" });
    const row = (id: number) => text(list.match(new RegExp(`<li[^>]*data-campaign-row="${id}"[\\s\\S]*?</li>`))?.[0] ?? "");
    // (P-13: a letter going out says its mails that went of all; the open letter's card says the rest, below)
    expect(row(going.id)).toBe("Pooleli Saatmine pooleli · 3 / 6");
    expect(row(sent.id)).toBe("Saadetud Saadetud 19.10 · 4 tellijale");
    expect(row(draft.id)).toMatch(/^Mustand Mustand · muudetud \d{2}\.\d{2} \d{2}:\d{2}$/);
  });

  test("a campaign going out opens read-only with its progress line, the failed count, „Peata saatmine“ and „Kopeeri“; the state is its status", async () => {
    const going = await campaign("Pooleli", { status: "sending", updatedAt: at(-30), recipients: { et: 3, ru: 2 } });
    await deliveries(going.id, { sent: 3, waiting: 2, failed: 1 });
    const open = await render({ vaade: "kampaaniad", kampaania: String(going.id) });
    expect(open).toContain('data-campaign-sent="sending"');
    expect(text(open)).toContain("Saadetud 3 / 6 — ülejäänud 2 lähevad järgmisel päeval.");
    expect(text(open)).toContain("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
    expect(open).not.toContain("data-campaign-unknown");
    expect(open).not.toContain("data-campaign-refused");
    expect(open).not.toContain("data-campaign-sent-line");
    expect(open).toContain("data-campaign-stop");
    expect(open).toContain("data-campaign-copy");
    expect(open).toContain("data-campaign-preview");
    expect(open).not.toContain("data-campaign-form");
    // nothing waits, but the campaign is still `sending` (the last mail is on its way): it is still going out
    await db.update(newsletterDeliveries).set({ status: "sent" }).where(eq(newsletterDeliveries.status, "waiting"));
    const last = await render({ vaade: "kampaaniad", kampaania: String(going.id) });
    expect(text(last)).toContain("Saadetud 5 / 6 — ülejäänud 0 lähevad järgmisel päeval.");
    expect(last).toContain("data-campaign-stop");
  });

  test("the batch Resend refused: the page says so while the campaign is going out, and only then", async () => {
    const going = await campaign("Pooleli", { status: "sending", updatedAt: at(-30), recipients: { et: 3, ru: 2 } });
    await deliveries(going.id, { sent: 1, waiting: 4 });
    await new PgKv(db).put(`newsletter:refused:${going.id}`, NOW.toISOString());
    const open = await render({ vaade: "kampaaniad", kampaania: String(going.id) });
    expect(text(open)).toContain("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
    expect(open).toContain("data-campaign-refused");
    // the mark outlives the campaign in the store for a while: a campaign that is sent does not show it
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 0 } }).where(eq(newsletterCampaigns.id, going.id));
    expect(await render({ vaade: "kampaaniad", kampaania: String(going.id) })).not.toContain("data-campaign-refused");
  });

  test("„Saada proov“'s select offers Maria's address and the signed-in admin's, each in both languages; without Maria's only the admin's; one when they are the same", async () => {
    const draft = await campaign("Mustand");
    const search = { vaade: "kampaaniad", kampaania: String(draft.id) };
    const options = (html: string) => [...html.matchAll(/<option value="([\w:]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    vi.stubEnv("MARIA_EMAIL", "Maria@Example.com");
    expect(options(await render(search))).toEqual([
      ["maria:et", "maria@example.com · eesti keeles"],
      ["maria:ru", "maria@example.com · vene keeles"],
      ["me:et", "maria@example.test · eesti keeles"],
      ["me:ru", "maria@example.test · vene keeles"],
    ]);
    vi.stubEnv("MARIA_EMAIL", "");
    expect(options(await render(search)).map(([v]) => v)).toEqual(["me:et", "me:ru"]);
    vi.stubEnv("MARIA_EMAIL", "maria@example.test");
    expect(options(await render(search)).map(([v]) => v)).toEqual(["maria:et", "maria:ru"]);
  });
});

describe("the student's drawer", () => {
  const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
  const student = async (email: string) => (await db.insert(clients).values({ email, name: "Kati Kask" }).returning())[0];

  test("the newsletter line is there, subscribed or not, and carries no mark about the address", async () => {
    const kati = await student("kati@example.com");
    const mari = await student("mari@example.com");
    await sub("kati@example.com");
    const subscribed = await drawer(kati.id);
    expect(subscribed).toContain('data-client-newsletter="yes"');
    expect(subscribed).not.toContain("data-client-suppressed");
    const not = await drawer(mari.id);
    expect(not).toContain('data-client-newsletter="no"');
    expect(not).not.toContain("data-client-suppressed");
    expect(await clientDetail(db, kati.id, NOW)).not.toHaveProperty("suppressed");
  });
});
