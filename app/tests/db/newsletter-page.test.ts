import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, mailSuppressions, settings, subscribers } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { NOTIFY_TIMEOUT_MS, RATE_LIMIT_RETRY_MS } from "@/server/notify";
import { makeTestDb } from "./helpers";
import { DOWN, fakeResend, type FakeResend } from "./resend-fake";

// Maria's „Uudiskiri“ page and the student's drawer on a real (PGlite) database, Resend an in-memory fake (newsletter campaigns, Task 3; spec D2, D8, D10,
// §5): the sync part (not set up without the key; the button and the two counts with it; the real count beside the site's, and Resend not answering
// or not answering in time), the mark on the rows whose address Resend suppresses (one query for the page's 50 rows), the same mark in the drawer of
// the student with that address (whether or not she subscribed), and the page's time limit. The shell, the drawer's forms and the server actions
// are stand-ins (they need a browser or a request).

const state = vi.hoisted(() => ({ db: null as unknown, fake: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/data", async () => {
  const { adminCounts } = await import("@/db/queries/admin");
  return { getAdminCounts: async () => adminCounts(state.db as Db) };
});
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/server/actions/admin-newsletter", () => ({ fullSyncAction: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-reviews", () => ({ decideReviewAction: vi.fn(), setFeaturedAction: vi.fn(), saveManualReviewAction: vi.fn(), deleteManualReviewAction: vi.fn() }));
// the deps of the page's count: the real builder (SITE_URL, the environment), the in-memory Resend, no pause between calls
vi.mock("@/server/send-deps", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/send-deps")>();
  return {
    ...real,
    adminMarketingDeps: (budgetMs?: number) => {
      const fake = state.fake as FakeResend | null;
      return { ...real.adminMarketingDeps(budgetMs), ...(fake ? { resend: fake.r, gapMs: 0 } : {}) };
    },
  };
});
// (spied, to see how often the page asks)
vi.mock("@/server/resend-marketing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/resend-marketing")>();
  return { ...real, suppressedAddresses: vi.fn(real.suppressedAddresses) };
});

import * as page from "@/app/admin/(panel)/uudiskiri/page";
import NewsletterPage from "@/app/admin/(panel)/uudiskiri/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";
import { COUNT_WAIT_MS, syncState } from "@/server/newsletter-admin";
import { suppressedAddresses } from "@/server/resend-marketing";
import { adminMarketingDeps } from "@/server/send-deps";

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const T = adminEt.newsletter;
const MARK = "Resend ei saada sellele aadressile kirju (tagastus või rämpspostiks märgitud). Seda saab muuta ainult Resendis.";

let db: Db;
let fake: FakeResend;

const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await NewsletterPage({ searchParams: Promise.resolve(search) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The HTML of the table row of subscriber `id`. */
const row = (html: string, id: number) => html.match(new RegExp(`<tr[^>]*data-subscriber="${id}"[\\s\\S]*?</tr>`))?.[0] ?? "";

let n = 0;
/** A subscriber, confirmed an hour before NOW unless told otherwise. */
async function sub(email: string, o: Partial<typeof subscribers.$inferInsert> = {}) {
  const [r] = await db
    .insert(subscribers)
    .values({ email, locale: "et", token: `tok${++n}`, consentAt: at(-60), confirmedAt: at(-60), ...o })
    .returning();
  return r;
}
/** An address Resend suppresses (`cleared` once it was lifted). */
async function suppress(email: string, cleared = false) {
  await db.insert(mailSuppressions).values({ email, reason: "bounce", since: at(-120), clearedAt: cleared ? at(-30) : null });
}

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  for (const table of [subscribers, mailSuppressions, settings, clients]) await db.delete(table);
  fake = fakeResend();
  state.fake = fake;
  vi.mocked(suppressedAddresses).mockClear();
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("RESEND_MARKETING_KEY", "re_marketing_test");
  vi.stubEnv("RESEND_API_KEY", "");
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the page without the newsletter's key", () => {
  test("the not-set-up text and nothing of the sync; Resend is not asked; the list, its count line and the two CSV buttons are as they were", async () => {
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    const kati = await sub("kati@example.com");
    await sub("mari@example.com", { confirmedAt: null });
    const html = await render();
    expect(html).toContain("data-sync-off");
    expect(text(html)).toContain("Resendi uudiskirja saatmine pole veel seadistatud.");
    for (const hook of ["data-sync-run", "data-sync-resend", "data-sync-site", "data-sync-warning", "data-sync-limit"]) expect(html, hook).not.toContain(hook);
    expect(fake.calls).toEqual([]);
    expect(html).toContain(`data-subscriber="${kati.id}"`);
    expect(text(html)).toContain("Tellijaid: 2, neist kinnitatud 1");
    expect(html).toContain('href="/api/admin/subscribers.csv?kinnitatud=1"');
    expect(html).toContain('href="/api/admin/subscribers.csv"');
    expect(html).toContain('data-csv="confirmed"');
    expect(html).toContain('data-csv="all"');
  });
});

describe("the page with the newsletter's key", () => {
  test("the button, Resend's own count of the account, and the site's count of the subscribers it has synced", async () => {
    for (let i = 0; i < 4; i++) fake.add(`contact${i}@example.com`); // Resend holds 4 contacts (two of them are not the site's)
    await sub("kati@example.com", { resendContactId: "ct_1", syncedAt: at(-5) });
    await sub("mari@example.com", { resendContactId: "ct_2", syncedAt: at(-5) });
    await sub("anu@example.com");
    const html = await render();
    expect(html).toContain("data-sync-run");
    expect(text(html)).toContain("Sünkrooni Resendiga");
    expect(text(html)).toContain("Resendis 4 kontakti (tasuta pakett: 1000)");
    expect(text(html)).toContain("Sünkroonitud tellijaid: 2");
    expect(html).not.toContain("data-sync-warning");
    expect(html).not.toContain("data-sync-off");
    expect(fake.calls).toEqual(["usage.get"]); // one call, Resend's own count
  });

  test("Resend not answering: the site's count alone, the list as ever", async () => {
    fake.fail.set("usage.get", DOWN);
    fake.fail.set("contacts.list", DOWN);
    const kati = await sub("kati@example.com", { resendContactId: "ct_1", syncedAt: at(-5) });
    const html = await render();
    expect(html).not.toContain("data-sync-resend");
    expect(text(html)).toContain("Sünkroonitud tellijaid: 1 (tasuta pakett: 1000)");
    expect(html).toContain("data-sync-run");
    expect(html).toContain(`data-subscriber="${kati.id}"`);
  });

  test("the warning from 900 contacts goes by the larger of Resend's count and the site's", async () => {
    fake.r.usage.get = async () => ({ data: { contacts: { used: 899, limit: 1000 } }, error: null });
    expect(await render()).not.toContain("data-sync-warning");
    fake.r.usage.get = async () => ({ data: { contacts: { used: 900, limit: 1000 } }, error: null });
    const html = await render();
    expect(html).toContain("data-sync-warning");
    expect(text(html)).toContain("Resendi tasuta paketis on 1000 kontakti. Üle selle on vaja tasulist paketti.");
    // Resend says little, the site's own count is above 900
    fake.r.usage.get = async () => ({ data: { contacts: { used: 120, limit: 1000 } }, error: null });
    await db.insert(subscribers).values(Array.from({ length: 900 }, (_, i) => ({ email: `bulk${i}@example.com`, token: `bulk${i}`, resendContactId: `ct_b${i}`, syncedAt: at(-5), confirmedAt: at(-60), consentAt: at(-60) })));
    expect(await render()).toContain("data-sync-warning");
  });

  test("the limit line: the plan is full and subscribers have no contact; their number is the line's", async () => {
    fake.r.usage.get = async () => ({ data: { contacts: { used: 1000, limit: 1000 } }, error: null });
    await sub("kati@example.com"); // no contact
    await sub("mari@example.com"); // no contact
    await sub("kaisa@example.test"); // a sample address is never mailed: not counted
    await sub("liis@example.com", { confirmedAt: null }); // unconfirmed: not a recipient
    await sub("anu@example.com", { resendContactId: "ct_1", syncedAt: at(-5) });
    const html = await render();
    expect(text(html)).toContain("2 tellijat ei ole Resendis — kontaktide piir on täis.");
    fake.r.usage.get = async () => ({ data: { contacts: { used: 999, limit: 1000 } }, error: null });
    expect(await render()).not.toContain("data-sync-limit");
  });
});

describe("syncState: what the sync part is told", () => {
  const deps = () => ({ ...adminMarketingDeps(), now: NOW });

  test("without the key: not configured, and Resend is not asked", async () => {
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    expect(await syncState(deps())).toEqual({ configured: false });
    expect(fake.calls).toEqual([]);
  });

  test("the rows' side: those with a contact are the site's synced count; those a recipient without one are missing (a sample address, an unconfirmed row and a row with a contact are not)", async () => {
    await sub("a@example.com", { resendContactId: "ct_1", syncedAt: at(-5) });
    await sub("b@example.com", { resendContactId: "ct_2", syncedAt: null }); // changed since: its contact is still in Resend
    await sub("c@example.com");
    await sub("d@example.com");
    await sub("e@example.test"); // a sample address
    await sub("F@Example.Test"); // (in any case)
    await sub("g@example.com", { confirmedAt: null });
    fake.add("x@example.com");
    expect(await syncState(deps())).toEqual({ configured: true, resend: 1, site: 2, missing: 2 });
  });

  test("Resend's count is null when Resend does not answer, and when it does not answer in time (a slow Resend does not hold the list)", async () => {
    fake.fail.set("usage.get", DOWN);
    fake.fail.set("contacts.list", DOWN);
    expect(await syncState(deps())).toMatchObject({ configured: true, resend: null });
    fake.fail.clear();
    fake.r.usage.get = () => new Promise((resolve) => setTimeout(() => resolve({ data: { contacts: { used: 7, limit: 1000 } }, error: null }), 400));
    const started = Date.now();
    expect(await syncState(deps(), 40)).toMatchObject({ configured: true, resend: null });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("did not answer in time"));
    // the wait is short of the longest call (a call waits NOTIFY_TIMEOUT_MS, and once more after a 429)
    expect(COUNT_WAIT_MS).toBeLessThan(NOTIFY_TIMEOUT_MS);
  });

  test("the log has no address", async () => {
    await sub("kati@example.com");
    fake.fail.set("usage.get", DOWN);
    fake.fail.set("contacts.list", DOWN);
    await syncState(deps());
    const logged = (["info", "error", "warn", "log"] as const).flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat()).join("\n");
    expect(logged).not.toContain("@");
  });
});

describe("the page's time limit", () => {
  test("60 seconds: the action's budget, a call begun at its end (8 s, and once more after a 429) and the page's queries fit", () => {
    expect(page.maxDuration).toBe(60);
    const worstSeconds = (adminMarketingDeps(25_000).budgetMs! + NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS) / 1000;
    expect(worstSeconds).toBeLessThan(page.maxDuration);
  });
});

describe("the mark on the rows (spec D10)", () => {
  test("a row whose address Resend suppresses says so in the spec's words; the others, and an address whose suppression was lifted, do not (any case)", async () => {
    const anu = await sub("Anu@Example.com");
    const mari = await sub("mari@example.com");
    const kati = await sub("kati@example.com");
    const liis = await sub("liis@example.com", { confirmedAt: null }); // an unconfirmed row is marked too: the address is blocked all the same
    await suppress("anu@example.com");
    await suppress("mari@example.com", true);
    await suppress("liis@example.com");
    expect(T.suppressed).toBe(MARK);
    const html = await render();
    expect(text(row(html, anu.id))).toContain(MARK);
    expect(row(html, anu.id)).toContain("data-subscriber-suppressed");
    expect(text(row(html, liis.id))).toContain(MARK);
    for (const unmarked of [mari, kati]) {
      expect(row(html, unmarked.id), unmarked.email).not.toContain("data-subscriber-suppressed");
      expect(text(row(html, unmarked.id))).not.toContain("Resend ei saada");
    }
    expect(html.match(/data-subscriber-suppressed/g)).toHaveLength(2);
    // the address is still there as it was written
    expect(text(row(html, anu.id))).toContain("Anu@Example.com");
  });

  test("with the key off the marks still show (the blocking is Resend's, whatever this site has set up)", async () => {
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    const anu = await sub("anu@example.com");
    await suppress("anu@example.com");
    expect(row(await render(), anu.id)).toContain("data-subscriber-suppressed");
  });

  test("one query for the page's rows, not one per row: the 50 addresses of page 1, then the 5 of page 2", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 55; i++) ids.push((await sub(`s${String(i).padStart(2, "0")}@example.com`, { consentAt: at(-1000 + i) })).id);
    // the newest consent first: s54 … s05 on page 1, s04 … s00 on page 2
    await suppress("s54@example.com");
    await suppress("s02@example.com");
    const first = await render();
    expect(suppressedAddresses).toHaveBeenCalledTimes(1);
    const asked1 = vi.mocked(suppressedAddresses).mock.calls[0][1];
    expect(asked1).toHaveLength(50);
    expect(asked1).toContain("s54@example.com");
    expect(asked1).not.toContain("s02@example.com");
    expect(first.match(/data-subscriber-suppressed/g)).toHaveLength(1);
    expect(row(first, ids[54])).toContain("data-subscriber-suppressed");
    vi.mocked(suppressedAddresses).mockClear();
    const second = await render({ leht: "2" });
    expect(suppressedAddresses).toHaveBeenCalledTimes(1);
    expect(vi.mocked(suppressedAddresses).mock.calls[0][1]).toHaveLength(5);
    expect(second.match(/data-subscriber-suppressed/g)).toHaveLength(1);
    expect(row(second, ids[2])).toContain("data-subscriber-suppressed");
  });

  test("an empty list asks for no marks and still renders", async () => {
    const html = await render();
    expect(text(html)).toContain("Tellijaid veel pole.");
    expect(html).toContain("data-sync-run");
  });
});

describe("the student's drawer (spec D10)", () => {
  const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
  const student = async (email: string) => (await db.insert(clients).values({ email, name: "Kati Kask" }).returning())[0];

  test("her address is suppressed: the drawer says so in the spec's words, whether or not she subscribed", async () => {
    const kati = await student("kati@example.com");
    await suppress("kati@example.com");
    const detail = await clientDetail(db, kati.id, NOW);
    expect(detail?.suppressed).toBe(true);
    expect(detail?.newsletter).toBe("no");
    const html = await drawer(kati.id);
    expect(html).toContain("data-client-suppressed");
    expect(text(html)).toContain(MARK);
  });

  test("not suppressed, or the suppression lifted: no mark (the address compared in lower case on both sides)", async () => {
    const kati = await student("kati@example.com");
    const mari = await student("Mari@Example.com");
    await suppress("MARI@example.com", true);
    await sub("kati@example.com");
    for (const id of [kati.id, mari.id]) {
      expect((await clientDetail(db, id, NOW))?.suppressed).toBe(false);
      expect(await drawer(id)).not.toContain("data-client-suppressed");
    }
    await db.delete(mailSuppressions);
    await suppress("MARI@example.com");
    expect((await clientDetail(db, mari.id, NOW))?.suppressed).toBe(true);
  });

  test("the drawer's newsletter line stays beside it", async () => {
    const kati = await student("kati@example.com");
    await sub("kati@example.com");
    await suppress("kati@example.com");
    const html = await drawer(kati.id);
    expect(html).toContain('data-client-newsletter="yes"');
    expect(html).toContain("data-client-suppressed");
  });
});
