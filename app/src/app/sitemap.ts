import type { MetadataRoute } from "next";
import { getDb } from "@/db/client";
import { listPosts, listPublishedCourses } from "@/db/queries/public";
import { href } from "@/i18n/href";
import { LOCALES } from "@/i18n/locales";
import { languageLinks, PUBLIC_SITEMAP_PATHS } from "@/lib/alternates";
import { siteBase } from "@/server/share-meta";

// SEO G3: /sitemap.xml. Read from the database when asked, never at build (no page is rendered at build, see app/[locale]/layout.tsx; a build has
// no database). It is not an always-through root file: the coming-soon gate answers it like any page, and robots.txt names it only once indexing is on.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // (the Estonian home page is the bare site address, as Next writes its canonical)
  const base = siteBase();
  const abs = (p: string) => (p === "/" ? base : base + p);
  const db = getDb();
  const [courses, posts] = await Promise.all([listPublishedCourses(db), listPosts(db)]);
  const entry = (path: string, lastModified?: Date): MetadataRoute.Sitemap =>
    LOCALES.map((locale) => ({
      url: abs(href(locale, path)),
      ...(lastModified ? { lastModified } : {}),
      alternates: { languages: Object.fromEntries(Object.entries(languageLinks(path)).map(([k, v]) => [k, abs(v)])) },
    }));
  return [
    ...PUBLIC_SITEMAP_PATHS.flatMap((path) => entry(path)),
    ...courses.flatMap((c) => entry(`/koolitused/${c.slug}`, c.updatedAt)),
    ...posts.flatMap((p) => entry(`/uudised/${p.slug}`, p.publishedAt)),
  ];
}
