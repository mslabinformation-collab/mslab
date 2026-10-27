import { tallinnInstant } from "./calendar";
import { Check, type FieldError } from "./field-check";
import { isBlankStat, SITE_LIMITS as L, type FaqDraft, type PackageDraft, type PageDraft, type SlideDraft, type TrainerDraft, type WorkDraft } from "./site-editor";
import type { PostPartValue } from "./site-entities";
import type { I18n } from "@/i18n/field";
import { isSlug, SLUG_MAX, slugify } from "@/lib/slug";

// The site editors' LOOSE checks (admin UX pass piece 4a, ruling R-d): what a draft save of Avaleht, Koolitaja and Praktika refuses. A draft may be
// incomplete — a new slide without its picture or title, a package with its price emptied, a FAQ row without its answer, a stat without its label —
// so nothing is required here: what is missing is said at „Avalda muudatused“, where the parts' strict checks run (server/admin-site.ts Part.check;
// S4-2 „Puudub: …“). Everything else the strict check refuses is refused here too, at the field (B3): a text over its limit, a list over its cap, and
// a value of the wrong form (a link, a focal point, a picture key that is no upload, a price, a whole number).
//
// The rules ARE the strict check's (Task 1 review M1): each field goes through the same Check method (domain/field-check.ts) with the same limit,
// only without `required`, and what Check calls missing even then — a text with only its Russian side ("required"), a point without its Estonian
// text ("listEt") — is left for the publish. So a draft this passes fails the strict check only on what is missing.
//
// The names are the fields' paths in the part's value as its editor holds it (domain/site-entities.ts): a package's `price`, the trainer card's
// `stats.0.label`, a list part's `slides.2.title`, and the list's own name (`slides`) for the list as a whole. Pure: the browser runs them too.
// A post (piece 4b, loosePost below) is the one part with two fields held at every save: no post is stored without its Estonian title and its day.

export type LooseProblems = Record<string, FieldError>;

/** The codes of a missing value (the publish's „Puudub: …“; server/site-drafts.ts holds a part back with them). */
export const MISSING_CODES: readonly FieldError[] = ["required", "imageRequired", "listEt"];

/** A Check's refusals without the missing ones. */
function looseOf(c: Check): LooseProblems {
  return Object.fromEntries(Object.entries(c.errors).filter(([, code]) => !MISSING_CODES.includes(code)));
}

const blank = (f: I18n) => !f.et.trim() && !(f.ru ?? "").trim();

/** Avaleht's slides (`{ slides }`): at most 8; each slide's picture, focal points, texts and link (the part's check, without `required`). */
export function looseSlides(slides: SlideDraft[]): LooseProblems {
  const c = new Check();
  if (slides.length > L.slides) c.fail("slides", "tooMany");
  for (const [i, s] of slides.entries()) {
    const p = `slides.${i}.`;
    c.image(`${p}imageKey`, s.imageKey);
    c.focal(`${p}imagePos`, s.imagePos);
    c.focal(`${p}imagePosMobile`, s.imagePosMobile);
    c.text(`${p}kicker`, s.kicker, L.slideKicker);
    c.text(`${p}title`, s.title, L.slideTitle);
    c.text(`${p}text`, s.text, L.slideText);
    c.text(`${p}ctaLabel`, s.ctaLabel, L.ctaLabel);
    c.href(`${p}ctaHref`, s.ctaHref);
  }
  return looseOf(c);
}

/** Avaleht's FAQ (`{ faq }`): at most 30 rows that are not empty (an empty row is dropped at the publish); each question's and answer's length. */
export function looseFaq(items: FaqDraft[]): LooseProblems {
  const c = new Check();
  let rows = 0;
  for (const [i, item] of items.entries()) {
    if (blank(item.q) && blank(item.a)) continue;
    rows++;
    c.text(`faq.${i}.q`, item.q, L.question);
    c.text(`faq.${i}.a`, item.a, L.answer);
  }
  if (rows > L.faq) c.fail("faq", "tooMany");
  return looseOf(c);
}

/** A text-only page part (`{ body }`: the statement, the trainer card's text, the trainer's bio). */
export function looseBody(v: { body: I18n }, max: number): LooseProblems {
  const c = new Check();
  c.text("body", v.body, max);
  return looseOf(c);
}

/** A page part with its title (`{ title, body }`: the trainer page's two stories). */
export function loosePage(v: PageDraft, titleMax: number, bodyMax: number): LooseProblems {
  const c = new Check();
  c.text("title", v.title, titleMax);
  c.text("body", v.body, bodyMax);
  return looseOf(c);
}

/** Koolitaja's card (TrainerDraft): the portrait and its focal point, name, role, and at most 3 stats that are not empty. */
export function looseTrainer(v: TrainerDraft): LooseProblems {
  const c = new Check();
  c.image("portraitKey", v.portraitKey);
  c.focal("portraitPos", v.portraitPos);
  c.text("name", v.name, L.trainerName);
  c.text("role", v.role, L.role);
  let stats = 0;
  for (const [i, s] of v.stats.entries()) {
    if (isBlankStat(s)) continue;
    stats++;
    c.plain(`stats.${i}.value`, s.value, L.statValue);
    c.text(`stats.${i}.label`, s.label, L.statLabel);
  }
  if (stats > L.stats) c.fail("stats", "tooMany");
  return looseOf(c);
}

/** Koolitaja's gallery (`{ works }`): at most 24 pictures; each picture's key and its text. */
export function looseWorks(items: WorkDraft[]): LooseProblems {
  const c = new Check();
  if (items.length > L.works) c.fail("works", "tooMany");
  for (const [i, x] of items.entries()) {
    c.image(`works.${i}.key`, x.key);
    c.text(`works.${i}.alt`, x.alt, L.alt);
  }
  return looseOf(c);
}

/**
 * A practice package (PackageDraft): its texts, the number of models, the price, and its points. Each point goes through Check.list on its own (so
 * one without its Estonian text, which waits for the publish, does not hide a later one that is too long), named by its place; then at most 20 that
 * are not empty.
 */
export function loosePackage(v: PackageDraft): LooseProblems {
  const c = new Check();
  c.text("name", v.name, L.packageName);
  c.text("tagline", v.tagline, L.tagline);
  c.whole("models", v.models, 0, L.models);
  c.text("durationLabel", v.durationLabel, L.duration);
  c.amount("price", v.price);
  for (const [i, item] of v.items.entries()) c.list(`items.${i}`, [item], L.item, 1);
  if (v.items.filter((item) => !blank(item)).length > L.packageItems) c.fail("items", "tooMany");
  return looseOf(c);
}

// ---------- Uudised: a post (piece 4b, rulings R-a, R-g) ----------

/**
 * A post's address as it is stored (today's rule, R-g): the typed one in small letters, or, typed empty, the one made from the Estonian title (at most
 * SLUG_MAX, no dash at its end). The stored address must then be a slug (lib/slug.ts isSlug) that no other post has.
 */
export const postSlug = (typed: string, titleEt: string): string => typed.trim().toLowerCase() || slugify(titleEt.trim()).slice(0, SLUG_MAX).replace(/-+$/, "");

/** Is the post's day a calendar day (YYYY-MM-DD, as the date field writes it)? The day is stored at 09:00 Estonian time (server/admin-site.ts). */
export const isPostDay = (day: string): boolean => tallinnInstant(day.trim(), "09:00") !== null;

/**
 * A post's save (PostPartValue; piece 4b R-a), the same for a draft and for a post that saves straight to its row: the texts' lengths, a typed
 * address's form, the cover's key. Two fields are held at the field even here, because no post can be stored without them (B3; S4-Q1: the Estonian
 * title never reaches the publish's check): the Estonian title and the day. What waits for the publish (S4-Q1 A, „Puudub: …“): the cover, the
 * category, the text, the Russian title and text — and so a text with only its Russian side (Check's "required"), as on the other site parts.
 */
export function loosePost(v: PostPartValue): LooseProblems {
  const c = new Check();
  c.text("title", v.title, L.postTitle, { required: true });
  const typed = v.slug.trim();
  if (typed && !isSlug(typed.toLowerCase())) c.fail("slug", "slugFormat");
  c.text("category", v.category, L.category);
  c.text("excerpt", v.excerpt, L.excerpt);
  c.text("body", v.body, L.postBody);
  c.image("coverKey", v.coverKey);
  const day = v.publishedAt.trim();
  if (!day) c.fail("publishedAt", "required");
  else if (!isPostDay(day)) c.fail("publishedAt", "date");
  const held = new Set(["title", "publishedAt"]);
  return Object.fromEntries(Object.entries(c.errors).filter(([name, code]) => held.has(name) || !MISSING_CODES.includes(code)));
}
