import type { I18n } from "@/i18n/field";
import { isStorableImageKey } from "@/lib/media";
import { textProblem } from "./lesson-limits";
import { parseEuroCents } from "./money";
import { hasLocalePrefix, isFocal, isSiteHref, SITE_LIMITS as L, type FaqDraft, type PackageDraft, type PageDraft, type SlideDraft, type TrainerDraft, type WorkDraft } from "./site-editor";

// The site editors' LOOSE checks (admin UX pass piece 4a, ruling R-d): what a draft save of Avaleht, Koolitaja and Praktika refuses. A draft may be
// incomplete — a new slide without its picture or title, a package with its price emptied, a FAQ row without its answer, a stat without its label —
// so nothing is required here: what is missing is said at „Avalda muudatused“, where the parts' strict checks run (server/admin-site.ts Part.check;
// S4-2 „Puudub: …“). Everything else the strict check refuses is refused here too, at the field (B3): a text over its limit, a list over its cap, and
// a value of the wrong form (a link, a focal point, a picture key that is no upload, a price, a whole number). The rules are the ones the strict
// check (server/edit-check.ts Check) runs on, from the same pure helpers, so a draft this passes fails the strict check only on what is missing.
//
// The names are the fields' paths in the part's value as its editor holds it (domain/site-entities.ts): a package's `price`, the trainer card's
// `stats.0.label`, a list part's `slides.2.title`, and the list's own name (`slides`) for the list as a whole. Pure: the browser runs them too.

/** Why a draft save refuses a field (a subset of server/edit-check.ts FieldError, the texts adminEt.courseEditor.errors). */
export type LooseCode = "tooLong" | "tooMany" | "href" | "localeHref" | "focal" | "image" | "whole" | "amount";
export type LooseProblems = Record<string, LooseCode>;

const blank = (f: I18n) => !f.et.trim() && !(f.ru ?? "").trim();

/** Collects the first problem of each field, as Check does. */
class Loose {
  readonly problems: LooseProblems = {};
  fail(name: string, code: LooseCode) {
    this.problems[name] ??= code;
  }
  /** Check.text without its required: each language at most `max` (trimmed). Only the Russian one there is missing the Estonian one: the publish says so. */
  text(name: string, f: I18n, max: number) {
    if (textProblem(f, max) === "tooLong") this.fail(name, "tooLong");
  }
  /** Check.plain without its required. */
  plain(name: string, v: string, max: number) {
    if (v.trim().length > max) this.fail(name, "tooLong");
  }
  /** Check.image: an upload or a picture of the site; empty waits. */
  image(name: string, key: string) {
    const v = key.trim();
    if (v && !isStorableImageKey(v)) this.fail(name, "image");
  }
  /** Check.focal: "x% y%" (never empty: the editors start one at the middle). */
  focal(name: string, v: string) {
    if (!isFocal(v.trim())) this.fail(name, "focal");
  }
  /** Check.href: a path on this site without its locale, or an https:// address; empty waits. */
  href(name: string, value: string) {
    const v = value.trim();
    if (!v) return;
    if (!isSiteHref(v)) this.fail(name, "href");
    else if (hasLocalePrefix(v)) this.fail(name, "localeHref");
  }
  /** Check.whole: a whole number in min…max; empty waits. */
  whole(name: string, value: string, min: number, max: number) {
    const v = value.trim();
    if (v && (!/^\d{1,4}$/.test(v) || Number(v) < min || Number(v) > max)) this.fail(name, "whole");
  }
  /** Check.amount: euros as typed; empty waits. */
  amount(name: string, value: string) {
    if (value.trim() && parseEuroCents(value) === null) this.fail(name, "amount");
  }
}

/** Avaleht's slides (`{ slides }`): at most 8; each slide's texts, picture, focal points and link. */
export function looseSlides(slides: SlideDraft[]): LooseProblems {
  const c = new Loose();
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
  return c.problems;
}

/** Avaleht's FAQ (`{ faq }`): at most 30 rows that are not empty (an empty row is dropped at the publish); each question's and answer's length. */
export function looseFaq(items: FaqDraft[]): LooseProblems {
  const c = new Loose();
  let rows = 0;
  for (const [i, item] of items.entries()) {
    if (blank(item.q) && blank(item.a)) continue;
    rows++;
    c.text(`faq.${i}.q`, item.q, L.question);
    c.text(`faq.${i}.a`, item.a, L.answer);
  }
  if (rows > L.faq) c.fail("faq", "tooMany");
  return c.problems;
}

/** A text-only page part (`{ body }`: the statement, the trainer card's text, the trainer's bio). */
export function looseBody(v: { body: I18n }, max: number): LooseProblems {
  const c = new Loose();
  c.text("body", v.body, max);
  return c.problems;
}

/** A page part with its title (`{ title, body }`: the trainer page's two stories). */
export function loosePage(v: PageDraft, titleMax: number, bodyMax: number): LooseProblems {
  const c = new Loose();
  c.text("title", v.title, titleMax);
  c.text("body", v.body, bodyMax);
  return c.problems;
}

/** Koolitaja's card (TrainerDraft): the portrait and its focal point, name, role, and at most 3 stats that are not empty. */
export function looseTrainer(v: TrainerDraft): LooseProblems {
  const c = new Loose();
  c.image("portraitKey", v.portraitKey);
  c.focal("portraitPos", v.portraitPos);
  c.text("name", v.name, L.trainerName);
  c.text("role", v.role, L.role);
  let stats = 0;
  for (const [i, s] of v.stats.entries()) {
    if (!s.value.trim() && blank(s.label)) continue;
    stats++;
    c.plain(`stats.${i}.value`, s.value, L.statValue);
    c.text(`stats.${i}.label`, s.label, L.statLabel);
  }
  if (stats > L.stats) c.fail("stats", "tooMany");
  return c.problems;
}

/** Koolitaja's gallery (`{ works }`): at most 24 pictures; each picture's key and its text. */
export function looseWorks(items: WorkDraft[]): LooseProblems {
  const c = new Loose();
  if (items.length > L.works) c.fail("works", "tooMany");
  for (const [i, x] of items.entries()) {
    c.image(`works.${i}.key`, x.key);
    c.text(`works.${i}.alt`, x.alt, L.alt);
  }
  return c.problems;
}

/** A practice package (PackageDraft): its texts, the number of models, the price, and at most 20 points that are not empty. */
export function loosePackage(v: PackageDraft): LooseProblems {
  const c = new Loose();
  c.text("name", v.name, L.packageName);
  c.text("tagline", v.tagline, L.tagline);
  c.whole("models", v.models, 0, L.models);
  c.text("durationLabel", v.durationLabel, L.duration);
  c.amount("price", v.price);
  let items = 0;
  for (const [i, item] of v.items.entries()) {
    if (blank(item)) continue;
    items++;
    if (item.et.trim().length > L.item || (item.ru ?? "").trim().length > L.item) c.fail(`items.${i}`, "tooLong");
  }
  if (items > L.packageItems) c.fail("items", "tooMany");
  return c.problems;
}
