import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { PracticalPage } from "@/components/account/PracticalPage";
import { practicalTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";
import { isSlug } from "@/lib/slug";

type Props = { params: Promise<{ locale: string; slug: string }> };

/** Rendered on the first visit of a course's practical work and then cached, like kursus/[slug] (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.practical.title} — ${d.common.siteName}` };
}

/**
 * An e-course's practical work (e-course completion, spec §4.3): /konto/kursus/<slug>/praktiline. A static shell, the same for every visitor
 * (no cookies, headers, query or database read here; the course is in the path). The browser loads the student's work from
 * GET /api/konto/kursus/<slug>/praktiline (PracticalPage): only her own access, only Maria's sent assessment.
 */
export default async function PracticalShellPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale) || !isSlug(slug)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <PracticalPage slug={slug} locale={locale} t={practicalTexts(d)} />
    </AccountShell>
  );
}
