import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, newsletterCampaigns, subscribers } from "@/db/schema";
import { makeTestDb } from "./helpers";

// Maria's „Uudiskiri“ page and the student's drawer on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's):
// the subscribers' view (the list, its count line, the two CSV buttons, and nothing of Resend: no sync, no counts, no marks on the rows), the
// „Kampaaniad“ view (the list, the editor of the chosen one, a sent one read-only), and the student's drawer (its newsletter line, no mark). The shell,
// the drawer's forms and the server actions are stand-ins (they need a browser or a request).

const state = vi.hoisted(() => ({ db: null as unknown }));
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
vi.mock("@/server/actions/admin-newsletter", () => ({
  saveCampaignAction: vi.fn(),
  copyCampaignAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));
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
  for (const table of [subscribers, clients, newsletterCampaigns]) await db.delete(table);
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
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

  test("the page sets no time limit of its own: nothing on it waits for Resend any more", () => {
    expect((page as Record<string, unknown>).maxDuration).toBeUndefined();
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

  test("a chosen draft opens its editor with its fields and the preview, and no sending: a new one an empty editor; an id that is not there says so", async () => {
    const draft = await campaign("Mustand");
    const html = await render({ vaade: "kampaaniad", kampaania: String(draft.id) });
    expect(html).toContain(`data-campaign-form="${draft.id}"`);
    expect(html).toContain('value="Mustand"');
    expect(html).toContain("data-campaign-preview");
    for (const hidden of ["data-campaign-send", "data-test-send", "data-send-all", "data-test-to"]) expect(html, hidden).not.toContain(hidden);
    expect(await render({ vaade: "kampaaniad", kampaania: "uus" })).toContain('data-campaign-form="new"');
    const gone = await render({ vaade: "kampaaniad", kampaania: "999999" });
    expect(text(gone)).toContain("Seda kampaaniat enam pole.");
    expect(gone).not.toContain("data-campaign-form");
  });

  test("a campaign that is no draft opens read-only: its line, „Kopeeri“, the preview, no field; one going out reads the same", async () => {
    const sent = await campaign("Saadetud", { status: "sent", sentAt: at(-60), recipients: { et: 3, ru: 0 } });
    const html = await render({ vaade: "kampaaniad", kampaania: String(sent.id) });
    expect(html).toContain('data-campaign-sent="sent"');
    expect(text(html)).toContain("Saadetud 19.10.2026 12:00 · 3 tellijale");
    expect(html).toContain("data-campaign-copy");
    expect(html).toContain("data-campaign-preview");
    expect(html).not.toContain("data-campaign-form");
    const going = await campaign("Pooleli", { status: "sending", updatedAt: at(-30), recipients: { et: 3, ru: 2 } });
    const list = await render({ vaade: "kampaaniad" });
    const line = list.match(new RegExp(`<li[^>]*data-campaign-row="${going.id}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(line)).toContain("Saatmine pooleli");
    const open = await render({ vaade: "kampaaniad", kampaania: String(going.id) });
    expect(open).toContain('data-campaign-sent="sending"');
    expect(open).toContain("data-campaign-copy");
    expect(open).not.toContain("data-campaign-form");
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
