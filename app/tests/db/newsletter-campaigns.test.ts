import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { mailSuppressions, newsletterCampaigns, settings, subscribers } from "@/db/schema";
import { CAMPAIGN_LIMITS, RESEND_FREE_CONTACTS } from "@/domain/newsletter-campaign";
import { INVOICE_KEY } from "@/domain/invoice";
import type { Env } from "@/server/notify";
import {
  copyCampaign,
  listCampaigns,
  prepareSend,
  saveCampaign,
  sendCampaign,
  sendTest,
  TEST_SEND_LIMIT,
} from "@/server/newsletter-campaigns";
import {
  ensureSegments,
  fullSync,
  SEGMENT_NAMES,
  SYNC_LEASE_SETTING,
  TEST_SEGMENT_NAME,
  TEST_SEGMENT_SETTING,
  UNSUBSCRIBE_PLACEHOLDER,
  UNSUBSCRIBE_PROPERTY,
  type MarketingDeps,
} from "@/server/resend-marketing";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";
import { DOWN, fakeResend, type FakeError, type FakeResend } from "./resend-fake";

// Maria's newsletter campaigns on a real (PGlite) database, Resend an in-memory fake (newsletter campaigns, Task 4; spec D4–D8, §5; rulings R2, R4,
// R5, R7, R9, R11): a draft is saved through the rules (domain/newsletter-campaign.ts) and a sent one never changes; „Kopeeri“ makes a new draft;
// „Saada proov“ is a real broadcast to a one-contact test segment, with the test link only for an address that is no subscriber, at most 10 an
// hour; „Saada kõigile“ runs the full sync first (under the same lease), refuses while a subscriber is left unsynced for any reason but the plan's
// limit, writes `sending` before the first broadcast, makes one broadcast per segment that has subscribers, and records what went. Two presses send
// once (Review Focus 3), the Russian subscribers get the Estonian text under their own footer when the Russian one is missing (Review Focus 5), and
// nothing is ever sent twice by itself. The real API is never called.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const loobu = (token: string) => `${SITE}/api/newsletter/loobu?t=${token}`;
const PROOV = `${SITE}/api/newsletter/loobu?proov=1`;
const MARIA = "maria@example.com";
const ADMIN = "admin@example.com";

let db: Db;
let fake: FakeResend;
let kv: ReturnType<typeof fakeKv>;

const marketingEnv = (extra: Partial<Env> = {}): Env => ({
  KV: kv,
  MAIL_FROM: "MS LAB <info@send.example.test>",
  MARIA_EMAIL: MARIA,
  SITE_URL: SITE,
  RESEND_MARKETING_KEY: "re_marketing_test",
  ...extra,
});
const deps = (o: Partial<MarketingDeps> = {}): MarketingDeps => ({ db, env: marketingEnv(), siteUrl: SITE, now: NOW, resend: fake.r, gapMs: 0, ...o });
const offDeps = () => deps({ env: marketingEnv({ RESEND_MARKETING_KEY: "", RESEND_API_KEY: "" }) });

/** Maria's campaign as the editor sends it: both languages, a picture, a code (typed in small letters) and a button. */
const DRAFT = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "−15% kõigile koolitustele", ru: "Скидка 15% на все курсы" },
  imageKey: "img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
  body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац.\n\nВторой абзац." },
  code: "sugis15",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
};
/** The same without its Russian subject and text: Russian subscribers get the Estonian mail (Review Focus 5). */
const ET_ONLY = { ...DRAFT, subject: { et: "Sügispakkumine", ru: "" }, body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "" }, preheader: { et: "Eelvaade", ru: "" } };

let n = 0;
/** A subscriber row; confirmed an hour before NOW unless told otherwise (unsynced: the send's own sync makes her contact). */
async function sub(email: string, o: Partial<typeof subscribers.$inferInsert> = {}) {
  const [row] = await db
    .insert(subscribers)
    .values({ email, locale: "et", token: `tok${++n}`, consentAt: at(-60), confirmedAt: at(-60), ...o })
    .returning();
  return row;
}
const rowOf = async (id: number) => (await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)))[0];
async function draft(raw: unknown = DRAFT): Promise<number> {
  const saved = await saveCampaign(db, null, raw, NOW);
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.id;
}
const ET = () => fake.segment(SEGMENT_NAMES.et)!;
const RU = () => fake.segment(SEGMENT_NAMES.ru)!;
const TEST = () => fake.segment(TEST_SEGMENT_NAME)!;
/** Holds the sync's lease as another sync would. */
const holdLease = () => setSetting(db, SYNC_LEASE_SETTING, { holder: "another", until: Date.now() + 60_000 });
/** Every line logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

const REFUSED: FakeError = { name: "validation_error", statusCode: 422, message: "The html field is invalid" };
const NO_ANSWER: FakeError = { name: "application_error", statusCode: null, message: "Unable to fetch data. The request could not be resolved." };
const RESTRICTED: FakeError = { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" };

beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  for (const table of [newsletterCampaigns, subscribers, mailSuppressions, settings]) await db.delete(table);
  fake = fakeResend();
  kv = fakeKv();
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveCampaign: a draft through the rules", () => {
  test("a new draft is stored as the rules give it back (the code in capitals), with its times; nothing is asked of Resend", async () => {
    const saved = await saveCampaign(db, null, DRAFT, NOW);
    expect(saved).toEqual({ ok: true, id: expect.any(Number) });
    const row = await rowOf((saved as { id: number }).id);
    expect(row).toMatchObject({
      name: "Oktoobri pakkumine",
      subject: DRAFT.subject,
      preheader: DRAFT.preheader,
      imageKey: DRAFT.imageKey,
      body: DRAFT.body,
      code: "SUGIS15",
      buttonLabel: DRAFT.buttonLabel,
      buttonHref: "/koolitused",
      status: "draft",
      sentAt: null,
      recipients: null,
      broadcasts: null,
    });
    expect(row.createdAt).toEqual(NOW);
    expect(row.updatedAt).toEqual(NOW);
    expect(fake.calls).toEqual([]);
  });

  test("a refused draft names its fields and stores nothing; a Russian text with a button needs the Russian label (ruling R2)", async () => {
    expect(await saveCampaign(db, null, { ...DRAFT, name: "", subject: { et: "", ru: "" } }, NOW)).toEqual({ ok: false, fields: { name: "required", "subject.et": "required" } });
    expect(await saveCampaign(db, null, { ...DRAFT, buttonLabel: { et: "Vaata", ru: "" } }, NOW)).toEqual({ ok: false, fields: { "buttonLabel.ru": "ruLabel" } });
    expect(await saveCampaign(db, null, { ...DRAFT, name: "x".repeat(CAMPAIGN_LIMITS.name + 1) }, NOW)).toEqual({ ok: false, fields: { name: "tooLong" } });
    expect(await saveCampaign(db, null, "not a form", NOW)).toEqual({ ok: false, fields: { form: "invalid" } });
    expect(await db.select().from(newsletterCampaigns)).toEqual([]);
  });

  test("the rules' own output, as the editor sends it after its check (nulls for no picture, code or button), is taken as it is", async () => {
    const plain = { ...ET_ONLY, imageKey: "", code: "", buttonLabel: { et: "", ru: "" }, buttonHref: "" };
    const first = await saveCampaign(db, null, plain, NOW);
    const row = await rowOf((first as { id: number }).id);
    const asSent = { name: row.name, subject: row.subject, preheader: row.preheader, imageKey: row.imageKey, body: row.body, code: row.code, buttonLabel: row.buttonLabel, buttonHref: row.buttonHref };
    expect(asSent).toMatchObject({ imageKey: null, code: null, buttonLabel: null, buttonHref: null });
    expect(await saveCampaign(db, row.id, asSent, at(1))).toEqual({ ok: true, id: row.id });
    expect(await rowOf(row.id)).toMatchObject({ ...asSent, updatedAt: at(1) });
  });

  test("a draft is saved again in place, with the new time; another campaign is not touched", async () => {
    const id = await draft();
    const other = await draft({ ...DRAFT, name: "Teine" });
    expect(await saveCampaign(db, id, { ...DRAFT, name: "Novembri pakkumine", code: "" }, at(5))).toEqual({ ok: true, id });
    expect(await rowOf(id)).toMatchObject({ name: "Novembri pakkumine", code: null, createdAt: NOW, updatedAt: at(5) });
    expect(await rowOf(other)).toMatchObject({ name: "Teine", updatedAt: NOW });
  });

  test("a campaign that is sent, or being sent, never changes (frozen once sent): `sent`; one that is not there is `notFound`", async () => {
    const sent = await draft();
    const sending = await draft();
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 0 }, broadcasts: { et: "bc_1" } }).where(eq(newsletterCampaigns.id, sent));
    await db.update(newsletterCampaigns).set({ status: "sending", recipients: { et: 1, ru: 0 }, broadcasts: {} }).where(eq(newsletterCampaigns.id, sending));
    const before = [await rowOf(sent), await rowOf(sending)];
    expect(await saveCampaign(db, sent, { ...DRAFT, name: "Muudetud" }, at(5))).toEqual({ ok: false, error: "sent" });
    expect(await saveCampaign(db, sending, { ...DRAFT, name: "Muudetud" }, at(5))).toEqual({ ok: false, error: "sent" });
    expect([await rowOf(sent), await rowOf(sending)]).toEqual(before);
    expect(await saveCampaign(db, 999_999, DRAFT, at(5))).toEqual({ ok: false, error: "notFound" });
  });

  test("a refused draft of a sent campaign answers its fields first: nothing is stored either way", async () => {
    const sent = await draft();
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, sent));
    expect(await saveCampaign(db, sent, { ...DRAFT, name: "" }, at(5))).toEqual({ ok: false, fields: { name: "required" } });
  });
});

describe("copyCampaign: „Kopeeri“", () => {
  test("a sent campaign gives a new draft with the same content and „(koopia)“ after its name; the sent one stays as it was", async () => {
    const id = await draft();
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW, recipients: { et: 3, ru: 1 }, broadcasts: { et: "bc_1", ru: "bc_2" } }).where(eq(newsletterCampaigns.id, id));
    const before = await rowOf(id);
    const copied = await copyCampaign(db, id, at(10));
    expect(copied).toEqual({ ok: true, id: expect.any(Number) });
    const copy = await rowOf((copied as { id: number }).id);
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({
      name: "Oktoobri pakkumine (koopia)",
      subject: before.subject,
      preheader: before.preheader,
      imageKey: before.imageKey,
      body: before.body,
      code: before.code,
      buttonLabel: before.buttonLabel,
      buttonHref: before.buttonHref,
      status: "draft",
      sentAt: null,
      recipients: null,
      broadcasts: null,
      createdAt: at(10),
      updatedAt: at(10),
    });
    expect(await rowOf(id)).toEqual(before);
  });

  test("a long name is cut so that the copy's name keeps to its limit; a campaign that is not there gives no copy", async () => {
    const id = await draft({ ...DRAFT, name: "N".repeat(CAMPAIGN_LIMITS.name) });
    const copied = await copyCampaign(db, id, NOW);
    const copy = await rowOf((copied as { id: number }).id);
    expect(copy.name.length).toBe(CAMPAIGN_LIMITS.name);
    expect(copy.name.endsWith(" (koopia)")).toBe(true);
    expect(await copyCampaign(db, 999_999, NOW)).toEqual({ ok: false });
  });
});

describe("listCampaigns: the tab's list", () => {
  test("drafts first (the last changed first), then the sent ones and the one being sent, the newest send first", async () => {
    const old = await draft({ ...DRAFT, name: "Vana mustand" });
    const fresh = await draft({ ...DRAFT, name: "Uus mustand" });
    await db.update(newsletterCampaigns).set({ updatedAt: at(-60) }).where(eq(newsletterCampaigns.id, old));
    const sentEarly = await draft({ ...DRAFT, name: "Saadetud ammu" });
    const sentLate = await draft({ ...DRAFT, name: "Saadetud hiljuti" });
    const sending = await draft({ ...DRAFT, name: "Pooleli" });
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: at(-600) }).where(eq(newsletterCampaigns.id, sentEarly));
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: at(-30) }).where(eq(newsletterCampaigns.id, sentLate));
    await db.update(newsletterCampaigns).set({ status: "sending", updatedAt: at(-120) }).where(eq(newsletterCampaigns.id, sending));
    expect((await listCampaigns(db)).map((c) => c.id)).toEqual([fresh, old, sentLate, sending, sentEarly]);
  });
});

describe("sendTest: „Saada proov“ as a broadcast to the test segment (rulings R4, R7)", () => {
  test("without the newsletter's key: `notConfigured`, and nothing is asked of Resend or counted", async () => {
    const id = await draft();
    expect(await sendTest(offDeps(), id, MARIA)).toEqual({ ok: false, error: "notConfigured" });
    expect(fake.calls).toEqual([]);
    expect([...kv.store.keys()]).toEqual([]);
  });

  test("a campaign that is not there: `notFound`", async () => {
    expect(await sendTest(deps(), 999_999, MARIA)).toEqual({ ok: false, error: "notFound" });
    expect(fake.calls).toEqual([]);
  });

  test("an address that is no subscriber: the segment „MS LAB uudiskiri (proov)“ is made and stored, holds her alone, with the test link; one broadcast goes to it, exactly the real mail but for „[Proov]“", async () => {
    const id = await draft();
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: true, realLink: false });
    expect(TEST()).toBeDefined();
    expect(await db.select().from(settings).where(eq(settings.key, TEST_SEGMENT_SETTING))).toEqual([{ key: TEST_SEGMENT_SETTING, value: { id: TEST() } }]);
    const contact = fake.of(MARIA)!;
    expect(contact.properties[UNSUBSCRIBE_PROPERTY]).toBe(PROOV);
    expect(contact.unsubscribed).toBe(false);
    expect([...contact.segments]).toEqual([TEST()]);
    expect(fake.broadcasts).toHaveLength(1);
    const [b] = fake.broadcasts;
    expect(b.args).toEqual({
      segmentId: TEST(),
      from: "MS LAB <info@send.example.test>",
      replyTo: MARIA,
      subject: "[Proov] Sügispakkumine",
      html: expect.any(String),
      text: expect.any(String),
      name: "[Proov] Oktoobri pakkumine (ET)",
      send: true,
    });
    // the placeholder itself goes to Resend (as in the real send), and Resend fills in her test link
    expect(b.args.html).toContain(`href="${UNSUBSCRIBE_PLACEHOLDER}"`);
    expect(b.args.text).toContain(UNSUBSCRIBE_PLACEHOLDER);
    expect(b.delivered).toEqual([{ email: MARIA, html: expect.stringContaining(`href="${PROOV}"`), text: expect.stringContaining(PROOV) }]);
    expect(b.args.html).toContain("Esimene lõik.");
    expect(b.args.html).toContain(`${SITE}/media/img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg`);
    expect(b.args.html).toContain(`${SITE}/brand/logo.png`);
    expect(b.args.html).toContain("SUGIS15");
    expect(b.args.html).toContain(`${SITE}/koolitused`);
  });

  test("the test's HTML is the real send's HTML: only the subject (its <title>) has „[Proov]“", async () => {
    const id = await draft();
    await sub("kati@example.com");
    expect(await sendTest(deps(), id, MARIA)).toMatchObject({ ok: true });
    expect(await sendCampaign(deps(), id)).toMatchObject({ ok: true });
    const [test, real] = fake.broadcasts;
    expect(real.args.segmentId).toBe(ET());
    expect(test.args.html).not.toBe(real.args.html);
    expect(test.args.html.replace("<title>[Proov] ", "<title>")).toBe(real.args.html);
    expect(test.args.text).toBe(real.args.text);
  });

  test("in Russian: the Russian text and footer, and the subject with „[Proov]“", async () => {
    const id = await draft();
    expect(await sendTest(deps(), id, MARIA, "ru")).toEqual({ ok: true, realLink: false });
    const [b] = fake.broadcasts;
    expect(b.args.subject).toBe("[Proov] Осеннее предложение");
    expect(b.args.name).toBe("[Proov] Oktoobri pakkumine (RU)");
    expect(b.args.html).toContain("Первый абзац.");
    expect(b.args.html).toContain("Отписаться от рассылки");
  });

  test("the previous test contact leaves the segment before the next joins it: Maria's, then the admin's; Maria's contact is not deleted", async () => {
    const id = await draft();
    await sendTest(deps(), id, MARIA);
    fake.calls.length = 0;
    expect(await sendTest(deps(), id, ADMIN)).toEqual({ ok: true, realLink: false });
    expect(fake.of(MARIA)).toBeDefined();
    expect([...fake.of(MARIA)!.segments]).toEqual([]);
    expect([...fake.of(ADMIN)!.segments]).toEqual([TEST()]);
    expect(fake.calls.indexOf("contacts.segments.remove")).toBeLessThan(fake.calls.indexOf("contacts.create"));
    expect(fake.broadcasts[1].delivered.map((d) => d.email)).toEqual([ADMIN]);
    // the segment was made once
    expect(fake.segments.filter((s) => s.name === TEST_SEGMENT_NAME)).toHaveLength(1);
  });

  test("an address that is no subscriber and already a contact (one-click unsubscribed in an earlier test): the test link again, and subscribed for this test", async () => {
    const id = await draft();
    fake.add(MARIA, { unsubscribed: true, properties: {} });
    await ensureSegments(deps());
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: true, realLink: false });
    expect(fake.of(MARIA)).toMatchObject({ unsubscribed: false, properties: { [UNSUBSCRIBE_PROPERTY]: PROOV } });
    expect(fake.broadcasts[0].delivered.map((d) => d.email)).toEqual([MARIA]);
  });

  test("a subscriber's address (ruling R7): her real link stays, she stays in her own segment, and the answer says so", async () => {
    const id = await draft();
    const maria = await sub(MARIA);
    await fullSync(deps());
    expect(fake.of(MARIA)!.properties[UNSUBSCRIBE_PROPERTY]).toBe(loobu(maria.token));
    fake.calls.length = 0;
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: true, realLink: true });
    expect(fake.calls).not.toContain("contacts.update");
    expect(fake.of(MARIA)!.properties[UNSUBSCRIBE_PROPERTY]).toBe(loobu(maria.token));
    expect([...fake.of(MARIA)!.segments].sort()).toEqual([ET(), TEST()].sort());
    expect(fake.broadcasts[0].delivered).toEqual([{ email: MARIA, html: expect.stringContaining(`href="${loobu(maria.token)}"`), text: expect.any(String) }]);
  });

  test("a subscriber whose contact the sync has not made yet: her contact is made with her real link", async () => {
    const id = await draft();
    const maria = await sub("Maria@Example.com");
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: true, realLink: true });
    expect(fake.of(MARIA)!.properties[UNSUBSCRIBE_PROPERTY]).toBe(loobu(maria.token));
  });

  test("the full sync afterwards leaves the test contact alone (it is in no segment of ours)", async () => {
    const id = await draft();
    await sendTest(deps(), id, MARIA);
    await sub("kati@example.com");
    const report = await fullSync(deps());
    expect(report.removed).toBe(0);
    expect(fake.of(MARIA)).toMatchObject({ properties: { [UNSUBSCRIBE_PROPERTY]: PROOV } });
    expect([...fake.of(MARIA)!.segments]).toEqual([TEST()]);
  });

  test(`at most ${10} an hour: the 11th is \`limited\` and asks nothing of Resend; the next hour may send again`, async () => {
    expect(TEST_SEND_LIMIT).toBe(10);
    const id = await draft();
    for (let i = 0; i < 10; i++) expect(await sendTest(deps(), id, MARIA)).toMatchObject({ ok: true });
    fake.calls.length = 0;
    expect(await sendTest(deps({ now: at(59) }), id, MARIA)).toEqual({ ok: false, error: "limited" });
    expect(fake.calls).toEqual([]);
    expect(fake.broadcasts).toHaveLength(10);
    expect(await sendTest(deps({ now: at(60) }), id, MARIA)).toMatchObject({ ok: true });
  });

  test("a test that failed does not count against the hour", async () => {
    const id = await draft();
    fake.fail.set("broadcasts.create", DOWN);
    for (let i = 0; i < 12; i++) expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: false, error: "unavailable" });
    fake.fail.clear();
    expect(await sendTest(deps(), id, MARIA)).toMatchObject({ ok: true });
  });

  test("another sync, send or test holds the lease: `busy`, nothing asked of Resend, the lease left as it was", async () => {
    const id = await draft();
    await holdLease();
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: false, error: "busy" });
    expect(fake.calls).toEqual([]);
    expect((await db.select().from(settings).where(eq(settings.key, SYNC_LEASE_SETTING)))[0].value).toMatchObject({ holder: "another" });
  });

  test("Resend down: `unavailable`; the key that can only send: `permission`; nothing sent; logged without an address", async () => {
    const id = await draft();
    fake.fail.set("segments.list", DOWN);
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: false, error: "unavailable" });
    fake.fail.set("segments.list", RESTRICTED);
    expect(await sendTest(deps(), id, MARIA)).toEqual({ ok: false, error: "permission" });
    expect(fake.broadcasts).toEqual([]);
    expect(logged()).not.toContain("maria@");
    expect(await db.select().from(settings).where(eq(settings.key, SYNC_LEASE_SETTING))).toEqual([]); // released
  });

  test("a test segment deleted in Resend's dashboard is made again", async () => {
    const id = await draft();
    await sendTest(deps(), id, MARIA);
    const gone = TEST();
    fake.segments.splice(fake.segments.findIndex((s) => s.id === gone), 1);
    for (const c of fake.contacts.values()) c.segments.delete(gone);
    fake.fail.set("contacts.list", (args) => ((args as { segmentId?: string }).segmentId === gone ? { name: "not_found", statusCode: 404, message: "Segment not found" } : null));
    expect(await sendTest(deps(), id, MARIA)).toMatchObject({ ok: true });
    expect(TEST()).not.toBe(gone);
    expect((await db.select().from(settings).where(eq(settings.key, TEST_SEGMENT_SETTING)))[0].value).toEqual({ id: TEST() });
    expect(fake.broadcasts[1].args.segmentId).toBe(TEST());
  });

  test("the test never goes to a subscriber of the newsletter's segments: only to the test segment", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await fullSync(deps());
    await sendTest(deps(), id, MARIA);
    expect(fake.broadcasts.map((b) => b.args.segmentId)).toEqual([TEST()]);
    expect(fake.broadcasts[0].delivered.map((d) => d.email)).toEqual([MARIA]);
  });
});

describe("prepareSend: the sync, then the counts the confirmation shows", () => {
  test("without the key: `notConfigured`; a campaign that is not there: `notFound`; one already sent or being sent: `sent`", async () => {
    const id = await draft();
    expect(await prepareSend(offDeps(), id)).toEqual({ ok: false, error: "notConfigured" });
    expect(await prepareSend(deps(), 999_999)).toEqual({ ok: false, error: "notFound" });
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, id));
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "sent" });
    await db.update(newsletterCampaigns).set({ status: "sending" }).where(eq(newsletterCampaigns.id, id));
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "sent" });
    expect(fake.calls).toEqual([]);
  });

  test("the full sync runs, and the plan has the subscribers in Resend by language and the sync's report; nothing is sent", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sub("mari@example.com");
    await sub("olga@example.com", { locale: "ru" });
    await sub("vana@example.com", { confirmedAt: null }); // the old double opt-in, never confirmed: no recipient (D7)
    await sub("naidis@example.test"); // a sample address: never synced, never counted (R6)
    const prepared = await prepareSend(deps(), id);
    expect(prepared).toEqual({
      ok: true,
      plan: { et: 2, ru: 1, ruFallsBack: false, left: 0, report: expect.objectContaining({ added: 3, finished: true, unsynced: 0, failed: 0 }) },
    });
    expect(fake.broadcasts).toEqual([]);
    expect((await rowOf(id)).status).toBe("draft");
  });

  test("a campaign without its Russian text says so in the plan (Review Focus 5)", async () => {
    const id = await draft(ET_ONLY);
    await sub("olga@example.com", { locale: "ru" });
    expect(await prepareSend(deps(), id)).toMatchObject({ ok: true, plan: { et: 0, ru: 1, ruFallsBack: true } });
  });

  test("no subscriber in Resend: `empty`", async () => {
    const id = await draft();
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "empty" });
  });

  test("another sync holds the lease: `busy`; Resend down: `unavailable`; the key that can only send: `permission`", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await holdLease();
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "busy" });
    await db.delete(settings).where(eq(settings.key, SYNC_LEASE_SETTING));
    fake.fail.set("segments.list", DOWN);
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "unavailable" });
    fake.fail.set("segments.list", RESTRICTED);
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "permission" });
  });

  test("a subscriber left unsynced by a failure: `unsynced` (Review Focus 2)", async () => {
    const id = await draft();
    await sub("kati@example.com");
    fake.fail.set("contacts.create", DOWN);
    expect(await prepareSend(deps(), id)).toEqual({ ok: false, error: "unsynced" });
  });

  test("the plan's contacts used up (ruling R5): not refused; the plan counts those left out", async () => {
    const id = await draft();
    await ensureSegments(deps());
    for (let i = 0; i < RESEND_FREE_CONTACTS - 1; i++) fake.add(`muu${i}@example.com`);
    const kati = await sub("kati@example.com", { syncedAt: at(-5) });
    fake.add("kati@example.com", { segments: [ET()], properties: { [UNSUBSCRIBE_PROPERTY]: loobu(kati.token) } });
    await sub("uus@example.com");
    const prepared = await prepareSend(deps(), id);
    expect(prepared).toMatchObject({ ok: true, plan: { et: 1, ru: 0, left: 1, report: { limitReached: true, unsynced: 1, failed: 0, finished: true } } });
  });
});

describe("sendCampaign: „Saada kõigile“", () => {
  test("the sync, then one broadcast per segment that has subscribers, at once, with its language's subject and Resend's placeholder; recorded as sent", async () => {
    const id = await draft();
    const kati = await sub("kati@example.com");
    const olga = await sub("olga@example.com", { locale: "ru" });
    const sent = await sendCampaign(deps(), id);
    expect(sent).toEqual({ ok: true, recipients: { et: 1, ru: 1 }, missing: [], left: 0 });
    expect(fake.broadcasts).toHaveLength(2);
    const [et, ru] = fake.broadcasts;
    expect(et.args).toEqual({
      segmentId: ET(),
      from: "MS LAB <info@send.example.test>",
      replyTo: MARIA,
      subject: "Sügispakkumine",
      html: expect.stringContaining(`href="${UNSUBSCRIBE_PLACEHOLDER}"`),
      text: expect.stringContaining(UNSUBSCRIBE_PLACEHOLDER),
      name: "Oktoobri pakkumine (ET)",
      send: true,
    });
    expect(ru.args).toMatchObject({ segmentId: RU(), subject: "Осеннее предложение", name: "Oktoobri pakkumine (RU)", send: true });
    expect(ru.args.html).toContain("Первый абзац.");
    expect(ru.args.html).toContain("Отписаться от рассылки");
    // each subscriber gets her own unsubscribe link, filled in by Resend from her contact
    expect(et.delivered).toEqual([{ email: "kati@example.com", html: expect.stringContaining(`href="${loobu(kati.token)}"`), text: expect.stringContaining(loobu(kati.token)) }]);
    expect(ru.delivered).toEqual([{ email: "olga@example.com", html: expect.stringContaining(`href="${loobu(olga.token)}"`), text: expect.stringContaining(loobu(olga.token)) }]);
    expect(await rowOf(id)).toMatchObject({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 1 }, broadcasts: { et: et.id, ru: ru.id } });
  });

  test("the broadcasts carry no tracking option (D1), and no address of the site's request: the picture, the logo and the site's paths are on SITE_URL", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sendCampaign(deps(), id);
    const [b] = fake.broadcasts;
    expect(Object.keys(b.args).sort()).toEqual(["from", "html", "name", "replyTo", "segmentId", "send", "subject", "text"]);
    expect(b.args.html).toContain(`src="${SITE}/media/img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg"`);
    expect(b.args.html).toContain(`src="${SITE}/brand/logo.png"`);
    expect(b.args.html).toContain(`href="${SITE}/koolitused"`);
  });

  test("the school's name and address come from Seaded → „Arve andmed“; „MS LAB“ when it is empty", async () => {
    await sub("kati@example.com");
    const first = await draft();
    await sendCampaign(deps(), first);
    expect(fake.broadcasts[0].args.text.split("\n").slice(-1)[0]).toBe("MS LAB");
    await setSetting(db, INVOICE_KEY, { company: "MS LAB Koolituskeskus OÜ", registryCode: "1", address: "Rüütli 1, Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" });
    const second = await draft();
    await sendCampaign(deps(), second);
    expect(fake.broadcasts[1].args.text.split("\n").slice(-2)).toEqual(["MS LAB Koolituskeskus OÜ", "Rüütli 1, Pärnu"]);
  });

  test("only Estonian subscribers: one broadcast, to the Estonian segment", async () => {
    const id = await draft();
    await sub("kati@example.com");
    expect(await sendCampaign(deps(), id)).toEqual({ ok: true, recipients: { et: 1, ru: 0 }, missing: [], left: 0 });
    expect(fake.broadcasts.map((b) => b.args.segmentId)).toEqual([ET()]);
    expect((await rowOf(id)).broadcasts).toEqual({ et: fake.broadcasts[0].id });
  });

  test("Review Focus 5: without the Russian text the Russian subscribers get the Estonian text and subject under their own Russian footer", async () => {
    const id = await draft(ET_ONLY);
    await sub("olga@example.com", { locale: "ru" });
    await sendCampaign(deps(), id);
    const [ru] = fake.broadcasts;
    expect(ru.args.segmentId).toBe(RU());
    expect(ru.args.subject).toBe("Sügispakkumine");
    expect(ru.args.html).toContain("Esimene lõik.");
    expect(ru.args.html).toContain("Отписаться от рассылки");
    expect(ru.args.html).not.toContain("Loobu uudiskirjast");
    expect(ru.args.html).toContain(`${SITE}/ru/koolitused`);
  });

  test("Review Focus 3: a second press answers `sent` and sends nothing, a campaign found `sending` is never sent again by itself", async () => {
    const id = await draft();
    await sub("kati@example.com");
    expect(await sendCampaign(deps(), id)).toMatchObject({ ok: true });
    fake.calls.length = 0;
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "sent" });
    expect(fake.calls).toEqual([]);
    expect(fake.broadcasts).toHaveLength(1);
    const stuck = await draft();
    await db.update(newsletterCampaigns).set({ status: "sending", recipients: { et: 1, ru: 0 }, broadcasts: {} }).where(eq(newsletterCampaigns.id, stuck));
    expect(await sendCampaign(deps(), stuck)).toEqual({ ok: false, error: "sent" });
    expect(fake.broadcasts).toHaveLength(1);
  });

  test("Review Focus 3: two presses at once (two tabs) send once: one sends, the other is `busy`", async () => {
    const id = await draft();
    await sub("kati@example.com");
    const results = await Promise.all([sendCampaign(deps(), id), sendCampaign(deps(), id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "busy" }]);
    expect(fake.broadcasts).toHaveLength(1);
  });

  test("`sending` is written and committed before the first broadcast: no row lock is held across Resend's call", async () => {
    const id = await draft();
    await sub("kati@example.com");
    const statuses: string[] = [];
    const create = fake.r.broadcasts.create;
    fake.r.broadcasts.create = async (o) => {
      statuses.push((await rowOf(id)).status);
      return create(o);
    };
    expect(await sendCampaign(deps(), id)).toMatchObject({ ok: true });
    expect(statuses).toEqual(["sending"]);
  });

  test("an unsubscribe made in Resend before the press is pulled by the sync first: she gets nothing (D3)", async () => {
    const id = await draft();
    const kati = await sub("kati@example.com");
    await sub("mari@example.com");
    await fullSync(deps({ now: at(-30) }));
    fake.of("kati@example.com")!.unsubscribed = true;
    expect(await sendCampaign(deps(), id)).toEqual({ ok: true, recipients: { et: 1, ru: 0 }, missing: [], left: 0 });
    expect(fake.broadcasts[0].delivered.map((d) => d.email)).toEqual(["mari@example.com"]);
    expect(await db.select().from(subscribers).where(eq(subscribers.id, kati.id))).toEqual([]);
  });

  test("a subscriber left unsynced by a failure: `unsynced`, nothing sent, still a draft (Review Focus 2)", async () => {
    const id = await draft();
    await sub("kati@example.com");
    fake.fail.set("contacts.create", DOWN);
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "unsynced" });
    expect(fake.broadcasts).toEqual([]);
    expect((await rowOf(id)).status).toBe("draft");
  });

  test("a contact that must leave our segments and could not: `unsynced` (the sync did not finish)", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await fullSync(deps());
    await db.delete(subscribers);
    await sub("mari@example.com");
    fake.fail.set("contacts.remove", DOWN);
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "unsynced" });
    expect(fake.broadcasts).toEqual([]);
  });

  test("the plan's contacts used up (ruling R5): the send goes to those in Resend, and says how many are not", async () => {
    const id = await draft();
    await ensureSegments(deps());
    for (let i = 0; i < RESEND_FREE_CONTACTS - 1; i++) fake.add(`muu${i}@example.com`);
    const kati = await sub("kati@example.com", { syncedAt: at(-5) });
    fake.add("kati@example.com", { segments: [ET()], properties: { [UNSUBSCRIBE_PROPERTY]: loobu(kati.token) } });
    await sub("uus@example.com");
    expect(await sendCampaign(deps(), id)).toEqual({ ok: true, recipients: { et: 1, ru: 0 }, missing: [], left: 1 });
    expect(fake.broadcasts[0].delivered.map((d) => d.email)).toEqual(["kati@example.com"]);
  });

  test("no subscriber in Resend: `empty`, nothing sent, still a draft", async () => {
    const id = await draft();
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "empty" });
    expect(fake.broadcasts).toEqual([]);
    expect((await rowOf(id)).status).toBe("draft");
  });

  test("without the key, a campaign not there, another sync running, Resend down, the key that can only send: refused, nothing sent", async () => {
    const id = await draft();
    await sub("kati@example.com");
    expect(await sendCampaign(offDeps(), id)).toEqual({ ok: false, error: "notConfigured" });
    expect(await sendCampaign(deps(), 999_999)).toEqual({ ok: false, error: "notFound" });
    await holdLease();
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "busy" });
    await db.delete(settings).where(eq(settings.key, SYNC_LEASE_SETTING));
    fake.fail.set("segments.list", DOWN);
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "unavailable" });
    fake.fail.set("segments.list", RESTRICTED);
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "permission" });
    expect(fake.broadcasts).toEqual([]);
    expect((await rowOf(id)).status).toBe("draft");
  });

  test("the first broadcast refused by Resend (a 4xx): nothing went, the campaign is a draft again, and a later press sends", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sub("olga@example.com", { locale: "ru" });
    fake.fail.set("broadcasts.create", REFUSED);
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "unavailable" });
    expect(fake.calls.filter((c) => c === "broadcasts.create")).toHaveLength(1); // the Russian one is not tried
    expect(await rowOf(id)).toMatchObject({ status: "draft", sentAt: null, recipients: null, broadcasts: null });
    fake.fail.clear();
    expect(await sendCampaign(deps(), id)).toMatchObject({ ok: true, recipients: { et: 1, ru: 1 } });
  });

  test("the first broadcast without an answer (a timeout, a 5xx): it may have gone, so the campaign stays `sending` and is never sent again by itself", async () => {
    for (const error of [NO_ANSWER, DOWN]) {
      const id = await draft();
      await db.delete(subscribers);
      await sub(`kati${error.statusCode ?? "x"}@example.com`);
      fake.fail.set("broadcasts.create", error);
      expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "interrupted" });
      expect(await rowOf(id)).toMatchObject({ status: "sending", sentAt: null, recipients: { et: 1, ru: 0 }, broadcasts: {} });
      fake.fail.clear();
      expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "sent" });
      fake.fail.set("broadcasts.create", error);
    }
    expect(fake.broadcasts).toEqual([]);
  });

  test("partial failure: the Russian broadcast refused after the Estonian one went: sent, with the one that went recorded and the Russian one missing", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sub("olga@example.com", { locale: "ru" });
    fake.fail.set("broadcasts.create", (args) => ((args as { segmentId: string }).segmentId === RU() ? REFUSED : null));
    expect(await sendCampaign(deps(), id)).toEqual({ ok: true, recipients: { et: 1, ru: 0 }, missing: ["ru"], left: 0 });
    expect(fake.broadcasts.map((b) => b.args.segmentId)).toEqual([ET()]);
    expect(await rowOf(id)).toMatchObject({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 1 }, broadcasts: { et: fake.broadcasts[0].id } });
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "sent" });
    expect(fake.broadcasts).toHaveLength(1);
  });

  test("the Russian broadcast without an answer after the Estonian one went: `sending`, the Estonian one recorded, never sent again", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sub("olga@example.com", { locale: "ru" });
    fake.fail.set("broadcasts.create", (args) => ((args as { segmentId: string }).segmentId === RU() ? NO_ANSWER : null));
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "interrupted" });
    expect(await rowOf(id)).toMatchObject({ status: "sending", recipients: { et: 1, ru: 1 }, broadcasts: { et: fake.broadcasts[0].id } });
    fake.fail.clear();
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "sent" });
    expect(fake.broadcasts).toHaveLength(1);
  });

  test("the logs carry ids and counts, never an address or a text of the campaign", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sub("olga@example.com", { locale: "ru" });
    await sendTest(deps(), id, MARIA);
    await sendCampaign(deps(), id);
    const lines = logged();
    expect(lines).toContain(`campaign ${id}`);
    for (const secret of ["@example.com", "Sügispakkumine", "Oktoobri pakkumine", "Esimene lõik", "loobu?t="]) expect(lines, secret).not.toContain(secret);
  });

  test("a sent campaign stays frozen after the send: saving it is refused", async () => {
    const id = await draft();
    await sub("kati@example.com");
    await sendCampaign(deps(), id);
    expect(await saveCampaign(db, id, { ...DRAFT, name: "Muudetud" }, at(5))).toEqual({ ok: false, error: "sent" });
    expect((await rowOf(id)).name).toBe("Oktoobri pakkumine");
  });

  test("a sample address is never counted nor sent to, in any case (R6): a list of sample rows alone is `empty`", async () => {
    const id = await draft();
    await sub("Naidis@Example.TEST", { syncedAt: at(-5), resendContactId: "ct_x" });
    expect(await sendCampaign(deps(), id)).toEqual({ ok: false, error: "empty" });
    expect(fake.broadcasts).toEqual([]);
  });
});
