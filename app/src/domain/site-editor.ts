// The site content editors' model (Task 13B: home page, practice, trainer, news, campaign, settings), shared by the
// browser (components/admin/*Editor.tsx) and the server (server/admin-site.ts): the drafts the editors hold and send,
// the stored-value → draft conversions, the limits, and the checks for links and focal points. Pure: no database, no
// React.

import type { Campaign } from "@/db/schema";
import type { I18n } from "@/i18n/field";
import { compactIban } from "./account-cards";
import { centsToInput } from "./money";

export const SITE_LIMITS = {
  slides: 8,
  slideKicker: 80,
  slideTitle: 120,
  slideText: 300,
  ctaLabel: 40,
  href: 300,
  statement: 400,
  teaser: 300,
  faq: 30,
  question: 200,
  answer: 2000,
  packageName: 40,
  tagline: 160,
  models: 20,
  duration: 40,
  packageItems: 20,
  item: 300,
  trainerName: 80,
  role: 160,
  stats: 3,
  statValue: 12,
  statLabel: 40,
  bio: 5000,
  works: 24,
  alt: 200,
  storyTitle: 120,
  story: 10_000,
  postTitle: 160,
  excerpt: 400,
  postBody: 20_000,
  category: 40,
  campaignKicker: 60,
  campaignTitle: 120,
  campaignText: 300,
  code: 24,
  email: 120,
  phone: 40,
  address: 200,
  url: 300,
  discount: 20,
  legalTitle: 120,
  legal: 30_000,
  receiver: 120,
  /** as typed, spaces included (34 characters at most once they are taken out) */
  iban: 60,
  bank: 80,
  referencePrefix: 30,
};

// ---------- links ----------

const UNSAFE_CHARS = /[\s\\<>"'`\u0000-\u001f\u007f]/;

/**
 * A link an admin may store for a button (hero CTA, campaign CTA): a path on this site ("/koolitused",
 * "/praktika#taotlus"; not "//host", which a browser reads as another site) or an https:// address. Anything else
 * (javascript:, data:, http:, mailto:, relative text) is refused.
 */
export function isSiteHref(value: string): boolean {
  if (!value || value.length > SITE_LIMITS.href || UNSAFE_CHARS.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  return isHttpsUrl(value);
}

/** An absolute https:// address with a host and no user name or password in it (social links, outside CTAs). */
export function isHttpsUrl(value: string): boolean {
  if (!value || value.length > SITE_LIMITS.url || UNSAFE_CHARS.test(value)) return false;
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

const LOCALE_PREFIX = /^\/(ru|et)(?=$|[/?#])/i;

/**
 * Does a site path start with a locale ("/ru/praktika", "/et", "/ru?x")? The site adds the locale itself, so a stored
 * link is written without it (the admin refuses one with it; "/ruumid" is not a locale).
 */
export const hasLocalePrefix = (path: string) => LOCALE_PREFIX.test(path);

/**
 * A stored button link for the page: a site path gets the locale prefix (via `to`), an https address stays; anything
 * else falls back. A path stored with a locale already ("/ru/praktika") loses it first, so it never becomes "/ru/ru/…".
 * What is left must still be a path on this site: "/ru//evil.example" would lose "/ru" and become "//evil.example",
 * which a browser opens as another site, so such a value falls back as well. ("/\evil.example", which browsers read the
 * same way, never gets this far: isSiteHref refuses any backslash.)
 */
export function linkFor(value: string, to: (path: string) => string, fallback: string): string {
  if (!isSiteHref(value)) return to(fallback);
  if (!value.startsWith("/")) return value;
  const bare = value.replace(LOCALE_PREFIX, "");
  if (bare.startsWith("//")) return to(fallback);
  return to(bare === "" || /^[?#]/.test(bare) ? `/${bare}` : bare);
}

// ---------- focal points ("x% y%", CSS object-position) ----------

export type Focal = { x: number; y: number };
export const DEFAULT_FOCAL = "50% 50%";

/**
 * A dark hero slide's phone focal point by default. On a phone a dark slide's picture runs 80% past the right edge
 * (prototype B, Hero.module.css), so its middle (50%) shows the side of the head; about 90% across shows the face.
 */
export const DARK_MOBILE_FOCAL = "90% 50%";

/** The phone focal point after a slide's tone changes: the default follows the tone; a point Maria has set stays. */
export function mobileFocalForTone(current: string, tone: "light" | "dark"): string {
  if (tone === "dark" && current === DEFAULT_FOCAL) return DARK_MOBILE_FOCAL;
  if (tone === "light" && current === DARK_MOBILE_FOCAL) return DEFAULT_FOCAL;
  return current;
}
const FOCAL = /^(\d{1,3})% (\d{1,3})%$/;

export function parseFocal(value: string | null | undefined): Focal | null {
  const m = FOCAL.exec((value ?? "").trim());
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x <= 100 && y <= 100 ? { x, y } : null;
}

export const isFocal = (value: string) => parseFocal(value) !== null;

/** Whole percentages, clamped to 0…100. */
export function formatFocal(f: Focal): string {
  const c = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 50)));
  return `${c(f.x)}% ${c(f.y)}%`;
}

// ---------- the trainer's portrait ----------

/**
 * The seed portrait (maria-standing) has much white space around Maria; the public pages zoom into it (Task 9 review).
 * An uploaded portrait is shown as it is, framed by its focal point only.
 */
export const SEED_PORTRAIT = "/seed/maria-standing.jpg";
/** Where the seed portrait was framed before the focal point existed. */
export const SEED_PORTRAIT_FOCAL = "50% 20%";

/** How a portrait is framed on the site: its focal point, and the zoom for the seed photo only. */
export function portraitFraming(key: string, pos: string | null | undefined): { pos: string; zoom: boolean } {
  const seed = key === SEED_PORTRAIT;
  return { pos: parseFocal(pos) ? pos!.trim() : seed ? SEED_PORTRAIT_FOCAL : DEFAULT_FOCAL, zoom: seed };
}

// ---------- drafts ----------

const empty = (): I18n => ({ et: "" });
/** A copy of a stored text (the RU key only when it exists), or an empty one. */
export const copyI18n = (f: I18n | null | undefined): I18n => (f && typeof f.et === "string" ? { et: f.et, ...(typeof f.ru === "string" ? { ru: f.ru } : {}) } : empty());
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const i18nOf = (v: unknown): I18n => {
  const o = obj(v);
  return typeof o.et === "string" ? copyI18n(o as I18n) : empty();
};

/** List rows carry a client key (`uid`) so that React keeps a row's fields while rows move; the server ignores it. */
export type Keyed = { uid: string };

export type SlideDraft = Keyed & {
  /** The stored slide (kept on save, so the slide keeps its id); null for a new one. */
  id: number | null;
  imageKey: string;
  imagePos: string;
  imagePosMobile: string;
  tone: "light" | "dark";
  kicker: I18n;
  title: I18n;
  text: I18n;
  ctaLabel: I18n;
  ctaHref: string;
  active: boolean;
};

type StoredSlide = Omit<SlideDraft, "uid" | "tone"> & { id: number; tone: string };

export function slideDraft(s: StoredSlide): SlideDraft {
  return {
    uid: `s${s.id}`,
    id: s.id,
    imageKey: s.imageKey,
    imagePos: parseFocal(s.imagePos) ? s.imagePos : DEFAULT_FOCAL,
    imagePosMobile: parseFocal(s.imagePosMobile) ? s.imagePosMobile : DEFAULT_FOCAL,
    tone: s.tone === "dark" ? "dark" : "light",
    kicker: copyI18n(s.kicker),
    title: copyI18n(s.title),
    text: copyI18n(s.text),
    ctaLabel: copyI18n(s.ctaLabel),
    ctaHref: s.ctaHref,
    active: s.active,
  };
}

export function newSlideDraft(uid: string): SlideDraft {
  return {
    uid,
    id: null,
    imageKey: "",
    imagePos: DEFAULT_FOCAL,
    imagePosMobile: DEFAULT_FOCAL,
    tone: "light",
    kicker: empty(),
    title: empty(),
    text: empty(),
    ctaLabel: empty(),
    ctaHref: "/koolitused",
    active: true,
  };
}

/** A FAQ item; `id`: the stored item (kept on save), null for a new one. */
export type FaqDraft = Keyed & { id: number | null; q: I18n; a: I18n };
export const faqDraft = (f: { id: number; q: I18n; a: I18n }): FaqDraft => ({ uid: `f${f.id}`, id: f.id, q: copyI18n(f.q), a: copyI18n(f.a) });

/** An editable text page (statement, trainer bio, stories, legal pages). */
export type PageDraft = { title: I18n; body: I18n };
export const pageDraft = (p: { title: I18n; body: I18n } | null): PageDraft => ({ title: copyI18n(p?.title), body: copyI18n(p?.body) });

export type PackageDraft = { name: I18n; tagline: I18n; models: string; durationLabel: I18n; price: string; items: I18n[] };
export function packageDraft(p: { name: I18n; tagline: I18n; models: number; durationLabel: I18n; price: number; items: I18n[] }): PackageDraft {
  return {
    name: copyI18n(p.name),
    tagline: copyI18n(p.tagline),
    models: String(p.models),
    durationLabel: copyI18n(p.durationLabel),
    price: centsToInput(p.price),
    items: p.items.map(copyI18n),
  };
}

export type StatDraft = Keyed & { value: string; label: I18n };
export type TrainerDraft = { portraitKey: string; portraitPos: string; name: I18n; role: I18n; stats: StatDraft[] };

/** settings.trainer → the trainer card's draft (the portrait's focal point defaults as the site frames it). */
export function trainerDraft(value: unknown): TrainerDraft {
  const t = obj(value);
  const portraitKey = str(t.portraitKey);
  return {
    portraitKey,
    portraitPos: portraitFraming(portraitKey, str(t.portraitPos)).pos,
    // a plain string (before round 2) is the Estonian name
    name: typeof t.name === "string" ? { et: t.name } : i18nOf(t.name),
    role: i18nOf(t.role),
    stats: (Array.isArray(t.stats) ? t.stats : []).map((s, i) => ({ uid: `t${i}`, value: str(obj(s).value), label: i18nOf(obj(s).label) })),
  };
}

export type WorkDraft = { key: string; alt: I18n };

export type CampaignDraft = {
  active: boolean;
  kicker: I18n;
  title: I18n;
  text: I18n;
  code: string;
  ctaLabel: I18n;
  ctaHref: string;
  imageKey: string;
};

/** M4: the campaign button says "Leia enda koolitus" unless Maria writes something else. */
export const CAMPAIGN_CTA = "Leia enda koolitus";

export function campaignDraft(c: CampaignDraft | null): CampaignDraft {
  if (!c) return { active: false, kicker: empty(), title: empty(), text: empty(), code: "", ctaLabel: { et: CAMPAIGN_CTA }, ctaHref: "/koolitused", imageKey: "" };
  return {
    active: c.active,
    kicker: copyI18n(c.kicker),
    title: copyI18n(c.title),
    text: copyI18n(c.text),
    code: c.code,
    ctaLabel: c.ctaLabel?.et?.trim() ? copyI18n(c.ctaLabel) : { ...copyI18n(c.ctaLabel), et: CAMPAIGN_CTA },
    ctaHref: c.ctaHref,
    imageKey: c.imageKey,
  };
}

/** Hüpikaken's newsletter popup (phase 2c): shown or not, and its kicker, title, text and picture (no code and no button: it has the form). */
export type NewsletterPopupDraft = { active: boolean; kicker: I18n; title: I18n; text: I18n; imageKey: string };

export function newsletterPopupDraft(c: Campaign | null): NewsletterPopupDraft {
  if (!c) return { active: false, kicker: empty(), title: empty(), text: empty(), imageKey: "" };
  return { active: c.active, kicker: copyI18n(c.kicker), title: copyI18n(c.title), text: copyI18n(c.text), imageKey: c.imageKey };
}

export type ContactDraft = { email: string; phone: string; address: string; instagram: string; facebook: string };
export function contactDraft(value: unknown): ContactDraft {
  const c = obj(value);
  return { email: str(c.email), phone: str(c.phone), address: str(c.address), instagram: str(c.instagram), facebook: str(c.facebook) };
}

/** Seaded "Uudiskiri" (settings key "newsletter"): the discount label and the welcome code ("Tervituskood", phase 2c; "" = none). */
export type NewsletterDraft = { discountLabel: string; welcomeCode: string };
export const newsletterDraft = (value: unknown): NewsletterDraft => ({ discountLabel: str(obj(value).discountLabel), welcomeCode: str(obj(value).welcomeCode) });

/** Seaded → „Maksmine“'s bank fields (settings key "prepayment"): where students pay, shown on their unpaid contact-course cards. */
export type PrepaymentDraft = { receiver: string; iban: string; bank: string; referencePrefix: string };
export function prepaymentDraft(value: unknown): PrepaymentDraft {
  const p = obj(value);
  return { receiver: str(p.receiver), iban: str(p.iban), bank: str(p.bank), referencePrefix: str(p.referencePrefix) };
}

/** An IBAN as typed → as stored: every space (also a non-breaking one, as copied from a bank page) taken out, upper case. */
export const normalizeIban = (typed: string): string => compactIban(typed);

/** The shape of a stored IBAN: country letters, two check digits, 10–30 letters and digits (no checksum test: a typo shows on the bank's side). */
export const isIban = (iban: string): boolean => /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban);

export type PostDraft = {
  id: number | null;
  title: I18n;
  slug: string;
  excerpt: I18n;
  body: I18n;
  category: I18n;
  coverKey: string;
  /** Estonian calendar date, YYYY-MM-DD. */
  publishedAt: string;
  published: boolean;
};

export function postDraft(p: { id: number; title: I18n; slug: string; excerpt: I18n; body: I18n; category: I18n; coverKey: string; published: boolean }, date: string): PostDraft {
  return {
    id: p.id,
    title: copyI18n(p.title),
    slug: p.slug,
    excerpt: copyI18n(p.excerpt),
    body: copyI18n(p.body),
    category: copyI18n(p.category),
    coverKey: p.coverKey,
    publishedAt: date,
    published: p.published,
  };
}

export function newPostDraft(today: string): PostDraft {
  return { id: null, title: empty(), slug: "", excerpt: empty(), body: empty(), category: empty(), coverKey: "", publishedAt: today, published: false };
}
