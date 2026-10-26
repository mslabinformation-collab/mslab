import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { newsletterCampaigns } from "@/db/schema";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";
import { adminEt } from "@/i18n/dict/admin";
import {
  copyCampaign,
  createDraft,
  deleteDraft,
  listCampaigns,
  prepareSend,
  readCampaign,
  saveCampaign,
  sendCountNow,
  sendCountsNow,
  writeCampaign,
} from "@/server/newsletter-campaigns";
import { subscribers } from "@/db/schema";
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
  await db.delete(subscribers);
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
    // (an empty subject is no refusal of a save any more, ruling R-g: only the name is required to save)
    expect(await saveCampaign(db, null, { ...DRAFT, name: "", subject: { et: "", ru: "" } }, NOW)).toEqual({ ok: false, fields: { name: "required" } });
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
    // (the same content again: nothing changed, so `updatedAt` stays, spec C4)
    expect(await rowOf(row.id)).toMatchObject({ ...asSent, updatedAt: NOW });
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

// Piece 3b, Task 6 (README B5, B17, B9; spec C4; rulings R-g, R-h): the letter's autosave, „Uus kiri +“, „Kustuta mustand“ and the count on „Saada kõigile ({n})“.
describe("C4 and R-g: a save that changes nothing, a draft without its subject", () => {
  test("C4: a save that changes no field keeps `updatedAt` (the send guard's version), whole or by field; a real change moves it", async () => {
    const id = await draft();
    const before = await rowOf(id);
    expect(await saveCampaign(db, id, DRAFT, at(5))).toEqual({ ok: true, id });
    // (the code typed in small letters is stored in capitals: the same text again is no change either)
    expect((await rowOf(id)).updatedAt).toEqual(before.updatedAt);
    const read = await readCampaign(db, id);
    if (!read) throw new Error("no letter");
    const again = await writeCampaign(db, id, { subject: DRAFT.subject, code: "SUGIS15", name: " Oktoobri pakkumine " }, read.version, at(6));
    expect(again).toEqual({ ok: true, version: read.version, savedAt: at(6).toISOString() });
    expect(await rowOf(id)).toEqual(before);
    // the press's version is the one before the saves: it still holds
    const plan = await prepareSendWith(id);
    expect(plan.updatedAt).toBe(before.updatedAt.toISOString());
    const moved = await writeCampaign(db, id, { preheader: { et: "Uus rida", ru: "" } }, read.version, at(7));
    expect(moved).toMatchObject({ ok: true });
    expect((moved as { version: string }).version).not.toBe(read.version);
    expect((await rowOf(id)).updatedAt).toEqual(at(7));
  });

  test("R-g: „Uus kiri +“ makes the draft „Uus kiri“ with an empty subject and text; saves take an empty subject and text; the name stays required", async () => {
    const { id } = await createDraft(db, NOW);
    expect(await rowOf(id)).toMatchObject({
      name: "Uus kiri",
      subject: { et: "", ru: "" },
      preheader: { et: "", ru: "" },
      body: { et: "", ru: "" },
      imageKey: null,
      code: null,
      buttonLabel: null,
      buttonHref: null,
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(adminEt.newsletter.campaigns.newTitle).toBe("Uus kiri");
    const read = await readCampaign(db, id);
    if (!read) throw new Error("no letter");
    expect(read.value).toEqual({ name: "Uus kiri", subject: { et: "", ru: "" }, preheader: { et: "", ru: "" }, imageKey: "", body: { et: "", ru: "" }, code: "", buttonLabel: { et: "", ru: "" }, buttonHref: "" });
    // a subject typed, then emptied again: both saves go
    const typed = await writeCampaign(db, id, { subject: { et: "Teema", ru: "" } }, read.version, at(1));
    if (!typed.ok) throw new Error(JSON.stringify(typed));
    const emptied = await writeCampaign(db, id, { subject: { et: "", ru: "" }, body: { et: "", ru: "" } }, typed.version, at(2));
    expect(emptied).toMatchObject({ ok: true });
    expect(await rowOf(id)).toMatchObject({ subject: { et: "", ru: "" }, updatedAt: at(2) });
    expect(await saveCampaign(db, id, { ...DRAFT, subject: { et: "", ru: "" }, body: { et: "", ru: "" } }, at(3))).toEqual({ ok: true, id });
    // the name is the list's: an empty one is refused by field, nothing stored
    const now = await readCampaign(db, id);
    expect(await writeCampaign(db, id, { name: "  " }, now!.version, at(4))).toEqual({ ok: false, error: "invalid", fields: { name: "required" } });
    expect((await rowOf(id)).updatedAt).toEqual(at(3));
  });

  test("the autosave of a field: the other fields' rules do not hold it back; the button's rule falls on the field that breaks it; a field too long is refused by name", async () => {
    const { id } = await createDraft(db, NOW);
    let v = (await readCampaign(db, id))!.version;
    // the button's label first: stored, its address still to come (the rule names the address, which this save does not carry)
    const label = await writeCampaign(db, id, { buttonLabel: { et: "Vaata", ru: "" } }, v, at(1));
    if (!label.ok) throw new Error(JSON.stringify(label));
    v = label.version;
    expect(await rowOf(id)).toMatchObject({ buttonLabel: { et: "Vaata", ru: "" }, buttonHref: null });
    expect(await writeCampaign(db, id, { buttonHref: "javascript:alert(1)" }, v, at(2))).toEqual({ ok: false, error: "invalid", fields: { buttonHref: "invalid" } });
    const href = await writeCampaign(db, id, { buttonHref: "/koolitused" }, v, at(2));
    if (!href.ok) throw new Error(JSON.stringify(href));
    expect(await writeCampaign(db, id, { subject: { et: "x".repeat(CAMPAIGN_LIMITS.subject + 1), ru: "" } }, href.version, at(3))).toEqual({ ok: false, error: "invalid", fields: { subject: "tooLong" } });
    // a Russian text under a button without its Russian label: the label is the field held back (ruling R2), the text itself goes
    const ru = await writeCampaign(db, id, { body: { et: "Tekst.", ru: "Текст." } }, href.version, at(4));
    if (!ru.ok) throw new Error(JSON.stringify(ru));
    expect(await writeCampaign(db, id, { buttonLabel: { et: "Vaata kõiki", ru: "" } }, ru.version, at(5))).toEqual({ ok: false, error: "invalid", fields: { buttonLabel: "ruLabel" } });
    const both = await writeCampaign(db, id, { buttonLabel: { et: "Vaata kõiki", ru: "Смотреть" } }, ru.version, at(5));
    if (!both.ok) throw new Error(JSON.stringify(both));
    // the button taken away: its label and its address together (each alone would break the rule, so the editor holds the first until the second)
    expect(await writeCampaign(db, id, { buttonHref: "" }, both.version, at(6))).toEqual({ ok: false, error: "invalid", fields: { buttonHref: "required" } });
    expect(await writeCampaign(db, id, { buttonLabel: { et: "", ru: "" }, buttonHref: "" }, both.version, at(6))).toMatchObject({ ok: true });
    expect(await rowOf(id)).toMatchObject({ buttonLabel: null, buttonHref: null });
  });

  test("another tab's version is a conflict with the stored fields; a letter sent meanwhile is a conflict too and never changes", async () => {
    const id = await draft();
    const read = (await readCampaign(db, id))!;
    expect(await writeCampaign(db, id, { name: "Esimene vahekaart" }, read.version, at(1))).toMatchObject({ ok: true });
    const stale = await writeCampaign(db, id, { name: "Teine vahekaart" }, read.version, at(2));
    expect(stale).toMatchObject({ ok: false, error: "conflict", value: { name: "Esimene vahekaart" } });
    const now = (await readCampaign(db, id))!;
    await db.update(newsletterCampaigns).set({ status: "sending" }).where(eq(newsletterCampaigns.id, id));
    const before = await rowOf(id);
    expect(await writeCampaign(db, id, { name: "Pärast saatmist" }, now.version, at(3))).toMatchObject({ ok: false, error: "conflict" });
    expect(await rowOf(id)).toEqual(before);
    expect(await readCampaign(db, 999_999)).toBeNull();
  });
});

describe("deleteDraft: „Kustuta mustand“ (B17)", () => {
  test("a draft is deleted; a letter sent or going out is refused (`sent`) and stays; one that is not there is `notFound`", async () => {
    const id = await draft();
    const other = await draft({ ...DRAFT, name: "Teine" });
    expect(await deleteDraft(db, id)).toBe("ok");
    expect(await rowOf(id)).toBeUndefined();
    expect(await rowOf(other)).toBeDefined();
    expect(await deleteDraft(db, id)).toBe("notFound");
    for (const status of ["sent", "sending"] as const) {
      const letter = await draft();
      await db.update(newsletterCampaigns).set({ status, recipients: { et: 1, ru: 0 } }).where(eq(newsletterCampaigns.id, letter));
      const before = await rowOf(letter);
      expect(await deleteDraft(db, letter), status).toBe("sent");
      expect(await rowOf(letter)).toEqual(before);
    }
    expect(adminEt.newsletter.campaigns.errorsOf.sent).toBe("See kiri on juba saadetud.");
  });
});

describe("sendCountNow: the count on „Saada kõigile ({n})“ (B9, R-h)", () => {
  const sub = (email: string, locale: "et" | "ru" = "et", confirmed = true) =>
    db.insert(subscribers).values({ email, locale, token: `tok_${email.replace(/[^a-z0-9]/gi, "_")}_0123456789`, confirmedAt: confirmed ? NOW : null });

  test("the confirmed subscribers a press would write now: never a sample address (@example.test), an unconfirmed row or an address twice", async () => {
    expect(await sendCountNow(db)).toBe(0);
    await sub("kati@example.com");
    await sub("olga@example.com", "ru");
    await sub("ootab@example.com", "et", false);
    await sub("naidis@example.test");
    await sub("Teine.Naidis@Example.Test", "ru");
    await sub("KATI@example.com", "ru");
    expect(await sendCountNow(db)).toBe(2);
    expect(await sendCountsNow(db)).toEqual({ et: 1, ru: 1, samples: 2 });
    // the press's own read under its lock says the same
    const id = await draft();
    expect(await prepareSend(db, id)).toMatchObject({ ok: true, et: 1, ru: 1, samples: 2 });
  });
});

/** prepareSend's plan, or the test fails. */
async function prepareSendWith(id: number): Promise<{ updatedAt: string }> {
  await db.insert(subscribers).values({ email: "kati@example.com", locale: "et", token: "tok_kati_0123456789", confirmedAt: NOW }).onConflictDoNothing();
  const plan = await prepareSend(db, id);
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  return plan;
}

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

// docs/deploy.md section 24, item 2 (the rollback): the older code mails a stored draft without checking its content, so before a rollback every draft with
// no Estonian subject or text, or with a button of only one part, is completed or deleted, and this read-only query must return no row. The test runs the
// query as the doc prints it.
describe("the rollback check of deploy.md §24 item 2: empty and half-done draft letters", () => {
  const docQuery = (): string => {
    const doc = readFileSync(join(process.cwd(), "..", "docs", "deploy.md"), "utf8");
    const found = /`(select id, name from newsletter_campaigns where status = 'draft'[^`]*)`/.exec(doc);
    if (!found) throw new Error("the query is not in docs/deploy.md section 24");
    return found[1];
  };
  const unsafe = async (): Promise<number[]> => {
    const rows = (await db.execute(sql.raw(docQuery()))) as unknown as { rows?: { id: number }[] } & { id: number }[];
    return ((rows.rows ?? rows) as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
  };

  test("it finds „Uus kiri“ as made, a draft without its text, a spaces-only subject and a half button — and nothing that is ready, sent or only without Russian", async () => {
    const empty = (await createDraft(db, NOW)).id;
    const noBody = await draft({ ...DRAFT, name: "Ilma tekstita", body: { et: "", ru: "" } });
    const spaces = await draft({ ...DRAFT, name: "Tühik teemas", subject: { et: "   ", ru: "" } });
    // (a whole-draft save refuses a half button; the field-by-field autosave stores the one part that was typed — a rule broken by a field the patch does not carry holds nothing back)
    const halfOf = async (name: string, patch: Record<string, unknown>): Promise<number> => {
      const id = await draft({ ...DRAFT, name, buttonLabel: { et: "", ru: "" }, buttonHref: "" });
      const read = await readCampaign(db, id);
      if (!read) throw new Error("no letter");
      expect(await writeCampaign(db, id, patch, read.version, at(1))).toMatchObject({ ok: true });
      return id;
    };
    const halfLabel = await halfOf("Nupp ilma aadressita", { buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" } });
    const halfHref = await halfOf("Aadress ilma nupuni", { buttonHref: "/koolitused" });
    expect(await rowOf(halfLabel)).toMatchObject({ buttonHref: null });
    expect((await rowOf(halfLabel)).buttonLabel).not.toBeNull();
    expect(await rowOf(halfHref)).toMatchObject({ buttonLabel: null, buttonHref: "/koolitused" });
    // (not found: a ready letter, one with no Russian text (the Estonian one goes out), one with no button at all)
    await draft({ ...DRAFT, name: "Valmis" });
    await draft({ ...ET_ONLY, name: "Ainult eesti" });
    await draft({ ...DRAFT, name: "Nuputa", buttonLabel: { et: "", ru: "" }, buttonHref: "" });
    const sent = await draft({ ...DRAFT, name: "Saadetud" });
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW }).where(eq(newsletterCampaigns.id, sent));
    const sentEmpty = (await createDraft(db, NOW)).id;
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: NOW }).where(eq(newsletterCampaigns.id, sentEmpty));
    expect(await unsafe()).toEqual([empty, noBody, spaces, halfLabel, halfHref].sort((a, b) => a - b));

    // completed or deleted: the check is clean
    await deleteDraft(db, empty);
    for (const id of [noBody, spaces, halfLabel, halfHref]) await deleteDraft(db, id);
    expect(await unsafe()).toEqual([]);
  });
});
