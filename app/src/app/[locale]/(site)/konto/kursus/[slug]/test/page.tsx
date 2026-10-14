import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { TestPage } from "@/components/account/TestPage";
import { shellTexts, testTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";
import { isSlug } from "@/lib/slug";

type Props = { params: Promise<{ locale: string; slug: string }> };

/** Rendered on the first visit of a course's test and then cached, like kursus/[slug] (app/[locale]/layout.tsx). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.test.title} — ${d.common.siteName}` };
}

/**
 * An e-course's knowledge test (e-course completion, spec §4.2): /konto/kursus/<slug>/test. A static shell, the same for every visitor (no
 * cookies, headers, query or database read here; the course is in the path, an account page never has a query). The browser loads the test
 * from GET /api/konto/kursus/<slug>/test (TestPage): only for the signed-in student's own access, never the answer key.
 */
export default async function TestShellPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale) || !isSlug(slug)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <TestPage slug={slug} locale={locale} t={testTexts(d)} />
    </AccountShell>
  );
}
