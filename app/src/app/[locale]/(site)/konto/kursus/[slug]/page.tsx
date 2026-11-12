import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { EcoursePage } from "@/components/account/EcoursePage";
import { ecourseTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";
import { isSlug } from "@/lib/slug";

type Props = { params: Promise<{ locale: string; slug: string }> };

/** Rendered on the first visit of a course and then cached, like koolitused/[slug] (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.shell.courses} — ${d.common.siteName}`, robots: { index: false, follow: false } };
}

/**
 * An e-course in the account: a static shell, the same for every visitor of this course (no cookies, headers or query read
 * here, no database: the CDN serves it without a render, and nothing personal can enter its cache). The browser loads the
 * signed-in client's view from GET /api/konto/kursus/:slug (EcoursePage): the terms notice, then the course, or "Sul ei ole sellele
 * koolitusele ligipääsu." The page sits under the "Minu koolitused" tab. An address that cannot be a course's slug is a 404.
 */
export default async function EcourseShellPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale) || !isSlug(slug)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <EcoursePage slug={slug} locale={locale} t={ecourseTexts(d)} />
    </AccountShell>
  );
}
