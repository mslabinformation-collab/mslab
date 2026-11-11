// Pure rules for the catalogue (/koolitused) and the course pages (no database, no React).

export type FormatFilter = "all" | "e" | "k";
export type LevelFilter = "all" | "baas" | "taiend";
type CourseType = "e_learning" | "contact";
type CourseLevel = "basic" | "advanced";

/**
 * Catalogue state in the URL, the single source of truth: ?vorm=e|k&tase=baas|taiend&valdkond=<area slug>&otsi=<text>.
 * Hybrid is never a filter (K1); ?vorm=h (old prototype links) only opens its explanation. `valdkond` is the area as written (course areas,
 * spec 2026-11-11-course-areas-filter-design.md §5.2): the chips decide whether it is one of theirs (domain/course-areas.ts parseArea), so an unknown
 * or old one reads as „Kõik“.
 */
export type CatalogueQuery = { vorm: FormatFilter; tase: LevelFilter; otsi: string; valdkond: string; hybrid: boolean };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export function parseCatalogueQuery(params: Params): CatalogueQuery {
  const vorm = first(params.vorm);
  const tase = first(params.tase);
  return {
    vorm: vorm === "e" || vorm === "k" ? vorm : "all",
    tase: tase === "baas" || tase === "taiend" ? tase : "all",
    otsi: first(params.otsi).slice(0, 100),
    valdkond: first(params.valdkond).slice(0, 100),
    hybrid: vorm === "h",
  };
}

/** The query string for a catalogue state ("" when nothing is filtered); always vorm, tase, valdkond, otsi in that order. */
export function catalogueSearch(q: { vorm: FormatFilter; tase: LevelFilter; valdkond?: string; otsi?: string }): string {
  const p = new URLSearchParams();
  if (q.vorm !== "all") p.set("vorm", q.vorm);
  if (q.tase !== "all") p.set("tase", q.tase);
  if (q.valdkond) p.set("valdkond", q.valdkond);
  if (q.otsi && q.otsi.trim()) p.set("otsi", q.otsi);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Lowercase without diacritics, so "summeetria" finds "sümmeetria" and "LAMI" finds "lami". */
export function normalizeSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export type CatalogueItem = {
  type: CourseType;
  level: CourseLevel;
  /** normalized title + summary */
  text: string;
  /** the slug of the course's area (domain/course-areas.ts areaSlug); null or absent: none */
  area?: string | null;
};

/** Every filter must hold (AND): the format, the level, the area (null or absent: every area; a course without one only then) and the search. */
export function matchesCatalogue(c: CatalogueItem, f: { vorm: FormatFilter; tase: LevelFilter; search: string; area?: string | null }): boolean {
  if (f.vorm === "e" && c.type !== "e_learning") return false;
  if (f.vorm === "k" && c.type !== "contact") return false;
  if (f.tase === "baas" && c.level !== "basic") return false;
  if (f.tase === "taiend" && c.level !== "advanced") return false;
  if (f.area && (c.area ?? null) !== f.area) return false;
  const q = normalizeSearch(f.search);
  return !q || c.text.includes(q);
}

/** D's format card text: the first sentence of the definition. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const i = t.indexOf(". ");
  return i < 0 ? t : t.slice(0, i + 1);
}

/** Cities of the sessions that can still be booked, in date order, each once. */
export function bookableCities(sessions: { city: string; status: "scheduled" | "cancelled" }[]): string[] {
  return [...new Set(sessions.filter((s) => s.status !== "cancelled").map((s) => s.city.trim()).filter(Boolean))];
}

/** A group registration needs at least one session that is neither full nor cancelled. */
export function hasPickableSession(sessions: { disabled: boolean }[]): boolean {
  return sessions.some((s) => !s.disabled);
}

/** "?sessioon=12" preselects session 12 when it belongs to the course and can be picked; otherwise nothing is preselected. */
export function initialSession(sessions: { id: number; disabled: boolean }[], requested: string | string[] | undefined): number | null {
  const id = Number(first(requested));
  if (!Number.isInteger(id)) return null;
  return sessions.some((s) => s.id === id && !s.disabled) ? id : null;
}

/** Paragraphs of a content text (separated by a blank line). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
