// Pure selection rules for the home page (no database, no React).

type Typed = { type: "e_learning" | "contact" };
type Dated = { courseId: number; status: "scheduled" | "cancelled"; course: Typed };

/**
 * The course cards on the home page: `n` published courses with both types represented (half each when possible,
 * the rest from the type that has more). The admin order (`sort`) of the input is kept.
 */
export function pickHomeCourses<T extends Typed>(list: T[], n = 4): T[] {
  const contact = list.filter((c) => c.type === "contact");
  const online = list.filter((c) => c.type === "e_learning");
  let takeContact = Math.min(contact.length, Math.ceil(n / 2));
  const takeOnline = Math.min(online.length, n - takeContact);
  takeContact = Math.min(contact.length, n - takeOnline);
  const chosen = new Set<T>([...contact.slice(0, takeContact), ...online.slice(0, takeOnline)]);
  return list.filter((c) => chosen.has(c));
}

/** The upcoming strip: the next `n` sessions that are not cancelled, contact courses only (input is soonest first). */
export function nextSessions<S extends Dated>(sessions: S[], n = 3): S[] {
  return sessions.filter((s) => s.status !== "cancelled" && s.course.type === "contact").slice(0, n);
}

/** The first session that is not cancelled, per course id (input is soonest first). */
export function nextSessionByCourse<S extends Dated>(sessions: S[]): Map<number, S> {
  const out = new Map<number, S>();
  for (const s of sessions) if (s.status !== "cancelled" && !out.has(s.courseId)) out.set(s.courseId, s);
  return out;
}

/**
 * D's statement line: ink up to and including the first comma, the rest in a lighter tone
 * ("Õpetame … nii," + " nagu oleksime ise tahtnud õppida …"). Without a comma the whole line is ink.
 */
export function splitStatement(text: string): [string, string] {
  const t = text.trim();
  const i = t.indexOf(", ");
  return i < 0 ? [t, ""] : [t.slice(0, i + 1), t.slice(i + 1)];
}

/** The first paragraph of a text (paragraphs are separated by a blank line). */
export function firstParagraph(text: string): string {
  return text.trim().split(/\n\s*\n/)[0]?.trim() ?? "";
}

/**
 * A bio without its first sentence when that sentence is the role shown above it (UX pass 11.11 P12: the course page's trainer card had „Kulmu- ja
 * ripsmetehnikate meister ja koolitaja“ under the name and again as the bio's opening). Case and the closing mark aside; anything else is kept.
 */
export function withoutRole(text: string, role: string): string {
  const said = role.trim().replace(/[.!?]+$/, "");
  if (!said) return text;
  const lead = text.slice(0, said.length);
  const rest = text.slice(said.length);
  if (lead.toLocaleLowerCase("et") !== said.toLocaleLowerCase("et") || !/^[.!?]+(\s|$)/.test(rest)) return text;
  return rest.replace(/^[.!?]+\s*/, "");
}
