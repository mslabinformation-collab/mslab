import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, clientLoginTokens, mailSuppressions, settings, subscribers } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { deleteClient, setNewsletter, updateProfile } from "@/server/client-data";
import { confirmNewsletter, unsubscribeByToken } from "@/server/newsletter";
import type { Env } from "@/server/notify";
import {
  BACKGROUND_GAP_MS,
  backgroundMarketingDeps,
  broadcastRefused,
  contactCount,
  ensureSegments,
  FullSyncBusy,
  fullSync,
  isSubscriberAddress,
  keyRefused,
  MARKETING_GAP_MS,
  MarketingUnavailable,
  marketingConfigured,
  readContactCount,
  REJECTED_SETTING,
  rejectedSubscribers,
  SEGMENT_NAMES,
  SEGMENTS_SETTING,
  subscriberSync,
  suppressedAddresses,
  SYNC_LEASE_SETTING,
  syncAddress,
  UNSUBSCRIBE_PLACEHOLDER,
  UNSUBSCRIBE_PROPERTY,
  type MarketingDeps,
  type SubscriberSync,
} from "@/server/resend-marketing";
import { handleSubscribe, subscribeLater, type Deps } from "@/server/submit";
import { fakeKv, stubFetch } from "../fakes";
import { CONTACTS_QUOTA, DOWN, fakeResend, INVALID_EMAIL, RATE_LIMITED, type FakeResend } from "./resend-fake";
import { makeTestDb } from "./helpers";

// The site keeps Resend's marketing contacts in step with `subscribers`, which stays the record of consent (newsletter campaigns, spec D2, D3, D7,
// D10): every confirmed row has one contact, in the segment of its language, with the property unsubscribe_url (the site's own unsubscribe link);
// an address without a confirmed row has none. Each change to a row syncs that address after its commit (best effort), and the full sync puts
// everything right. Resend is an in-memory fake here (./resend-fake.ts); the real API is never called.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const SITE = "https://mslab.example";
const loobu = (token: string) => `${SITE}/api/newsletter/loobu?t=${token}`;

let db: Db;
let fake: FakeResend;

const marketingEnv = (extra: Partial<Env> = {}): Env => ({
  KV: fakeKv(),
  MAIL_FROM: "MS LAB <info@send.example.test>",
  MARIA_EMAIL: "maria@example.com",
  SITE_URL: SITE,
  RESEND_MARKETING_KEY: "re_marketing_test",
  ...extra,
});
const deps = (o: Partial<MarketingDeps> = {}): MarketingDeps => ({ db, env: marketingEnv(), siteUrl: SITE, now: NOW, resend: fake.r, gapMs: 0, ...o });
/** The hook a production deps builder makes (resend-marketing.ts subscriberSync), on the fake. */
const hook = (o: Partial<MarketingDeps> = {}): SubscriberSync => async (email) => {
  await syncAddress(deps(o), email);
};

let n = 0;
/** A subscriber row; confirmed an hour before NOW unless told otherwise. */
async function sub(email: string, o: Partial<typeof subscribers.$inferInsert> = {}) {
  const [row] = await db
    .insert(subscribers)
    .values({ email, locale: "et", token: `tok${++n}`, consentAt: at(-60), confirmedAt: at(-60), ...o })
    .returning();
  return row;
}
const rowOf = async (email: string) => (await db.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email.toLowerCase()}`))[0];
const ET = () => fake.segment(SEGMENT_NAMES.et)!;
const RU = () => fake.segment(SEGMENT_NAMES.ru)!;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  for (const table of [subscribers, mailSuppressions, clientSessions, clientLoginTokens]) await db.delete(table);
  await db.delete(clients);
  await db.delete(settings);
  fake = fakeResend();
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every line the module logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

describe("the configuration", () => {
  test("ruling R15: RESEND_MARKETING_KEY alone is the switch; RESEND_API_KEY (the site's own mails) never turns the newsletter on", async () => {
    expect(marketingConfigured(marketingEnv())).toBe(true);
    expect(marketingConfigured(marketingEnv({ RESEND_API_KEY: "re_send" }))).toBe(true);
    // a full-access RESEND_API_KEY without the marketing key: still off, and a blank marketing key is off too (the way to switch it off again)
    for (const off of [{ RESEND_MARKETING_KEY: undefined, RESEND_API_KEY: "re_full_access" }, { RESEND_MARKETING_KEY: "", RESEND_API_KEY: "re_full_access" }, { RESEND_MARKETING_KEY: undefined }]) {
      const none = marketingEnv(off);
      expect(marketingConfigured(none), JSON.stringify(off)).toBe(false);
      await db.delete(subscribers);
      await sub("kati@example.com");
      expect(await syncAddress(deps({ env: none }), "kati@example.com")).toBe("skipped");
      expect(await contactCount(deps({ env: none }))).toBeNull();
      await expect(fullSync(deps({ env: none }))).rejects.toMatchObject({ code: "not_configured" });
      await expect(ensureSegments(deps({ env: none }))).rejects.toMatchObject({ code: "not_configured" });
      expect(subscriberSync(db, none)).toBeUndefined();
    }
    expect(fake.calls).toEqual([]);
  });

  test("ruling R15: the newsletter's calls carry RESEND_MARKETING_KEY, never RESEND_API_KEY, when both are set", async () => {
    await sub("kati@example.com");
    const f = stubFetch(() => Response.json({ name: "internal_server_error", message: "down", statusCode: 500 }, { status: 500 }));
    await syncAddress({ db, env: marketingEnv({ RESEND_API_KEY: "re_transactional" }), siteUrl: SITE, now: NOW, gapMs: 0 }, "kati@example.com");
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((c) => c.headers.get("authorization") === "Bearer re_marketing_test")).toBe(true);
  });

  test("the placeholder Task 4 puts in a broadcast fills the contact property unsubscribe_url (triple braces: not escaped)", () => {
    expect(UNSUBSCRIBE_PROPERTY).toBe("unsubscribe_url");
    expect(UNSUBSCRIBE_PLACEHOLDER).toBe("{{{contact.unsubscribe_url}}}");
  });
});

describe("ensureSegments", () => {
  test("creates „MS LAB uudiskiri (ET)“ and „(RU)“ and the string property unsubscribe_url once, stores their ids; the next call asks Resend nothing", async () => {
    const ids = await ensureSegments(deps());
    expect(SEGMENT_NAMES).toEqual({ et: "MS LAB uudiskiri (ET)", ru: "MS LAB uudiskiri (RU)" });
    expect(fake.segments.map((s) => s.name)).toEqual(["MS LAB uudiskiri (ET)", "MS LAB uudiskiri (RU)"]);
    expect(ids).toEqual({ et: ET(), ru: RU() });
    expect(fake.properties).toMatchObject([{ key: "unsubscribe_url", type: "string" }]);
    const [stored] = await db.select().from(settings).where(eq(settings.key, SEGMENTS_SETTING));
    expect(SEGMENTS_SETTING).toBe("resend_segments");
    expect(stored.value).toEqual({ et: ET(), ru: RU(), property: fake.properties[0].id });
    const before = fake.calls.length;
    expect(await ensureSegments(deps())).toEqual(ids);
    expect(fake.calls.length).toBe(before);
  });

  test("segments and the property that Resend has already (a run that failed before storing them) are reused, never made twice", async () => {
    await fake.r.segments.create({ name: SEGMENT_NAMES.ru });
    await fake.r.contactProperties.create({ key: UNSUBSCRIBE_PROPERTY, type: "string" });
    const ru = RU();
    fake.calls.length = 0;
    expect((await ensureSegments(deps())).ru).toBe(ru);
    expect(fake.segments.map((s) => s.name).sort()).toEqual([SEGMENT_NAMES.et, SEGMENT_NAMES.ru]);
    expect(fake.properties).toHaveLength(1);
    expect(fake.writes()).toEqual(["segments.create"]);
  });

  test("Resend unavailable: MarketingUnavailable, and nothing is stored", async () => {
    fake.fail.set("segments.create", DOWN);
    await expect(ensureSegments(deps())).rejects.toBeInstanceOf(MarketingUnavailable);
    expect(await db.select().from(settings)).toEqual([]);
  });
});

describe("syncAddress", () => {
  test("a confirmed row: her contact, subscribed, with her unsubscribe link, in her language's segment only; the row is marked synced", async () => {
    const row = await sub("kati@example.com");
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    const contact = fake.of("kati@example.com")!;
    expect(contact).toMatchObject({ unsubscribed: false, properties: { unsubscribe_url: loobu(row.token) } });
    expect([...contact.segments]).toEqual([ET()]);
    expect(await rowOf("kati@example.com")).toMatchObject({ syncedAt: NOW, resendContactId: contact.id });
  });

  test("the language moves the segment: a Russian row's contact leaves the Estonian segment for the Russian one", async () => {
    await ensureSegments(deps());
    const contact = fake.add("kati@example.com", { segments: [ET()], properties: { unsubscribe_url: "old" } });
    const row = await sub("kati@example.com", { locale: "ru", resendContactId: contact.id });
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    expect([...contact.segments]).toEqual([RU()]);
    expect(contact.properties.unsubscribe_url).toBe(loobu(row.token));
    expect(fake.calls.filter((c) => c === "contacts.create")).toEqual([]); // the same contact, moved
  });

  test("an address stored in another case is the same address; Resend gets it in lower case", async () => {
    await sub("Kati@Example.com");
    expect(await syncAddress(deps(), " KATI@example.COM ")).toBe("synced");
    expect(fake.of("kati@example.com")).toBeDefined();
    expect((await rowOf("kati@example.com")).syncedAt).toEqual(NOW);
  });

  test("a fresh consent wins over a Resend-side unsubscribe (R1): an unsynced row's contact is set back to subscribed", async () => {
    await ensureSegments(deps());
    const contact = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.com", { consentAt: at(-1), syncedAt: null });
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    expect(contact.unsubscribed).toBe(false);
  });

  test("no row, or a row of the old flow never confirmed: her contact is deleted (404 is fine); nothing is created", async () => {
    await ensureSegments(deps());
    fake.add("gone@example.com", { segments: [ET()] });
    fake.add("pending@example.com", { segments: [ET()] });
    await sub("pending@example.com", { confirmedAt: null });
    expect(await syncAddress(deps(), "gone@example.com")).toBe("removed");
    expect(await syncAddress(deps(), "pending@example.com")).toBe("removed");
    expect(await syncAddress(deps(), "never@example.com")).toBe("removed");
    expect(fake.contacts.size).toBe(0);
    expect(fake.calls).not.toContain("contacts.create");
  });

  test("Resend failing: 'failed', never a throw; the row keeps its 'not synced' mark; the log has no address", async () => {
    await sub("kati@example.com");
    fake.fail.set("contacts.create", DOWN);
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    fake.fail.set("contacts.get", () => {
      throw new Error("network down for kati@example.com");
    });
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect(logged()).toContain("[newsletter-sync]");
    expect(logged()).not.toContain("@");
  });

  test("a key that may only send: the log says a full-access key is needed (RESEND_MARKETING_KEY)", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" });
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect(logged()).toContain("RESEND_MARKETING_KEY");
  });

  test("Resend asks for fewer requests (429): the call is tried once more, never a third time", async () => {
    await sub("kati@example.com");
    let refused = 0;
    fake.fail.set("contacts.create", () => (refused++ < 1 ? RATE_LIMITED : null));
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(2);
    fake.fail.set("contacts.get", RATE_LIMITED);
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect(fake.calls.filter((c) => c === "contacts.get")).toHaveLength(3); // one before, then this one and its retry
  });

  test("the plan's contacts used up: she is not added, her row stays unsynced ('skipped')", async () => {
    await sub("kati@example.com");
    fake.fail.set("contacts.create", CONTACTS_QUOTA);
    expect(await syncAddress(deps(), "kati@example.com")).toBe("skipped");
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
  });
});

describe("fullSync", () => {
  test("Review Focus 1: a Resend-side unsubscribe is pulled before anything else: her row is gone before the first write to Resend", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.com", { syncedAt: at(-30), resendContactId: kati.id });
    await sub("mari@example.com"); // new: to be added
    const rowAtFirstWrite: unknown[] = [];
    fake.onCall = (name) => {
      if (/\.(create|update|remove|add)$/.test(name) && rowAtFirstWrite.length === 0) rowAtFirstWrite.push(name);
    };
    let checked = false;
    const firstWrite = fake.r.contacts.remove.bind(fake.r.contacts);
    fake.r.contacts.remove = async (o) => {
      if (!checked) {
        checked = true;
        expect(await rowOf("kati@example.com")).toBeUndefined();
      }
      return firstWrite(o);
    };
    const report = await fullSync(deps());
    expect(rowAtFirstWrite).toEqual(["contacts.remove"]); // her contact's removal is the first write; the new contact comes after
    expect(checked).toBe(true);
    expect(await rowOf("kati@example.com")).toBeUndefined();
    expect(fake.of("kati@example.com")).toBeUndefined();
    expect(report).toMatchObject({ unsubscribedPulled: 1, removed: 1, added: 1, unsynced: 0, finished: true, limitReached: false, contacts: 1 });
  });

  test("R1: she unsubscribed in Resend, then signed up again on the site before the sync ran: her row survives and her contact is subscribed again", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.com", { consentAt: at(-5), syncedAt: null, resendContactId: kati.id }); // the new sign-up marked it unsynced
    const report = await fullSync(deps());
    expect(await rowOf("kati@example.com")).toMatchObject({ syncedAt: NOW });
    expect(kati.unsubscribed).toBe(false);
    expect(report).toMatchObject({ unsubscribedPulled: 0, updated: 1, removed: 0, finished: true });
  });

  test("R1, the plain case: a synced row whose consent is older than the sync is deleted for a Resend unsubscribe; a consent given after the sync began is not", async () => {
    await ensureSegments(deps());
    const a = fake.add("vana@example.com", { unsubscribed: true, segments: [ET()] });
    const b = fake.add("uus@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("vana@example.com", { consentAt: at(-60), syncedAt: at(-30), resendContactId: a.id });
    await sub("uus@example.com", { consentAt: at(1), syncedAt: at(2), resendContactId: b.id });
    const report = await fullSync(deps());
    expect(await rowOf("vana@example.com")).toBeUndefined();
    expect(await rowOf("uus@example.com")).toBeDefined();
    expect(report.unsubscribedPulled).toBe(1);
  });

  test("Review Focus 2: every synced contact ends with the property, subscribed and in exactly its segment, whatever state it was in", async () => {
    await ensureSegments(deps());
    const noProperty = fake.add("ilma@example.com", { segments: [ET()] });
    const wrongSegment = fake.add("vale@example.com", { segments: [ET(), RU()], properties: { unsubscribe_url: "x" } });
    const fine = fake.add("korras@example.com", { segments: [ET()] });
    await sub("ilma@example.com", { syncedAt: null, resendContactId: noProperty.id }); // synced before the property existed
    await sub("vale@example.com", { locale: "ru", syncedAt: at(-10), resendContactId: wrongSegment.id });
    const korras = await sub("korras@example.com", { syncedAt: at(-10), resendContactId: fine.id });
    fine.properties.unsubscribe_url = loobu(korras.token);
    await sub("kadunud@example.com", { syncedAt: at(-10), resendContactId: "ct_deleted_in_the_dashboard" });
    await sub("uus@example.com");
    const report = await fullSync(deps());
    const rows = await db.select().from(subscribers);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const contact = fake.of(row.email)!;
      expect(contact, row.email).toBeDefined();
      expect(contact.properties.unsubscribe_url, row.email).toBe(loobu(row.token));
      expect(contact.unsubscribed, row.email).toBe(false);
      expect([...contact.segments], row.email).toEqual([row.locale === "ru" ? RU() : ET()]);
      expect(row.resendContactId, row.email).toBe(contact.id);
    }
    expect(rows.filter((r) => r.email !== "korras@example.com").every((r) => r.syncedAt?.getTime() === NOW.getTime())).toBe(true);
    expect(report).toMatchObject({ contacts: 5, added: 2, updated: 2, removed: 0, unsynced: 0, finished: true });
  });

  test("a row that is fine is left alone: no write to Resend", async () => {
    await ensureSegments(deps());
    const c = fake.add("korras@example.com", { segments: [ET()] });
    await sub("korras@example.com", { syncedAt: at(-10), resendContactId: c.id });
    fake.calls.length = 0;
    expect(await fullSync(deps())).toMatchObject({ contacts: 1, added: 0, updated: 0, removed: 0, unsynced: 0, finished: true });
    expect(fake.writes()).toEqual([]);
  });

  test("Review Focus 4: Resend refuses a new contact for the plan's limit: the sync stops adding, counts the rest as unsynced, and still updates the others", async () => {
    await ensureSegments(deps());
    const old = fake.add("vana@example.com", { segments: [RU()] });
    await sub("vana@example.com", { locale: "et", syncedAt: null, resendContactId: old.id });
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) await sub(email);
    let created = 0;
    fake.fail.set("contacts.create", () => (created++ >= 1 ? CONTACTS_QUOTA : null));
    const report = await fullSync(deps());
    expect(report).toMatchObject({ added: 1, updated: 1, unsynced: 2, limitReached: true, finished: true });
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(2); // one added, one refused, no third try
    expect([...old.segments]).toEqual([ET()]);
  });

  test("the site stops at the free plan's 1,000 contacts itself (Resend would take more and then refuse every broadcast)", async () => {
    await ensureSegments(deps());
    const emails = Array.from({ length: 1000 }, (_, i) => `s${i}@example.com`);
    const contacts = emails.map((email) => fake.add(email, { segments: [ET()] }));
    await db.insert(subscribers).values(emails.map((email, i) => ({ email, locale: "et", token: `t${i}`, consentAt: at(-60), confirmedAt: at(-60), syncedAt: at(-10), resendContactId: contacts[i].id })));
    for (const [i, c] of contacts.entries()) c.properties.unsubscribe_url = loobu(`t${i}`);
    await sub("uus@example.com");
    const report = await fullSync(deps());
    expect(fake.calls).not.toContain("contacts.create");
    expect(report).toMatchObject({ contacts: 1000, added: 0, unsynced: 1, limitReached: true, finished: true });
    expect(await syncAddress(deps(), "uus@example.com")).toBe("skipped"); // the address sync keeps to the same limit
  });

  test("contacts without a confirmed row are deleted (an unsubscribe on the site whose own sync failed, a row never confirmed)", async () => {
    await ensureSegments(deps());
    fake.add("loobunud@example.com", { segments: [ET()] });
    fake.add("pending@example.com", { segments: [ET()] });
    await sub("pending@example.com", { confirmedAt: null });
    const report = await fullSync(deps());
    expect(fake.contacts.size).toBe(0);
    expect(report).toMatchObject({ removed: 2, contacts: 0, finished: true });
    expect(await rowOf("pending@example.com")).toBeDefined(); // the row is the site's: only its contact goes
  });

  test("the suppression list is read into mail_suppressions in lower case (bounce, complaint, other); an address no longer on it is cleared", async () => {
    await sub("kati@example.com");
    await sub("mari@example.com");
    await db.insert(mailSuppressions).values({ email: "vana@example.com", reason: "bounce", since: at(-600) });
    fake.suppressions.push(
      { id: "sup_1", email: "Kati@Example.com", origin: "bounce", source_id: "em_1", created_at: "2026-10-18T08:00:00.000Z" },
      { id: "sup_2", email: "opilane@example.com", origin: "complaint", source_id: "em_2", created_at: "2026-10-17T08:00:00.000Z" },
      { id: "sup_3", email: "kasitsi@example.com", origin: "manual", source_id: null, created_at: "2026-10-16T08:00:00.000Z" },
    );
    const report = await fullSync(deps());
    const rows = await db.select().from(mailSuppressions).orderBy(mailSuppressions.email);
    expect(rows.map((r) => [r.email, r.reason, r.since.toISOString(), r.clearedAt?.toISOString() ?? null])).toEqual([
      ["kasitsi@example.com", "other", "2026-10-16T08:00:00.000Z", null],
      ["kati@example.com", "bounce", "2026-10-18T08:00:00.000Z", null],
      ["opilane@example.com", "complaint", "2026-10-17T08:00:00.000Z", null],
      ["vana@example.com", "bounce", at(-600).toISOString(), NOW.toISOString()],
    ]);
    expect(report.suppressed).toBe(1); // one subscriber is blocked (kati); the student who never subscribed is marked too, for her drawer
    expect([...(await suppressedAddresses(db, ["KATI@example.com", "mari@example.com", "vana@example.com", "opilane@example.com"]))].sort()).toEqual([
      "kati@example.com",
      "opilane@example.com",
    ]);
    expect(await suppressedAddresses(db, [])).toEqual(new Set());
  });

  test("the suppression list unavailable: the rest of the sync goes on", async () => {
    await sub("kati@example.com");
    fake.fail.set("suppressions.list", DOWN);
    expect(await fullSync(deps())).toMatchObject({ added: 1, unsynced: 0, finished: true });
  });

  test("the time budget: no new call after it, a clean stop with finished false and the rest counted; the next run finishes", async () => {
    await ensureSegments(deps());
    for (const email of ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]) await sub(email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    fake.onCall = (name) => {
      if (name === "contacts.create") vi.setSystemTime(Date.now() + 1000);
    };
    const report = await fullSync(deps({ budgetMs: 2500 }));
    expect(report).toMatchObject({ added: 3, unsynced: 2, finished: false });
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(3);
    fake.onCall = null;
    expect(await fullSync(deps({ budgetMs: 2500 }))).toMatchObject({ added: 2, unsynced: 0, finished: true, contacts: 5 });
  });

  test("Resend unreachable for the contact list: MarketingUnavailable, and nothing is deleted on either side", async () => {
    await ensureSegments(deps());
    const c = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.com", { syncedAt: at(-30), resendContactId: c.id });
    fake.fail.set("contacts.list", DOWN);
    await expect(fullSync(deps())).rejects.toBeInstanceOf(MarketingUnavailable);
    expect(await rowOf("kati@example.com")).toBeDefined();
    expect(fake.contacts.size).toBe(1);
  });

  test("the log line has counts only, never an address", async () => {
    await ensureSegments(deps());
    await sub("kati@example.com");
    fake.add("vana@example.com", { segments: [ET()] });
    await fullSync(deps());
    expect(logged()).toMatch(/\[newsletter-sync\] full sync: 1 contacts, 1 added, 0 updated, 1 removed, 0 unsubscribed in Resend, 0 suppressed, 0 not synced, 0 failed/);
    expect(logged()).not.toContain("@");
  });
});

describe("R6: only the newsletter's own segments, never a sample address", () => {
  test("a contact only in our segment without a row is deleted; one in ours and another segment only leaves ours; one in none of ours is never touched", async () => {
    await ensureSegments(deps());
    const proov = (await fake.r.segments.create({ name: "MS LAB uudiskiri (proov)" })).data!.id;
    const mariasOwn = (await fake.r.segments.create({ name: "Maria's own list" })).data!.id;
    const onlyOurs = fake.add("loobunud@example.com", { segments: [ET()] });
    const alsoTest = fake.add("maria@example.com", { segments: [RU(), proov] });
    const testOnly = fake.add("proov@example.com", { segments: [proov] });
    const notOurs = fake.add("maria.list@example.com", { segments: [mariasOwn] });
    const noSegment = fake.add("dashboard@example.com");
    const report = await fullSync(deps());
    expect(fake.contacts.has(onlyOurs.id)).toBe(false);
    expect([...fake.contacts.get(alsoTest.id)!.segments]).toEqual([proov]);
    expect([...fake.contacts.get(testOnly.id)!.segments]).toEqual([proov]);
    expect([...fake.contacts.get(notOurs.id)!.segments]).toEqual([mariasOwn]);
    expect(fake.contacts.get(noSegment.id)).toBeDefined();
    const touched = fake.requests.filter((q) => /\.(remove|update|add)$|segments\.list$/.test(q.name)).map((q) => JSON.stringify(q.args));
    for (const id of [testOnly.id, notOurs.id, noSegment.id]) expect(touched.some((args) => args.includes(id)), id).toBe(false);
    expect(report).toMatchObject({ removed: 2, contacts: 4, failed: 0, finished: true });
  });

  test("the address sync keeps to the same rule: a contact also in another segment only leaves ours, one in none of ours is left alone", async () => {
    await ensureSegments(deps());
    const proov = (await fake.r.segments.create({ name: "MS LAB uudiskiri (proov)" })).data!.id;
    const shared = fake.add("maria@example.com", { segments: [ET(), proov] });
    const outside = fake.add("muu@example.com", { segments: [proov] });
    expect(await syncAddress(deps(), "maria@example.com")).toBe("removed");
    expect(await syncAddress(deps(), "muu@example.com")).toBe("removed");
    expect([...shared.segments]).toEqual([proov]);
    expect([...outside.segments]).toEqual([proov]);
    expect(fake.contacts.size).toBe(2);
  });

  test("a sample address (@example.test) is never synced: 'skipped' with no call, never counted unsynced, its old contact in our segment removed", async () => {
    await ensureSegments(deps());
    const old = fake.add("naidis@example.test", { segments: [ET()] }); // a contact made before this rule
    await sub("naidis@example.test", { syncedAt: at(-30), resendContactId: old.id });
    await sub("uus.naidis@example.test");
    fake.calls.length = 0;
    expect(await syncAddress(deps(), "uus.naidis@example.test")).toBe("skipped");
    expect(fake.calls).toEqual([]);
    const report = await fullSync(deps());
    expect(fake.contacts.size).toBe(0);
    expect(fake.calls).not.toContain("contacts.create");
    expect(report).toMatchObject({ removed: 1, added: 0, unsynced: 0, contacts: 0, finished: true });
    // the sign-up's own hook skips it too
    const tasks: (() => Promise<unknown>)[] = [];
    const fd = new FormData();
    fd.set("email", "kolmas@example.test");
    fd.set("locale", "et");
    await handleSubscribe({ db, env: { KV: fakeKv(), MAIL_FROM: "x", MARIA_EMAIL: "", SITE_URL: SITE }, ip: "203.0.113.9", siteUrl: SITE, now: NOW, later: (t) => void tasks.push(t), newsletterSync: hook() }, fd);
    await Promise.all(tasks.splice(0).map((t) => t()));
    expect(fake.contacts.size).toBe(0);
  });
});

describe("the review's narrow cases (fix round 1)", () => {
  test("M1: a row her own sync stamped after this sync read Resend's contacts is not pulled for the stale unsubscribe", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] }); // her Resend unsubscribe, whose webhook was lost
    const row = await sub("kati@example.com", { consentAt: at(-60), syncedAt: at(-30), resendContactId: kati.id });
    const list = fake.r.contacts.list.bind(fake.r.contacts);
    let raced = false;
    fake.r.contacts.list = async (o) => {
      const answer = await list(o);
      if (!o.segmentId && !raced) {
        // she signs up again right after the sync's read: her hook sets her contact back to subscribed and stamps the row
        raced = true;
        kati.unsubscribed = false;
        await db.update(subscribers).set({ syncedAt: at(1) }).where(eq(subscribers.id, row.id));
      }
      return answer;
    };
    const report = await fullSync(deps());
    expect(await rowOf("kati@example.com")).toBeDefined();
    expect(fake.contacts.has(kati.id)).toBe(true);
    expect(report).toMatchObject({ unsubscribedPulled: 0, removed: 0 });
  });

  test("M2: a routine push (a segment move) never sends `unsubscribed`: an unsubscribe made after the sync's read stays", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { segments: [RU()] });
    const row = await sub("kati@example.com", { syncedAt: at(-30), resendContactId: kati.id }); // Estonian, but in the Russian segment
    kati.properties.unsubscribe_url = loobu(row.token);
    const update = fake.r.contacts.update.bind(fake.r.contacts);
    fake.r.contacts.update = async (o) => {
      kati.unsubscribed = true; // she unsubscribes in Resend between the read and the push
      return update(o);
    };
    const report = await fullSync(deps());
    expect([...kati.segments]).toEqual([ET()]);
    expect(kati.unsubscribed).toBe(true);
    expect(fake.requests.filter((q) => q.name === "contacts.update").map((q) => Object.keys(q.args as object).sort())).toEqual([["id", "properties"]]);
    expect(report).toMatchObject({ updated: 1, failed: 0 });
  });

  test("M2: the property put right on an unsynced row (her language changed) does not resubscribe a contact that is subscribed; a fresh consent does", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { segments: [ET()] });
    await sub("kati@example.com", { locale: "ru", syncedAt: null, resendContactId: kati.id });
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    expect(fake.requests.filter((q) => q.name === "contacts.update").map((q) => "unsubscribed" in (q.args as object))).toEqual([false]);
    const mari = fake.add("mari@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("mari@example.com", { consentAt: at(-1), syncedAt: null, resendContactId: mari.id });
    expect(await syncAddress(deps(), "mari@example.com")).toBe("synced");
    expect(fake.requests.filter((q) => q.name === "contacts.update").map((q) => (q.args as { unsubscribed?: boolean }).unsubscribed)).toEqual([undefined, false]);
    expect(mari.unsubscribed).toBe(false);
  });

  test("M3: the row went while it was pushed (she unsubscribed meanwhile): the contact just made is taken out again in the same call", async () => {
    await ensureSegments(deps());
    await sub("kati@example.com");
    const create = fake.r.contacts.create.bind(fake.r.contacts);
    fake.r.contacts.create = async (o) => {
      const answer = await create(o);
      await db.delete(subscribers).where(eq(subscribers.email, o.email)); // she unsubscribes while her contact is made
      return answer;
    };
    expect(await syncAddress(deps(), "kati@example.com")).toBe("removed");
    expect(fake.contacts.size).toBe(0);
    await sub("mari@example.com");
    const report = await fullSync(deps()); // the same in the full sync
    expect(fake.contacts.size).toBe(0);
    expect(report).toMatchObject({ added: 0, contacts: 0, failed: 0, finished: true });
  });

  test("M4: a failed push of a synced row is counted in `failed` and logged with the row's id", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.com", { segments: [RU()] });
    const row = await sub("kati@example.com", { syncedAt: at(-30), resendContactId: kati.id });
    fake.fail.set("contacts.segments.add", DOWN);
    const report = await fullSync(deps());
    expect(report).toMatchObject({ failed: 1, unsynced: 0, updated: 0 });
    expect(logged()).toContain(`subscriber ${row.id}: contact ${kati.id} not added to segment`);
  });

  test("M5: ensureSegments without a key is MarketingUnavailable (not_configured), as fullSync is; nothing is asked", async () => {
    const none = marketingEnv({ RESEND_MARKETING_KEY: undefined });
    await expect(ensureSegments(deps({ env: none }))).rejects.toMatchObject({ name: "MarketingUnavailable", code: "not_configured" });
    await expect(fullSync(deps({ env: none }))).rejects.toMatchObject({ name: "MarketingUnavailable", code: "not_configured" });
    expect(fake.calls).toEqual([]);
  });

  test("the fake refuses what Resend refuses: a property without a definition, or of another type; the sync fails cleanly when the definition is gone", async () => {
    const refused = await fake.r.contacts.create({ email: "kati@example.com", unsubscribed: false, properties: { unsubscribe_url: "x" }, segments: [] });
    expect(refused.error).toMatchObject({ name: "validation_error", statusCode: 422 });
    await fake.r.contactProperties.create({ key: UNSUBSCRIBE_PROPERTY, type: "string" });
    const wrongType = await fake.r.contacts.create({ email: "kati@example.com", unsubscribed: false, properties: { unsubscribe_url: 5 as unknown as string }, segments: [] });
    expect(wrongType.error).toMatchObject({ name: "validation_error" });
    // the setting says the property exists, but it was deleted in Resend's dashboard: the push is refused, the row stays unsynced
    fake.properties.length = 0;
    await ensureSegments(deps());
    fake.properties.length = 0;
    await sub("mari@example.com");
    expect(await syncAddress(deps(), "mari@example.com")).toBe("failed");
    expect((await rowOf("mari@example.com")).syncedAt).toBeNull();
  });

  test("R7: isSubscriberAddress is true for a confirmed row in any case, false for an unconfirmed row or none", async () => {
    await sub("Kati@Example.com");
    await sub("pending@example.com", { confirmedAt: null });
    expect(await isSubscriberAddress(db, " KATI@example.COM ")).toBe(true);
    expect(await isSubscriberAddress(db, "pending@example.com")).toBe(false);
    expect(await isSubscriberAddress(db, "never@example.com")).toBe(false);
  });
});

describe("ruling R17: an address Resend refuses as a contact is `rejected`, never a failure", () => {
  const refusesBad = (args: unknown) => (/^bad/.test((args as { email: string }).email) ? INVALID_EMAIL : null);

  test("the full sync: `rejected` (not `failed`), the row marked, the rest synced; the sync is finished and nothing is left `unsynced` for it", async () => {
    await ensureSegments(deps());
    const bad = await sub("bad@example.com");
    await sub("kati@example.com");
    await sub("olga@example.com", { locale: "ru" });
    fake.fail.set("contacts.create", refusesBad);
    const report = await fullSync(deps());
    expect(report).toMatchObject({ added: 2, failed: 0, rejected: 1, unsynced: 0, finished: true });
    expect((await rowOf("bad@example.com")).syncedAt).toBeNull();
    expect(await rejectedSubscribers(db, [bad.id, bad.id + 1, bad.id + 2])).toEqual(new Set([bad.id]));
    expect((await db.select().from(settings).where(eq(settings.key, REJECTED_SETTING)))[0].value).toEqual({ [bad.id]: NOW.toISOString() });
    expect(logged()).toContain(`subscriber ${bad.id}: Resend refused the contact`);
    expect(logged()).toMatch(/full sync: .*, 0 failed, 1 rejected/);
    expect(logged()).not.toContain("bad@example.com");
  });

  test("refused rows are no run of failures: three or more in a row neither stop the sync nor count toward its three", async () => {
    await ensureSegments(deps());
    for (let i = 1; i <= 4; i++) await sub(`bad${i}@example.com`);
    await sub("kati@example.com");
    fake.fail.set("contacts.create", refusesBad);
    expect(await fullSync(deps())).toMatchObject({ added: 1, failed: 0, rejected: 4, unsynced: 0, finished: true });
    expect(fake.of("kati@example.com")).toBeDefined();
    expect(logged()).not.toContain("failed in a row");
  });

  test("still a failure: a 5xx, Resend's 'already exists', a refused property, a 403 validation error — none is `rejected`, and the row is not marked", async () => {
    await ensureSegments(deps());
    const row = await sub("kati@example.com");
    for (const error of [DOWN, { name: "validation_error", statusCode: 422, message: "Contact already exists" }, { name: "validation_error", statusCode: 422, message: "The property unsubscribe_url does not exist" }, { name: "validation_error", statusCode: 403, message: "Invalid `email` field" }]) {
      fake.fail.set("contacts.create", error);
      expect(await fullSync(deps()), error.message).toMatchObject({ rejected: 0, failed: 1, unsynced: 1 });
    }
    expect(await rejectedSubscribers(db, [row.id])).toEqual(new Set());
  });

  test("an update Resend refuses for the address is `rejected` too (the row's language changed, the contact exists)", async () => {
    await ensureSegments(deps());
    const c = fake.add("kati@example.com", { segments: [ET()] });
    const row = await sub("kati@example.com", { locale: "ru", resendContactId: c.id });
    fake.fail.set("contacts.update", INVALID_EMAIL);
    expect(await fullSync(deps())).toMatchObject({ rejected: 1, failed: 0, unsynced: 0, finished: true });
    expect(await rejectedSubscribers(db, [row.id])).toEqual(new Set([row.id]));
  });

  test("the address's own sync (a sign-up): 'rejected', the row marked; once Resend takes her, 'synced' and the mark is gone", async () => {
    const bad = await sub("bad@example.com");
    fake.fail.set("contacts.create", refusesBad);
    expect(await syncAddress(deps(), "bad@example.com")).toBe("rejected");
    expect(await rejectedSubscribers(db, [bad.id])).toEqual(new Set([bad.id]));
    fake.fail.clear();
    expect(await syncAddress(deps({ now: at(5) }), "bad@example.com")).toBe("synced");
    expect(await rejectedSubscribers(db, [bad.id])).toEqual(new Set());
    expect((await rowOf("bad@example.com")).syncedAt).toEqual(at(5));
  });

  test("the full sync that pushes a marked row successfully takes its mark away; another row's mark stays", async () => {
    await ensureSegments(deps());
    const bad = await sub("bad@example.com");
    const worse = await sub("bad2@example.com");
    fake.fail.set("contacts.create", refusesBad);
    await fullSync(deps());
    expect(await rejectedSubscribers(db, [bad.id, worse.id])).toEqual(new Set([bad.id, worse.id]));
    fake.fail.set("contacts.create", (args) => ((args as { email: string }).email === "bad2@example.com" ? INVALID_EMAIL : null));
    expect(await fullSync(deps({ now: at(5) }))).toMatchObject({ added: 1, rejected: 1 });
    expect(await rejectedSubscribers(db, [bad.id, worse.id])).toEqual(new Set([worse.id]));
  });

  test("no mark at all: an empty set, and no settings row is made by reading", async () => {
    expect(await rejectedSubscribers(db, [1, 2, 3])).toEqual(new Set());
    expect(await rejectedSubscribers(db, [])).toEqual(new Set());
    expect(await db.select().from(settings)).toEqual([]);
  });
});

describe("Task 2 N4: nothing is deleted when a contact's segments cannot be read, or its delete fails", () => {
  test("a contact in our segment without a row, its segments unreadable: `failed`, the sync not finished, the contact kept; the send refuses", async () => {
    await ensureSegments(deps());
    const orphan = fake.add("loobunud@example.com", { segments: [ET()] });
    await sub("kati@example.com");
    fake.fail.set("contacts.segments.list", DOWN);
    const report = await fullSync(deps());
    expect(report).toMatchObject({ failed: 1, finished: false });
    expect(fake.contacts.get(orphan.id)).toBeDefined();
    expect([...fake.contacts.get(orphan.id)!.segments]).toEqual([ET()]);
    expect(fake.calls).not.toContain("contacts.remove");
    expect(fake.calls).not.toContain("contacts.segments.remove");
    expect(logged()).toContain(`contact ${orphan.id}: its segments not read`);
  });

  test("the site's unsubscribe whose contact cannot be deleted: 'failed', the contact kept; the next full sync takes it out", async () => {
    await ensureSegments(deps());
    await sub("kati@example.com");
    expect(await syncAddress(deps(), "kati@example.com")).toBe("synced");
    const contact = fake.of("kati@example.com")!;
    await db.delete(subscribers);
    fake.fail.set("contacts.remove", DOWN);
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect(fake.contacts.get(contact.id)).toBeDefined();
    // its segments unreadable: 'failed' too, and nothing is removed
    fake.fail.clear();
    fake.fail.set("contacts.segments.list", DOWN);
    expect(await syncAddress(deps(), "kati@example.com")).toBe("failed");
    expect(fake.contacts.get(contact.id)).toBeDefined();
    fake.fail.clear();
    expect(await fullSync(deps())).toMatchObject({ removed: 1, failed: 0, finished: true });
    expect(fake.contacts.get(contact.id)).toBeUndefined();
  });
});

describe("contactCount", () => {
  test("Resend's own count of the contacts; null when Resend cannot be reached", async () => {
    fake.add("a@example.com");
    fake.add("b@example.com");
    expect(await contactCount(deps())).toBe(2);
    fake.fail.set("usage.get", DOWN);
    expect(await contactCount(deps())).toBeNull();
  });

  test("M2: counted from the list only when `usage` answered without a number — never after it answered an error (no second call, no second log line)", async () => {
    fake.add("a@example.com");
    fake.add("b@example.com");
    fake.r.usage.get = async () => ({ data: { contacts: {} as { used: number; limit: number } }, error: null }); // (answered, but no number)
    expect(await contactCount(deps())).toBe(2);
    expect(fake.calls).toEqual(["contacts.list"]);
  });

  test("M2: an error from `usage` is null at once: one call, one log line", async () => {
    fake.add("a@example.com");
    fake.fail.set("usage.get", DOWN);
    expect(await contactCount(deps())).toBeNull();
    expect(fake.calls).toEqual(["usage.get"]);
    expect(logged().match(/contact count unavailable/g)).toHaveLength(1);
  });

  test("readContactCount: `refused` is the key's refusal (a key that can only send, an unknown key, a bare 401 or 403), not an outage nor a 403 validation_error", async () => {
    const refuse = (error: { name: string; statusCode: number | null; message: string }) => {
      fake.r.usage.get = async () => ({ data: null, error });
    };
    refuse({ name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" });
    expect(await readContactCount(deps())).toEqual({ count: null, refused: true });
    refuse({ name: "invalid_api_key", statusCode: 403, message: "API key is invalid" });
    expect(await readContactCount(deps())).toEqual({ count: null, refused: true });
    refuse({ name: "unauthorized", statusCode: 401, message: "no" });
    expect(await readContactCount(deps())).toEqual({ count: null, refused: true });
    refuse(DOWN);
    expect(await readContactCount(deps())).toEqual({ count: null, refused: false });
    refuse({ name: "validation_error", statusCode: 403, message: "something else" });
    expect(await readContactCount(deps())).toEqual({ count: null, refused: false });
    fake.add("a@example.com");
    fake.r.usage.get = async () => ({ data: { contacts: { used: 1, limit: 1000 } }, error: null });
    expect(await readContactCount(deps())).toEqual({ count: 1, refused: false });
    expect(await readContactCount(deps({ env: marketingEnv({ RESEND_MARKETING_KEY: undefined }) }))).toEqual({ count: null, refused: false });
  });

  test("the log of a refused key names the call and the status and says a full-access key is needed; no address", async () => {
    fake.r.usage.get = async () => ({ data: null, error: { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails for kati@example.com" } });
    await readContactCount(deps());
    expect(logged()).toContain("RESEND_MARKETING_KEY");
    expect(logged()).not.toContain("@");
  });
});

describe("broadcastRefused (the review's M2): what counts as „the broadcast was refused, nothing sent“", () => {
  // Resend makes and sends a broadcast in one call: only an answer that says it refused the request means it was not made. Anything else (no
  // answer, a 5xx, a status no one can read as a refusal) may have gone, and the send is `interrupted` (ruling R13).
  const TABLE: [string, { name?: string | null; statusCode?: number | null }, boolean][] = [
    ["400 validation_error", { name: "validation_error", statusCode: 400 }, true],
    ["401 restricted_api_key", { name: "restricted_api_key", statusCode: 401 }, true],
    ["401 missing_api_key", { name: "missing_api_key", statusCode: 401 }, true],
    ["403 invalid_api_key", { name: "invalid_api_key", statusCode: 403 }, true],
    ["403 validation_error (an unverified domain)", { name: "validation_error", statusCode: 403 }, true],
    ["404 not_found (the segment is gone)", { name: "not_found", statusCode: 404 }, true],
    ["422 missing_required_field", { name: "missing_required_field", statusCode: 422 }, true],
    ["422 invalid_from_address", { name: "invalid_from_address", statusCode: 422 }, true],
    ["429 rate_limit_exceeded (after its second try)", { name: "rate_limit_exceeded", statusCode: 429 }, true],
    ["429 daily_quota_exceeded", { name: "daily_quota_exceeded", statusCode: 429 }, true],
    ["a validation error without a status", { name: "validation_error", statusCode: null }, true],
    ["a key error without a status", { name: "invalid_api_key" }, true],
    ["405 method_not_allowed", { name: "method_not_allowed", statusCode: 405 }, false],
    ["408 from a gateway", { name: "application_error", statusCode: 408 }, false],
    ["409 concurrent_idempotent_requests", { name: "concurrent_idempotent_requests", statusCode: 409 }, false],
    ["413 from a gateway", { name: "application_error", statusCode: 413 }, false],
    ["451 security_error", { name: "security_error", statusCode: 451 }, false],
    ["499 from a gateway", { name: "application_error", statusCode: 499 }, false],
    ["500 internal_server_error", { name: "internal_server_error", statusCode: 500 }, false],
    ["502 from a gateway", { name: "application_error", statusCode: 502 }, false],
    ["a 5xx that names a validation error (the server may have made it)", { name: "validation_error", statusCode: 500 }, false],
    ["no answer (the SDK's fetch failed)", { name: "application_error", statusCode: null }, false],
    ["our own timeout", { name: "request_failed", statusCode: null }, false],
    ["nothing at all", {}, false],
  ];
  test.each(TABLE)("%s → refused: %s", (_, error, refused) => {
    expect(broadcastRefused(error)).toBe(refused);
  });
  test("null is no refusal", () => {
    expect(broadcastRefused(null)).toBe(false);
  });
});

describe("keyRefused", () => {
  test("by the API's name or by the status, from a Resend error or from a MarketingUnavailable (whose name is its class, its `code` the API's)", () => {
    expect(keyRefused({ name: "restricted_api_key", statusCode: 401 })).toBe(true);
    expect(keyRefused(new MarketingUnavailable({ name: "invalid_api_key", statusCode: 403 }, "contacts.list"))).toBe(true);
    expect(keyRefused(new MarketingUnavailable({ name: "forbidden", statusCode: 403 }))).toBe(true);
    expect(keyRefused(new MarketingUnavailable({ name: "internal_server_error", statusCode: 500 }))).toBe(false);
    expect(keyRefused(new MarketingUnavailable({ name: "validation_error", statusCode: 403 }))).toBe(false);
    expect(keyRefused(new MarketingUnavailable({ name: "request_failed", statusCode: null }))).toBe(false);
    for (const odd of [null, undefined, "restricted_api_key", 401, {}]) expect(keyRefused(odd), String(odd)).toBe(false);
  });
});

describe("each change to a subscriber row syncs that address after its commit, best effort", () => {
  const formEnv = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.com", SITE_URL: SITE });
  function formDeps(sync?: SubscriberSync) {
    const tasks: (() => Promise<unknown>)[] = [];
    const d: Deps = { db, env: formEnv(), ip: "203.0.113.9", siteUrl: SITE, now: NOW, later: (task) => void tasks.push(task), newsletterSync: sync };
    return { d, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
  }
  const signUp = (d: Deps, email: string, locale = "et") => {
    const fd = new FormData();
    fd.set("email", email);
    fd.set("locale", locale);
    return handleSubscribe(d, fd);
  };

  test("the sign-up (footer, popup, coming-soon page): synced after the answer, in her language", async () => {
    const { d, flush } = formDeps(hook());
    expect(await signUp(d, "kati@example.com", "ru")).toEqual({ ok: true });
    expect(fake.contacts.size).toBe(0); // not before the answer
    await flush();
    expect([...fake.of("kati@example.com")!.segments]).toEqual([RU()]);
    expect((await rowOf("kati@example.com")).syncedAt).toEqual(NOW);
  });

  test("a failed sync never fails the sign-up: the answer is the same, the row is stored with its 'not synced' mark", async () => {
    fake.fail.set("contacts.create", DOWN);
    const { d, flush } = formDeps(hook());
    expect(await signUp(d, "kati@example.com")).toEqual({ ok: true });
    await flush();
    expect(await rowOf("kati@example.com")).toMatchObject({ confirmedAt: NOW, syncedAt: null });
    const throwing = formDeps(async () => {
      throw new Error("the hook itself broke");
    });
    expect(await signUp(throwing.d, "mari@example.com")).toEqual({ ok: true });
    await expect(throwing.flush()).resolves.toBeDefined();
  });

  test("signing up again is a fresh consent (D3): a confirmed row is marked for the sync, and a Resend-side unsubscribe is undone", async () => {
    await ensureSegments(deps());
    const c = fake.add("kati@example.com", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.com", { syncedAt: at(-30), resendContactId: c.id }); // the webhook of her unsubscribe was lost
    const { d, flush } = formDeps(hook());
    expect(await signUp(d, "kati@example.com")).toEqual({ ok: true });
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    await flush();
    expect(c.unsubscribed).toBe(false);
    expect((await rowOf("kati@example.com")).syncedAt).toEqual(NOW);
  });

  test("the registration forms' box (subscribeLater): synced in the same work after the answer", async () => {
    const { d } = formDeps(hook());
    await subscribeLater(d, "register", { email: "kati@example.com", locale: "et" });
    expect(fake.of("kati@example.com")).toBeDefined();
  });

  test("the site's unsubscribe button: the row goes, then her contact", async () => {
    const row = await sub("kati@example.com", { token: "u".repeat(43) }); // a token of newToken()'s shape
    await syncAddress(deps(), "kati@example.com");
    const gone: string[] = [];
    expect(await unsubscribeByToken(db, fakeKv(), row.token, (email) => void gone.push(email))).toEqual({ locale: "et" });
    expect(gone).toEqual(["kati@example.com"]);
    await hook()(gone[0]);
    expect(fake.contacts.size).toBe(0);
    expect(await unsubscribeByToken(db, fakeKv(), row.token, (email) => void gone.push(email))).toBeNull(); // pressed twice: nothing to tell
    expect(gone).toHaveLength(1);
  });

  test("the old confirmation link: the first confirmation syncs her, a second click does not", async () => {
    const row = await sub("kati@example.com", { confirmedAt: null, token: "c".repeat(43) });
    const tasks: (() => Promise<unknown>)[] = [];
    const confirm = () =>
      confirmNewsletter({ db, env: { KV: fakeKv(), MAIL_FROM: "x", MARIA_EMAIL: "", SITE_URL: SITE }, now: NOW, siteUrl: SITE, later: (t) => void tasks.push(t), newsletterSync: hook() }, row.token);
    expect((await confirm()).outcome).toBe("kinnitatud");
    await Promise.all(tasks.splice(0).map((t) => t()));
    expect(fake.of("kati@example.com")).toBeDefined();
    fake.calls.length = 0;
    await confirm();
    await Promise.all(tasks.splice(0).map((t) => t()));
    expect(fake.calls).toEqual([]);
  });

  test("„Minu andmed“: the newsletter switch on syncs her (a fresh consent: marked unsynced first), off deletes her contact", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "ru" }).returning();
    const told: string[] = [];
    expect(await setNewsletter(db, kati.id, true, NOW, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.com"]);
    await hook()("kati@example.com");
    expect([...fake.of("kati@example.com")!.segments]).toEqual([RU()]);
    await setNewsletter(db, kati.id, true, NOW, (email) => void told.push(email)); // on again: a fresh consent
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    expect(await setNewsletter(db, kati.id, false, NOW, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.com", "kati@example.com", "kati@example.com"]);
    await hook()("kati@example.com");
    expect(fake.contacts.size).toBe(0);
    await setNewsletter(db, kati.id, false, NOW, (email) => void told.push(email)); // nothing to delete: nothing to tell
    expect(told).toHaveLength(3);
  });

  test("„Minu andmed“: a change of language moves her linked row's language, marks it unsynced, and the sync moves her segment; the same language tells nothing", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "et" }).returning();
    await sub("kati@example.com", { clientId: kati.id });
    await syncAddress(deps(), "kati@example.com");
    const told: string[] = [];
    expect(await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "et" }, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual([]);
    expect(await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "ru" }, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.com"]);
    expect(await rowOf("kati@example.com")).toMatchObject({ locale: "ru", syncedAt: null });
    await hook()("kati@example.com");
    expect([...fake.of("kati@example.com")!.segments]).toEqual([RU()]);
  });

  test("„Minu andmed“: a change of language moves only her linked row (not another client's, not an unlinked row of the same language)", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "et" }).returning();
    const [mari] = await db.insert(clients).values({ email: "mari@example.com", locale: "et" }).returning();
    await sub("kati@example.com", { clientId: kati.id, syncedAt: at(-30) });
    await sub("mari@example.com", { clientId: mari.id, syncedAt: at(-30) });
    await sub("vaba@example.com", { syncedAt: at(-30) });
    const told: string[] = [];
    await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "ru" }, (email) => void told.push(email));
    expect(told).toEqual(["kati@example.com"]);
    const rows = await db.select({ email: subscribers.email, locale: subscribers.locale, syncedAt: subscribers.syncedAt }).from(subscribers).orderBy(subscribers.email);
    expect(rows).toEqual([
      { email: "kati@example.com", locale: "ru", syncedAt: null },
      { email: "mari@example.com", locale: "et", syncedAt: at(-30) },
      { email: "vaba@example.com", locale: "et", syncedAt: at(-30) },
    ]);
  });

  test("the transactional hooks tell the address only after the commit, and a rolled-back change tells nothing", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "et" }).returning();
    await sub("kati@example.com", { clientId: kati.id });
    const real = db.transaction.bind(db) as (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>;
    const events: string[] = [];
    const committing = vi.spyOn(db, "transaction").mockImplementation((async (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
      const out = await real(fn, config);
      events.push("committed");
      return out;
    }) as never);
    await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "ru" }, (email) => void events.push(`told ${email}`));
    expect(events).toEqual(["committed", "told kati@example.com"]);
    committing.mockRestore();
    // the same change rolled back (the transaction fails after the write): no sync is due, and nothing changed
    const rolling = vi.spyOn(db, "transaction").mockImplementation((async (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      real(async (tx) => {
        await fn(tx);
        throw new Error("rolled back");
      }, config)) as never);
    const told: string[] = [];
    await expect(updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "et" }, (email) => void told.push(email))).rejects.toThrow("rolled back");
    await expect(deleteClient(db, kati.id, (email) => void told.push(email))).rejects.toThrow("rolled back");
    expect(told).toEqual([]);
    expect(await rowOf("kati@example.com")).toMatchObject({ locale: "ru" });
    expect(await db.select().from(clients).where(eq(clients.id, kati.id))).toHaveLength(1);
    rolling.mockRestore();
    // and the deletion that commits tells after the commit
    const after: string[] = [];
    const deleting = vi.spyOn(db, "transaction").mockImplementation((async (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
      const out = await real(fn, config);
      after.push("committed");
      return out;
    }) as never);
    await deleteClient(db, kati.id, (email) => void after.push(`told ${email}`));
    expect(after).toEqual(["committed", "told kati@example.com"]);
    deleting.mockRestore();
  });

  test("a deleted account: told once the deletion has committed, and her contact is deleted", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "et" }).returning();
    await sub("kati@example.com", { clientId: kati.id });
    await syncAddress(deps(), "kati@example.com");
    const told: string[] = [];
    expect(await deleteClient(db, kati.id, (email) => void told.push(email))).toMatchObject({ email: "kati@example.com" });
    expect(told).toEqual(["kati@example.com"]);
    await hook()(told[0]);
    expect(fake.contacts.size).toBe(0);
    const [mari] = await db.insert(clients).values({ email: "mari@example.com", locale: "et" }).returning();
    await deleteClient(db, mari.id, (email) => void told.push(email)); // no subscription: nothing to tell
    expect(told).toHaveLength(1);
  });

  test("the account API wires the three: PATCH /andmed, POST /uudiskiri and POST /kustuta sync after the answer", async () => {
    const tasks: (() => Promise<unknown>)[] = [];
    const accountDeps: AccountDeps = {
      db,
      env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.com", SITE_URL: SITE },
      now: NOW,
      siteUrl: SITE,
      later: (task) => void tasks.push(task),
      dev: true,
      newsletterSync: hook(),
    };
    const flush = () => Promise.all(tasks.splice(0).map((t) => t()));
    const call = async (path: string, body: unknown, cookie?: string, method = "POST") =>
      (await handleAccountApi(
        new Request(`${SITE}/api/konto${path}`, { method, headers: { "x-forwarded-for": "203.0.113.9", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }),
        accountDeps,
      ))!;
    const login = await (await call("/login", { email: "kati@example.com", locale: "et" })).json();
    const signedIn = await call("/code", { email: "kati@example.com", code: login.devCode });
    const cookie = signedIn.headers.getSetCookie().find((c) => c.startsWith("__Host-mslab_client="))!.split(";")[0];
    await flush();

    expect((await call("/uudiskiri", { on: true }, cookie)).status).toBe(200);
    expect(fake.contacts.size).toBe(0);
    await flush();
    expect([...fake.of("kati@example.com")!.segments]).toEqual([ET()]);

    expect((await call("/andmed", { name: "Kati", phone: "", locale: "ru" }, cookie, "PATCH")).status).toBe(200);
    await flush();
    expect([...fake.of("kati@example.com")!.segments]).toEqual([RU()]);

    expect((await call("/kustuta", { confirm: true }, cookie)).status).toBe(200);
    await flush();
    expect(fake.contacts.size).toBe(0);
  });
});

describe("the real SDK behind ResendLike", () => {
  test("syncAddress with the resend package itself (fetch stubbed): the documented endpoints, the key, an address a path cannot hold encoded", async () => {
    await sub("a/b?c@example.com");
    const f = stubFetch((href, init) => {
      const method = init?.method ?? "GET";
      const url = new URL(href).pathname;
      if (url.endsWith("/segments") && method === "GET") return Response.json({ object: "list", data: [], has_more: false });
      if (url.endsWith("/segments")) return Response.json({ object: "segment", id: `seg-${JSON.parse(String(init?.body)).name.includes("RU") ? "ru" : "et"}`, name: "x" });
      if (url.endsWith("/contact-properties") && method === "GET") return Response.json({ object: "list", data: [], has_more: false });
      if (url.endsWith("/contact-properties")) return Response.json({ object: "contact_property", id: "prop-1" });
      if (url.endsWith("/usage")) return Response.json({ object: "usage", contacts: { used: 0, limit: 1000 } });
      if (method === "GET" && url.includes("/contacts/")) return Response.json({ name: "not_found", message: "Contact not found", statusCode: 404 }, { status: 404 });
      if (method === "POST" && url.endsWith("/contacts")) return Response.json({ object: "contact", id: "ct-1" });
      return Response.json({ name: "not_found", message: "?", statusCode: 404 }, { status: 404 });
    });
    const outcome = await syncAddress({ db, env: marketingEnv(), siteUrl: SITE, now: NOW, gapMs: 0 }, "a/b?c@example.com");
    expect(outcome).toBe("synced");
    expect(f.calls.every((c) => c.url.startsWith("https://api.resend.com/"))).toBe(true);
    expect(f.calls.every((c) => c.headers.get("authorization") === "Bearer re_marketing_test")).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.url.slice("https://api.resend.com".length)}`)).toEqual([
      "GET /segments?limit=100",
      "POST /segments",
      "POST /segments",
      "GET /contact-properties?limit=100",
      "POST /contact-properties",
      "GET /contacts/a%2Fb%3Fc@example.com",
      "POST /contacts",
    ]);
    expect(f.calls[4].body).toEqual({ key: "unsubscribe_url", type: "string" });
    const row = await rowOf("a/b?c@example.com");
    expect(f.calls[6].body).toEqual({ email: "a/b?c@example.com", unsubscribed: false, properties: { unsubscribe_url: loobu(row.token) }, segments: [{ id: "seg-et" }] });
    expect(row).toMatchObject({ syncedAt: NOW, resendContactId: "ct-1" });
  });
});

describe("the review's M5: a background sync is slower than a press", () => {
  test("a sign-up's own sync (the production hook) keeps a second between its Resend calls; MARKETING_GAP_MS (a press, a send) stays 600 ms", async () => {
    expect(BACKGROUND_GAP_MS).toBe(1000);
    expect(MARKETING_GAP_MS).toBe(600);
    const background = backgroundMarketingDeps(db, marketingEnv(), NOW, 5000);
    expect(background.db).toBe(db);
    expect({ siteUrl: background.siteUrl, now: background.now, gapMs: background.gapMs, budgetMs: background.budgetMs }).toEqual({ siteUrl: SITE, now: NOW, gapMs: BACKGROUND_GAP_MS, budgetMs: 5000 });
    expect(backgroundMarketingDeps(db, marketingEnv(), NOW)).not.toHaveProperty("budgetMs");
    await db.insert(settings).values({ key: SEGMENTS_SETTING, value: { et: "seg-et", ru: "seg-ru", property: "prop-1" } });
    await sub("kati@example.com");
    const times: number[] = [];
    stubFetch((href, init) => {
      times.push(Date.now());
      if ((init?.method ?? "GET") === "GET") return Response.json({ name: "not_found", message: "Contact not found", statusCode: 404 }, { status: 404 });
      return Response.json({ object: "contact", id: "ct-1" });
    });
    const hookOf = subscriberSync(db, marketingEnv())!;
    expect(await hookOf("kati@example.com")).toBe("synced");
    expect(times).toHaveLength(2); // contacts.get, contacts.create
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(BACKGROUND_GAP_MS - 20);
  });
});

describe("the full sync's lease (rulings R9, R11): one full sync at a time", () => {
  const leaseRow = async () => (await db.select().from(settings).where(eq(settings.key, SYNC_LEASE_SETTING)))[0];
  const putLease = (value: unknown) => db.insert(settings).values({ key: SYNC_LEASE_SETTING, value });
  /**
   * The fake Resend with `before` run ahead of each answer of the contacts' list (a full sync's first reads, after its segments are made: the segments are
   * made in a transaction, and PGlite has one connection, so a query of the test's own would wait for that transaction).
   */
  const watched = (before: () => Promise<void>) => ({
    ...fake.r,
    contacts: {
      ...fake.r.contacts,
      async list(o: Parameters<typeof fake.r.contacts.list>[0]) {
        await before();
        return fake.r.contacts.list(o);
      },
    },
  });

  test("two full syncs at once: one runs and the other is busy; the lease is gone afterwards and a third runs", async () => {
    await sub("kati@example.com");
    const results = await Promise.allSettled([fullSync(deps()), fullSync(deps())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(FullSyncBusy);
    expect(refused[0].reason).not.toBeInstanceOf(MarketingUnavailable);
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(1); // she was added once
    expect(await leaseRow()).toBeUndefined();
    expect(logged()).toContain("already running");
    expect(await fullSync(deps())).toMatchObject({ added: 0, finished: true });
  });

  test("a sync begun while another is in the middle of its work is busy and makes no call to Resend", async () => {
    await sub("kati@example.com");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const running = new Promise<void>((resolve) => (reached = resolve));
    const resend = watched(async () => {
      reached();
      await held; // (the first sync stands still at its first call to Resend)
    });
    const first = fullSync(deps({ resend }));
    await running;
    fake.calls.length = 0;
    await expect(fullSync(deps())).rejects.toBeInstanceOf(FullSyncBusy);
    expect(fake.calls).toEqual([]);
    release();
    expect(await first).toMatchObject({ added: 1, finished: true });
    expect(await leaseRow()).toBeUndefined();
  });

  test("the lease is a settings row `{ holder, until }`: a random holder, the same all through the sync, and until = now + the sync's budget + 30 s (5 minutes + 30 s with no budget)", async () => {
    const seen: { holder: string; until: number }[] = [];
    const resend = watched(async () => void seen.push((await leaseRow()).value as { holder: string; until: number }));
    const before = Date.now();
    await fullSync(deps({ resend, budgetMs: 10_000 }));
    const after = Date.now();
    expect(SYNC_LEASE_SETTING).toBe("newsletter_sync_lease");
    expect(seen.length).toBeGreaterThanOrEqual(3); // (the lists of all the contacts and of the two segments)
    expect(new Set(seen.map((l) => l.holder)).size).toBe(1);
    const held = seen[0];
    expect(held.holder).toMatch(/^[0-9a-f-]{36}$/);
    expect(held.until).toBeGreaterThanOrEqual(before + 40_000);
    expect(held.until).toBeLessThanOrEqual(after + 40_000);
    expect(seen.every((l) => l.until === held.until)).toBe(true);
    seen.length = 0;
    await fullSync(deps({ resend })); // (no budget)
    expect(seen[0].until).toBeGreaterThanOrEqual(before + 330_000);
    expect(seen[0].until).toBeLessThanOrEqual(Date.now() + 330_000);
    expect(seen[0].holder).not.toBe(held.holder);
    expect(await leaseRow()).toBeUndefined();
  });

  test("an expired lease is taken over, and the sync runs; a missing or odd `until` counts as expired", async () => {
    await sub("kati@example.com");
    await putLease({ holder: "crashed", until: Date.now() - 1000 });
    expect(await fullSync(deps())).toMatchObject({ added: 1, finished: true });
    expect(await leaseRow()).toBeUndefined();
    for (const odd of [{}, { holder: "x" }, { holder: "x", until: "soon" }, { holder: "x", until: null }, "x", 5]) {
      await db.delete(settings).where(eq(settings.key, SYNC_LEASE_SETTING));
      await putLease(odd);
      expect(await fullSync(deps()), JSON.stringify(odd)).toMatchObject({ finished: true });
      expect(await leaseRow()).toBeUndefined();
    }
  });

  test("a lease another holds is not taken, not touched and not released: busy, Resend is not asked", async () => {
    await sub("kati@example.com");
    const other = { holder: "other", until: Date.now() + 60_000 };
    await putLease(other);
    await expect(fullSync(deps())).rejects.toBeInstanceOf(FullSyncBusy);
    expect(fake.calls).toEqual([]);
    expect((await leaseRow()).value).toEqual(other);
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
  });

  test("the lease is released after a throw (Resend not answering the lists, a call that throws), and the next sync runs", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", DOWN);
    await expect(fullSync(deps())).rejects.toBeInstanceOf(MarketingUnavailable);
    expect(await leaseRow()).toBeUndefined();
    fake.fail.clear();
    fake.fail.set("contacts.list", () => {
      throw new Error("socket hang up for kati@example.com");
    });
    await expect(fullSync(deps())).rejects.toBeInstanceOf(MarketingUnavailable);
    expect(await leaseRow()).toBeUndefined();
    fake.fail.clear();
    expect(await fullSync(deps())).toMatchObject({ added: 1, finished: true });
  });

  test("a sync whose lease ran out and was taken over meanwhile does not release the other's lease", async () => {
    await sub("kati@example.com");
    const later = { holder: "later", until: Date.now() + 120_000 };
    const resend = watched(async () => {
      await db.update(settings).set({ value: later }).where(eq(settings.key, SYNC_LEASE_SETTING));
    });
    expect(await fullSync(deps({ resend }))).toMatchObject({ finished: true });
    expect((await leaseRow()).value).toEqual(later);
  });

  test("a lease that cannot be released is logged without an address and does not turn a finished sync into a failure", async () => {
    await sub("kati@example.com");
    const failing = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "delete")
          return () => ({
            where() {
              throw new TypeError("boom for kati@example.com");
            },
          });
        return Reflect.get(target, key, receiver);
      },
    });
    const report = await fullSync(deps({ db: failing as Db }));
    expect(report).toMatchObject({ added: 1, finished: true });
    expect(logged()).toContain("lease not released");
    expect(logged()).not.toContain("kati");
    expect((await leaseRow())?.value).toMatchObject({ holder: expect.any(String) }); // (it ends by itself at its `until`)
  });
});

describe("the daily cron", () => {
  test("with a marketing key the sweep runs the full sync within its budget and answers its report; Resend failing is reported, not a 500", async () => {
    const { GET } = await import("@/app/api/cron/sweep/route");
    for (const name of ["MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER"]) vi.stubEnv(name, "");
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789");
    vi.stubEnv("RESEND_MARKETING_KEY", "re_marketing_test");
    // the segments were set up before (each call waits a background sync's 1 s between Resend calls here: the fewer, the shorter the test)
    await db.insert(settings).values({ key: SEGMENTS_SETTING, value: { et: "seg-et", ru: "seg-ru", property: "prop-1" } });
    const empty = () => Response.json({ object: "list", data: [], has_more: false });
    const times: number[] = [];
    stubFetch((url, init) => {
      times.push(Date.now());
      if ((init?.method ?? "GET") === "GET") return empty();
      if (url.endsWith("/segments")) return Response.json({ object: "segment", id: `seg-${Math.random()}`, name: "x" });
      return Response.json({ object: "contact_property", id: "prop-1" });
    });
    const call = () => GET(new Request("https://mslab.example/api/cron/sweep", { headers: { authorization: "Bearer cron-secret-for-tests-0123456789" } }));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).newsletter).toEqual({ contacts: 0, added: 0, updated: 0, removed: 0, unsubscribedPulled: 0, suppressed: 0, unsynced: 0, failed: 0, rejected: 0, limitReached: false, finished: true });
    // the review's M5: the cron is a background sync, a second between two calls (a press keeps MARKETING_GAP_MS, 600 ms)
    expect(times.length).toBeGreaterThanOrEqual(3);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.min(...gaps), JSON.stringify(gaps)).toBeGreaterThanOrEqual(BACKGROUND_GAP_MS - 20);
    stubFetch(() => Response.json({ name: "internal_server_error", message: "down", statusCode: 500 }, { status: 500 }));
    const failed = await call();
    expect(failed.status).toBe(200);
    expect((await failed.json()).newsletter).toEqual({ error: "unavailable" });
  });

  test("a full sync already running (Maria's button, an earlier run): the sweep skips it, answers `busy` and logs it; nothing is asked of Resend, and it is not a 500", async () => {
    const { GET } = await import("@/app/api/cron/sweep/route");
    for (const name of ["MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER"]) vi.stubEnv(name, "");
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789");
    vi.stubEnv("RESEND_MARKETING_KEY", "re_marketing_test");
    await db.insert(settings).values({ key: SYNC_LEASE_SETTING, value: { holder: "button", until: Date.now() + 60_000 } });
    const f = stubFetch(() => Response.json({}));
    const res = await GET(new Request("https://mslab.example/api/cron/sweep", { headers: { authorization: "Bearer cron-secret-for-tests-0123456789" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).newsletter).toEqual({ error: "busy" });
    expect(f.calls.filter((c) => c.url.includes("resend"))).toEqual([]);
    expect(logged()).toContain("already running");
    expect((await db.select().from(settings).where(eq(settings.key, SYNC_LEASE_SETTING)))[0].value).toMatchObject({ holder: "button" });
  });
});

