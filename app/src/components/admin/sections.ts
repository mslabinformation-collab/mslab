import { adminEt } from "@/i18n/dict/admin";
import { parseRowId } from "@/lib/row-id";
import type { AdminIconName } from "./AdminIcon";

// The admin menu (prototype B sidebar, Maria's A1; grouped by the admin UX pass, README §1.1). Every section has its page.
export type Section =
  | "overview"
  | "courses"
  | "calendar"
  | "registrations"
  // Hindamine (phase e-course completion): the protocol screen of an access (Task 11) marks it; its page and menu entry are Task 12's
  | "assessment"
  | "payments"
  | "feedback"
  | "clients"
  | "requests"
  | "practice"
  | "home"
  | "trainer"
  | "news"
  | "campaign"
  | "newsletter"
  | "settings"
  // admin UX pass (README §1.1): the protocol index (A3) and the test page (C7) have their menu rows
  | "protocols"
  | "testing";

/** Every section, in the menu's order (GROUPS below cuts it into groups). */
export const SECTIONS: readonly { key: Section; href: string; icon: AdminIconName }[] = [
  { key: "overview", href: "/admin", icon: "grid" },
  { key: "registrations", href: "/admin/registreerimised", icon: "clipboard" },
  { key: "protocols", href: "/admin/protokollid", icon: "clipboard" },
  // e-course completion (spec §5.2): what waits for Maria's assessment, after Protokollid
  { key: "assessment", href: "/admin/hindamine", icon: "check" },
  { key: "requests", href: "/admin/paringud", icon: "inbox" },
  { key: "clients", href: "/admin/opilased", icon: "users" },
  { key: "feedback", href: "/admin/tagasiside", icon: "chat" },
  { key: "payments", href: "/admin/maksed", icon: "card" },
  { key: "courses", href: "/admin/koolitused", icon: "book" },
  { key: "calendar", href: "/admin/kalender", icon: "calendar" },
  { key: "practice", href: "/admin/praktika", icon: "flower" },
  { key: "home", href: "/admin/avaleht", icon: "home" },
  { key: "trainer", href: "/admin/koolitaja", icon: "user" },
  { key: "news", href: "/admin/uudised", icon: "edit" },
  { key: "campaign", href: "/admin/kampaania", icon: "tag" },
  { key: "newsletter", href: "/admin/uudiskiri", icon: "mail" },
  { key: "settings", href: "/admin/seaded", icon: "settings" },
  { key: "testing", href: "/admin/testimine", icon: "check" },
];

export type GroupId = "daily" | "courses" | "site" | "admin";

/**
 * The menu's groups (README §1.1). The first has no heading. `fold` is the one that folds: its header is a button, it is open whenever
 * the page is inside it, and otherwise it follows the stored choice (Sidebar.tsx). The phone menu shows every group open.
 */
export const GROUPS: readonly { id: GroupId | null; fold?: true; items: readonly Section[] }[] = [
  { id: null, items: ["overview"] },
  { id: "daily", items: ["registrations", "protocols", "assessment", "requests", "clients", "feedback", "payments"] },
  { id: "courses", items: ["courses", "calendar", "practice"] },
  { id: "site", fold: true, items: ["home", "trainer", "news", "campaign", "newsletter"] },
  { id: "admin", items: ["settings", "testing"] },
];

export const sectionHref = (key: Section) => SECTIONS.find((s) => s.key === key)!.href;

/**
 * The first address segment after /admin → the menu entry it highlights (README §1.1). A page without a row of its own belongs to a
 * neighbour: Arved to Maksed, Tunnistused and the test page (/admin/hindamine/test) to Hindamine.
 */
const BY_SEGMENT: ReadonlyMap<string, Section> = new Map<string, Section>([
  ["koolitused", "courses"],
  ["kalender", "calendar"],
  ["registreerimised", "registrations"],
  ["protokollid", "protocols"],
  ["hindamine", "assessment"],
  ["tunnistused", "assessment"],
  ["maksed", "payments"],
  ["arved", "payments"],
  ["tagasiside", "feedback"],
  ["opilased", "clients"],
  ["paringud", "requests"],
  ["praktika", "practice"],
  ["avaleht", "home"],
  ["koolitaja", "trainer"],
  ["uudised", "news"],
  ["kampaania", "campaign"],
  ["uudiskiri", "newsletter"],
  ["seaded", "settings"],
  ["testimine", "testing"],
]);

/**
 * The active menu entry, from the address: the sidebar lives in the (panel) layout, which does not render again when the visitor moves
 * between pages, so no page names its own entry any more. /admin/protokollid is Protokollid, except the practical-work screen of an
 * e-course access (?ligipaas=), which is Hindamine's (spec D4). The page reads the three parameters in the order sessioon, registreering,
 * ligipaas and takes the first that is an id; so does this: a session or a registration in the address wins over an access.
 */
export function activeSection(pathname: string, search: URLSearchParams): Section {
  const [, root, segment] = pathname.split("/");
  const section = root === "admin" && segment ? BY_SEGMENT.get(segment) : undefined;
  if (section !== "protocols") return section ?? "overview";
  const ofSession = parseRowId(search.get("sessioon") ?? "") !== null || parseRowId(search.get("registreering") ?? "") !== null;
  return !ofSession && parseRowId(search.get("ligipaas") ?? "") !== null ? "assessment" : "protocols";
}

/** <title> of an admin page: "Registreerimised — Haldus — MS LAB". */
export const adminTitle = (label: string) => `${label} — ${adminEt.meta.title}`;
