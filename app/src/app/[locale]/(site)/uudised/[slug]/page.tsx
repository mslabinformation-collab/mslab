import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Icon } from "@/components/site/Icon";
import { NewsGrid } from "@/components/site/NewsCard";
import { PreviewBar } from "@/components/site/PreviewBar";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { getPost, listPosts } from "@/db/queries/public";
import { paragraphs } from "@/domain/catalogue";
import { pick } from "@/i18n/field";
import { formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import styles from "../news.module.css";
import { previewActive } from "@/server/preview";
import { shareMetadata } from "@/server/share-meta";

type Props = { params: Promise<{ locale: string; slug: string }> };

/** Rendered on the first visit and cached, like every public page (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

/** Number of other posts under "Loe veel". */
const MORE = 3;

// Is this request the signed-in admin's draft preview (api/admin/eelvaade; admin UX pass piece 4b, Task 2)? `previewActive()` is true only with draft mode
// on AND a live admin session; it reads no cookie otherwise, so a visitor's page, and the one Next keeps, stays the cached render. Asked once per request.
const inPreview = cache(() => previewActive());

// One post query per request, shared by generateMetadata and the page: in the preview with the post's drafts, at its live address (db/queries/public.ts).
const loadPost = cache(async (slug: string) => {
  return getPost(getDb(), slug, { drafts: await inPreview() });
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const post = await loadPost(slug);
  if (!post) return {};
  const d = getDict(locale);
  const title = pick(post.title, locale);
  const description = pick(post.excerpt, locale);
  // the post's own link preview: its title, excerpt and cover
  const share = await shareMetadata(locale, { path: `/uudised/${post.slug}`, title, description, image: mediaUrl(post.coverKey) || undefined });
  return { title: `${title} — ${d.common.siteName}`, description, ...share };
}

/**
 * A blog post (Task 9, B1) on prototype D `pArticle`: crumb, date · category, title, 16:9 cover, the stored text as
 * paragraphs (split on blank lines), "Vaata koolitusi", then "Loe veel" with the three newest other posts.
 * Russian falls back to the Estonian text field by field. Unknown or unpublished slug → 404. In the admin's draft preview the post (and the others
 * under it) shows its drafts, under the post's bar: „Avaldamata {n}“, „Loobu muudatustest“ and the way out (piece 4b, Task 2).
 */
export default async function PostPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const post = await loadPost(slug);
  if (!post) notFound();
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const db = getDb();
  const drafts = await inPreview();
  const others = (await listPosts(db, undefined, { drafts })).filter((p) => p.id !== post.id).slice(0, MORE);
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { sitePreviewBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewBar {...await sitePreviewBarProps(db, { entity: "post", id: post.id }, to(`/uudised/${post.slug}`))} />;
  }

  const title = pick(post.title, locale);
  const category = pick(post.category, locale);
  const date = formatDate(post.publishedAt, locale);
  const cover = mediaUrl(post.coverKey);
  const body = paragraphs(pick(post.body, locale));

  return (
    <>
      <div className={`${ui.wrap} ${styles.page}`}>
        <article className={styles.article} data-article="">
          <nav className={styles.crumb} aria-label={d.course.breadcrumb}>
            <ol>
              <li>
                <Link href={to("/uudised")}>{d.nav.news}</Link>
              </li>
              <li aria-current="page">{category}</li>
            </ol>
          </nav>
          <p className={styles.meta}>
            <time dateTime={post.publishedAt.toISOString()}>{date}</time> · {category}
          </p>
          <h1 className={styles.articleTitle}>{title}</h1>
          {cover && (
            <div className={styles.cover} data-article-cover="">
              <Image className={styles.coverImage} src={cover} alt="" fill preload unoptimized sizes="(max-width: 800px) 100vw, 760px" />
            </div>
          )}
          <div className={styles.body} data-article-body="">
            {body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <div className={styles.cta}>
            <Link className={ui.btn} href={to("/koolitused")}>
              {d.news.coursesCta}
              <Icon name="arrow" />
            </Link>
          </div>
        </article>
      </div>

      {others.length > 0 && (
        <section className={`${ui.wrap} ${styles.more}`} aria-labelledby="more-posts" data-more-posts="">
          <h2 id="more-posts" className={styles.moreTitle}>
            {d.news.more}
          </h2>
          <NewsGrid
            level={3}
            readMore={d.news.readMore}
            posts={others.map((p) => ({
              slug: p.slug,
              href: to(`/uudised/${p.slug}`),
              title: pick(p.title, locale),
              excerpt: pick(p.excerpt, locale),
              date: formatDate(p.publishedAt, locale),
              category: pick(p.category, locale),
              cover: mediaUrl(p.coverKey),
            }))}
          />
        </section>
      )}
      {previewBar}
    </>
  );
}
