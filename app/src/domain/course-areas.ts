// The training areas („Valdkonnad“; spec 2026-11-11-course-areas-filter-design.md): pure rules shared by the server (server/course-areas.ts), the
// Seaded card (components/admin/AreasSettings.tsx, which checks a name in the browser by the same rule) and the public filters (the calendar and the
// catalogue). No database, no React; it runs on old iPads (tests/unit/old-safari.test.ts): no regex lookbehind.
//
// - An area has an Estonian and a Russian name, both required, at most 60 characters, one line; the Estonian names are unique by their slug.
// - Its slug is the city's rule applied to the Estonian name (domain/calendar.ts citySlug): `?valdkond=kulmukoolitused`, the same on the Russian
//   pages. A renamed area gets a new slug; an old link reads as „Kõik“.
// - A filter row lists only the areas its list has, in Maria's order, and is shown only for two or more (the spec's anti-goal: a row that offers
//   one choice besides „Kõik“).

import { toStorable } from "@/lib/to-storable";
import { citySlug } from "./calendar";

/** A name's length in each language (spec §4.1). */
export const AREA_LIMITS = { name: 60 } as const;

/** The area in the address: its Estonian name lowercase, without diacritics, spaces as dashes („Kulmukoolitused“ → `kulmukoolitused`). */
export const areaSlug = (name: { et: string }): string => citySlug(name.et);

/** A name as stored: what Postgres can store, on one line (a pasted line break is a space, a run of spaces one space), trimmed. */
export const cleanAreaName = (s: string): string => toStorable(s).replace(/\s+/g, " ").trim();

/** Why a name is refused, per language it is given (`et`, `ru`): "required" when it is empty, "tooLong" over AREA_LIMITS.name (after the clean-up). */
export function areaNameProblems(name: { et?: unknown; ru?: unknown }): Partial<Record<"et" | "ru", "required" | "tooLong">> {
  const out: Partial<Record<"et" | "ru", "required" | "tooLong">> = {};
  for (const lang of ["et", "ru"] as const) {
    if (!(lang in name)) continue;
    const v = name[lang];
    const text = typeof v === "string" ? cleanAreaName(v) : "";
    if (!text) out[lang] = "required";
    else if (text.length > AREA_LIMITS.name) out[lang] = "tooLong";
  }
  return out;
}

/** A chip of a filter row: the area's id, its slug (the address) and its name in the page's language. */
export type AreaChip = { id: number; slug: string; label: string };

/**
 * The chips of a filter row after „Kõik“: of `areas` (all of them, in Maria's order), those whose id is among `present` (the listed sessions' or
 * courses' areas; null: a course without one), each slug once. None at all when fewer than two are left: the row is then not shown.
 */
export function areaChips(areas: readonly AreaChip[], present: Iterable<number | null>): AreaChip[] {
  const ids = new Set<number>();
  for (const id of present) if (id !== null) ids.add(id);
  const seen = new Set<string>();
  const out: AreaChip[] = [];
  for (const a of areas) {
    if (!ids.has(a.id) || seen.has(a.slug)) continue;
    seen.add(a.slug);
    out.push(a);
  }
  return out.length >= 2 ? out : [];
}

/**
 * The area filter in the URL, the single source of truth (as the city's): ?valdkond=<slug>. The slug of one of `chips`; a missing, unknown or old
 * value — and any value while the row is not shown (no chips) — means every area (null).
 */
export function parseArea(value: string | string[] | null | undefined, chips: readonly AreaChip[]): string | null {
  const v = citySlug(Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
  return v && chips.some((c) => c.slug === v) ? v : null;
}
