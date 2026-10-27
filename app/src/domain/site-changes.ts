import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { stableJson } from "@/lib/version";
import { HOME_PARTS, TRAINER_PARTS, type SiteDraftEntity } from "./site-entities";

// The site editors' field labels (admin UX pass piece 4a; piece4-texts S4-1, S4-2, S4-12, S4-17, S4-34; ruling R-i), pure: the server's publish
// names a blocked part's fields with them (server/site-drafts.ts), and the editors' PublishBar lists the changes with them (siteChangeLabels, the
// row-by-row differ of a draft against live). A field is named by its path in the part's value as the editor holds it (domain/site-entities.ts,
// the same names as domain/site-checks.ts): a package's `price`, a list row's `slides.2.title` (numbered by its place in the draft, from 1: „Slaid 3
// pealkiri“), a list as a whole by its own name (`slides`: „Slaidid“). Old iPads run it too: no lookbehind (tests/unit/old-safari.test.ts).

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

/**
 * The fields of a list part's row in the order its labels are listed (S4-12: a slide's picture with its focal points, kicker, title, text, button,
 * link, tone, „Näidatakse avalehel“; a question, then its answer): the leave guard's field in a row is the first of them that changed.
 */
export const siteRowFields = (entity: SiteDraftEntity, part: string): readonly string[] =>
  entity === "home" && part === "slides" ? Object.keys(SLIDE_FIELDS) : entity === "home" && part === "faq" ? ["q", "a"] : [];

/** The trainer card's fields → their labels (S4-17: the picture and its focal point are „Portree“, every stat is „Numbrid“). */
const TRAINER_FIELDS: Record<string, string> = { portraitKey: T.trainer.portrait, portraitPos: T.trainer.portrait, name: T.trainer.name, role: T.trainer.role, stats: T.trainer.stats };

/** A package's fields → their labels' templates (S4-34). */
const PACKAGE_FIELDS: Record<string, string> = { name: T.practice.name, tagline: T.practice.tagline, models: T.practice.models, durationLabel: T.practice.durationLabel, price: T.practice.price };

/** A post's fields → their labels (S4-24), in the bar's order. */
const POST_FIELDS: Record<string, string> = {
  title: T.post.title,
  slug: T.post.slug,
  category: T.post.category,
  excerpt: T.post.excerpt,
  body: T.post.body,
  publishedAt: T.post.publishedAt,
  coverKey: T.post.coverKey,
};

/** A row's place in the draft as the label says it (from 1), or null when the path names no row. */
const rowNumber = (s: string | undefined): number | null => (s !== undefined && /^\d{1,4}$/.test(s) ? Number(s) + 1 : null);

/**
 * S4-1's label of a field of a site part, as S4-12 (Avaleht), S4-17 (Koolitaja), S4-34 (Praktika) and S4-24 (a post) give it: `Slaid 3 pilt`,
 * `KKK vastus 6`, `MAXI punkt 4`, `Nimi`, `Kaanepilt`; the list's card title for a list as a whole (`Slaidid`, `KKK`, `Galerii`, `Numbrid`, `MAXI
 * punktid`). A post's Russian side, which its publish asks for (S4-Q1 A: the path `title.ru`, `body.ru`), is `{silt} (RU)`: `Pealkiri (RU)`. `path`:
 * the field's path in the part's editor value (a path this does not know is named by its part or list).
 */
export function siteFieldLabel(entity: SiteDraftEntity, part: string, path: string): string {
  const [field, row, sub] = path.split(".");
  if (entity === "post") {
    const label = Object.hasOwn(POST_FIELDS, field) ? POST_FIELDS[field] : T.post.title;
    return row === "ru" ? fill(T.ru, { label }) : label;
  }
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

/** S4-2's list of missing fields, as „Puudub: {väljad}“ takes it: each label in missingCase, joined with ", " (`slaid 3 pilt, KKK vastus 2`). */
export const missingLabels = (fields: readonly string[]): string => fields.map(missingCase).join(", ");

/** A text in two languages ({et, ru?} and nothing else). */
function isText(v: unknown): v is { et: string; ru?: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.et === "string" && Object.keys(o).every((k) => k === "et" || k === "ru") && (o.ru === undefined || typeof o.ru === "string");
}

/** A text in two languages with its Russian side "" when it has none, so that a Russian text typed and emptied again is no change. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  if (isText(v)) return { et: v.et, ru: v.ru ?? "" };
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).map((k) => [k, canonical(o[k])]));
}

/** Do two values of a site part read the same on the editor's screen? (A text without its Russian side and one with it empty do.) */
export const sameSiteValue = (a: unknown, b: unknown): boolean => stableJson(canonical(a)) === stableJson(canonical(b));

// ---------- the PublishBar's labels: the draft against live, row by row (S4-1, R-i) ----------

/** How two values differ: not at all, only in the Russian side of their texts, or otherwise. */
type Diff = "same" | "ru" | "other";
const worse = (a: Diff, b: Diff): Diff => (a === "other" || b === "other" ? "other" : a === "ru" || b === "ru" ? "ru" : "same");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function diffOf(a: unknown, b: unknown): Diff {
  if (isText(a) && isText(b)) return a.et !== b.et ? "other" : (a.ru ?? "") !== (b.ru ?? "") ? "ru" : "same";
  if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length ? "other" : a.reduce<Diff>((d, x, i) => worse(d, diffOf(x, b[i])), "same");
  if (isRecord(a) && isRecord(b) && !isText(a) && !isText(b)) {
    return Object.keys({ ...a, ...b }).reduce<Diff>((d, k) => worse(d, diffOf(a[k], b[k])), "same");
  }
  return sameSiteValue(a, b) ? "same" : "other";
}

/** A slide's fields in S4-12's order (its focal points are its picture); a FAQ row's; a package's in its card's order (S4-34, the P4 frame). */
const SLIDE_ORDER = ["imageKey", "imagePos", "imagePosMobile", "kicker", "title", "text", "ctaLabel", "ctaHref", "tone", "active"];
const FAQ_ORDER = ["q", "a"];
const PACKAGE_ORDER = ["name", "tagline", "price", "models", "durationLabel", "items"];
const TRAINER_ORDER = ["portraitKey", "portraitPos", "name", "role", "stats"];
const POST_ORDER = Object.keys(POST_FIELDS);
/** A list row's keys that are no field of the screen (the row's client key and its stored id). */
const ROW_KEYS = ["uid", "id"];

/**
 * The labels, in the cards' order, each once: a label's place is its card's (`card`), then the order it came in. `(RU)` when every change under it
 * was only on the Russian side (S4-1, R-i).
 */
class Labels {
  private readonly list: { label: string; ru: boolean; card: number; n: number }[] = [];
  add(label: string, diff: Diff, card: number): void {
    if (diff === "same") return;
    const known = this.list.find((x) => x.label === label);
    if (known) known.ru = known.ru && diff === "ru";
    else this.list.push({ label, ru: diff === "ru", card, n: this.list.length });
  }
  out(): string[] {
    return [...this.list].sort((a, b) => a.card - b.card || a.n - b.n).map((x) => (x.ru ? fill(T.ru, { label: x.label }) : x.label));
  }
}

/** A record's keys: `order` first, then any other key of either side (in their order), less `skip`. */
const keysOf = (a: Record<string, unknown>, b: Record<string, unknown>, order: readonly string[], skip: readonly string[] = []): string[] =>
  [...order, ...Object.keys({ ...a, ...b }).filter((k) => !order.includes(k))].filter((k) => !skip.includes(k) && (k in a || k in b));

/**
 * A list of rows (the slides, the FAQ, a package's points). Rows with a client key (`uid`) are followed by it: rows added, removed or moved name the
 * list as a whole (`listLabel`), and a row that is on both sides names its changed fields by its place in the draft (`rowLabel(i, field)`); rows
 * without one are compared by place, and any row added, removed or moved names the list.
 */
function listLabels(add: (label: string, diff: Diff) => void, live: unknown, draft: unknown, listLabel: string, rowLabel: (i: number, field: string | null) => string, order: readonly string[]): void {
  const before = Array.isArray(live) ? live : [];
  const after = Array.isArray(draft) ? draft : [];
  const uid = (r: unknown) => (isRecord(r) && typeof r.uid === "string" ? r.uid : null);
  const keys = [...before, ...after].map(uid);
  const keyed = keys.every((k) => k !== null) && new Set(before.map(uid)).size === before.length && new Set(after.map(uid)).size === after.length;
  let pairs: [unknown, unknown, number][];
  if (keyed) {
    const moved = before.length !== after.length || before.some((r, i) => uid(r) !== uid(after[i]));
    if (moved) add(listLabel, "other");
    pairs = after.flatMap((r, i): [unknown, unknown, number][] => {
      const was = before.find((b) => uid(b) === uid(r));
      return was === undefined ? [] : [[was, r, i]];
    });
  } else {
    const sorted = (rows: unknown[]) => rows.map((r) => stableJson(canonical(r))).sort();
    const moved = before.length !== after.length || (diffOf(before, after) !== "same" && stableJson(sorted(before)) === stableJson(sorted(after)));
    if (moved) return add(listLabel, "other");
    pairs = after.map((r, i): [unknown, unknown, number] => [before[i], r, i]);
  }
  for (const [was, row, i] of pairs) {
    if (!isRecord(was) || !isRecord(row) || isText(was) || isText(row)) {
      add(rowLabel(i, null), diffOf(was, row));
      continue;
    }
    for (const field of keysOf(was, row, order, ROW_KEYS)) add(rowLabel(i, field), diffOf(was[field], row[field]));
  }
}

/**
 * The PublishBar's labels of an entity's drafts (`changed`; README §1.8, S4-1, R-i): each part's draft against its live value, row by row, as S4-12
 * (Avaleht), S4-17 (Koolitaja), S4-34 (Praktika) and S4-24 (a post) name them, in the cards' order and once each. A row is numbered by its place in the draft,
 * from 1 (`Slaid 2 pealkiri`, `KKK küsimus 4`, `MAXI punkt 4`); rows added, removed or moved name the list's card (`Slaidid`, `KKK`, `Galerii`,
 * `Numbrid`, `MAXI punktid`); a label whose only change is the Russian text says so (`Slaid 2 pealkiri (RU)`). A Russian text typed and emptied
 * again is no change. `parts`: each part's name, live value and draft value, as the editor holds them (domain/site-entities.ts).
 */
export function siteChangeLabels(entity: SiteDraftEntity, parts: readonly { part: string; live: unknown; draft: unknown }[]): string[] {
  const labels = new Labels();
  // the parts in the cards' order: Avaleht's and Koolitaja's fixed, Praktika's packages as they come (the packages' order)
  const rank = (part: string) => {
    const fixed: readonly string[] = entity === "home" ? HOME_PARTS : entity === "trainer" ? TRAINER_PARTS : [];
    const i = fixed.indexOf(part);
    return i < 0 ? fixed.length : i;
  };
  const ordered = parts.map((p, i) => ({ ...p, i })).sort((a, b) => rank(a.part) - rank(b.part) || a.i - b.i);
  for (const { part, live: l, draft: d, i } of ordered) {
    const live = isRecord(l) ? l : {};
    const draft = isRecord(d) ? d : {};
    const label = (path: string) => siteFieldLabel(entity, part, path);
    if (entity === "home") {
      const card = rank(part);
      const add = (text: string, diff: Diff) => labels.add(text, diff, card);
      if (part === "slides" || part === "faq") {
        const order = part === "slides" ? SLIDE_ORDER : FAQ_ORDER;
        listLabels(add, live[part], draft[part], label(part), (n, f) => label(f === null ? part : `${part}.${n}.${f}`), order);
      } else for (const f of keysOf(live, draft, [])) add(label(f), diffOf(live[f], draft[f]));
    } else if (entity === "trainer") {
      // the cards: „Portree ja tutvustus“ (the portrait, name and role, then the bio), „Numbrid“ (the trainer's stats), „Galerii“, the two stories
      const card = (f: string) => (part === "trainer" ? (f === "stats" ? 1 : 0) : part === "bio" ? 0 : part === "works" ? 2 : part === "center_story" ? 3 : part === "trainer_journey" ? 4 : 5);
      for (const f of keysOf(live, draft, part === "trainer" ? TRAINER_ORDER : [])) labels.add(label(f), diffOf(live[f], draft[f]), card(f));
    } else if (entity === "post") {
      // one card, its fields in S4-24's order
      for (const f of keysOf(live, draft, POST_ORDER)) labels.add(label(f), diffOf(live[f], draft[f]), 0);
    } else {
      const add = (text: string, diff: Diff) => labels.add(text, diff, i);
      for (const f of keysOf(live, draft, PACKAGE_ORDER)) {
        if (f === "items") listLabels(add, live.items, draft.items, label("items"), (n) => label(`items.${n}`), []);
        else add(label(f), diffOf(live[f], draft[f]));
      }
    }
  }
  return labels.out();
}
