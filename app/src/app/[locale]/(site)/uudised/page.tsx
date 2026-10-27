import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewsGrid } from "@/components/site/NewsCard";
import { PreviewLabelBar } from "@/components/site/PreviewBar";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { listPosts } from "@/db/queries/public";
import { pick } from "@/i18n/field";
import { formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import { previewActive } from "@/server/preview";
import styles from "./news.module.css";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.nav.news} — ${d.common.siteName}`, description: d.news.lead };
}

/**
 * Blog list (Task 9, B1): prototype D `pNewsList` kept as it is (Maria C28) — eyebrow, "Blogi.", the card grid. In the signed-in admin's draft preview
 * (api/admin/eelvaade; admin UX pass piece 4b, Task 2) each post shows its drafts, under the catalogue's bar „Eelvaade · Lõpeta eelvaade“ (a list of
 * posts has nothing of its own to discard).
 */
export default async function NewsPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  // previewActive() is false, with no cookie read, for every visitor and for the static render, so the page stays the one cached
  const drafts = await previewActive();
  const posts = await listPosts(getDb(), undefined, { drafts });
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { catalogueBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewLabelBar {...catalogueBarProps(href(locale, "/uudised"))} />;
  }
  return (
    <div className={`${ui.wrap} ${styles.page}`}>
      <header className={styles.head}>
        <p className={ui.caps}>{d.news.title}</p>
        <h1 className={`${ui.pageTitle} ${styles.title}`}>{d.news.pageTitle}</h1>
      </header>
      {posts.length > 0 ? (
        <NewsGrid
          readMore={d.news.readMore}
          posts={posts.map((p) => ({
            slug: p.slug,
            href: href(locale, `/uudised/${p.slug}`),
            title: pick(p.title, locale),
            excerpt: pick(p.excerpt, locale),
            date: formatDate(p.publishedAt, locale),
            category: pick(p.category, locale),
            cover: mediaUrl(p.coverKey),
          }))}
        />
      ) : (
        <p className={styles.empty}>{d.news.lead}</p>
      )}
      {previewBar}
    </div>
  );
}
