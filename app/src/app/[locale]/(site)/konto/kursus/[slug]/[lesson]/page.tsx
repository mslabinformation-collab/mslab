import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { LessonPage } from "@/components/account/LessonPage";
import { lessonTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";
import { parseRowId } from "@/lib/row-id";
import { isSlug } from "@/lib/slug";

type Props = { params: Promise<{ locale: string; slug: string; lesson: string }> };

/** Rendered on the first visit of a lesson's address and then cached, like the e-course shell (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string; lesson: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.shell.courses} — ${d.common.siteName}`, robots: { index: false, follow: false } };
}

/**
 * One lesson of an e-course in the account (phase 3a): a static shell, the same for every visitor of this address (no cookies,
 * headers or query read here, no database: the CDN serves it without a render, and nothing personal can enter its cache). The
 * browser loads the lesson from GET /api/konto/kursus/:slug/:lesson (LessonPage): the video, the text and the files, or the lock,
 * or a way to the terms notice. An address that cannot be a slug and a lesson id is a 404.
 */
export default async function LessonShellPage({ params }: Props) {
  const { locale, slug, lesson } = await params;
  const lessonId = parseRowId(lesson);
  if (!isLocale(locale) || !isSlug(slug) || lessonId === null) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <LessonPage slug={slug} lessonId={lessonId} locale={locale} t={lessonTexts(d)} />
    </AccountShell>
  );
}
