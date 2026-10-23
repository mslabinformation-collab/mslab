import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, kvEntries, newsletterCampaigns, newsletterDeliveries, subscribers } from "@/db/schema";
import { PgKv } from "@/server/kv";
import { PRESS_BUDGET_MS, SEND_GAP_MS } from "@/server/newsletter-campaigns";
import { NOTIFY_TIMEOUT_MS, RATE_LIMIT_RETRY_MS } from "@/server/notify";
import { makeTestDb } from "./helpers";

// Maria's „Uudiskiri“ page and the student's drawer on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's):
// the subscribers' view (the list, its count line, the two CSV buttons, and nothing of Resend: no sync, no counts, no marks on the rows), the
// „Kampaaniad“ view (the list with the progress of the campaign going out, the editor of the chosen one with its sends, one going out with its
// progress, its failed and unknown counts and the refused mark, a sent one read-only), and the student's drawer (its newsletter line, no mark). The
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
  saveCampaignAction: vi.fn(),
  copyCampaignAction: vi.fn(),
  prepareSendAction: vi.fn(),
  startSendAction: vi.fn(),
  stopSendAction: vi.fn(),
  sendTestAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn(), extendAccessAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(), updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-reviews", () => ({ decideReviewAction: vi.fn(), setFeaturedAction: vi.fn(), saveManualReviewAction: vi.fn(), deleteManualReviewAction: vi.fn() }));

import * as page from "@/app/admin/(panel)/uudiskiri/page";
import NewsletterPage from "@/app/admin/(panel)/uudiskiri/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;

const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await NewsletterPage({ searchParams: Promise.resolve(search) }));
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

describe("the subscribers' view", () => {
  test("the list, its count line and the two CSV buttons; nothing of Resend on it: no sync, no counts, no marks on the rows", async () => {
    const kati = await sub("kati@example.com");
    await sub("mari@example.com", { confirmedAt: null });
    const html = await render();
    expect(html).toContain(`data-subscriber="${kati.id}"`);
    expect(text(html)).toContain("kati@example.com");
    expect(text(html)).toContain("Tellijaid: 2, neist kinnitatud 1");
    expect(html).toContain('href="/api/admin/subscribers.csv?kinnitatud=1"');
    expect(html).toContain('href="/api/admin/subscribers.csv"');
    expect(html).toContain('data-csv="confirmed"');
    expect(html).toContain('data-csv="all"');
    for (const gone of ["data-newsletter-sync", "data-sync-", "data-subscriber-suppressed", "data-subscriber-rejected"]) expect(html, gone).not.toContain(gone);
    expect(text(html)).not.toMatch(/Resend/i);
  });

  test("an empty list says so and still renders the CSV buttons", async () => {
    const html = await render();
    expect(text(html)).toContain("Tellijaid veel pole.");
    expect(html).toContain('data-csv="all"');
  });

  test("120 seconds: „Saada kõigile“ is a server action of this page and runs the first batch (PRESS_BUDGET_MS, a send begun at its end included)", () => {
    expect((page as Record<string, unknown>).maxDuration).toBe(120);
    const oneSend = NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS; // a call, a 429, the one retry
    expect((PRESS_BUDGET_MS + SEND_GAP_MS + oneSend) / 1000).toBeLessThan(120 - 30); // (room for the queries and the database's own waits)
  });
});

describe("the „Kampaaniad“ view (?vaade=kampaaniad)", () => {
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

  test("both views are named above the page; the subscribers' view is the default, the campaigns' its own heading without the CSV buttons", async () => {
    const subscribersView = await render();
    expect(subscribersView).toContain('data-newsletter-views=""');
    expect(subscribersView).toMatch(/<a[^>]*aria-current="page"[^>]*data-view="subscribers"/);
    const campaigns = await render({ vaade: "kampaaniad" });
    expect(campaigns).toMatch(/<a[^>]*aria-current="page"[^>]*data-view="campaigns"/);
    expect(campaigns).toContain(">Kampaaniad</h1>");
    expect(campaigns).not.toContain("data-csv");
    expect(campaigns).not.toContain("data-subscriber=");
    expect(text(campaigns)).toContain("Kampaaniaid veel pole.");
    expect(campaigns).toContain(`href="/admin/uudiskiri?vaade=kampaaniad&amp;kampaania=uus"`);
  });

  test("the list: drafts first, then the sent ones the newest first, each linking to its editor; „Saadetud {date} · {n} tellijale“ for a sent one", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-60), recipients: { et: 3, ru: 2 } });
    const draft = await campaign("Mustand");
    const html = await render({ vaade: "kampaaniad" });
    const order = [...html.matchAll(/data-campaign-row="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([draft.id, sent.id]);
    expect(html).toContain(`href="/admin/uudiskiri?vaade=kampaaniad&amp;kampaania=${draft.id}"`);
    expect(text(html)).toContain("Saadetud 19.10.2026 12:00 · 5 tellijale");
    expect(html).toContain('data-campaign-status="draft"');
    expect(html).not.toContain("data-campaign-form"); // (none chosen)
  });

  test("a chosen draft opens its editor with its fields, the preview and its sends: a new one an empty editor; an id that is not there says so", async () => {
    const draft = await campaign("Mustand");
    const html = await render({ vaade: "kampaaniad", kampaania: String(draft.id) });
    expect(html).toContain(`data-campaign-form="${draft.id}"`);
    expect(html).toContain('value="Mustand"');
    expect(html).toContain("data-campaign-preview");
    for (const shown of ["data-campaign-send", "data-test-send", "data-send-all", "data-test-to"]) expect(html, shown).toContain(shown);
    for (const absent of ["data-campaign-stop", "data-campaign-progress", "data-mark-not-sent", "data-send-missing"]) expect(html, absent).not.toContain(absent);
    expect(await render({ vaade: "kampaaniad", kampaania: "uus" })).toContain('data-campaign-form="new"');
    const gone = await render({ vaade: "kampaaniad", kampaania: "999999" });
    expect(text(gone)).toContain("Seda kampaaniat enam pole.");
    expect(gone).not.toContain("data-campaign-form");
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
    expect(row(going.id)).toContain("Saatmine pooleli");
    expect(row(going.id)).toContain("Saadetud 3 / 6 — ülejäänud 2 lähevad järgmisel päeval.");
    expect(row(sent.id)).toContain("Saadetud 19.10.2026 11:00 · 4 tellijale");
    expect(row(sent.id)).not.toContain("ülejäänud");
    expect(row(draft.id)).toContain("Mustand");
    expect(row(draft.id)).toContain("Muudetud");
    expect(row(draft.id)).not.toContain("ülejäänud");
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

  test("„Saada proov“ offers Maria's address and the signed-in admin's; without Maria's only the admin's; one choice when they are the same", async () => {
    const draft = await campaign("Mustand");
    const search = { vaade: "kampaaniad", kampaania: String(draft.id) };
    const targets = async () => [...(await render(search)).matchAll(/data-test-to="(\w+)"/g)].map((m) => m[1]);
    vi.stubEnv("MARIA_EMAIL", "Maria@Example.com");
    const both = await render(search);
    expect([...both.matchAll(/data-test-to="(\w+)"/g)].map((m) => m[1])).toEqual(["maria", "me"]);
    expect(text(both)).toContain("Maria: maria@example.com");
    expect(text(both)).toContain("Mina: maria@example.test");
    vi.stubEnv("MARIA_EMAIL", "");
    expect(await targets()).toEqual(["me"]);
    vi.stubEnv("MARIA_EMAIL", "maria@example.test");
    expect(await targets()).toEqual(["maria"]);
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
