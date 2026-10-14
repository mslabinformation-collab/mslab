import { adminEt } from "@/i18n/dict/admin";
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
  | "settings";

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

/** <title> of an admin page: "Registreerimised — Haldus — MS LAB". */
export const adminTitle = (label: string) => `${label} — ${adminEt.meta.title}`;
