import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { newsletterCampaigns } from "@/db/schema";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";
import { copyCampaign, listCampaigns, saveCampaign } from "@/server/newsletter-campaigns";
import { makeTestDb } from "./helpers";

// Maria's newsletter campaigns on a real (PGlite) database (newsletter campaigns, Task 4; spec D4, D5): a draft is saved through the rules
// (domain/newsletter-campaign.ts) and a sent one never changes; „Kopeeri“ makes a new draft; the list shows the drafts first. The sending half is
// the 20.10 design's (docs/superpowers/specs/2026-10-20-newsletter-simple-design.md); its tests come with it.

const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;

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
/** The same without its Russian subject and text. */
const ET_ONLY = { ...DRAFT, subject: { et: "Sügispakkumine", ru: "" }, body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "" }, preheader: { et: "Eelvaade", ru: "" } };

const rowOf = async (id: number) => (await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)))[0];
async function draft(raw: unknown = DRAFT): Promise<number> {
  const saved = await saveCampaign(db, null, raw, NOW);
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.id;
}

beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  await db.delete(newsletterCampaigns);
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveCampaign: a draft through the rules", () => {
  test("a new draft is stored as the rules give it back (the code in capitals), with its times", async () => {
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
    });
    expect(row.createdAt).toEqual(NOW);
    expect(row.updatedAt).toEqual(NOW);
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
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 0 } }).where(eq(newsletterCampaigns.id, sent));
    await db.update(newsletterCampaigns).set({ status: "sending", recipients: { et: 1, ru: 0 } }).where(eq(newsletterCampaigns.id, sending));
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
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW, recipients: { et: 3, ru: 1 } }).where(eq(newsletterCampaigns.id, id));
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
