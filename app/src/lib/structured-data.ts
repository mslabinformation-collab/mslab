import { priceOptions } from "@/domain/course";
import { pick, type I18n } from "@/i18n/field";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";

// SEO G5: structured data (JSON-LD) for search engines and AI search, built from what the page already has. Pure: plain objects with
// `@context`; components/site/JsonLd.tsx prints them. Nothing here is shown on a page. No legal company name or registry code: the company
// is not decided.

const CONTEXT = "https://schema.org";

/** The organization's address in every graph that points at it. */
const orgId = (base: string): string => `${base}/#organization`;

/** A site path or a stored picture address as an absolute address on the site. */
const absolute = (base: string, path: string): string => (/^https?:\/\//i.test(path) ? path : base + path);

/** The cents as the decimal text schema.org prices use: 19000 → "190.00". */
const euros = (cents: number): string => (cents / 100).toFixed(2);

/** The course's language field ("ET", "RU", "ET / RU") as language codes. */
function languages(field: string): string[] {
  return field
    .split(/[/,]/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x === "et" || x === "ru");
}

/** `{ inLanguage: [...] }`, or nothing when the field names neither Estonian nor Russian (validators flag an empty list). */
function inLanguage(field: string): { inLanguage?: string[] } {
  const list = languages(field);
  return list.length > 0 ? { inLanguage: list } : {};
}

/** `{ [key]: value }`, or nothing when the text is empty (validators flag an empty value). */
function text<K extends string>(key: K, value: string): { [P in K]?: string } {
  return value.trim() ? ({ [key]: value } as { [P in K]?: string }) : {};
}

export type OrganizationContact = { email: string; phone: string; address: string; instagram: string; facebook: string };

/** The training centre, on every public page: its name, logo and the contact details Seaded → Kontakt has filled in. */
export function organizationLd(base: string, name: string, contact: OrganizationContact) {
  const sameAs = [contact.instagram, contact.facebook].filter(Boolean);
  return {
    "@context": CONTEXT,
    "@type": "EducationalOrganization",
    "@id": orgId(base),
    name,
    url: base,
    logo: `${base}/brand/logo.png`,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { telephone: contact.phone } : {}),
    ...(contact.address ? { address: contact.address } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };
}

/** The site, on the home page. */
export function websiteLd(base: string, name: string) {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    "@id": `${base}/#website`,
    name,
    url: base,
    inLanguage: ["et", "ru"],
    publisher: { "@id": orgId(base) },
  };
}

export type CourseLdInput = {
  slug: string;
  type: "e_learning" | "contact";
  title: I18n;
  summary: I18n;
  language: string;
  price: number | null;
  priceGroup: number | null;
  priceIndividual: number | null;
  images: { key: string }[];
};
export type SessionLdInput = { startsAt: Date; city: string; venue: string; language: string; status: "scheduled" | "cancelled" };

/**
 * A course page: the course with its prices in EUR (an e-course's price; a contact course's group and individual price) and its instances: an
 * e-course one online instance, a contact course one onsite instance per scheduled session in `sessions` (the caller passes the upcoming ones;
 * a cancelled one is left out here as well).
 */
export function courseLd(base: string, locale: Locale, course: CourseLdInput, sessions: SessionLdInput[]) {
  const url = base + href(locale, `/koolitused/${course.slug}`);
  // the prices the page itself shows (domain/course.ts priceOptions): an e-course's price, a contact course's group and individual price
  const offers = priceOptions(course).map((o) => ({ "@type": "Offer", price: euros(o.cents), priceCurrency: "EUR", url }));
  const image = mediaUrl(course.images[0]?.key ?? "");
  const instances =
    course.type === "e_learning"
      ? [{ "@type": "CourseInstance", courseMode: "online" }]
      : sessions
          .filter((s) => s.status === "scheduled")
          .map((s) => ({
            "@type": "CourseInstance",
            courseMode: "onsite",
            startDate: s.startsAt.toISOString(),
            location: { "@type": "Place", ...(s.venue ? { name: s.venue } : {}), address: s.city },
            ...inLanguage(s.language),
          }));
  return {
    "@context": CONTEXT,
    "@type": "Course",
    name: pick(course.title, locale),
    ...text("description", pick(course.summary, locale)),
    url,
    ...(image ? { image: absolute(base, image) } : {}),
    ...inLanguage(course.language),
    provider: { "@id": orgId(base) },
    ...(offers.length > 0 ? { offers } : {}),
    ...(instances.length > 0 ? { hasCourseInstance: instances } : {}),
  };
}

export type PostLdInput = { slug: string; title: I18n; excerpt: I18n; coverKey: string; publishedAt: Date };

/** A news post: a blog posting by the organization. */
export function postLd(base: string, locale: Locale, post: PostLdInput) {
  const url = base + href(locale, `/uudised/${post.slug}`);
  const image = mediaUrl(post.coverKey);
  return {
    "@context": CONTEXT,
    "@type": "BlogPosting",
    headline: pick(post.title, locale),
    ...text("description", pick(post.excerpt, locale)),
    url,
    mainEntityOfPage: url,
    datePublished: post.publishedAt.toISOString(),
    inLanguage: locale,
    ...(image ? { image: absolute(base, image) } : {}),
    author: { "@id": orgId(base) },
    publisher: { "@id": orgId(base) },
  };
}

/** The trail home → list → page; `path` is a site path with the locale prefix already on it. */
export function breadcrumbLd(base: string, items: { name: string; path: string }[]) {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.name, item: base + (x.path === "/" ? "" : x.path) })),
  };
}
