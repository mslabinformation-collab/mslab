import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { stableJson } from "@/lib/version";
import type { SiteEntity } from "./site-entities";

// The site editors' field labels (admin UX pass piece 4a; piece4-texts S4-1, S4-2, S4-12, S4-17, S4-34; ruling R-i), pure: the server's publish
// names a blocked part's fields with them (server/site-drafts.ts), and the editors' PublishBar lists the changes with them (Task 2's differ is
// built on siteFieldLabel). A field is named by its path in the part's value as the editor holds it (domain/site-entities.ts, the same names as
// domain/site-checks.ts): a package's `price`, a list row's `slides.2.title` (numbered by its place in the draft, from 1: „Slaid 3 pealkiri“), a
// list as a whole by its own name (`slides`: „Slaidid“). Old iPads run it too: no lookbehind (tests/unit/old-safari.test.ts).

const T = adminEt.siteChanges;

/** A slide's fields → their words (a slide's focal points are its picture, S4-10). */
const SLIDE_FIELDS: Record<string, keyof typeof T.home.slideFields> = {
  imageKey: "image",
  imagePos: "image",
  imagePosMobile: "image",
  kicker: "kicker",
  title: "title",
  text: "text",
  ctaLabel: "ctaLabel",
  ctaHref: "ctaHref",
  tone: "tone",
  active: "active",
};

/** The trainer card's fields → their labels (S4-17: the picture and its focal point are „Portree“, every stat is „Numbrid“). */
const TRAINER_FIELDS: Record<string, string> = { portraitKey: T.trainer.portrait, portraitPos: T.trainer.portrait, name: T.trainer.name, role: T.trainer.role, stats: T.trainer.stats };

/** A package's fields → their labels' templates (S4-34). */
const PACKAGE_FIELDS: Record<string, string> = { name: T.practice.name, tagline: T.practice.tagline, models: T.practice.models, durationLabel: T.practice.durationLabel, price: T.practice.price };

/** A row's place in the draft as the label says it (from 1), or null when the path names no row. */
const rowNumber = (s: string | undefined): number | null => (s !== undefined && /^\d{1,4}$/.test(s) ? Number(s) + 1 : null);

/**
 * S4-1's label of a field of a site part, as S4-12 (Avaleht), S4-17 (Koolitaja) and S4-34 (Praktika) give it: `Slaid 3 pilt`, `KKK vastus 6`,
 * `MAXI punkt 4`, `Nimi`; the list's card title for a list as a whole (`Slaidid`, `KKK`, `Galerii`, `Numbrid`, `MAXI punktid`). `path`: the field's
 * path in the part's editor value (a path this does not know is named by its part or list).
 */
export function siteFieldLabel(entity: SiteEntity, part: string, path: string): string {
  const [field, row, sub] = path.split(".");
  const n = rowNumber(row);
  if (entity === "home") {
    if (part === "slides") return n !== null && sub !== undefined && Object.hasOwn(SLIDE_FIELDS, sub) ? fill(T.home.slide, { n, field: T.home.slideFields[SLIDE_FIELDS[sub]] }) : T.home.slides;
    if (part === "faq") return n !== null && (sub === "q" || sub === "a") ? fill(sub === "q" ? T.home.question : T.home.answer, { n }) : T.home.faq;
    return part === "teaser" ? T.home.teaser : T.home.statement;
  }
  if (entity === "trainer") {
    if (part === "trainer") return Object.hasOwn(TRAINER_FIELDS, field) ? TRAINER_FIELDS[field] : T.trainer.portrait;
    if (part === "works") return T.trainer.works;
    if (part === "center_story" || part === "trainer_journey") return T.trainer[part];
    return T.trainer.bio;
  }
  if (field === "items") return n !== null ? fill(T.practice.item, { code: part, n }) : fill(T.practice.items, { code: part });
  return fill(Object.hasOwn(PACKAGE_FIELDS, field) ? PACKAGE_FIELDS[field] : T.practice.name, { code: part });
}

/**
 * S4-2: a label as „Puudub: …“ lists it — its first letter in lower case, except a first word written in capitals (KKK, MINI, MAXI, MS LAB):
 * `slaid 3 pilt`, `KKK vastus 6`, `MAXI hind`, `nimi`.
 */
export function missingCase(label: string): string {
  const first = label.split(" ")[0];
  const capitals = first.length > 1 && first === first.toLocaleUpperCase("et") && first !== first.toLocaleLowerCase("et");
  return capitals ? label : label.charAt(0).toLocaleLowerCase("et") + label.slice(1);
}

/** A text in two languages with its Russian side "" when it has none, so that a Russian text typed and emptied again is no change. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (typeof o.et === "string" && keys.every((k) => k === "et" || k === "ru") && (o.ru === undefined || typeof o.ru === "string")) return { et: o.et, ru: o.ru ?? "" };
  return Object.fromEntries(keys.map((k) => [k, canonical(o[k])]));
}

/** Do two values of a site part read the same on the editor's screen? (A text without its Russian side and one with it empty do.) */
export const sameSiteValue = (a: unknown, b: unknown): boolean => stableJson(canonical(a)) === stableJson(canonical(b));

/**
 * The labels of a part's changes, field by field of its editor value (a list field changed: the list's label), in the fields' order and once each.
 * The first version, for the publish's "changed" answer (server/site-drafts.ts); the PublishBar's row-by-row differ (R-i, with `(RU)`) builds on it.
 */
export function partChangeLabels(entity: SiteEntity, part: string, live: Record<string, unknown>, draft: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of Object.keys({ ...live, ...draft })) {
    if (sameSiteValue(live[field], draft[field])) continue;
    const label = siteFieldLabel(entity, part, field);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
