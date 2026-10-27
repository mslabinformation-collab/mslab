import { adminEt } from "@/i18n/dict/admin";

// C3 Uudised' small rules, one place each (admin UX pass piece 4b, Task 2 review m4): the address of the list or of a post's editor with the list's
// search (`?otsi=`, ruling R-f: the rows' links, „← Uudised“ and the list after a delete keep it), and a post's day (Tallinn, "YYYY-MM-DD") as the row
// writes it (`dd.mm`, S4-18) and the footer line (`dd.mm.yyyy`, S4-20). Pure; the server page and the browser both use it (no regex lookbehind: old iPads).

/** `path` (the list, `/admin/uudised`, or a post's editor) with the list's search `q`, if any, and `extra` parameters (`kustutatud=1`). */
export function newsHref(path: string, q: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams(q ? { otsi: q, ...extra } : extra).toString();
  return query ? `${path}?${query}` : path;
}

/** A day "YYYY-MM-DD", in its parts; null for anything else. */
function dayParts(day: string): { year: string; month: string; date: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? { year: m[1], month: m[2], date: m[3] } : null;
}

/** The row's day, "dd.mm"; without one „—“ (S4-18). */
export function dayMonth(day: string): string {
  const d = dayParts(day);
  return d ? `${d.date}.${d.month}` : adminEt.news.noDate;
}

/** The footer's day, "dd.mm.yyyy" (S4-20); anything else as it is. */
export function fullDay(day: string): string {
  const d = dayParts(day);
  return d ? `${d.date}.${d.month}.${d.year}` : day;
}
