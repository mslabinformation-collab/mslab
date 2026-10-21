import { SECTIONS, type Section } from "./sections";

// What the admin menu shows besides its entries: the badges, the addresses a badged row opens, the sum on the phone's ≡ button and the card of
// today's session. The shell builds it on the server for the first paint (menu.ts menuOf), /api/admin/margid answers it again for the sidebar when
// the visitor moves to another page, and the sidebar reads that answer here. Plain data, no React and nothing server-only: it runs in the browser too
// (no lookbehind: tests/unit/old-safari.test.ts).

/** A menu badge: a number, or a word („Täna“). `label` is what a screen reader says. */
export type NavBadge = { n: number; label: string } | { text: string; label: string };

/** A session on today's date, as the phone menu's card shows it. */
export type TodayCard = { href: string; time: string; course: string };

export type MenuState = {
  /** Only the entries that have a badge. */
  badges: Partial<Record<Section, NavBadge>>;
  /** Only the entries whose row opens a filtered page while it carries a badge. */
  hrefs: Partial<Record<Section, string>>;
  /** What the numeric badges add up to: the phone's ≡ button. A word badge adds nothing. */
  total: number;
  today: TodayCard | null;
};

const SECTION_KEYS: readonly string[] = SECTIONS.map((s) => s.key);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readBadge(v: unknown): NavBadge | null {
  if (!isObject(v) || typeof v.label !== "string") return null;
  if (typeof v.n === "number" && Number.isFinite(v.n)) return { n: v.n, label: v.label };
  if (typeof v.text === "string") return { text: v.text, label: v.label };
  return null;
}

/**
 * The answer of /api/admin/margid as the menu state, or null when it is not one (a login page's HTML, an error body, a shape from another
 * version). Entries it does not know are left out; a badge it cannot read is left out with its row's address.
 */
export function readMenuState(body: unknown): MenuState | null {
  if (!isObject(body) || body.ok !== true || typeof body.total !== "number" || !isObject(body.badges) || !isObject(body.hrefs)) return null;
  const badges: MenuState["badges"] = {};
  const hrefs: MenuState["hrefs"] = {};
  for (const key of SECTION_KEYS) {
    const badge = readBadge(body.badges[key]);
    if (badge) badges[key as Section] = badge;
    const href = body.hrefs[key];
    if (badge && typeof href === "string" && href.startsWith("/admin")) hrefs[key as Section] = href;
  }
  let today: TodayCard | null = null;
  if (isObject(body.today)) {
    const { href, time, course } = body.today;
    if (typeof href === "string" && href.startsWith("/admin") && typeof time === "string" && typeof course === "string") today = { href, time, course };
  }
  return { badges, hrefs, total: body.total, today };
}
