import { adminEt } from "@/i18n/dict/admin";
import { parseRowId } from "@/lib/row-id";
import type { AdminIconName } from "./AdminIcon";

// The admin menu (prototype B sidebar, Maria's A1), in this order. Every section has its page (Tasks 12 and 13; Õpilased: phase 2a;
// Tagasiside: phase protocols, after Maksed).
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
  // admin UX pass (README §1.1): Protokollid and Testimine get their menu rows with the grouped menu (Task 3); until then no row marks them
  | "protocols"
  | "testing";

export const SECTIONS: readonly { key: Section; href: string; icon: AdminIconName }[] = [
  { key: "overview", href: "/admin", icon: "grid" },
  { key: "courses", href: "/admin/koolitused", icon: "book" },
  { key: "calendar", href: "/admin/kalender", icon: "calendar" },
  { key: "registrations", href: "/admin/registreerimised", icon: "clipboard" },
  // e-course completion (spec §5.2): what waits for Maria's assessment, after Registreerimised
  { key: "assessment", href: "/admin/hindamine", icon: "check" },
  { key: "payments", href: "/admin/maksed", icon: "card" },
  { key: "feedback", href: "/admin/tagasiside", icon: "chat" },
  { key: "clients", href: "/admin/opilased", icon: "users" },
  { key: "requests", href: "/admin/paringud", icon: "inbox" },
  { key: "practice", href: "/admin/praktika", icon: "flower" },
  { key: "home", href: "/admin/avaleht", icon: "home" },
  { key: "trainer", href: "/admin/koolitaja", icon: "user" },
  { key: "news", href: "/admin/uudised", icon: "edit" },
  { key: "campaign", href: "/admin/kampaania", icon: "tag" },
  { key: "newsletter", href: "/admin/uudiskiri", icon: "mail" },
  { key: "settings", href: "/admin/seaded", icon: "settings" },
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
