import type { ListPill } from "@/components/admin/ListToolbar";
import type { AdminCourse, CourseListRow } from "@/db/queries/admin";
import { shownBadge } from "@/domain/badge";
import { euro } from "@/domain/money-text";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { mediaUrl } from "@/lib/media";

// What a row of the Koolitused list shows (README B1), as plain strings and numbers: the page (a server component) makes them, the list (a client component,
// CourseList.tsx) draws them. Pure, so the rules are tested without a page (tests/unit/admin-course-rows.test.ts).

export type CourseStatus = "published" | "draft" | "changes";

export type CourseRowData = {
  id: number;
  slug: string;
  /** The Estonian title. */
  name: string;
  /** The first picture's address, or null. */
  image: string | null;
  /** „{tase} · {valdkond} · /{slug}“ (UX pass A5), „{tase} · /{slug}“ without an area. */
  sub: string;
  type: AdminCourse["type"];
  typeLabel: string;
  /** The price, one entry per line („Grupp 350 €“ / „Individuaal 450 €“; an e-course has one; „—“ when there is none). */
  price: string[];
  /** The badge as the card shows it, or null. */
  badge: { label: string; bg: string; fg: string } | null;
  status: CourseStatus;
  statusLabel: string;
  sample: boolean;
};

/** The price column on two lines for a contact course (only the prices offered), one line for an e-course, a dash for none. */
export function priceLines(c: Pick<AdminCourse, "type" | "price" | "priceGroup" | "priceIndividual">): string[] {
  const r = adminEt.registrations;
  if (c.type === "e_learning") return [c.price != null ? euro(c.price) : adminEt.courses.noPrice];
  const lines = [c.priceGroup != null ? `${r.group} ${euro(c.priceGroup)}` : "", c.priceIndividual != null ? `${r.individual} ${euro(c.priceIndividual)}` : ""].filter(Boolean);
  return lines.length ? lines : [adminEt.courses.noPrice];
}

/** „Avaldatud“, or „Avaldamata muudatused“ while the draft layer holds changes of it; „Mustand“ for a course that is not published (it saves live, so it holds none). */
export function courseStatus(c: Pick<CourseListRow, "published" | "changes">): CourseStatus {
  return !c.published ? "draft" : c.changes ? "changes" : "published";
}

/** `area`: the Estonian name of the course's area (Seaded → Valdkonnad), null for none. */
export function courseRowOf(c: CourseListRow, area: string | null = null): CourseRowData {
  const t = adminEt.courses;
  const status = courseStatus(c);
  const image = c.images[0];
  return {
    id: c.id,
    slug: c.slug,
    name: pick(c.title, "et"),
    image: image ? mediaUrl(image.key) : null,
    sub: [t.level[c.level], area, `/${c.slug}`].filter(Boolean).join(" · "),
    type: c.type,
    typeLabel: t.type[c.type],
    price: priceLines(c),
    badge: shownBadge(c.badge, "et"),
    status,
    statusLabel: status === "published" ? t.published : status === "changes" ? t.changes : t.draft,
    sample: c.isSample,
  };
}

/** The list's view: the form (`?vorm=e` / `?vorm=k`), the courses without an area (`?valdkond=puudub`, UX pass A5), or null for „Kõik“. */
export type CourseView = "e" | "k" | "puudub" | null;

const FORMS = { e: "e_learning", k: "contact" } as const;

export function courseView(sp: Record<string, string | string[] | undefined>): CourseView {
  if (sp.vorm === "e" || sp.vorm === "k") return sp.vorm;
  return sp.valdkond === "puudub" ? "puudub" : null;
}

/** The courses a view shows, in their order. */
export function coursesIn<C extends Pick<CourseListRow, "type" | "areaId">>(all: C[], view: CourseView): C[] {
  if (view === null) return all;
  return all.filter((c) => (view === "puudub" ? c.areaId == null : c.type === FORMS[view]));
}

/** The pills Kõik / E-õpe / Kontaktõpe / Määramata valdkond with their counts; one view at a time. */
export function coursePills(all: Pick<CourseListRow, "type" | "areaId">[], view: CourseView): ListPill[] {
  const t = adminEt.courses.filter;
  const views: { key: CourseView; label: string; href: string }[] = [
    { key: null, label: t.all, href: "/admin/koolitused" },
    { key: "e", label: t.e, href: "/admin/koolitused?vorm=e" },
    { key: "k", label: t.k, href: "/admin/koolitused?vorm=k" },
    { key: "puudub", label: t.noArea, href: "/admin/koolitused?valdkond=puudub" },
  ];
  return views.map((v) => ({ href: v.href, label: v.label, count: coursesIn(all, v.key).length, current: view === v.key }));
}
