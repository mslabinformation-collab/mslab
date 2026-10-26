import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { replaceGallery, setSetting, upsertCampaign, upsertPage } from "@/db/queries/admin";
import type { Campaign, FaqItem, GalleryItem, HeroSlide, Page, Post, PracticePackage } from "@/db/schema";
import {
  deletePostRow,
  insertPost,
  isPostSlugTaken,
  lockTables,
  readCampaign,
  readFaq,
  readGallery,
  readNewsletterPopup,
  readPackage,
  readPackages,
  readPage,
  readPost,
  readSetting,
  readSlides,
  saveFaq,
  saveSlides,
  updatePackage,
  updatePost,
  type FaqRow,
  type SiteTable,
  type SlideRow,
} from "@/db/queries/admin-site";
import { PREPAYMENT_KEY } from "@/domain/account-cards";
import { tallinnFormParts, tallinnInstant } from "@/domain/calendar";
import { nextTermsVersion, TERMS_PAGE_KEY, TERMS_PAGE_TITLE, TERMS_VERSION_KEY } from "@/domain/course-terms";
import {
  CAMPAIGN_CTA,
  campaignDraft,
  contactDraft,
  copyI18n,
  faqDraft,
  newsletterDraft,
  newsletterPopupDraft,
  normalizeIban,
  isIban,
  packageDraft,
  prepaymentDraft,
  pageDraft,
  postDraft,
  SITE_LIMITS as L,
  slideDraft,
  trainerDraft,
  type CampaignDraft,
  type ContactDraft,
  type FaqDraft,
  type NewsletterDraft,
  type NewsletterPopupDraft,
  type PackageDraft,
  type PrepaymentDraft,
  type PageDraft,
  type PostDraft,
  type SlideDraft,
  type TrainerDraft,
  type WorkDraft,
} from "@/domain/site-editor";
import { isWelcomeCode, normalizeWelcomeCode, WELCOME_CODE_MAX } from "@/domain/welcome-code";
import type { I18n } from "@/i18n/field";
import { isSlug, SLUG_MAX, slugify } from "@/lib/slug";
import type { SaveAnswer } from "@/domain/autosave";
import { contentVersion } from "@/lib/version";
import { fieldCodes } from "./autosave-route";
import { Check, field, invalid, type EditResult, type SavedParts } from "./edit-check";

// The site content editors' form handling (Task 13B): home page, practice packages, trainer page, campaign, settings
// and posts. Callers have already checked the admin session (server/actions/admin-site.ts wraps each in adminAction);
// these take a Db and run without Next.js (tests/db/admin-site.test.ts).
//
// An editor page is made of PARTS (the hero slides, the statement, the FAQ; MINI and MAXI; …). The page loads every
// part with its version (a hash of the stored value, lib/version.ts) and sends back only the parts the admin changed,
// each with the version it loaded. A save checks every sent part, then in one transaction locks the tables, compares
// each part's stored version with the one sent (refused as `stale`, nothing written, when another save came first) and
// writes them all. So two admins can save different parts of the same page, but never overwrite a change unseen.

const DRAFT_MAX = 600_000;
const ID_MAX = 2_147_483_647;

const i18n = z.object({ et: z.string().max(40_000), ru: z.string().max(40_000).optional() });
const text = (max = 2000) => z.string().max(max);
const uid = z.string().max(40);

type Write = (tx: Tx, stored: unknown) => Promise<void>;

/** One part of an editor page. */
type Part<V> = {
  /** The tables its save writes (locked for the transaction). */
  tables: SiteTable[];
  /** The draft as the browser sends it. */
  schema: z.ZodType<V>;
  /** The stored value its version is of (read again inside the save's transaction). */
  read: (q: Q) => Promise<unknown>;
  /** Stored value → the editor's draft. */
  draft: (stored: unknown) => V;
  /** Checks a draft (errors into `c`, field names prefixed with the part's name); the write, or null when refused. */
  check: (c: Check, value: V, name: string) => Write | null;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a page's parts have different draft types
type Parts = Record<string, Part<any>>;

const part = <V>(p: Part<V>): Part<V> => p;

/** Every part of a page as stored: the drafts and their versions. */
export async function loadParts(q: Q, parts: Record<string, Pick<Part<unknown>, "read" | "draft">>, only?: string[]): Promise<SavedParts> {
  const names = only ?? Object.keys(parts);
  const stored = await Promise.all(names.map((n) => parts[n].read(q)));
  const versions = await Promise.all(stored.map((s) => contentVersion(s)));
  return {
    values: Object.fromEntries(names.map((n, i) => [n, parts[n].draft(stored[i])])),
    versions: Object.fromEntries(names.map((n, i) => [n, versions[i]])),
  };
}

const payloadSchema = z.object({ parts: z.record(z.string().max(40), z.object({ version: z.string().max(64), value: z.unknown() })) });

/** The form's `data` field: { parts: { <name>: { version, value } } }, or null when it is not that. */
function payload(formData: FormData): z.infer<typeof payloadSchema> | null {
  const raw = field(formData, "data");
  if (!raw || raw.length > DRAFT_MAX) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Saves the sent parts of a page (see the top of this file). The result carries the saved parts as now stored. */
export async function saveParts(db: Db, parts: Parts, formData: FormData): Promise<EditResult> {
  const sent = payload(formData);
  if (!sent) return { ok: false, error: "invalid" };
  return saveSent(db, parts, sent);
}

/**
 * saveParts' work on the parts as sent: every part checked, then one transaction — the tables locked, each stored version compared, the writes. `db`
 * may be a caller's open transaction: the save is then a savepoint of it (the legal texts' publish, server/legal-drafts.ts).
 */
async function saveSent(db: Q, parts: Parts, sent: z.infer<typeof payloadSchema>): Promise<EditResult> {
  const c = new Check();
  const writes: { name: string; def: Part<unknown>; version: string; write: Write }[] = [];
  for (const [name, p] of Object.entries(sent.parts)) {
    const def = Object.hasOwn(parts, name) ? parts[name] : undefined;
    if (!def) return { ok: false, error: "invalid" };
    const value = def.schema.safeParse(p.value);
    if (!value.success) return { ok: false, error: "invalid" };
    const write = def.check(c, value.data, name);
    if (write) writes.push({ name, def, version: p.version, write });
  }
  if (!c.ok) return invalid(c.errors);
  if (writes.length === 0) return { ok: true, id: 0, saved: { values: {}, versions: {} } };

  const outcome = await (db as Db).transaction(async (tx) => {
    await lockTables(tx, writes.flatMap((w) => w.def.tables));
    const stored = await Promise.all(writes.map((w) => w.def.read(tx)));
    for (const [i, w] of writes.entries()) if ((await contentVersion(stored[i])) !== w.version) return "stale" as const;
    for (const [i, w] of writes.entries()) await w.write(tx, stored[i]);
    // read back inside the same transaction (still locked): exactly what this save stored, with its versions
    return loadParts(tx, parts, writes.map((w) => w.name));
  });
  if (outcome === "stale") return { ok: false, error: "stale" };
  return { ok: true, id: 0, saved: outcome };
}

// ---------- shared checks ----------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const orEmpty = (f: I18n | null): I18n => f ?? { et: "" };
const blank = (f: I18n) => !f.et.trim() && !(f.ru ?? "").trim();

/** A text page part ({ title, body }) stored as pages.<key>; `keepTitle`: only the body is edited. */
function pagePart(key: string, opts: { titleMax: number; bodyMax: number; required?: boolean }): Part<PageDraft> {
  return part<PageDraft>({
    tables: ["pages"],
    schema: z.object({ title: i18n, body: i18n }),
    read: (q) => readPage(q, key),
    draft: (stored) => pageDraft(stored as Page | null),
    check: (c, v, name) => {
      const title = c.text(`${name}.title`, v.title, opts.titleMax, { required: opts.required });
      const body = c.text(`${name}.body`, v.body, opts.bodyMax, { required: opts.required });
      return async (tx) => void (await upsertPage(tx, { key, title: orEmpty(title), body: orEmpty(body) }));
    },
  });
}

/** A part that edits only the body of pages.<key> (the statement, the trainer's bio); the stored title is kept. */
function bodyPart(key: string, max: number, defaultTitle: I18n): Part<{ body: I18n }> {
  return part<{ body: I18n }>({
    tables: ["pages"],
    schema: z.object({ body: i18n }),
    read: (q) => readPage(q, key),
    draft: (stored) => ({ body: copyI18n((stored as Page | null)?.body) }),
    check: (c, v, name) => {
      const body = c.text(`${name}.body`, v.body, max);
      return async (tx, stored) => void (await upsertPage(tx, { key, title: (stored as Page | null)?.title ?? defaultTitle, body: orEmpty(body) }));
    },
  });
}

// ---------- Avaleht: hero slides, statement, the trainer card's text, FAQ ----------

export type HomeValues = { slides: SlideDraft[]; statement: { body: I18n }; teaser: { body: I18n }; faq: FaqDraft[] };

/** A stored row's id in a list draft; null (or absent) for a new row. */
const storedId = z.number().int().positive().max(ID_MAX).nullable().default(null);

const slideSchema = z.object({
  uid,
  id: storedId,
  imageKey: text(400),
  imagePos: text(20),
  imagePosMobile: text(20),
  tone: z.enum(["light", "dark"]),
  kicker: i18n,
  title: i18n,
  text: i18n,
  ctaLabel: i18n,
  ctaHref: text(400),
  active: z.boolean(),
});

const homeParts: Parts = {
  slides: part<SlideDraft[]>({
    tables: ["hero_slides"],
    schema: z.array(slideSchema).max(50),
    read: readSlides,
    draft: (stored) => (stored as HeroSlide[]).map(slideDraft),
    check: (c, slides, name) => {
      if (slides.length > L.slides) c.fail(name, "tooMany");
      const rows: (SlideRow & { id: number | null })[] = slides.map((s, i) => {
        const p = `${name}.${i}.`;
        return {
          id: s.id,
          imageKey: c.image(`${p}imageKey`, s.imageKey, { required: true }),
          imagePos: c.focal(`${p}imagePos`, s.imagePos),
          imagePosMobile: c.focal(`${p}imagePosMobile`, s.imagePosMobile),
          tone: s.tone,
          kicker: orEmpty(c.text(`${p}kicker`, s.kicker, L.slideKicker)),
          title: orEmpty(c.text(`${p}title`, s.title, L.slideTitle, { required: true })),
          text: orEmpty(c.text(`${p}text`, s.text, L.slideText)),
          ctaLabel: orEmpty(c.text(`${p}ctaLabel`, s.ctaLabel, L.ctaLabel)),
          ctaHref: c.href(`${p}ctaHref`, s.ctaHref, { required: true }),
          active: s.active,
        };
      });
      return (tx) => saveSlides(tx, rows); // ids kept; a repeated or unknown id becomes a new row (syncPlan)
    },
  }),
  statement: bodyPart("statement", L.statement, { et: "MS LAB Koolituskeskus" }),
  // the text on the home page's trainer card (Maria C26); empty: the first paragraph of the trainer's bio
  teaser: bodyPart("trainer_teaser", L.teaser, { et: "Sinu koolitaja", ru: "Ваш преподаватель" }),
  faq: part<FaqDraft[]>({
    tables: ["faq"],
    schema: z.array(z.object({ uid, id: storedId, q: i18n, a: i18n })).max(200),
    read: readFaq,
    draft: (stored) => (stored as FaqItem[]).map(faqDraft),
    check: (c, items, name) => {
      const rows: (FaqRow & { id: number | null })[] = [];
      for (const [i, item] of items.entries()) {
        if (blank(item.q) && blank(item.a)) continue; // an empty row is dropped
        const q = c.text(`${name}.${i}.q`, item.q, L.question, { required: true });
        const a = c.text(`${name}.${i}.a`, item.a, L.answer, { required: true });
        if (q && a) rows.push({ id: item.id, q, a });
      }
      if (rows.length > L.faq) c.fail(name, "tooMany");
      return (tx) => saveFaq(tx, rows); // the items keep their ids (the editor's rows keep their fields and focus)
    },
  }),
};

export const loadHome = async (q: Q) => (await loadParts(q, homeParts)) as SavedParts & { values: HomeValues };
export const saveHomeForm = (db: Db, formData: FormData) => saveParts(db, homeParts, formData);

// ---------- Praktika: one part per package (MINI, MAXI; the codes are fixed) ----------

function packagePart(code: string): Part<PackageDraft> {
  return part<PackageDraft>({
    tables: ["practice_packages"],
    schema: z.object({ name: i18n, tagline: i18n, models: text(20), durationLabel: i18n, price: text(40), items: z.array(i18n).max(200) }),
    read: (q) => readPackage(q, code),
    draft: (stored) => packageDraft(stored as PracticePackage),
    check: (c, v, name) => {
      const p = `${name}.`;
      const title = c.text(`${p}name`, v.name, L.packageName, { required: true });
      const tagline = c.text(`${p}tagline`, v.tagline, L.tagline);
      const models = c.whole(`${p}models`, v.models, 0, L.models);
      if (models == null) c.fail(`${p}models`, "required");
      const durationLabel = c.text(`${p}durationLabel`, v.durationLabel, L.duration, { required: true });
      const price = c.amount(`${p}price`, v.price);
      if (price == null) c.fail(`${p}price`, "required");
      const items = c.list(`${p}items`, v.items, L.item, L.packageItems);
      if (!title || !durationLabel || models == null || price == null) return null;
      return (tx) => updatePackage(tx, code, { name: title, tagline: orEmpty(tagline), models, durationLabel, price, items });
    },
  });
}

async function practiceParts(q: Q): Promise<Parts> {
  const codes = (await readPackages(q)).map((p) => p.code);
  return Object.fromEntries(codes.map((code) => [code, packagePart(code)]));
}

/** The packages in their order: codes and drafts. */
export async function loadPractice(q: Q): Promise<SavedParts & { values: Record<string, PackageDraft>; codes: string[] }> {
  const parts = await practiceParts(q);
  const loaded = (await loadParts(q, parts)) as SavedParts & { values: Record<string, PackageDraft> };
  return { ...loaded, codes: Object.keys(parts) };
}

export const savePracticeForm = async (db: Db, formData: FormData) => saveParts(db, await practiceParts(db), formData);

// ---------- Koolitaja: the trainer card, bio, works gallery, the two stories ----------

export type TrainerValues = { trainer: TrainerDraft; bio: { body: I18n }; works: WorkDraft[]; center_story: PageDraft; trainer_journey: PageDraft };
export const WORKS_GROUP = "trainer_works";

const trainerParts: Parts = {
  trainer: part<TrainerDraft>({
    tables: ["settings"],
    schema: z.object({
      portraitKey: text(400),
      portraitPos: text(20),
      name: i18n,
      role: i18n,
      stats: z.array(z.object({ uid, value: text(100), label: i18n })).max(20),
    }),
    read: (q) => readSetting(q, "trainer"),
    draft: trainerDraft,
    check: (c, v, name) => {
      const p = `${name}.`;
      const portraitKey = c.image(`${p}portraitKey`, v.portraitKey);
      const portraitPos = c.focal(`${p}portraitPos`, v.portraitPos);
      const trainerName = c.text(`${p}name`, v.name, L.trainerName, { required: true });
      const role = c.text(`${p}role`, v.role, L.role);
      const stats: { value: string; label: I18n }[] = [];
      for (const [i, s] of v.stats.entries()) {
        if (!s.value.trim() && blank(s.label)) continue;
        const value = c.plain(`${p}stats.${i}.value`, s.value, L.statValue, { required: true });
        const label = c.text(`${p}stats.${i}.label`, s.label, L.statLabel, { required: true });
        if (value && label) stats.push({ value, label });
      }
      if (stats.length > L.stats) c.fail(`${p}stats`, "tooMany");
      return (tx, stored) => {
        // other keys (the contact block's photo) stay as they are
        const { role: _oldRole, ...rest } = obj(stored);
        void _oldRole;
        return setSetting(tx, "trainer", { ...rest, portraitKey, portraitPos, name: trainerName, ...(role ? { role } : {}), stats });
      };
    },
  }),
  bio: bodyPart("trainer_bio", L.bio, { et: "" }),
  works: part<WorkDraft[]>({
    tables: ["gallery_items"],
    schema: z.array(z.object({ key: text(400), alt: i18n })).max(200),
    read: (q) => readGallery(q, WORKS_GROUP),
    draft: (stored) => (stored as GalleryItem[]).map((g) => ({ key: g.key, alt: copyI18n(g.alt) })),
    check: (c, items, name) => {
      if (items.length > L.works) c.fail(name, "tooMany");
      // each picture's own field names, so the editor marks the one that is wrong
      const rows = items.map((x, i) => ({ key: c.image(`${name}.${i}.key`, x.key, { required: true }), alt: c.text(`${name}.${i}.alt`, x.alt, L.alt) }));
      return async (tx) => void (await replaceGallery(tx, WORKS_GROUP, rows));
    },
  }),
  center_story: pagePart("center_story", { titleMax: L.storyTitle, bodyMax: L.story }),
  trainer_journey: pagePart("trainer_journey", { titleMax: L.storyTitle, bodyMax: L.story }),
};

export const loadTrainer = async (q: Q) => (await loadParts(q, trainerParts)) as SavedParts & { values: TrainerValues };
export const saveTrainerForm = (db: Db, formData: FormData) => saveParts(db, trainerParts, formData);

// ---------- Hüpikaken (prototype D adminCamp + image upload; phase 2c: the newsletter popup, one shown at a time) ----------

const CODE = /^[A-Z0-9-]*$/;

const campaignParts: Parts = {
  campaign: part<CampaignDraft>({
    tables: ["campaign"],
    schema: z.object({ active: z.boolean(), kicker: i18n, title: i18n, text: i18n, code: text(100), ctaLabel: i18n, ctaHref: text(400), imageKey: text(400) }),
    read: readCampaign,
    draft: (stored) => campaignDraft(stored as Campaign | null),
    check: (c, v, name) => {
      const p = `${name}.`;
      // an active campaign is shown: it needs its title and its picture; a switched-off one may stay unfinished
      const title = c.text(`${p}title`, v.title, L.campaignTitle, { required: v.active });
      const kicker = c.text(`${p}kicker`, v.kicker, L.campaignKicker);
      const body = c.text(`${p}text`, v.text, L.campaignText);
      const code = v.code.trim().toUpperCase();
      if (code.length > L.code) c.fail(`${p}code`, "tooLong");
      else if (!CODE.test(code)) c.fail(`${p}code`, "codeFormat");
      const ctaLabel = c.text(`${p}ctaLabel`, v.ctaLabel, L.ctaLabel) ?? { et: CAMPAIGN_CTA }; // M4
      const ctaHref = c.href(`${p}ctaHref`, v.ctaHref, { required: true });
      const imageKey = c.image(`${p}imageKey`, v.imageKey, { required: v.active });
      return async (tx) => void (await upsertCampaign(tx, { active: v.active, kicker: orEmpty(kicker), title: orEmpty(title), text: orEmpty(body), code, ctaLabel, ctaHref, imageKey }, "campaign"));
    },
  }),
  // Hüpikaken's newsletter popup (phase 2c): a shown one needs its title and its picture; its code, button text and link stay empty.
  // Both parts lock `campaign` and run in the save's one transaction; each write switches the other popup off before it switches its
  // own on (upsertCampaign), so saving both parts, in either order, or one alone, leaves at most one row active (campaign_one_active).
  newsletter: part<NewsletterPopupDraft>({
    tables: ["campaign"],
    schema: z.object({ active: z.boolean(), kicker: i18n, title: i18n, text: i18n, imageKey: text(400) }),
    read: readNewsletterPopup,
    draft: (stored) => newsletterPopupDraft(stored as Campaign | null),
    check: (c, v, name) => {
      const p = `${name}.`;
      const title = c.text(`${p}title`, v.title, L.campaignTitle, { required: v.active });
      const kicker = c.text(`${p}kicker`, v.kicker, L.campaignKicker);
      const body = c.text(`${p}text`, v.text, L.campaignText);
      const imageKey = c.image(`${p}imageKey`, v.imageKey, { required: v.active });
      return async (tx) =>
        void (await upsertCampaign(tx, { active: v.active, kicker: orEmpty(kicker), title: orEmpty(title), text: orEmpty(body), code: "", ctaLabel: { et: "" }, ctaHref: "", imageKey }, "newsletter"));
    },
  }),
};

export const loadCampaign = async (q: Q) => (await loadParts(q, campaignParts)) as SavedParts & { values: { campaign: CampaignDraft; newsletter: NewsletterPopupDraft } };
export const saveCampaignForm = (db: Db, formData: FormData) => saveParts(db, campaignParts, formData);

// ---------- Seaded: contact details, newsletter discount and welcome code, prepayment instructions (autosaved), legal pages, the e-course terms ----------

export type SettingsValues = {
  contact: ContactDraft;
  newsletter: NewsletterDraft;
  prepayment: PrepaymentDraft;
};

/**
 * Seaded's autosaved settings parts (admin UX pass piece 3b, Task 4; README B4): the contact details, „Uudiskiri“ and the prepayment instructions
 * („Ettemaksu juhised“, the bank fields of the „Maksmine“ card: ruling R-f, one source — the invoice reads them too), saved field by field on
 * api/admin/seaded/<part> (server/seaded.ts). Each is one `settings` row; its version is the hash of the stored value, as every site part's.
 */
export const SETTINGS_PARTS = ["contact", "newsletter", "prepayment"] as const;
export type SettingsPart = (typeof SETTINGS_PARTS)[number];

const SETTING_KEYS: Record<SettingsPart, string> = { contact: "contact", newsletter: "newsletter", prepayment: PREPAYMENT_KEY };
const DRAFTS: Record<SettingsPart, (stored: unknown) => Record<string, string>> = { contact: contactDraft, newsletter: newsletterDraft, prepayment: prepaymentDraft };

/** A field's text as the card sends it: a string (else "invalid") of the old form's length at most (else "tooLong"); the rule (FIELD_RULES) decides the rest. */
const sent = (max: number) => z.string({ error: "invalid" }).max(max, "tooLong");

/** Each part's autosave patch (the route's schema): some of its fields, no other. */
const PATCHES: Record<SettingsPart, z.ZodType<Record<string, string | undefined>>> = {
  contact: z.strictObject({ email: sent(400), phone: sent(400), address: sent(1000), instagram: sent(1000), facebook: sent(1000) }, { error: "invalid" }).partial(),
  newsletter: z.strictObject({ discountLabel: sent(400), welcomeCode: sent(400) }, { error: "invalid" }).partial(),
  prepayment: z.strictObject({ receiver: sent(400), iban: sent(400), bank: sent(400), referencePrefix: sent(400) }, { error: "invalid" }).partial(),
};

export const settingsPartPatch = (part: SettingsPart) => PATCHES[part];

/** A field's rule: its value as stored, its refusal into `c` under `name`. */
type FieldRule = (c: Check, name: string, value: string) => unknown;

/**
 * The fields' rules, one by one (a save checks only the fields it sends):
 * - contact: an e-mail and a phone as people write them; the social links https only (the site opens them in a new tab: never javascript: or the like);
 * - newsletter: the discount label is required; "Tervituskood" (phase 2c) is A–Z, 0–9 and "-", at most 30, stored in capitals; empty = no welcome code;
 * - prepayment: every field may be empty; all empty means no instructions (the cards say Maria sends an invoice), and so does one without the
 *   receiver or the IBAN (domain/account-cards.ts hasPrepayment). The IBAN is stored without spaces, in capitals.
 */
const FIELD_RULES: Record<SettingsPart, Record<string, FieldRule>> = {
  contact: {
    email: (c, n, v) => c.email(n, v, L.email),
    phone: (c, n, v) => c.phone(n, v),
    address: (c, n, v) => c.plain(n, v, L.address),
    instagram: (c, n, v) => c.httpsUrl(n, v),
    facebook: (c, n, v) => c.httpsUrl(n, v),
  },
  newsletter: {
    discountLabel: (c, n, v) => c.plain(n, v, L.discount, { required: true }),
    welcomeCode: (c, n, v) => {
      const code = normalizeWelcomeCode(v);
      if (code.length > WELCOME_CODE_MAX) return c.fail(n, "tooLong");
      return isWelcomeCode(code) ? code : c.fail(n, "codeFormat");
    },
  },
  prepayment: {
    receiver: (c, n, v) => c.plain(n, v, L.receiver),
    iban: (c, n, v) => {
      if (v.length > L.iban) return c.fail(n, "tooLong");
      const iban = normalizeIban(v);
      return iban && !isIban(iban) ? c.fail(n, "iban") : iban;
    },
    bank: (c, n, v) => c.plain(n, v, L.bank),
    referencePrefix: (c, n, v) => c.plain(n, v, L.referencePrefix),
  },
};

/** An autosaved part as the page reads it: the stored setting's hash and its draft. */
const settingsRead = (part: SettingsPart): Pick<Part<unknown>, "read" | "draft"> => ({ read: (q) => readSetting(q, SETTING_KEYS[part]), draft: DRAFTS[part] });

/**
 * One autosaved settings part (the route's `write`; server/autosave-route.ts' contract): `patch` (some of its fields) over the stored setting at
 * `version`. The fields sent are checked first, each by its rule (FIELD_RULES: refused by field, nothing written); then, with the settings table
 * locked as every site save locks it, a version that is not the stored one's is a conflict with the part as stored; else the fields are written
 * over the stored value, its other keys kept (the prepayment's four always written). The same text again writes nothing and keeps the version.
 * `changed`: whether anything was written (the caller revalidates the pages that show the part).
 */
export async function writeSettingsPart(db: Db, part: SettingsPart, patch: unknown, version: string, now: Date): Promise<SaveAnswer & { changed?: boolean }> {
  const parsed = PATCHES[part].safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? {} };
  const c = new Check();
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed.data)) if (value !== undefined) values[name] = FIELD_RULES[part][name](c, name, value);
  if (!c.ok) return { ok: false, error: "invalid", fields: c.errors };
  const key = SETTING_KEYS[part];
  const savedAt = now.toISOString();
  return db.transaction(async (tx) => {
    await lockTables(tx, ["settings"]);
    const stored = await readSetting(tx, key);
    const current = await contentVersion(stored);
    if (current !== version) return { ok: false, error: "conflict", version: current, value: DRAFTS[part](stored) };
    const next = { ...(part === "prepayment" ? prepaymentDraft(stored) : obj(stored)), ...values };
    // nothing the card shows would change (the same text again, or a space typed into a field that is empty on a part with no row yet, which is the
    // defaults): no write, no new version, nothing revalidated (C4)
    const sameCard = JSON.stringify(DRAFTS[part](next)) === JSON.stringify(DRAFTS[part](stored));
    if (sameCard || (await contentVersion(next)) === current) return { ok: true, version: current, savedAt };
    await setSetting(tx, key, next);
    return { ok: true, version: await contentVersion(await readSetting(tx, key)), savedAt, changed: true };
  });
}

// The legal pages and the e-course contract (Seaded → „Lepingud ja tingimused“): since piece 3b, Task 5 their cards type into drafts
// (server/legal-drafts.ts) and „Avalda uus tekst“ / „Avalda uus leping“ writes a draft live through these parts, unchanged: their checks, their
// lock, the e-course version's bump (saveLegalParts below).
const legalParts: Parts = {
  privacy: pagePart("privacy", { titleMax: L.legalTitle, bodyMax: L.legal, required: true }),
  terms: pagePart("terms", { titleMax: L.legalTitle, bodyMax: L.legal, required: true }),
  // „E-koolituse leping“: what a student accepts in the cart before buying and at the terms gate of a course opened without a purchase
  // (account-only, no public page): the e-course contract (contracts, D2). Its title is the contract's (ruling R3: Maria's page title as she writes it;
  // the card suggests „E-koolituse leping“) and its text the contract's body. A page that sends the text alone (open since before the title was
  // editable) keeps the stored title. A changed text or title and the new version (settings courseTermsVersion = the save time) are written in
  // this one transaction, so a student is never asked about a text that has no version, nor holds a version of another text.
  // The same text and title again keep the version: nobody is asked to accept what did not change.
  course_terms: part<{ title?: I18n; body: I18n }>({
    tables: ["pages", "settings"],
    schema: z.object({ title: i18n.optional(), body: i18n }),
    read: (q) => readPage(q, TERMS_PAGE_KEY),
    draft: (stored) => ({ title: copyI18n((stored as Page | null)?.title ?? TERMS_PAGE_TITLE), body: copyI18n((stored as Page | null)?.body) }),
    check: (c, v, name) => {
      const title = v.title === undefined ? undefined : c.text(`${name}.title`, v.title, L.legalTitle, { required: true });
      const body = c.text(`${name}.body`, v.body, L.legal, { required: true });
      if (!body || title === null) return null;
      return async (tx, stored) => {
        const old = stored as Page | null;
        const kept = title ?? old?.title ?? TERMS_PAGE_TITLE;
        await upsertPage(tx, { key: TERMS_PAGE_KEY, title: kept, body });
        const same = (a: I18n, b: I18n) => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");
        if (old && same(old.body, body) && same(old.title, kept)) return;
        await setSetting(tx, TERMS_VERSION_KEY, nextTermsVersion(new Date(), await readSetting(tx, TERMS_VERSION_KEY)));
      };
    },
  }),
};

/** The page's read: Seaded's autosaved parts with their versions (their routes' versions). The legal texts are read with their drafts (legal-drafts.ts). */
export const loadSettings = async (q: Q) => (await loadParts(q, Object.fromEntries(SETTINGS_PARTS.map((p) => [p, settingsRead(p)])))) as SavedParts & { values: SettingsValues };

/** The legal parts' names: Privaatsus, Õppetingimused and E-koolituse leping (the contact contract has its own writer, contracts.ts saveContractTexts). */
export type LegalPart = "privacy" | "terms" | "course_terms";
export type LegalValues = { privacy: PageDraft; terms: PageDraft; course_terms: { title: I18n; body: I18n } };

/** The legal parts as stored, each with the version its writer compares (the hash of the stored page row). */
export const loadLegalParts = async (q: Q, only?: LegalPart[]) => (await loadParts(q, legalParts, only)) as SavedParts & { values: LegalValues };

/**
 * The legal parts' writer (what their „Salvesta“ was, unchanged): `sent` is each part's `{ version, value }` — the version the value was made from —,
 * any other part is refused as invalid. Every part checked (the refusals by `<part>.<field>`), then the pages (and for the e-course text the settings)
 * locked, each stored version compared (`stale`: nothing written), the writes; a changed e-course title or text moves `courseTermsVersion` in the same
 * transaction, the same text keeps it. `q` may be a caller's transaction (publishLegal: a savepoint of it).
 */
export const saveLegalParts = (q: Q, sent: Partial<Record<LegalPart, { version: string; value: unknown }>>) => saveSent(q, legalParts, { parts: sent as Record<string, { version: string; value: unknown }> });

// ---------- Uudised: posts ----------

const postSchema = z.object({
  id: z.number().int().positive().max(ID_MAX).nullable(),
  title: i18n,
  slug: text(200),
  excerpt: i18n,
  body: i18n,
  category: i18n,
  coverKey: text(400),
  publishedAt: text(20),
  published: z.boolean(),
});

/** A post's draft and version as the editor loads it (its date in Estonian time). */
export async function postParts(post: Post): Promise<SavedParts & { values: { post: PostDraft } }> {
  return { values: { post: postDraft(post, tallinnFormParts(post.publishedAt).date) }, versions: { post: await contentVersion(post) } };
}

export async function loadPost(q: Q, id: number): Promise<(SavedParts & { values: { post: PostDraft } }) | null> {
  const post = await readPost(q, id);
  return post ? postParts(post) : null;
}

/**
 * The post editor's save: part `post` (PostDraft; id null = a new post). The slug is typed or made from the Estonian
 * title, unique among the posts. The date is the Estonian calendar day: a new day is stored at 09:00 Estonian time, an
 * unchanged day keeps the stored time. A published post needs its cover. An existing post is refused as `stale` when it
 * was saved elsewhere since its version.
 */
export async function savePostForm(db: Db, formData: FormData): Promise<EditResult> {
  const sent = payload(formData)?.parts.post;
  if (!sent) return { ok: false, error: "invalid" };
  const parsed = postSchema.safeParse(sent.value);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;
  const c = new Check();
  const title = c.text("post.title", d.title, L.postTitle, { required: true });
  const typed = d.slug.trim().toLowerCase();
  const slug = typed || slugify(d.title.et.trim()).slice(0, SLUG_MAX).replace(/-+$/, "");
  if (!isSlug(slug)) c.fail("post.slug", typed || d.title.et.trim() ? "slugFormat" : "required");
  const excerpt = c.text("post.excerpt", d.excerpt, L.excerpt);
  const body = c.text("post.body", d.body, L.postBody);
  const category = c.text("post.category", d.category, L.category, { required: true });
  const coverKey = c.image("post.coverKey", d.coverKey, { required: d.published });
  const date = d.publishedAt.trim();
  const newDay = date ? tallinnInstant(date, "09:00") : null;
  if (!newDay) c.fail("post.publishedAt", date ? "date" : "required");
  if (!c.ok || !title || !category || !newDay) return invalid(c.errors);

  const fields = { slug, title, excerpt: orEmpty(excerpt), body: orEmpty(body), category, coverKey, published: d.published };
  const outcome = await db.transaction(async (tx) => {
    await lockTables(tx, ["posts"]);
    const stored = d.id != null ? await readPost(tx, d.id) : null;
    if (d.id != null) {
      if (!stored) return "notFound" as const;
      if ((await contentVersion(stored)) !== sent.version) return "stale" as const;
    }
    if (await isPostSlugTaken(tx, slug, d.id)) return "slugTaken" as const;
    // the same day keeps the stored time (the order of posts on one day stays); a new day starts at 09:00
    const publishedAt = stored && tallinnFormParts(stored.publishedAt).date === date ? stored.publishedAt : newDay;
    let id: number;
    if (stored) {
      await updatePost(tx, stored.id, { ...fields, publishedAt });
      id = stored.id;
    } else id = (await insertPost(tx, { ...fields, publishedAt })).id;
    const saved = await loadPost(tx, id); // read back inside the transaction: what this save stored
    return { id, saved: saved! };
  });
  if (outcome === "slugTaken") return invalid({ "post.slug": "slugTaken" });
  if (outcome === "notFound" || outcome === "stale") return { ok: false, error: outcome };
  return { ok: true, id: outcome.id, created: d.id == null, saved: outcome.saved };
}

/** "Kustuta postitus": field id. */
export async function deletePostForm(db: Db, formData: FormData): Promise<EditResult> {
  const id = z.coerce.number().int().positive().max(ID_MAX).safeParse(field(formData, "id"));
  if (!id.success) return { ok: false, error: "invalid" };
  return (await deletePostRow(db, id.data)) ? { ok: true, id: id.data, deleted: true } : { ok: false, error: "notFound" };
}
