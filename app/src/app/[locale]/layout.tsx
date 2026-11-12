import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDict, isLocale } from "@/i18n/locales";
import { indexingOn } from "@/lib/indexing";
import { shareMetadata } from "@/server/share-meta";
import { fontVariables } from "../fonts";
import "@/styles/tokens.css";
import "@/styles/globals.css";

type Props = { children: React.ReactNode; params: Promise<{ locale: string }> };

/**
 * No page is rendered at build time (that would read the build machine's database); every public page is rendered on
 * its first visit and then served from the cache until a change revalidates it (server/public-cache.ts). The empty
 * list is what makes the pages cacheable (incremental static regeneration) rather than rendered on every request.
 */
export function generateStaticParams(): { locale: string }[] {
  return [];
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const dict = getDict(locale);
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    // SEO G1: noindex until indexing is on (the gate off, Vercel production: lib/indexing.ts); then no robots meta at all. Pages are
    // rendered on Vercel at run time (never at build: generateStaticParams is empty), where both settings are there. The private pages
    // set their own noindex, which replaces this one. Named in full (process.env.NAME).
    ...(indexingOn({ SITE_GATE: process.env.SITE_GATE, VERCEL_ENV: process.env.VERCEL_ENV }) ? {} : { robots: { index: false, follow: false } }),
    // every public page's link preview: the site's name, language, type and picture; a page's own title and description
    // come from its <title> (the home page, a course and a post add their own preview: share-meta.ts)
    ...(await shareMetadata(locale)),
  };
}

// Root layout of the public site: it renders <html> so that lang follows the locale (et at "/", ru at "/ru").
// The admin area (app/admin) is a second root layout.
export default async function RootLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
