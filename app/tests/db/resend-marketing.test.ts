import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, clientLoginTokens, mailSuppressions, settings, subscribers } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { deleteClient, setNewsletter, updateProfile } from "@/server/client-data";
import { confirmNewsletter, unsubscribeByToken } from "@/server/newsletter";
import type { Env } from "@/server/notify";
import {
  contactCount,
  ensureSegments,
  fullSync,
  MarketingUnavailable,
  marketingConfigured,
  SEGMENT_NAMES,
  SEGMENTS_SETTING,
  suppressedAddresses,
  syncAddress,
  UNSUBSCRIBE_PLACEHOLDER,
  UNSUBSCRIBE_PROPERTY,
  type MarketingDeps,
  type SubscriberSync,
} from "@/server/resend-marketing";
import { handleSubscribe, subscribeLater, type Deps } from "@/server/submit";
import { fakeKv, stubFetch } from "../fakes";
import { CONTACTS_QUOTA, DOWN, fakeResend, RATE_LIMITED, type FakeResend } from "./resend-fake";
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
  MARIA_EMAIL: "maria@example.test",
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
  test("the marketing key is RESEND_MARKETING_KEY, else RESEND_API_KEY; without either nothing is synced and Resend is not asked", async () => {
    expect(marketingConfigured(marketingEnv())).toBe(true);
    expect(marketingConfigured(marketingEnv({ RESEND_MARKETING_KEY: undefined, RESEND_API_KEY: "re_send" }))).toBe(true);
    const none = marketingEnv({ RESEND_MARKETING_KEY: undefined });
    expect(marketingConfigured(none)).toBe(false);
    await sub("kati@example.test");
    expect(await syncAddress(deps({ env: none }), "kati@example.test")).toBe("skipped");
    expect(await contactCount(deps({ env: none }))).toBeNull();
    expect(fake.calls).toEqual([]);
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
    const row = await sub("kati@example.test");
    expect(await syncAddress(deps(), "kati@example.test")).toBe("synced");
    const contact = fake.of("kati@example.test")!;
    expect(contact).toMatchObject({ unsubscribed: false, properties: { unsubscribe_url: loobu(row.token) } });
    expect([...contact.segments]).toEqual([ET()]);
    expect(await rowOf("kati@example.test")).toMatchObject({ syncedAt: NOW, resendContactId: contact.id });
  });

  test("the language moves the segment: a Russian row's contact leaves the Estonian segment for the Russian one", async () => {
    await ensureSegments(deps());
    const contact = fake.add("kati@example.test", { segments: [ET()], properties: { unsubscribe_url: "old" } });
    const row = await sub("kati@example.test", { locale: "ru", resendContactId: contact.id });
    expect(await syncAddress(deps(), "kati@example.test")).toBe("synced");
    expect([...contact.segments]).toEqual([RU()]);
    expect(contact.properties.unsubscribe_url).toBe(loobu(row.token));
    expect(fake.calls.filter((c) => c === "contacts.create")).toEqual([]); // the same contact, moved
  });

  test("an address stored in another case is the same address; Resend gets it in lower case", async () => {
    await sub("Kati@Example.test");
    expect(await syncAddress(deps(), " KATI@example.TEST ")).toBe("synced");
    expect(fake.of("kati@example.test")).toBeDefined();
    expect((await rowOf("kati@example.test")).syncedAt).toEqual(NOW);
  });

  test("a fresh consent wins over a Resend-side unsubscribe (R1): an unsynced row's contact is set back to subscribed", async () => {
    await ensureSegments(deps());
    const contact = fake.add("kati@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.test", { consentAt: at(-1), syncedAt: null });
    expect(await syncAddress(deps(), "kati@example.test")).toBe("synced");
    expect(contact.unsubscribed).toBe(false);
  });

  test("no row, or a row of the old flow never confirmed: her contact is deleted (404 is fine); nothing is created", async () => {
    await ensureSegments(deps());
    fake.add("gone@example.test", { segments: [ET()] });
    fake.add("pending@example.test", { segments: [ET()] });
    await sub("pending@example.test", { confirmedAt: null });
    expect(await syncAddress(deps(), "gone@example.test")).toBe("removed");
    expect(await syncAddress(deps(), "pending@example.test")).toBe("removed");
    expect(await syncAddress(deps(), "never@example.test")).toBe("removed");
    expect(fake.contacts.size).toBe(0);
    expect(fake.calls).not.toContain("contacts.create");
  });

  test("Resend failing: 'failed', never a throw; the row keeps its 'not synced' mark; the log has no address", async () => {
    await sub("kati@example.test");
    fake.fail.set("contacts.create", DOWN);
    expect(await syncAddress(deps(), "kati@example.test")).toBe("failed");
    expect((await rowOf("kati@example.test")).syncedAt).toBeNull();
    fake.fail.set("contacts.get", () => {
      throw new Error("network down for kati@example.test");
    });
    expect(await syncAddress(deps(), "kati@example.test")).toBe("failed");
    expect(logged()).toContain("[newsletter-sync]");
    expect(logged()).not.toContain("@");
  });

  test("a key that may only send: the log says a full-access key is needed (RESEND_MARKETING_KEY)", async () => {
    await sub("kati@example.test");
    fake.fail.set("segments.list", { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" });
    expect(await syncAddress(deps(), "kati@example.test")).toBe("failed");
    expect(logged()).toContain("RESEND_MARKETING_KEY");
  });

  test("Resend asks for fewer requests (429): the call is tried once more, never a third time", async () => {
    await sub("kati@example.test");
    let refused = 0;
    fake.fail.set("contacts.create", () => (refused++ < 1 ? RATE_LIMITED : null));
    expect(await syncAddress(deps(), "kati@example.test")).toBe("synced");
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(2);
    fake.fail.set("contacts.get", RATE_LIMITED);
    expect(await syncAddress(deps(), "kati@example.test")).toBe("failed");
    expect(fake.calls.filter((c) => c === "contacts.get")).toHaveLength(3); // one before, then this one and its retry
  });

  test("the plan's contacts used up: she is not added, her row stays unsynced ('skipped')", async () => {
    await sub("kati@example.test");
    fake.fail.set("contacts.create", CONTACTS_QUOTA);
    expect(await syncAddress(deps(), "kati@example.test")).toBe("skipped");
    expect((await rowOf("kati@example.test")).syncedAt).toBeNull();
  });
});

describe("fullSync", () => {
  test("Review Focus 1: a Resend-side unsubscribe is pulled before anything else: her row is gone before the first write to Resend", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.test", { syncedAt: at(-30), resendContactId: kati.id });
    await sub("mari@example.test"); // new: to be added
    const rowAtFirstWrite: unknown[] = [];
    fake.onCall = (name) => {
      if (/\.(create|update|remove|add)$/.test(name) && rowAtFirstWrite.length === 0) rowAtFirstWrite.push(name);
    };
    let checked = false;
    const firstWrite = fake.r.contacts.remove.bind(fake.r.contacts);
    fake.r.contacts.remove = async (o) => {
      if (!checked) {
        checked = true;
        expect(await rowOf("kati@example.test")).toBeUndefined();
      }
      return firstWrite(o);
    };
    const report = await fullSync(deps());
    expect(rowAtFirstWrite).toEqual(["contacts.remove"]); // her contact's removal is the first write; the new contact comes after
    expect(checked).toBe(true);
    expect(await rowOf("kati@example.test")).toBeUndefined();
    expect(fake.of("kati@example.test")).toBeUndefined();
    expect(report).toMatchObject({ unsubscribedPulled: 1, removed: 1, added: 1, unsynced: 0, finished: true, limitReached: false, contacts: 1 });
  });

  test("R1: she unsubscribed in Resend, then signed up again on the site before the sync ran: her row survives and her contact is subscribed again", async () => {
    await ensureSegments(deps());
    const kati = fake.add("kati@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.test", { consentAt: at(-5), syncedAt: null, resendContactId: kati.id }); // the new sign-up marked it unsynced
    const report = await fullSync(deps());
    expect(await rowOf("kati@example.test")).toMatchObject({ syncedAt: NOW });
    expect(kati.unsubscribed).toBe(false);
    expect(report).toMatchObject({ unsubscribedPulled: 0, updated: 1, removed: 0, finished: true });
  });

  test("R1, the plain case: a synced row whose consent is older than the sync is deleted for a Resend unsubscribe; a consent given after the sync began is not", async () => {
    await ensureSegments(deps());
    const a = fake.add("vana@example.test", { unsubscribed: true, segments: [ET()] });
    const b = fake.add("uus@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("vana@example.test", { consentAt: at(-60), syncedAt: at(-30), resendContactId: a.id });
    await sub("uus@example.test", { consentAt: at(1), syncedAt: at(2), resendContactId: b.id });
    const report = await fullSync(deps());
    expect(await rowOf("vana@example.test")).toBeUndefined();
    expect(await rowOf("uus@example.test")).toBeDefined();
    expect(report.unsubscribedPulled).toBe(1);
  });

  test("Review Focus 2: every synced contact ends with the property, subscribed and in exactly its segment, whatever state it was in", async () => {
    await ensureSegments(deps());
    const noProperty = fake.add("ilma@example.test", { segments: [ET()] });
    const wrongSegment = fake.add("vale@example.test", { segments: [ET(), RU()], properties: { unsubscribe_url: "x" } });
    const fine = fake.add("korras@example.test", { segments: [ET()] });
    await sub("ilma@example.test", { syncedAt: null, resendContactId: noProperty.id }); // synced before the property existed
    await sub("vale@example.test", { locale: "ru", syncedAt: at(-10), resendContactId: wrongSegment.id });
    const korras = await sub("korras@example.test", { syncedAt: at(-10), resendContactId: fine.id });
    fine.properties.unsubscribe_url = loobu(korras.token);
    await sub("kadunud@example.test", { syncedAt: at(-10), resendContactId: "ct_deleted_in_the_dashboard" });
    await sub("uus@example.test");
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
    expect(rows.filter((r) => r.email !== "korras@example.test").every((r) => r.syncedAt?.getTime() === NOW.getTime())).toBe(true);
    expect(report).toMatchObject({ contacts: 5, added: 2, updated: 2, removed: 0, unsynced: 0, finished: true });
  });

  test("a row that is fine is left alone: no write to Resend", async () => {
    await ensureSegments(deps());
    const c = fake.add("korras@example.test", { segments: [ET()] });
    await sub("korras@example.test", { syncedAt: at(-10), resendContactId: c.id });
    fake.calls.length = 0;
    expect(await fullSync(deps())).toMatchObject({ contacts: 1, added: 0, updated: 0, removed: 0, unsynced: 0, finished: true });
    expect(fake.writes()).toEqual([]);
  });

  test("Review Focus 4: Resend refuses a new contact for the plan's limit: the sync stops adding, counts the rest as unsynced, and still updates the others", async () => {
    await ensureSegments(deps());
    const old = fake.add("vana@example.test", { segments: [RU()] });
    await sub("vana@example.test", { locale: "et", syncedAt: null, resendContactId: old.id });
    for (const email of ["a@example.test", "b@example.test", "c@example.test"]) await sub(email);
    let created = 0;
    fake.fail.set("contacts.create", () => (created++ >= 1 ? CONTACTS_QUOTA : null));
    const report = await fullSync(deps());
    expect(report).toMatchObject({ added: 1, updated: 1, unsynced: 2, limitReached: true, finished: true });
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(2); // one added, one refused, no third try
    expect([...old.segments]).toEqual([ET()]);
  });

  test("the site stops at the free plan's 1,000 contacts itself (Resend would take more and then refuse every broadcast)", async () => {
    await ensureSegments(deps());
    const emails = Array.from({ length: 1000 }, (_, i) => `s${i}@example.test`);
    const contacts = emails.map((email) => fake.add(email, { segments: [ET()] }));
    await db.insert(subscribers).values(emails.map((email, i) => ({ email, locale: "et", token: `t${i}`, consentAt: at(-60), confirmedAt: at(-60), syncedAt: at(-10), resendContactId: contacts[i].id })));
    for (const [i, c] of contacts.entries()) c.properties.unsubscribe_url = loobu(`t${i}`);
    await sub("uus@example.test");
    const report = await fullSync(deps());
    expect(fake.calls).not.toContain("contacts.create");
    expect(report).toMatchObject({ contacts: 1000, added: 0, unsynced: 1, limitReached: true, finished: true });
    expect(await syncAddress(deps(), "uus@example.test")).toBe("skipped"); // the address sync keeps to the same limit
  });

  test("contacts without a confirmed row are deleted (an unsubscribe on the site whose own sync failed, a row never confirmed)", async () => {
    await ensureSegments(deps());
    fake.add("loobunud@example.test", { segments: [ET()] });
    fake.add("pending@example.test", { segments: [ET()] });
    await sub("pending@example.test", { confirmedAt: null });
    const report = await fullSync(deps());
    expect(fake.contacts.size).toBe(0);
    expect(report).toMatchObject({ removed: 2, contacts: 0, finished: true });
    expect(await rowOf("pending@example.test")).toBeDefined(); // the row is the site's: only its contact goes
  });

  test("the suppression list is read into mail_suppressions in lower case (bounce, complaint, other); an address no longer on it is cleared", async () => {
    await sub("kati@example.test");
    await sub("mari@example.test");
    await db.insert(mailSuppressions).values({ email: "vana@example.test", reason: "bounce", since: at(-600) });
    fake.suppressions.push(
      { id: "sup_1", email: "Kati@Example.test", origin: "bounce", source_id: "em_1", created_at: "2026-10-18T08:00:00.000Z" },
      { id: "sup_2", email: "opilane@example.test", origin: "complaint", source_id: "em_2", created_at: "2026-10-17T08:00:00.000Z" },
      { id: "sup_3", email: "kasitsi@example.test", origin: "manual", source_id: null, created_at: "2026-10-16T08:00:00.000Z" },
    );
    const report = await fullSync(deps());
    const rows = await db.select().from(mailSuppressions).orderBy(mailSuppressions.email);
    expect(rows.map((r) => [r.email, r.reason, r.since.toISOString(), r.clearedAt?.toISOString() ?? null])).toEqual([
      ["kasitsi@example.test", "other", "2026-10-16T08:00:00.000Z", null],
      ["kati@example.test", "bounce", "2026-10-18T08:00:00.000Z", null],
      ["opilane@example.test", "complaint", "2026-10-17T08:00:00.000Z", null],
      ["vana@example.test", "bounce", at(-600).toISOString(), NOW.toISOString()],
    ]);
    expect(report.suppressed).toBe(1); // one subscriber is blocked (kati); the student who never subscribed is marked too, for her drawer
    expect([...(await suppressedAddresses(db, ["KATI@example.test", "mari@example.test", "vana@example.test", "opilane@example.test"]))].sort()).toEqual([
      "kati@example.test",
      "opilane@example.test",
    ]);
    expect(await suppressedAddresses(db, [])).toEqual(new Set());
  });

  test("the suppression list unavailable: the rest of the sync goes on", async () => {
    await sub("kati@example.test");
    fake.fail.set("suppressions.list", DOWN);
    expect(await fullSync(deps())).toMatchObject({ added: 1, unsynced: 0, finished: true });
  });

  test("the time budget: no new call after it, a clean stop with finished false and the rest counted; the next run finishes", async () => {
    await ensureSegments(deps());
    for (const email of ["a@example.test", "b@example.test", "c@example.test", "d@example.test", "e@example.test"]) await sub(email);
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
    const c = fake.add("kati@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.test", { syncedAt: at(-30), resendContactId: c.id });
    fake.fail.set("contacts.list", DOWN);
    await expect(fullSync(deps())).rejects.toBeInstanceOf(MarketingUnavailable);
    expect(await rowOf("kati@example.test")).toBeDefined();
    expect(fake.contacts.size).toBe(1);
  });

  test("the log line has counts only, never an address", async () => {
    await sub("kati@example.test");
    fake.add("vana@example.test");
    await fullSync(deps());
    expect(logged()).toMatch(/\[newsletter-sync\] full sync: 1 contacts, 1 added, 0 updated, 1 removed/);
    expect(logged()).not.toContain("@");
  });
});

describe("contactCount", () => {
  test("Resend's own count of the contacts; counted from the list when that is not answered; null when Resend cannot be reached", async () => {
    fake.add("a@example.test");
    fake.add("b@example.test");
    expect(await contactCount(deps())).toBe(2);
    fake.fail.set("usage.get", DOWN);
    expect(await contactCount(deps())).toBe(2);
    fake.fail.set("contacts.list", DOWN);
    expect(await contactCount(deps())).toBeNull();
  });
});

describe("each change to a subscriber row syncs that address after its commit, best effort", () => {
  const formEnv = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE });
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
    expect(await signUp(d, "kati@example.test", "ru")).toEqual({ ok: true });
    expect(fake.contacts.size).toBe(0); // not before the answer
    await flush();
    expect([...fake.of("kati@example.test")!.segments]).toEqual([RU()]);
    expect((await rowOf("kati@example.test")).syncedAt).toEqual(NOW);
  });

  test("a failed sync never fails the sign-up: the answer is the same, the row is stored with its 'not synced' mark", async () => {
    fake.fail.set("contacts.create", DOWN);
    const { d, flush } = formDeps(hook());
    expect(await signUp(d, "kati@example.test")).toEqual({ ok: true });
    await flush();
    expect(await rowOf("kati@example.test")).toMatchObject({ confirmedAt: NOW, syncedAt: null });
    const throwing = formDeps(async () => {
      throw new Error("the hook itself broke");
    });
    expect(await signUp(throwing.d, "mari@example.test")).toEqual({ ok: true });
    await expect(throwing.flush()).resolves.toBeDefined();
  });

  test("signing up again is a fresh consent (D3): a confirmed row is marked for the sync, and a Resend-side unsubscribe is undone", async () => {
    await ensureSegments(deps());
    const c = fake.add("kati@example.test", { unsubscribed: true, segments: [ET()] });
    await sub("kati@example.test", { syncedAt: at(-30), resendContactId: c.id }); // the webhook of her unsubscribe was lost
    const { d, flush } = formDeps(hook());
    expect(await signUp(d, "kati@example.test")).toEqual({ ok: true });
    expect((await rowOf("kati@example.test")).syncedAt).toBeNull();
    await flush();
    expect(c.unsubscribed).toBe(false);
    expect((await rowOf("kati@example.test")).syncedAt).toEqual(NOW);
  });

  test("the registration forms' box (subscribeLater): synced in the same work after the answer", async () => {
    const { d } = formDeps(hook());
    await subscribeLater(d, "register", { email: "kati@example.test", locale: "et" });
    expect(fake.of("kati@example.test")).toBeDefined();
  });

  test("the site's unsubscribe button: the row goes, then her contact", async () => {
    const row = await sub("kati@example.test", { token: "u".repeat(43) }); // a token of newToken()'s shape
    await syncAddress(deps(), "kati@example.test");
    const gone: string[] = [];
    expect(await unsubscribeByToken(db, fakeKv(), row.token, (email) => void gone.push(email))).toEqual({ locale: "et" });
    expect(gone).toEqual(["kati@example.test"]);
    await hook()(gone[0]);
    expect(fake.contacts.size).toBe(0);
    expect(await unsubscribeByToken(db, fakeKv(), row.token, (email) => void gone.push(email))).toBeNull(); // pressed twice: nothing to tell
    expect(gone).toHaveLength(1);
  });

  test("the old confirmation link: the first confirmation syncs her, a second click does not", async () => {
    const row = await sub("kati@example.test", { confirmedAt: null, token: "c".repeat(43) });
    const tasks: (() => Promise<unknown>)[] = [];
    const confirm = () =>
      confirmNewsletter({ db, env: { KV: fakeKv(), MAIL_FROM: "x", MARIA_EMAIL: "", SITE_URL: SITE }, now: NOW, siteUrl: SITE, later: (t) => void tasks.push(t), newsletterSync: hook() }, row.token);
    expect((await confirm()).outcome).toBe("kinnitatud");
    await Promise.all(tasks.splice(0).map((t) => t()));
    expect(fake.of("kati@example.test")).toBeDefined();
    fake.calls.length = 0;
    await confirm();
    await Promise.all(tasks.splice(0).map((t) => t()));
    expect(fake.calls).toEqual([]);
  });

  test("„Minu andmed“: the newsletter switch on syncs her (a fresh consent: marked unsynced first), off deletes her contact", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", locale: "ru" }).returning();
    const told: string[] = [];
    expect(await setNewsletter(db, kati.id, true, NOW, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.test"]);
    await hook()("kati@example.test");
    expect([...fake.of("kati@example.test")!.segments]).toEqual([RU()]);
    await setNewsletter(db, kati.id, true, NOW, (email) => void told.push(email)); // on again: a fresh consent
    expect((await rowOf("kati@example.test")).syncedAt).toBeNull();
    expect(await setNewsletter(db, kati.id, false, NOW, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.test", "kati@example.test", "kati@example.test"]);
    await hook()("kati@example.test");
    expect(fake.contacts.size).toBe(0);
    await setNewsletter(db, kati.id, false, NOW, (email) => void told.push(email)); // nothing to delete: nothing to tell
    expect(told).toHaveLength(3);
  });

  test("„Minu andmed“: a change of language moves her linked row's language, marks it unsynced, and the sync moves her segment; the same language tells nothing", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", locale: "et" }).returning();
    await sub("kati@example.test", { clientId: kati.id });
    await syncAddress(deps(), "kati@example.test");
    const told: string[] = [];
    expect(await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "et" }, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual([]);
    expect(await updateProfile(db, kati.id, { name: "Kati", phone: "", locale: "ru" }, (email) => void told.push(email))).toBe(true);
    expect(told).toEqual(["kati@example.test"]);
    expect(await rowOf("kati@example.test")).toMatchObject({ locale: "ru", syncedAt: null });
    await hook()("kati@example.test");
    expect([...fake.of("kati@example.test")!.segments]).toEqual([RU()]);
  });

  test("a deleted account: told once the deletion has committed, and her contact is deleted", async () => {
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", locale: "et" }).returning();
    await sub("kati@example.test", { clientId: kati.id });
    await syncAddress(deps(), "kati@example.test");
    const told: string[] = [];
    expect(await deleteClient(db, kati.id, (email) => void told.push(email))).toMatchObject({ email: "kati@example.test" });
    expect(told).toEqual(["kati@example.test"]);
    await hook()(told[0]);
    expect(fake.contacts.size).toBe(0);
    const [mari] = await db.insert(clients).values({ email: "mari@example.test", locale: "et" }).returning();
    await deleteClient(db, mari.id, (email) => void told.push(email)); // no subscription: nothing to tell
    expect(told).toHaveLength(1);
  });

  test("the account API wires the three: PATCH /andmed, POST /uudiskiri and POST /kustuta sync after the answer", async () => {
    const tasks: (() => Promise<unknown>)[] = [];
    const accountDeps: AccountDeps = {
      db,
      env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
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
    const login = await (await call("/login", { email: "kati@example.test", locale: "et" })).json();
    const signedIn = await call("/code", { email: "kati@example.test", code: login.devCode });
    const cookie = signedIn.headers.getSetCookie().find((c) => c.startsWith("__Host-mslab_client="))!.split(";")[0];
    await flush();

    expect((await call("/uudiskiri", { on: true }, cookie)).status).toBe(200);
    expect(fake.contacts.size).toBe(0);
    await flush();
    expect([...fake.of("kati@example.test")!.segments]).toEqual([ET()]);

    expect((await call("/andmed", { name: "Kati", phone: "", locale: "ru" }, cookie, "PATCH")).status).toBe(200);
    await flush();
    expect([...fake.of("kati@example.test")!.segments]).toEqual([RU()]);

    expect((await call("/kustuta", { confirm: true }, cookie)).status).toBe(200);
    await flush();
    expect(fake.contacts.size).toBe(0);
  });
});

describe("the real SDK behind ResendLike", () => {
  test("syncAddress with the resend package itself (fetch stubbed): the documented endpoints, the key, an address a path cannot hold encoded", async () => {
    await sub("a/b?c@example.test");
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
    const outcome = await syncAddress({ db, env: marketingEnv(), siteUrl: SITE, now: NOW, gapMs: 0 }, "a/b?c@example.test");
    expect(outcome).toBe("synced");
    expect(f.calls.every((c) => c.url.startsWith("https://api.resend.com/"))).toBe(true);
    expect(f.calls.every((c) => c.headers.get("authorization") === "Bearer re_marketing_test")).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.url.slice("https://api.resend.com".length)}`)).toEqual([
      "GET /segments?limit=100",
      "POST /segments",
      "POST /segments",
      "GET /contact-properties?limit=100",
      "POST /contact-properties",
      "GET /contacts/a%2Fb%3Fc@example.test",
      "POST /contacts",
    ]);
    expect(f.calls[4].body).toEqual({ key: "unsubscribe_url", type: "string" });
    const row = await rowOf("a/b?c@example.test");
    expect(f.calls[6].body).toEqual({ email: "a/b?c@example.test", unsubscribed: false, properties: { unsubscribe_url: loobu(row.token) }, segments: [{ id: "seg-et" }] });
    expect(row).toMatchObject({ syncedAt: NOW, resendContactId: "ct-1" });
  });
});

describe("the daily cron", () => {
  test("with a marketing key the sweep runs the full sync within its budget and answers its report; Resend failing is reported, not a 500", async () => {
    const { GET } = await import("@/app/api/cron/sweep/route");
    for (const name of ["MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER"]) vi.stubEnv(name, "");
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789");
    vi.stubEnv("RESEND_MARKETING_KEY", "re_marketing_test");
    // the segments were set up before (each call waits the 600 ms between Resend calls here: the fewer, the shorter the test)
    await db.insert(settings).values({ key: SEGMENTS_SETTING, value: { et: "seg-et", ru: "seg-ru", property: "prop-1" } });
    const empty = () => Response.json({ object: "list", data: [], has_more: false });
    stubFetch((url, init) => {
      if ((init?.method ?? "GET") === "GET") return empty();
      if (url.endsWith("/segments")) return Response.json({ object: "segment", id: `seg-${Math.random()}`, name: "x" });
      return Response.json({ object: "contact_property", id: "prop-1" });
    });
    const call = () => GET(new Request("https://mslab.example/api/cron/sweep", { headers: { authorization: "Bearer cron-secret-for-tests-0123456789" } }));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).newsletter).toEqual({ contacts: 0, added: 0, updated: 0, removed: 0, unsubscribedPulled: 0, suppressed: 0, unsynced: 0, limitReached: false, finished: true });
    stubFetch(() => Response.json({ name: "internal_server_error", message: "down", statusCode: 500 }, { status: 500 }));
    const failed = await call();
    expect(failed.status).toBe(200);
    expect((await failed.json()).newsletter).toEqual({ error: "unavailable" });
  });
});

